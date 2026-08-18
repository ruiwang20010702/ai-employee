"""Run routed Foursday messages through Hermes without touching DingTalk delivery."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import re
import tempfile
from typing import Optional

from dws_personal.memory import NodeProjectMemoryProvider
from project_router.registry import ProjectRegistry


ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
SESSION_ID = re.compile(r"^session_id:\s*([A-Za-z0-9_-]+)\s*$")


def _absolute_file(value: str, label: str, executable: bool = False) -> str:
    path = Path(value).expanduser()
    if not path.is_absolute() or not path.is_file():
        raise ValueError(f"{label} must be an absolute regular file")
    if executable and not os.access(path, os.X_OK):
        raise ValueError(f"{label} must be executable")
    return str(path.resolve())


def _safe_environment(hermes_home: str, registry_path: str) -> dict[str, str]:
    allowed = {
        key: value
        for key, value in os.environ.items()
        if key in {
            "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "TMPDIR",
            "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY",
            "NO_PROXY", "CODEX_HOME",
        }
    }
    allowed["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    allowed["HERMES_HOME"] = hermes_home
    allowed["FOURSDAY_PROJECT_REGISTRY"] = registry_path
    return allowed


def _sandbox_profile(workspace: str, hermes_home: str) -> str:
    def quoted(value: str) -> str:
        return value.replace("\\", "\\\\").replace('"', '\\"')

    home = str(Path.home())
    protected = [
        str(Path(home, ".ssh")),
        str(Path(home, ".codex", "memories")),
        str(Path(home, "Library", "Keychains")),
        str(Path(__file__).resolve().parents[1] / ".runtime" / "production.json"),
        str(Path(__file__).resolve().parents[1] / ".runtime" / "keychain-migration-backups"),
        str(Path(__file__).resolve().parents[1] / ".runtime" / "config-backups"),
    ]
    rules = [
        "(version 1)",
        "(allow default)",
        f'(deny file-write* (subpath "{quoted(workspace)}"))',
        '(deny process-exec (literal "/usr/bin/security"))',
    ]
    for path in protected:
        if os.path.realpath(path) == os.path.realpath(hermes_home):
            continue
        rules.append(f'(deny file-read* (subpath "{quoted(path)}"))')
    return "\n".join(rules) + "\n"


def _prompt(route, memory_context: str, question: str, read_only: bool) -> str:
    mode = (
        "This is a read-only shadow run. Do not create, edit, delete, rename, or send anything."
        if read_only
        else "You may make reversible workspace changes, but must test and read back every change."
    )
    return "\n\n".join(filter(None, [
        """<foursday_operating_contract>
