#!/usr/bin/env python3
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Tuple


DEFAULT_THRESHOLDS = {
    "lines": 100,
    "functions": 100,
    "branches": 100,
    "statements": 100,
}


def _read_payload() -> Dict:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except Exception:
        return {}


def _load_json(path: Path):
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def _write_json(path: Path, data: Dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n")


def _run_cmd(command: str, cwd: Path) -> Tuple[bool, str]:
    proc = subprocess.run(
        command,
        shell=True,
        cwd=str(cwd),
        text=True,
        capture_output=True,
    )
    output = (proc.stdout or "") + ("\n" + proc.stderr if proc.stderr else "")
    return proc.returncode == 0, output.strip()


def _extract_pct(total: Dict, key: str) -> float:
    data = total.get(key) or {}
    pct = data.get("pct")
    try:
        return float(pct)
    except Exception:
        return -1.0


def _check_coverage(config: Dict, cwd: Path) -> Tuple[bool, str]:
    summary_path = Path(str(config.get("coverageSummaryPath", "coverage/coverage-summary.json")))
    if not summary_path.is_absolute():
        summary_path = cwd / summary_path

    summary = _load_json(summary_path)
    if not isinstance(summary, dict):
        return False, f"Coverage summary not found or invalid: {summary_path}"

    total = summary.get("total") or {}
    thresholds = DEFAULT_THRESHOLDS.copy()
    thresholds.update(config.get("coverageThresholds") or {})

    failures: List[str] = []
    checks = {}
    for key, threshold in thresholds.items():
        actual = _extract_pct(total, key)
        checks[key] = actual
        if actual < float(threshold):
            failures.append(f"{key}: {actual:.2f}% < {float(threshold):.2f}%")

    if failures:
        return False, "Coverage gate failed: " + "; ".join(failures)

    return True, "Coverage gate passed: " + ", ".join(
        [f"{k}={v:.2f}%" for k, v in checks.items()]
    )


def _block(reason: str, context: str):
    output = {
        "decision": "block",
        "reason": reason,
        "hookSpecificOutput": {
            "hookEventName": "TaskCompleted",
            "additionalContext": context,
        },
    }
    print(json.dumps(output))


def main() -> int:
    payload = _read_payload()
    cwd = Path(payload.get("cwd") or os.getcwd())
    config_path = cwd / ".claude" / "tdd-guardian" / "config.json"
    state_path = cwd / ".claude" / "tdd-guardian" / "state.json"

    config = _load_json(config_path) or {}
    if not config.get("enabled", False):
        return 0
    if not config.get("enforceOnTaskCompleted", True):
        return 0

    bypass_env = str(config.get("bypassEnv", "TDD_GUARD_BYPASS"))
    if os.getenv(bypass_env, "").lower() in {"1", "true", "yes"}:
        _write_json(
            state_path,
            {
                "last_gate_passed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "last_result": "bypassed",
            },
        )
        return 0

    execution_log: List[str] = []

    preflight = str(config.get("preflightCommand", "")).strip()
    if preflight:
        ok, out = _run_cmd(preflight, cwd)
        execution_log.append(f"$ {preflight}\n{out}")
        if not ok:
            _block("Preflight command failed", "\n\n".join(execution_log)[-8000:])
            return 0

    for key in ["testCommand", "coverageCommand"]:
        command = str(config.get(key, "")).strip()
        if not command:
            _block(
                f"Missing required setting: {key}",
                "Run /tdd-guardian-for-claude:init and provide project commands.",
            )
            return 0
        ok, out = _run_cmd(command, cwd)
        execution_log.append(f"$ {command}\n{out}")
        if not ok:
            _block(f"{key} failed", "\n\n".join(execution_log)[-8000:])
            return 0

    coverage_ok, coverage_msg = _check_coverage(config, cwd)
    execution_log.append(coverage_msg)
    if not coverage_ok:
        _block("Coverage gate failed", "\n\n".join(execution_log)[-8000:])
        return 0

    require_mutation = bool(config.get("requireMutation", False))
    mutation_command = str(config.get("mutationCommand", "")).strip()
    if require_mutation:
        if not mutation_command:
            _block(
                "Mutation gate enabled but mutationCommand is missing",
                "Set mutationCommand in .claude/tdd-guardian/config.json",
            )
            return 0
        ok, out = _run_cmd(mutation_command, cwd)
        execution_log.append(f"$ {mutation_command}\n{out}")
        if not ok:
            _block("Mutation gate failed", "\n\n".join(execution_log)[-8000:])
            return 0

    _write_json(
        state_path,
        {
            "last_gate_passed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "last_result": "passed",
            "require_mutation": require_mutation,
            "coverage_summary_path": str(config.get("coverageSummaryPath", "coverage/coverage-summary.json")),
        },
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
