---
name: tdd-guardian-audit-coverage
description: |
  Dispatch the tdd-coverage-auditor agent to run the coverage command, compare against thresholds, and list uncovered branches with proposed tests.

  <example>
  user: /tdd-guardian:audit-coverage
  assistant: |
    Loading config, then dispatching the tdd-coverage-auditor. It runs `coverageCommand`, parses the summary via the parse-coverage partial, compares against `coverageThresholds`, lists uncovered code per file, proposes concrete tests with assertion levels, and runs the coverage-ignore directive audit. Returns a PASS/FAIL verdict.
  </example>

  <example>
  user: /tdd-guardian:audit-coverage src/queue.ts
  assistant: |
    Treating `src/queue.ts` as a scope hint — I will run the coverage command as configured, then filter the auditor's focus to lines in that path. The gate still evaluates the whole-project totals against thresholds; the detail report concentrates on the requested file.
  </example>
argument-hint: "[optional file or directory to focus the report on]"
allowed-tools: Read, Bash, Glob, Grep, Task
model: inherit
---

Dispatch the `tdd-coverage-auditor` agent.

## Steps

### Step 1 — Load config

Follow `commands/shared/load-config.md`. Stop on missing/disabled.

### Step 2 — Run coverage

Invoke the `Bash` tool with `{coverageCommand}`. Capture exit code + output tail. Timeout 900000 ms (coverage runs can be slow).

If the coverage command fails (non-zero exit), stop with:

```
Coverage command failed: `{coverageCommand}`
Exit code: {code}
stderr (last 40 lines):
{tail}

Fix the runner before auditing coverage — the auditor cannot infer thresholds from a broken run.
```

### Step 3 — Parse summary

Follow `commands/shared/parse-coverage.md` to load `{coverageSummaryPath}` and normalize to the standard shape.

### Step 4 — Dispatch the auditor

Use the `Task` tool to invoke `tdd-coverage-auditor` with:
- The parsed totals + per-file data.
- The configured thresholds.
- The optional scope hint from `$ARGUMENTS`.
- A directive: "Use the `tdd-guardian:coverage-gate` skill. Compare totals against thresholds per `coverageMode`. List uncovered branches and functions. Propose concrete tests with assertion levels from `tdd-guardian:policy-core`. Run the coverage-ignore directive audit — flag any `/* v8 ignore next */` or `/* v8 ignore next N */`."

### Step 5 — Persist result

Write the auditor's report to `.claude/tdd-guardian/coverage-{YYYYMMDD-HHMMSS}.md` and update `.claude/tdd-guardian/state.json`:

```json
{
  "lastCoverageRun": {
    "timestamp": "<ISO>",
    "status": "PASS" | "FAIL",
    "totals": { "lines": N, "functions": N, "branches": N, "statements": N },
    "reportPath": ".claude/tdd-guardian/coverage-{ts}.md"
  }
}
```

## Output format

```markdown
# Coverage Audit — {PASS | FAIL}

**Timestamp**: {ISO}
**Command**: `{coverageCommand}`
**Report**: `.claude/tdd-guardian/coverage-{timestamp}.md`

## Totals vs thresholds

| Metric     | Actual  | Threshold | Status |
|------------|---------|-----------|--------|
| Lines      | {n.nn}% | {n}%      | PASS/FAIL/WARN (not measured) |
| Functions  | {n.nn}% | {n}%      | PASS/FAIL/WARN |
| Branches   | {n.nn}% | {n}%      | PASS/FAIL/WARN |
| Statements | {n.nn}% | {n}%      | PASS/FAIL/WARN |

{full auditor output follows}
```

## Contract

- Input: optional scope hint.
- Output: coverage report file + normalized summary in `state.json`.
- Side effects: runs the coverage command (may be slow). Writes two files under `.claude/tdd-guardian/`.
- Failure modes: coverage runner error → stop with runner message; null-valued metric + non-zero threshold → WARN not FAIL.