You are Foursday, a personal-memory-driven work twin using a general Agent Loop, not a business-metric template engine. Work inside the routed real project. Autonomously inspect project instructions, scripts, ledgers, reports, and Git state; use tools to calculate changing facts; distinguish source rows, formal production, release, review, and legacy history; cite audit-friendly file or command evidence; then answer in concise natural Chinese. Never invent a capability limitation merely because no predefined metric exists. Do not push, merge, deploy, modify production databases, make payments, sign contracts, make HR decisions, irreversibly delete data, or expose secrets.
Use the routed gbrain context as the memory source. Do not inspect Codex's own memory folder; it is not Foursday's knowledge authority. For changing operational facts, current workspace evidence remains authoritative.
</foursday_operating_contract>""",
        route.context,
        memory_context,
        mode,
        f"<user_message>\n{question}\n</user_message>",
    ]))


def _parse_output(output: str) -> tuple[Optional[str], str]:
    clean = ANSI.sub("", output).replace("\r", "")
    lines = clean.splitlines()
    session_id = None
    session_index = None
    for index, line in enumerate(lines):
        match = SESSION_ID.match(line.strip())
        if match:
            session_id = match.group(1)
            session_index = index
    response_lines = lines[session_index + 1:] if session_index is not None else lines
    response = "\n".join(line for line in response_lines if line.strip()).strip()
    return session_id, response


async def _run_turn(
    *,
    hermes_bin: str,
    hermes_home: str,
    workspace: str,
    prompt: str,
    session_id: Optional[str],
    read_only: bool,
    max_turns: int,
    timeout: int,
    registry_path: str,
) -> dict:
    command = [
        hermes_bin, "chat", "-q", prompt, "-Q",
        "--in", workspace,
        "--max-turns", str(max_turns),
        "--source", "foursday-shadow",
        "--toolsets", "terminal,web",
    ]
    if session_id:
        command.extend(["--resume", session_id, "--no-restore-cwd"])
    if not read_only:
        command.append("--checkpoints")
    environment = _safe_environment(hermes_home, registry_path)
    profile_path = None
    if read_only:
        profile = tempfile.NamedTemporaryFile("w", suffix=".sb", delete=False)
        profile.write(_sandbox_profile(workspace, hermes_home))
        profile.close()
        profile_path = profile.name
        command = ["/usr/bin/sandbox-exec", "-f", profile_path, *command]
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=environment,
        )
        try:
            stdout, _stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            raise RuntimeError("Hermes shadow turn timed out")
    finally:
        if profile_path:
            Path(profile_path).unlink(missing_ok=True)
    output = stdout.decode("utf-8", errors="replace")
    next_session_id, response = _parse_output(output)
    if process.returncode != 0 or not next_session_id or not response:
        raise RuntimeError("Hermes shadow turn failed")
    return {
        "sessionId": next_session_id,
        "response": response,
        "workspace": workspace,
        "readOnly": read_only,
    }


async def run(args) -> dict:
    hermes_bin = _absolute_file(args.hermes_bin, "Hermes executable", executable=True)
    hermes_home = str(Path(args.hermes_home).expanduser().resolve())
    if not Path(hermes_home).is_dir():
        raise ValueError("Hermes home must be an existing directory")
    registry = ProjectRegistry.load(
        args.registry,
        fallback_workspace=args.fallback_workspace,
        binding_path=args.route_state_file,
    )
    memory = None
    if args.memory_sidecar and args.production_config:
        memory = NodeProjectMemoryProvider(
            node_path=args.node_path,
            sidecar_path=args.memory_sidecar,
            config_path=args.production_config,
        )
    session_id = args.resume
    turns = []
    for question in args.question:
        route = registry.route(text=question, session_key=args.session_key)
        if route.project is None:
            turns.append({
                "status": route.status,
                "response": route.context,
                "workspace": route.workspace_path,
            })
            break
        memory_context = ""
        memory_status = "not_configured"
        if memory is not None:
            try:
                memory_context = await memory.context_for_route(route)
                memory_status = "available" if memory_context else "empty"
            except Exception:
                memory_status = "unavailable"
        result = await _run_turn(
            hermes_bin=hermes_bin,
            hermes_home=hermes_home,
            workspace=route.workspace_path,
            prompt=_prompt(route, memory_context, question, args.read_only),
            session_id=session_id,
            read_only=args.read_only,
            max_turns=args.max_turns,
            timeout=args.timeout,
            registry_path=str(Path(args.registry).expanduser().resolve()),
        )
        session_id = result["sessionId"]
        turns.append({
            "status": "completed",
            "projectId": route.project.id,
            "routeStatus": route.status,
            "memoryStatus": memory_status,
            **result,
        })
    return {
        "valid": all(turn.get("status") == "completed" for turn in turns),
        "delivery": "shadow_only",
        "turns": turns,
    }


def parser() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser()
    cli.add_argument("--registry", required=True)
    cli.add_argument("--fallback-workspace", required=True)
    cli.add_argument("--hermes-bin", required=True)
    cli.add_argument("--hermes-home", required=True)
    cli.add_argument("--node-path", default="/opt/homebrew/bin/node")
    cli.add_argument("--memory-sidecar")
    cli.add_argument("--production-config")
    cli.add_argument("--session-key", required=True)
    cli.add_argument("--route-state-file")
    cli.add_argument("--resume")
    cli.add_argument("--question", action="append", required=True)
    cli.add_argument("--max-turns", type=int, default=80)
    cli.add_argument("--timeout", type=int, default=600)
    cli.add_argument("--write", action="store_true")
    return cli


def main() -> None:
    args = parser().parse_args()
    args.read_only = not args.write
    if not 1 <= args.max_turns <= 500 or not 30 <= args.timeout <= 1800:
        raise SystemExit("invalid shadow-run limits")
    print(json.dumps(asyncio.run(run(args)), ensure_ascii=False))


if __name__ == "__main__":
    main()
