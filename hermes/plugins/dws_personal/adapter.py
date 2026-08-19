"""Hermes platform adapter for Foursday's normalized DWS bridge protocol."""

from __future__ import annotations

import asyncio
from collections import deque
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
from typing import Any, Awaitable, Callable, Dict, Iterable, Optional

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)


def _strings(value: Any) -> set[str]:
    if isinstance(value, str):
        values: Iterable[Any] = value.split(",")
    elif isinstance(value, (list, tuple, set)):
        values = value
    else:
        values = []
    return {str(item).strip() for item in values if str(item).strip()}


def _milliseconds(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(default if value in (None, "") else value)
    except (TypeError, ValueError) as error:
        raise ValueError("DWS bundle timing is invalid") from error
    if parsed < minimum or parsed > maximum:
        raise ValueError("DWS bundle timing is invalid")
    return parsed


def dws_available() -> bool:
    configured = str(os.getenv("DWS_PATH", "")).strip()
    if configured:
        return os.path.isabs(configured) and os.access(configured, os.X_OK)
    return shutil.which("dws") is not None


_OUTBOUND_SECRET = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----"
    r"|\b(?:password|passwd|secret|api[_ -]?key|access[_ -]?token|bearer)\s*[:=]\s*\S+"
    r"|\b(?:ghp|github_pat|sk-[A-Za-z0-9_-]{10,}|AKIA)[A-Za-z0-9_-]+"
    r"|\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?)://[^\s]+",
    re.IGNORECASE,
)
_IRREVERSIBLE_COMMITMENT = re.compile(
    r"(?:我|我们|本人|Foursday).{0,12}(?:保证|承诺|同意|批准|决定).{0,24}(?:付款|转账|签署|合同|录用|辞退|调薪|绩效|赔偿|不可撤销)"
    r"|\b(?:I|we)\s+(?:guarantee|commit|approve|agree)\b.{0,40}\b(?:pay|transfer|sign|hire|fire|salary|contract|irrevocable)\b",
    re.IGNORECASE,
)


def _digest(value: Any) -> str:
    return hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()[:16]


