---
description: "Shared: execute one lane (setup, command, coverage report, teardown) and classify the outcome, distinguishing runner failure from test failure"
user-invocable: false
---
<!-- Shared partial: lane execution wrapper -->
<!-- Referenced by: implement, audit-coverage, gate, workflow. Do not use standalone. -->

## Purpose

Run one lane and classify the result. Callers depend on one distinction above all others: **a crashed runner is not a failing test**. A fix-it agent can act on the second and will waste a cycle on the first.

The same logic is implemented in `scripts/tdd-guardian/lib/lanes.js` (`runLane`) and `lib/exec.js` (`run`, `classify`). Prefer running it over re-implementing:

```bash
node -e "
const {load}=require('<plugin-root>/scripts/tdd-guardian/lib/config.js');
const {runLane,describeResult}=require('<plugin-root>/scripts/tdd-guardian/lib/lanes.js');
const {config}=load(process.cwd());
const lane=config.lanes.find(l=>l.name==='<lane>');
console.log(JSON.stringify(runLane(lane,process.cwd()),null,2));
"
```

## Steps

### Step 1 — Optional preflight (once per gate run, not per lane)

If the config has a non-empty `preflightCommand`, run it before any lane. On failure:

```
Preflight failed: `{preflightCommand}`
Exit code: {code}
stderr (last 40 lines):
{tail}

Fix the preflight (missing dependencies? stale lockfile?) and rerun.
```

Do NOT proceed to any lane.

### Step 2 — Lane setup

If the lane has a `setupCommand`, run it first with a 300s timeout. A setup failure is reported with `phase: "setup"` and is never presented as a test failure — the tests did not run.

Once setup has run, `teardownCommand` MUST run at the end regardless of outcome. A red lane that leaks containers costs the next run too.

### Step 3 — Run the lane command

Invoke `{command}` from the workspace root, capturing both stdout and stderr, with the lane's `timeoutMs` (default 600000). Do not run in background — the caller needs the result synchronously.

### Step 4 — Classify the exit code

| Exit code | Classification | Action |
|-----------|----------------|--------|
| `0` | `pass` | Continue |
| `1` | `fail` | Test failures — actionable |
| `2` | Ambiguous | Output mentions "no tests" → `no-tests`; else `fail` |
| `126` / `127` | `runner-missing` | Runner not executable or not found |
| `130` | `interrupted` | SIGINT |
| `137` / `143` | `killed` | OOM or SIGTERM |
| any other non-zero | `runner-error` | Unknown runner failure |
| (timeout elapsed) | `timeout` | Lane exceeded `timeoutMs` |

### Step 5 — Upgrade misleading exit codes

Many runners exit 1 on a broken environment. Apply these to stderr (and stdout) and upgrade the classification even when the exit code is 1:

- `Cannot find module` / `ModuleNotFoundError` / `could not find` → `runner-error`
- `SyntaxError` / `TSError` / `parse error` / `compilation failed`, **and no test output present** → `runner-error`
- `heap out of memory` / `OutOfMemoryError` → `killed`
- `command not found` / `No such file or directory` → `runner-missing`
- Empty stdout and empty stderr → `runner-missing`

The "and no test output present" qualifier matters: a suite that asserts a `SyntaxError` is thrown legitimately prints that word while passing.

### Step 6 — A zero-test run is a failure

If the runner exits 0 but discovered nothing (`collected 0 items`, `no test files found`, `[no test files]`, `Test suites: 0 total`), classify as `no-tests` and FAIL the lane.

Green with nothing run is indistinguishable from green with everything run. Every gate in this plugin refuses the ambiguity.

**Bootstrap exception, applied by the caller, not here.** This partial always reports `no-tests`. Whether that blocks depends on `ever_had_tests` in `.claude/tdd-guardian/state.json`:

| `ever_had_tests` | Meaning | Gate |
|------------------|---------|------|
| `false` | Greenfield — the lane has never had a test | Report loudly, do not block |
| `true` | Regression — tests were deleted, or discovery broke | Block |

The ratchet is one-way. Diagnose the two differently: telling a brand-new project that its discovery glob is wrong sends the user hunting a bug that does not exist.

### Step 7 — Coverage (lanes with `coverage: "include"`)

1. If `coverageReportCommand` is set, run it now. A failure is `phase: "coverage-report"`.
2. Read `coverageSummaryPath` and parse it per `commands/shared/parse-coverage.md`.
3. A missing or unparseable report fails the lane with status `coverage-missing` — never treat it as zero coverage, and never skip the check.

### Step 8 — Teardown

Run `teardownCommand` if setup ran. A failing teardown produces a **warning** attached to the result; it never changes the lane's verdict. Masking a green lane because cleanup failed, or a red one because it succeeded, both misreport the thing the caller asked about.

### Step 9 — Parse test counts when possible

Attempt extraction from known runner formats (Vitest, Jest, pytest, cargo, Surefire, `dotnet test`, go, ExUnit, RSpec). If no count can be parsed, return `testCounts: null` — **do NOT fabricate numbers.**

### Step 10 — Return

```
{
  name: string,
  ok: boolean,
  status: "pass" | "fail" | "no-tests" | "runner-missing" | "runner-error" | "killed" | "timeout" | "interrupted" | "coverage-missing",
  phase: "setup" | "command" | "coverage-report" | null,
  exitCode: number | null,
  durationMs: number,
  testCounts: { passed, failed, skipped, total } | null,
  stdoutTail: "<last 80 lines>",
  stderrTail: "<last 40 lines>",
  coverageReport: <normalized report> | null,
  coverageError: string | null,
  teardownWarning: string | null
}
```

## How callers must treat each status

| Status | Caller action |
|--------|---------------|
| `pass` | Continue |
| `fail` | Actionable — dispatch a fix, or report the failing tests |
| `no-tests` | Stop. Test discovery is misconfigured; adding code will not help |
| `coverage-missing` | Stop. The coverage command or path is wrong |
| `runner-missing` / `runner-error` / `killed` / `timeout` | Stop. The environment is broken. **Do NOT dispatch a fix-it agent** — it will edit correct code to chase a broken runner |
| `interrupted` | Stop silently; the user cancelled |

This partial produces no user-facing output on its own. The caller decides how to render it.
