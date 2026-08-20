"""Create low-risk, source-bound personal gbrain candidates through a host sidecar."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
from typing import Any

from tools.registry import tool_error, tool_result


_SCHEMA = {
    "type": "function",
    "function": {
        "name": "foursday_remember_project_fact",
        "description": (
            "Queue one durable low-risk project fact, future commitment, or source pointer "
            "for the owner's personal gbrain. Call only after verifying current registered-"
            "workspace files and computing their SHA-256 hashes. Never submit chat text, "
            "credentials, personal data, temporary status, guesses, or conflicting facts."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "type": {"type": "string", "enum": ["atom", "prospective", "source"]},
                "projectId": {"type": "string"},
                "factKey": {"type": "string"},
                "title": {"type": "string"},
                "statement": {"type": "string"},
                "sensitivity": {"type": "string", "enum": ["public", "internal"]},
                "confidence": {"type": "number", "minimum": 0.97, "maximum": 1},
                "evidence": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 8,
                    "items": {
                        "type": "object",
                        "properties": {
                            "relativePath": {"type": "string"},
                            "contentSha256": {"type": "string"},
                            "description": {"type": "string"},
                        },
                        "required": ["relativePath", "contentSha256", "description"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": [
                "type", "projectId", "factKey", "title", "statement",
                "sensitivity", "confidence", "evidence",
            ],
            "additionalProperties": False,
        },
    },
}


def _configured() -> bool:
    values = (
        os.getenv("FOURSDAY_NODE_PATH", ""),
        os.getenv("FOURSDAY_MEMORY_CANDIDATE_SIDECAR", ""),
        os.getenv("FOURSDAY_PRODUCTION_CONFIG", ""),
        os.getenv("FOURSDAY_PROJECT_REGISTRY", ""),
    )
    return all(value and os.path.isabs(value) for value in values)


def _handle(args: dict[str, Any], **kwargs: Any) -> str:
    if not _configured():
        return tool_error("Foursday personal gbrain candidate bridge is unavailable")
    node = Path(os.environ["FOURSDAY_NODE_PATH"]).resolve(strict=True)
    sidecar = Path(os.environ["FOURSDAY_MEMORY_CANDIDATE_SIDECAR"]).resolve(strict=True)
    config = Path(os.environ["FOURSDAY_PRODUCTION_CONFIG"]).resolve(strict=True)
    registry = Path(os.environ["FOURSDAY_PROJECT_REGISTRY"]).resolve(strict=True)
    session_id = str(kwargs.get("session_id") or kwargs.get("session_key") or "")
    if not session_id:
        return tool_error("Foursday memory candidates require a bound Hermes session")
    from project_router.runtime_context import current_routed_principal_id

    source_principal_id = current_routed_principal_id()
    if not source_principal_id:
        return tool_error("Foursday memory candidates require a bound requester identity")
    source_session_hash = hashlib.sha256(session_id.encode("utf-8")).hexdigest()
    payload = {
        **dict(args or {}),
        "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "sourceSessionHash": source_session_hash,
        # This host-only identity is never part of the tool schema or receipt.
        "sourcePrincipalId": source_principal_id,
    }
    environment = {
        "HOME": os.getenv("FOURSDAY_MEMORY_HOME", ""),
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "FOURSDAY_PRODUCTION_CONFIG": str(config),
        "FOURSDAY_PROJECT_REGISTRY": str(registry),
        "NO_COLOR": "1",
    }
    process = subprocess.run(
        [str(node), str(sidecar)],
        input=json.dumps(payload, ensure_ascii=False) + "\n",
        text=True,
        capture_output=True,
        env=environment,
        timeout=45,
        check=False,
    )
    frames = [line for line in process.stdout.splitlines() if line.strip()]
    if process.returncode != 0 or len(frames) != 1:
        return tool_error("Foursday personal gbrain candidate bridge failed")
    try:
        result = json.loads(frames[0])
    except json.JSONDecodeError:
        return tool_error("Foursday personal gbrain candidate bridge returned an invalid frame")
    if result.get("success") is not True:
        return tool_error("Foursday rejected this memory candidate")
    receipt = result.get("result") or {}
    return tool_result({
        "accepted": receipt.get("accepted") is True,
        "status": str(receipt.get("status") or "proposed"),
        "projectId": str(receipt.get("projectId") or ""),
        "automaticPromotionQueued": receipt.get("automaticPromotionQueued") is True,
        "personalWorktreeTouched": False,
    })


def register(ctx) -> None:
    ctx.register_tool(
        name="foursday_remember_project_fact",
        toolset="foursday_memory",
        schema=_SCHEMA,
        handler=_handle,
        check_fn=_configured,
        description=_SCHEMA["function"]["description"],
        emoji="🧠",
    )


__all__ = ["register"]
