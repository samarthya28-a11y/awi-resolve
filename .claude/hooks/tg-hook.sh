#!/usr/bin/env bash
# Token Governor — Claude Code hook (macOS / Linux)
set -euo pipefail
python3 - "$@" <<'PY'
import json, os, re, sys
from datetime import datetime, timezone
from pathlib import Path

raw = sys.stdin.read()
if not raw.strip():
    sys.exit(0)
try:
    evt = json.loads(raw)
except json.JSONDecodeError:
    sys.exit(0)

def emit(obj, code=0):
    sys.stdout.write(json.dumps(obj))
    sys.exit(code)

event = evt.get("hook_event_name") or ""
cwd = evt.get("cwd") or os.getcwd()
session = evt.get("session_id") or ""
cfg = {}
cfg_path = Path(cwd) / ".claude" / "token-governor.json"
if cfg_path.exists():
    try:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    except Exception:
        cfg = {}
if cfg.get("enabled") is False:
    sys.exit(0)
max_turns = int(cfg.get("maxTurns") or 8)
block_dumps = bool(cfg.get("blockDumps", True))
max_read = int(cfg.get("maxReadBytes") or 80000)

def count_turns(path):
    p = Path(path or "")
    if not p.exists():
        return 0
    n = 0
    try:
        for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
            if re.search(r'"type"\s*:\s*"user"', line):
                n += 1
    except Exception:
        return 0
    return n

def write_control(turns, event_name, reason):
    root = Path(os.environ.get("HOME", "")) / ".token-governor"
    if os.name == "nt":
        root = Path(os.environ.get("LOCALAPPDATA", "")) / "TokenGovernor"
    root.mkdir(parents=True, exist_ok=True)
    path = root / "control.json"
    doc = {"projects": {}}
    if path.exists():
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    projects = doc.get("projects") or {}
    row = {
        "path": cwd,
        "sessionId": session,
        "turns": turns,
        "event": event_name,
        "reason": reason,
        "at": datetime.now(timezone.utc).isoformat(),
    }
    projects[cwd] = row
    path.write_text(json.dumps({"updated": row["at"], "projects": projects}, indent=2), encoding="utf-8")

if event == "SessionStart":
    write_control(0, "session", "Claude Code started in a protected folder.")
    emit({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": (
                "Token Governor is active in this folder. Read .ai/HANDOFF.md and .ai/SESSION.md "
                f"before exploring. Search, then read a slice. Do not dump the repository. After {max_turns} "
                "user turns this chat is blocked until a handoff, then start a new chat."
            ),
        }
    })

if event == "UserPromptSubmit":
    prompt = evt.get("prompt") or ""
    turns = count_turns(evt.get("transcript_path")) + 1
    handoff = bool(re.search(r"\b(handoff|compact|new chat|HANDOFF\.md|SESSION\.md)\b", prompt, re.I))
    if turns >= max_turns and not handoff:
        reason = (
            f"Token Governor blocked this message. This Claude Code chat is at turn {turns} "
            f"(limit {max_turns}). Ask Claude to write .ai/HANDOFF.md, then start a NEW chat in this folder."
        )
        write_control(turns, "blocked", reason)
        emit({"decision": "block", "reason": reason})
    note = f"Token Governor: turn {turns} of {max_turns} in this chat."
    if handoff:
        note = "Token Governor: write .ai/HANDOFF.md, refresh .ai/SESSION.md, then stop. Start a new chat after."
    elif turns >= max_turns - 2:
        note = f"Token Governor: turn {turns} of {max_turns}. Next, write a handoff and start a new chat."
    write_control(turns, "allowed", note)
    emit({
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": note,
        }
    })

if event == "PreToolUse" and block_dumps:
    tool = evt.get("tool_name") or ""
    tin = evt.get("tool_input") or {}
    why = None
    if tool == "Read":
        fp = tin.get("file_path") or ""
        has_limit = tin.get("limit") is not None
        if fp and Path(fp).exists():
            try:
                length = Path(fp).stat().st_size
                if length > max_read and not has_limit:
                    why = f"Token Governor blocked a full-file read ({length} bytes). Read a line range."
            except OSError:
                pass
    if tool == "Glob":
        pat = tin.get("pattern") or ""
        if re.match(r"^(\*\*|\*\*/\*$|\*)$", pat):
            why = "Token Governor blocked a whole-tree glob. Use a narrower pattern."
    if tool == "Bash":
        cmd = tin.get("command") or ""
        if re.search(r"ls\s+-R|find\s+\.\s+|cat\s+\*|tree\s", cmd):
            why = "Token Governor blocked a recursive dump command. Search, then read a slice."
    if why:
        write_control(0, "dump-blocked", why)
        emit({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": why,
            }
        })

sys.exit(0)
PY
