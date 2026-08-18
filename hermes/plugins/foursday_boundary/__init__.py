"""Small hard boundary around irreversible or externally committing actions."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
from typing import Any, Optional


_DELETE_TOOLS = {
    "delete_file", "remove_file", "delete_directory", "remove_directory",
}

_COMMAND_RULES = (
    ("git_push", re.compile(r"(?:^|[;&|]\s*)git\s+(?:-[^\s]+\s+)*push(?:\s|$)", re.I)),
    ("github_merge_or_release", re.compile(r"\bgh\s+(?:pr\s+merge|release\s+(?:create|delete))\b", re.I)),
    ("package_publish", re.compile(r"\b(?:npm|pnpm|yarn)\s+(?:npm\s+)?publish\b", re.I)),
    ("production_deploy", re.compile(
        r"\b(?:kubectl\s+(?:apply|delete)|helm\s+(?:install|upgrade|uninstall)|terraform\s+(?:apply|destroy))\b"
        r"|\brelease:local\b[^\n]*\s--apply\b"
        r"|\b(?:production|deploy)[^\n]{0,80}\s--apply\b",
        re.I,
    )),
    ("irreversible_delete", re.compile(
        r"(?:^|[;&|]\s*)(?:sudo\s+)?(?:rm\s+-(?:[^\s]*r[^\s]*f|[^\s]*f[^\s]*r)\b|shred\b|diskutil\s+erase)",
        re.I,
    )),
    ("production_database_write", re.compile(
        r"\bpsql\b[^\n]*(?:\b(?:DROP|TRUNCATE|ALTER|DELETE|UPDATE|INSERT)\b|--file\b)"
        r"|\b(?:DROP|TRUNCATE)\s+(?:DATABASE|SCHEMA|TABLE)\b",
        re.I,
    )),
    ("secret_access", re.compile(
        r"\bsecurity\s+find-generic-password\b|\b(?:cat|sed|awk|rg|grep)\b[^\n]*(?:\.env\b|auth\.json\b|production\.json\b|Library/Keychains|/\.ssh/)",
        re.I,
    )),
    ("financial_or_people_commitment", re.compile(
        r"\b(?:stripe|paypal)\b[^\n]*(?:pay|charge|refund|transfer)"
        r"|\b(?:sign|execute)\b[^\n]*(?:contract|agreement)"
        r"|\b(?:hire|fire|terminate)\b[^\n]*(?:employee|staff)",
        re.I,
    )),
    ("system_control", re.compile(
        r"(?:^|[;&|]\s*)(?:sudo\b|launchctl\b|osascript\b|killall\b|pkill\b|shutdown\b|reboot\b|defaults\s+write\b)",
        re.I,
    )),
)

_COMMAND_TOOLS = {"exec_command", "terminal", "shell", "bash"}
_READ_FILE_TOOLS = {"read_file", "open_file", "list_directory", "search_files"}
_WRITE_FILE_TOOLS = {"write_file", "edit_file", "apply_patch", "create_file"}
_WEB_TOOLS = {"web", "web_search", "search_web", "fetch_url", "browser"}
_SECRET_MATERIAL = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----"
    r"|\b(?:password|passwd|secret|api[_ -]?key|access[_ -]?token|bearer)\s*[:=]\s*\S+"
    r"|\b(?:ghp|github_pat|sk-[A-Za-z0-9_-]{10,}|AKIA)[A-Za-z0-9_-]+"
    r"|\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?)://[^\s]+",
    re.I,
)
_PROJECT_CACHE: tuple[str, int, tuple[dict[str, str], ...]] | None = None
_PROTECTED_WORKSPACE_NAMES = {".runtime", ".env"}


def _text_args(args: Any) -> str:
    if isinstance(args, str):
        return args
    if not isinstance(args, dict):
        return ""
    values = []
    for key in ("command", "cmd", "script", "query", "path", "url"):
        value = args.get(key)
        if isinstance(value, str):
            values.append(value)
    return "\n".join(values) or json.dumps(args, ensure_ascii=False, default=str)


def classify_high_risk(tool_name: str, args: Any) -> Optional[str]:
    normalized_tool = str(tool_name or "").strip().lower()
    if normalized_tool in _DELETE_TOOLS:
        return "irreversible_delete"
    text = _text_args(args)
    for name, pattern in _COMMAND_RULES:
        if pattern.search(text):
            return name
    return None


def _projects() -> tuple[dict[str, str], ...]:
    global _PROJECT_CACHE
    path = os.getenv("FOURSDAY_PROJECT_REGISTRY", "").strip()
    if not path:
        return ()
    lexical = Path(path).expanduser()
    if not lexical.is_absolute():
        raise RuntimeError("Foursday project registry must be absolute")
    metadata = lexical.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o022:
        raise RuntimeError("Foursday project registry must be a protected regular file")
    canonical = str(lexical.resolve(strict=True))
    if canonical != str(lexical):
        raise RuntimeError("Foursday project registry must not use a symlink")
    if _PROJECT_CACHE and _PROJECT_CACHE[:2] == (canonical, metadata.st_mtime_ns):
        return _PROJECT_CACHE[2]
    document = json.loads(lexical.read_text(encoding="utf-8"))
    rows = []
    for raw in document.get("projects", []):
        root = Path(str(raw.get("root") or ""))
        isolation = str(raw.get("isolation") or "workspace-write")
        if not root.is_absolute() or isolation not in {"read-only", "workspace-write"}:
            raise RuntimeError("Foursday project isolation is invalid")
        canonical_root = str(root.resolve(strict=True))
        if canonical_root != str(root) or not root.is_dir():
            raise RuntimeError("Foursday project root must be a canonical directory")
        rows.append({"root": canonical_root, "isolation": isolation})
    _PROJECT_CACHE = (canonical, metadata.st_mtime_ns, tuple(rows))
    return _PROJECT_CACHE[2]


def _project_for_path(value: str) -> Optional[dict[str, str]]:
    if not value:
        return None
    path = Path(value).expanduser()
    if not path.is_absolute():
        return None
    try:
        canonical = str(path.resolve(strict=True))
    except OSError:
        return None
    matches = [project for project in _projects() if (
        canonical == project["root"] or canonical.startswith(project["root"] + os.sep)
    )]
    if not matches:
        return None
    return max(matches, key=lambda project: len(project["root"]))


def _profile_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _sandbox_profile(project: dict[str, str]) -> str:
    root = _profile_escape(project["root"])
    read_roots = [
        "/System", "/usr", "/bin", "/sbin", "/Library",
        "/opt/homebrew", "/private/etc", "/private/var/db", "/dev",
        project["root"],
    ]
    rules = [
        "(version 1)",
        "(deny default)",
        '(import "system.sb")',
        "(allow process*)",
        "(allow sysctl-read)",
        "(allow mach-lookup)",
        "(allow ipc-posix*)",
    ]
    rules.extend(
        f'(allow file-read* (subpath "{_profile_escape(path)}"))'
        for path in read_roots
    )
    for path in ["/private/tmp", "/var/folders", "/dev"]:
        rules.append(f'(allow file-write* (subpath "{_profile_escape(path)}"))')
    if project["isolation"] == "workspace-write":
        rules.append(f'(allow file-write* (subpath "{root}"))')
    for name in _PROTECTED_WORKSPACE_NAMES:
        protected = _profile_escape(str(Path(project["root"]) / name))
        rules.append(f'(deny file-read* (subpath "{protected}"))')
        rules.append(f'(deny file-write* (subpath "{protected}"))')
    rules.append("(deny network*)")
    rules.append('(deny process-exec (literal "/usr/bin/security"))')
    return "\n".join(rules) + "\n"


def _profile_path(project: dict[str, str]) -> str:
    home = Path(os.getenv("HERMES_HOME") or Path.home() / ".hermes").resolve()
    directory = home / "plugin-data" / "foursday-high-risk-boundary" / "sandbox"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(directory, 0o700)
    content = _sandbox_profile(project)
    digest = hashlib.sha256(content.encode()).hexdigest()[:20]
    target = directory / f"{digest}.sb"
    if not target.exists():
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
    if not stat.S_ISREG(target.lstat().st_mode) or target.stat().st_mode & 0o077:
        raise RuntimeError("Foursday sandbox profile is not private")
    return str(target)


def _sandbox_tool_call(tool_name: str, args: Any):
    normalized = str(tool_name or "").strip().lower()
    if not isinstance(args, dict) or not _projects():
        return None
    if normalized in _COMMAND_TOOLS:
        command = args.get("command") or args.get("cmd")
        cwd = str(args.get("cwd") or "")
        project = _project_for_path(cwd)
        if not isinstance(command, str) or not project:
            return {
                "action": "block",
                "message": "Foursday blocked a command outside a registered project workspace.",
            }
        profile = _profile_path(project)
        rewritten = dict(args)
        rewritten["command" if "command" in args else "cmd"] = (
            f"/usr/bin/sandbox-exec -f {shlex.quote(profile)} "
            f"/bin/zsh -lc {shlex.quote(command)}"
        )
        return {"action": "modify", "args": rewritten}
    if normalized in _READ_FILE_TOOLS | _WRITE_FILE_TOOLS:
        path = str(args.get("path") or "")
        project = _project_for_path(path)
        if not project:
            return {
                "action": "block",
                "message": "Foursday blocked file access outside a registered project workspace.",
            }
        relative = Path(path).resolve(strict=False).relative_to(Path(project["root"]))
        if relative.parts and relative.parts[0] in _PROTECTED_WORKSPACE_NAMES:
            return {
                "action": "block",
                "message": "Foursday blocked access to protected runtime material inside the workspace.",
            }
        if normalized in _WRITE_FILE_TOOLS and project["isolation"] == "read-only":
            return {
                "action": "block",
                "message": "Foursday blocked a write in a read-only project workspace.",
            }
    if normalized in _WEB_TOOLS and _SECRET_MATERIAL.search(_text_args(args)):
        return {
            "action": "block",
            "message": "Foursday blocked credential-like material from leaving through a web tool.",
        }
    return None


def on_pre_tool_call(tool_name: str = "", args: Any = None, **_: Any):
    boundary = classify_high_risk(tool_name, args)
    if boundary:
        return {
            "action": "block",
            "message": (
                f"Foursday blocked this high-risk action ({boundary}). "
                "Prepare the reversible work and evidence, then ask the owner for explicit authorization."
            ),
        }
    try:
        return _sandbox_tool_call(tool_name, args)
    except Exception:
        return {
            "action": "block",
            "message": "Foursday could not establish the project boundary, so the tool call was blocked.",
        }


def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", on_pre_tool_call)


__all__ = [
    "classify_high_risk", "on_pre_tool_call", "register",
    "_sandbox_profile", "_sandbox_tool_call",
]