def _shadow_evidence(event: dict[str, Any]) -> None:
    configured = str(os.getenv("FOURSDAY_SHADOW_EVIDENCE_FILE", "")).strip()
    if not configured:
        return
    path = Path(configured).expanduser()
    if not path.is_absolute():
        raise RuntimeError("Foursday shadow evidence path must be absolute")
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    if path.parent.resolve(strict=True) != path.parent:
        raise RuntimeError("Foursday shadow evidence parent must not use a symlink")
    parent_metadata = path.parent.lstat()
    if not stat.S_ISDIR(parent_metadata.st_mode) or parent_metadata.st_mode & 0o077:
        raise RuntimeError("Foursday shadow evidence parent must be private")
    os.chmod(path.parent, 0o700)
    if path.exists():
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077:
            raise RuntimeError("Foursday shadow evidence must be a private regular file")
    flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    try:
        with os.fdopen(descriptor, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        os.chmod(path, 0o600)


class UnavailableBridge:
    async def start(self, _callback: Callable[[dict], Awaitable[None]]) -> None:
        raise RuntimeError("DWS bridge is not configured")

    async def stop(self) -> None:
        return None

    async def send(self, _payload: dict) -> dict:
        return {"success": False, "error": "DWS bridge is not configured"}


class DwsPersonalAdapter(BasePlatformAdapter):
    supports_code_blocks = True
    supports_async_delivery = True
    splits_long_messages = False
    MAX_MESSAGE_LENGTH = 20_000

    def __init__(
        self,
        config: PlatformConfig,
        bridge: Any = None,
        router: Any = None,
        memory: Any = None,
    ):
        super().__init__(config, Platform("dws_personal"))
        extra = config.extra or {}
        self._allowed_users = _strings(
            extra.get("allowed_users") or os.getenv("DWS_PERSONAL_ALLOWED_USERS")
        )
        self._allowed_groups = _strings(
            extra.get("allowed_groups") or os.getenv("DWS_PERSONAL_ALLOWED_GROUPS")
        )
        self._allow_all = bool(extra.get("allow_all")) or (
            str(os.getenv("DWS_PERSONAL_ALLOW_ALL_USERS", "")).lower() == "true"
        )
        self._toolsets = list(extra.get("toolsets") or ["coding"])
        self._bundle_quiet_ms = _milliseconds(
            extra.get("bundle_quiet_ms")
            if "bundle_quiet_ms" in extra
            else os.getenv("DWS_PERSONAL_BUNDLE_QUIET_MS"),
            3_000,
            0,
            8_000,
        )
        self._bundle_max_wait_ms = _milliseconds(
            extra.get("bundle_max_wait_ms")
            if "bundle_max_wait_ms" in extra
            else os.getenv("DWS_PERSONAL_BUNDLE_MAX_WAIT_MS"),
            8_000,
            1,
            8_000,
        )
        if self._bundle_quiet_ms > self._bundle_max_wait_ms:
            raise ValueError("DWS bundle quiet window cannot exceed maximum wait")
        self._bridge = bridge or UnavailableBridge()
        self._router = router
        self._memory = memory
        self._seen = set()
        self._seen_order = deque(maxlen=5_000)
        self._pending: dict[str, list[dict]] = {}
        self._bundle_tasks: dict[str, asyncio.Task] = {}

    @property
    def enforces_own_access_policy(self) -> bool:
        return True

    def toolsets_for_source(self, _source) -> Optional[list[str]]:
        return list(self._toolsets)

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        del is_reconnect
        if self._running:
            return True
        if self._router is None:
            return False
        await self._bridge.start(self._on_record)
        self._running = True
        return True

    async def disconnect(self) -> None:
        pending = list(self._pending.values())
        self._pending.clear()
        for task in self._bundle_tasks.values():
            task.cancel()
        self._bundle_tasks.clear()
        for records in pending:
            await self._deliver_records(records)
        if self._running:
            await self._bridge.stop()
        self._running = False

    def _remember(self, message_id: str) -> bool:
        if message_id in self._seen:
            return False
        if len(self._seen_order) == self._seen_order.maxlen:
            expired = self._seen_order.popleft()
            self._seen.discard(expired)
        self._seen_order.append(message_id)
        self._seen.add(message_id)
        return True

    def _user_allowed(self, user_id: str) -> bool:
        return self._allow_all or bool(user_id and user_id in self._allowed_users)

    async def _emit_control(self, record: Dict[str, Any]) -> None:
        conversation_id = str(record.get("conversationId") or "").strip()
        participant_id = str(record.get("participantUserId") or "").strip()
        chat_type = str(record.get("chatType") or "direct").strip()
        if (
            not conversation_id
            or not participant_id
            or not self._user_allowed(participant_id)
            or chat_type not in {"direct", "group"}
        ):
            return
        session_key = f"{conversation_id}:{participant_id}"
        source = self.build_source(
            chat_id=conversation_id,
            chat_type="dm" if chat_type == "direct" else "group",
            user_id=participant_id,
            message_id=str(record.get("id") or "control"),
        )
        control = str(record.get("control") or "").strip()
        if control == "human_takeover":
            await self.interrupt_session_activity(session_key, conversation_id)
        _shadow_evidence({
            "schema": "foursday-hermes-shadow-event/v1",
            "type": control,
            "conversationHash": _digest(conversation_id),
            "participantHash": _digest(participant_id),
            "occurredAt": str(record.get("createTime") or "") or None,
        })
        handler = getattr(self, "_platform_event_handler", None)
        if handler is not None and control in {"human_takeover", "message_withdrawn"}:
            await handler({
                "type": control,
                "conversation_id": conversation_id,
                "participant_id": participant_id,
                "message_id": str(record.get("messageId") or "") or None,
                "occurred_at": str(record.get("createTime") or "") or None,
            }, source)

    async def _bundle_after(self, key: str) -> None:
        try:
            while key in self._pending:
                records = self._pending[key]
                now = asyncio.get_running_loop().time() * 1_000
                due = min(
                    records[0]["_received_monotonic_ms"] + self._bundle_max_wait_ms,
                    records[-1]["_received_monotonic_ms"] + self._bundle_quiet_ms,
                )
                if due > now:
                    await asyncio.sleep((due - now) / 1_000)
                    continue
                records = self._pending.pop(key, [])
                if records:
                    await self._deliver_records(records)
                return
        finally:
            self._bundle_tasks.pop(key, None)

    async def _queue_record(self, record: Dict[str, Any]) -> None:
        if self._bundle_quiet_ms == 0:
            await self._deliver_records([record])
            return
        key = f"{record['chatType']}:{record['conversationId']}:{record['senderUserId']}"
        existing = self._pending.get(key, [])
        if existing:
            previous_at = datetime.fromisoformat(
                str(existing[-1].get("createTime") or "").replace("Z", "+00:00")
            )
            current_at = datetime.fromisoformat(
                str(record.get("createTime") or "").replace("Z", "+00:00")
            )
            source_gap_ms = (current_at - previous_at).total_seconds() * 1_000
            if source_gap_ms > self._bundle_max_wait_ms:
                records = self._pending.pop(key, [])
                task = self._bundle_tasks.pop(key, None)
                if task is not None:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                if records:
                    await self._deliver_records(records)
        record = {
            **record,
            "_received_monotonic_ms": asyncio.get_running_loop().time() * 1_000,
        }
        self._pending.setdefault(key, []).append(record)
        if key not in self._bundle_tasks:
            self._bundle_tasks[key] = asyncio.create_task(self._bundle_after(key))

    async def _deliver_records(self, records: list[Dict[str, Any]]) -> None:
        if not records:
            return
        records = sorted(records, key=lambda item: str(item.get("createTime") or ""))
        latest = records[-1]
        message_ids = [str(item["id"]) for item in records]
        content = "\n".join(str(item["content"]).strip() for item in records).strip()
        conversation_id = str(latest["conversationId"])
        user_id = str(latest["senderUserId"])
        open_id = str(latest.get("senderOpenDingTalkId") or "").strip()
        chat_type = str(latest["chatType"])
        timestamp = datetime.fromisoformat(
            str(latest.get("createTime") or "").replace("Z", "+00:00")
        )
        route = self._router.route(text=content, session_key=f"{conversation_id}:{user_id}")
        memory_context = ""
        memory_status = "not_configured"
        if self._memory is not None:
            try:
                memory_context = await self._memory.context_for_route(route)
                memory_status = "available" if memory_context else "empty"
            except Exception:
                memory_status = "unavailable"
        channel_prompt = "\n\n".join(item for item in [route.context, memory_context] if item)
        source = self.build_source(
            chat_id=conversation_id,
            chat_type="dm" if chat_type == "direct" else "group",
            user_id=user_id,
            user_id_alt=open_id or None,
            user_name=str(latest.get("senderName") or "").strip() or user_id,
            message_id=message_ids[-1],
            workspace_path=route.workspace_path,
        )
        event = MessageEvent(
            text=content,
            message_type=MessageType.TEXT,
            user_id=user_id,
            user_name=source.user_name,
            source=source,
            raw_message={"transport": "dws", "normalized": True},
            message_id=message_ids[-1],
            timestamp=timestamp,
            channel_prompt=channel_prompt,
            metadata={
                "dws_identity_verified": True,
                "project_route_status": getattr(route, "status", "unknown"),
                "personal_memory_status": memory_status,
                "source_message_ids": message_ids,
                "bundle_size": len(records),
            },
        )
        _shadow_evidence({
            "schema": "foursday-hermes-shadow-event/v1",
            "type": "inbound",
            "conversationHash": _digest(conversation_id),
            "participantHash": _digest(user_id),
            "messageHashes": [_digest(value) for value in message_ids],
            "projectId": getattr(getattr(route, "project", None), "id", None),
            "routeStatus": getattr(route, "status", "unknown"),
            "memoryStatus": memory_status,
            "bundleSize": len(records),
            "occurredAt": timestamp.isoformat(),
        })
        await self.handle_message(event)

    async def _on_record(self, record: Dict[str, Any]) -> None:
        if not isinstance(record, dict):
            return
        if record.get("control"):
            await self._emit_control(record)
            return
        if record.get("isSelf") is True:
            return
        message_id = str(record.get("id") or "").strip()
        conversation_id = str(record.get("conversationId") or "").strip()
        user_id = str(record.get("senderUserId") or "").strip()
        open_id = str(record.get("senderOpenDingTalkId") or "").strip()
        content = str(record.get("content") or "").strip()
        chat_type = str(record.get("chatType") or "").strip()
        if (
            not message_id
            or not conversation_id
            or not user_id
            or not content
            or chat_type not in {"direct", "group"}
            or not self._remember(message_id)
            or not self._user_allowed(user_id)
        ):
            return
        if chat_type == "group":
            if conversation_id not in self._allowed_groups:
                return
            if record.get("mentionedSelf") is not True:
                return
        try:
            datetime.fromisoformat(str(record.get("createTime") or "").replace("Z", "+00:00"))
        except ValueError:
            return
        await self._queue_record({
            **record,
            "id": message_id,
            "conversationId": conversation_id,
            "senderUserId": user_id,
            "senderOpenDingTalkId": open_id or None,
            "content": content,
            "chatType": chat_type,
        })

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        if _OUTBOUND_SECRET.search(str(content)) or _IRREVERSIBLE_COMMITMENT.search(str(content)):
            return SendResult(
                success=False,
                error="Foursday blocked secret material or an irreversible commitment",
                retryable=False,
            )
        payload = {
            "conversationId": str(chat_id),
            "content": str(content),
            "replyTo": str(reply_to) if reply_to else None,
            "metadata": dict(metadata or {}),
        }
        result = await self._bridge.send(payload)
        _shadow_evidence({
            "schema": "foursday-hermes-shadow-event/v1",
            "type": "reply_attempt",
            "conversationHash": _digest(chat_id),
            "replyToHash": _digest(reply_to) if reply_to else None,
            "deliveryContextHash": hashlib.sha256(
                json.dumps(metadata or {}, sort_keys=True, default=str).encode("utf-8")
            ).hexdigest()[:16],
            "contentHash": hashlib.sha256(str(content).encode("utf-8")).hexdigest(),
            "contentBytes": len(str(content).encode("utf-8")),
            "mode": str(os.getenv("FOURSDAY_HERMES_MODE", "unknown")),
            "bridgeSuccess": bool(
                isinstance(result, dict) and result.get("success") is True
            ),
            "outcomeUnknown": bool(
                isinstance(result, dict) and result.get("outcomeUnknown") is True
            ),
        })
        if not isinstance(result, dict) or result.get("success") is not True:
            shadow_mode = str(
                os.getenv("FOURSDAY_HERMES_MODE", "")
            ).strip().lower() == "shadow"
            if shadow_mode:
                shadow_id = hashlib.sha256(
                    f"{chat_id}\n{content}".encode("utf-8")
                ).hexdigest()[:24]
                return SendResult(
                    success=True,
                    message_id=f"shadow-{shadow_id}",
                )
            return SendResult(
                success=False,
                error="DWS bridge did not return an explicit success receipt",
                retryable=not bool(
                    isinstance(result, dict) and result.get("outcomeUnknown") is True
                ),
            )
        message_id = str(result.get("messageId") or "").strip()
        if not message_id:
            return SendResult(
                success=False,
                error="DWS bridge success receipt did not include a message ID",
            )
        return SendResult(success=True, message_id=message_id)

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        del chat_id, metadata

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": str(chat_id), "type": "dm", "chat_id": str(chat_id)}
