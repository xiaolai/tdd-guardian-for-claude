#!/usr/bin/env python3
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

BLOCK_PATTERNS = [
    re.compile(r"\\bgit\\s+commit\\b"),
    re.compile(r"\\bgit\\s+push\\b"),
    re.compile(r"\\bgh\\s+pr\\s+(create|merge)\\b"),
    re.compile(r"\\b(npm|pnpm|yarn)\\s+publish\\b"),
]


def _load_json(path: Path):
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def _deny(reason: str):
    output = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }
    print(json.dumps(output))


def _is_gate_fresh(state: dict, freshness_minutes: int) -> bool:
    stamp = state.get("last_gate_passed_at")
    if not stamp:
        return False
    try:
        ts = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except Exception:
        return False
    now = datetime.now(timezone.utc)
    age_minutes = (now - ts).total_seconds() / 60
    return age_minutes <= freshness_minutes


def main():
    raw = sys.stdin.read().strip()
    if not raw:
        return 0

    try:
        payload = json.loads(raw)
    except Exception:
        return 0

    if payload.get("tool_name") != "Bash":
        return 0

    tool_input = payload.get("tool_input") or {}
    command = str(tool_input.get("command") or "").strip()
    if not command:
        return 0

    if not any(p.search(command) for p in BLOCK_PATTERNS):
        return 0

    cwd = Path(payload.get("cwd") or os.getcwd())
    config_path = cwd / ".claude" / "tdd-guardian" / "config.json"
    state_path = cwd / ".claude" / "tdd-guardian" / "state.json"

    config = _load_json(config_path) or {}
    if not config.get("enabled", False):
        _deny("TDD Guardian is not enabled. Run /tdd-guardian-for-claude:init first.")
        return 0

    bypass_env = str(config.get("bypassEnv", "TDD_GUARD_BYPASS"))
    if os.getenv(bypass_env, "").lower() in {"1", "true", "yes"}:
        return 0

    if not config.get("blockCommitWithoutFreshGate", True):
        return 0

    state = _load_json(state_path) or {}
    freshness_minutes = int(config.get("gateFreshnessMinutes", 120))
    if not _is_gate_fresh(state, freshness_minutes):
        _deny(
            "Blocked by TDD Guardian: quality gates are stale or missing. "
            "Run your gate commands (tests, coverage, mutation if enabled), then retry."
        )
        return 0

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
