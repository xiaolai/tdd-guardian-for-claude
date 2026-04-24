---
description: "Shared: execute the configured test command, distinguish runner failure from test failure"
user-invocable: false
---
<!-- Shared partial: test execution wrapper -->
<!-- Referenced by: tdd-guardian-implement, tdd-guardian-audit-coverage, tdd-guardian-workflow. Do not use standalone. -->

## Purpose

Run the project's test command via the Bash tool, capture exit code + output, and classify the outcome. Calling commands depend on this distinction — a crashed runner is not the same as a failing test.

## Steps

### Step 1 — Optional preflight

If the loaded config has a non-empty `preflightCommand`, run it first via Bash. If it fails (non-zero exit), stop with:

```
Preflight failed: `{preflightCommand}`
Exit code: {code}
stderr (last 40 lines):
{tail}

Fix the preflight (dependencies missing? lockfile out of date?) and rerun.
```

Do NOT proceed to the test command.

### Step 2 — Run the test command

Invoke `{testCommand}` via Bash from the workspace root. Always capture BOTH stdout and stderr. Set a 600000 ms (10 min) timeout. Do not run in background — calling commands need the result synchronously.

### Step 3 — Classify the exit code

| Exit code | Classification | Action |
|-----------|----------------|--------|
| `0` | PASS | Return `{status: "pass", output}` |
| `1` | Test failures | Return `{status: "fail", output}` |
| `2` | Ambiguous (some runners use this for "no tests found") | Inspect output — if stderr mentions "no tests", return `{status: "no-tests"}`; else `{status: "fail"}` |
| `126` / `127` | Runner not executable / not found | Return `{status: "runner-missing", output}` |
| `130` | Interrupted (SIGINT) | Return `{status: "interrupted"}` |
| `137` / `143` | Killed (OOM / SIGTERM) | Return `{status: "killed", output}` |
| any other non-zero | Unknown runner failure | Return `{status: "runner-error", output}` |

### Step 4 — Distinguish runner failure from failing tests

A runner failure (missing binary, syntax error in test file, out-of-memory) is NOT a failing test. The calling command MUST surface this distinction:

- **Test failures (`fail`)**: the implementer agent can fix these by changing code or tests.
- **Runner failures (`runner-missing`, `runner-error`, `killed`)**: the environment is broken. Do not dispatch any fix-it agent. Surface the error to the user and stop.

Grep heuristics to detect runner failures even when exit code is `1`:
- `Cannot find module` / `ModuleNotFoundError` → runner-error (missing dep)
- `SyntaxError` / `TSError` / `parse error` in STDERR before any test output → runner-error
- `Out of memory` / `JavaScript heap out of memory` → killed
- Empty stdout + stderr containing usage info → runner-missing

If any of these match, upgrade the classification to the matching runner-error class even when exit code is 1.

### Step 5 — Parse test counts when possible

Attempt to extract test counts from known runner output formats:

- Vitest: `Tests  N passed | M failed (K)`
- Jest: `Tests:       N failed, M passed, K total`
- Pytest: `= N failed, M passed in ...s =`
- Go: count lines starting with `--- FAIL:` / `--- PASS:`
- Rust: `test result: ok. N passed; M failed`

If a count cannot be parsed, return `testCounts: null` — do NOT fabricate numbers.

### Step 6 — Return

Return to the caller:

```
{
  status: "pass" | "fail" | "no-tests" | "runner-missing" | "runner-error" | "killed" | "interrupted",
  exitCode: number,
  durationMs: number,
  testCounts: { passed, failed, skipped, total } | null,
  stdoutTail: "<last 80 lines>",
  stderrTail: "<last 40 lines>"
}
```

The caller decides how to render this. This partial does NOT produce user-facing output on its own.
