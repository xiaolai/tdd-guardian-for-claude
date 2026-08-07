---
name: audit-coverage
description: |
  Dispatch the tdd-coverage-auditor agent to run the coverage command, compare against thresholds, and list uncovered branches with proposed tests.

  <example>
  user: /tdd-guardian:audit-coverage
  assistant: |
    Loading config, then dispatching the tdd-coverage-auditor. It runs every lane with `coverage: "include"`, merges their reports via the parse-coverage partial, compares the merged totals against `coverageThresholds`, lists uncovered code per file with the lane each gap belongs in, proposes concrete tests with assertion levels, and runs the coverage-ignore directive audit. Returns a PASS/FAIL verdict, flagging the merge as approximate if any lane emitted a summary-only format.
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

### Step 1b — Determine report scope

Parse `$ARGUMENTS`:

| Input | Scope |
|-------|-------|
| Empty (the normal case) | Whole project — the detail tables list every uncovered file |
| File path | Gate still evaluates whole-project totals; the detail tables list only lines in that file |
| Directory path | Same, filtered to files under that directory |
| Path that matches no file in the coverage report | Stop with: `No coverage data for {path}. It may be excluded from instrumentation, or the path may be wrong.` |

The scope hint never changes the verdict. Thresholds apply to the merged project totals, so a per-file audit cannot lower the bar for one file.

### Step 2 — Run the contributing lanes

Identify every lane with `coverage: "include"`. Run each via `commands/shared/run-lane.md` (setup → command → coverage report → teardown).

If no lane sets `coverage: "include"`, stop with:

```
No lane produces a coverage report.

Set coverage:"include" and coverageSummaryPath on the lane that emits coverage,
or set all coverageThresholds to 0. Run /tdd-guardian:init to reconfigure.
```

If a lane fails, stop with its phase, exit code, and output tail. The auditor cannot infer thresholds from a broken run — and an environment failure must never be presented as a coverage finding.

### Step 3 — Parse and merge

Follow `commands/shared/parse-coverage.md` to load each lane's `coverageSummaryPath`, normalize, and merge.

Record the merge method. When it is `weighted`, say so in the report and name the lane whose summary-only format forced the fallback — a weighted number quoted as a union is a wrong number stated confidently.

Reject a merge that measured zero lines: under the 0/0 convention it scores 100%, so a silent no-op run would otherwise pass every threshold.

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
**Lanes**: {names of contributing lanes}
**Merge**: {single | union | weighted}{" — APPROXIMATE" when weighted}
**Formats**: {formats read}
**Report**: `.claude/tdd-guardian/coverage-{timestamp}.md`

## Totals vs thresholds

| Metric     | Actual              | Threshold | Status |
|------------|---------------------|-----------|--------|
| Lines      | {n.nn}% ({c}/{t})   | {n}%      | PASS/FAIL/WARN (not measured) |
| Functions  | {n.nn}% ({c}/{t})   | {n}%      | PASS/FAIL/WARN |
| Branches   | {n.nn}% ({c}/{t})   | {n}%      | PASS/FAIL/WARN |
| Statements | {n.nn}% ({c}/{t})   | {n}%      | PASS/FAIL/WARN |

{When merge is "weighted": "Coverage was combined as a weighted average, not a
union, because {lane} emits {format}, which carries no per-line detail. Lines
covered by more than one lane are counted more than once. Emit LCOV or Cobertura
from that lane for an exact merge."}

{full auditor output follows}
```

## Contract

- Input: optional scope hint.
- Output: coverage report file + normalized summary in `state.json`.
- Side effects: runs the coverage command (may be slow). Writes two files under `.claude/tdd-guardian/`.
- Failure modes: coverage runner error → stop with runner message; null-valued metric + non-zero threshold → WARN not FAIL.
