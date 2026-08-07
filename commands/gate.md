---
name: gate
description: |
  Run the lanes bound to a trigger (commit, push, taskCompleted, manual) or a named lane, then evaluate the coverage and mutation gates and refresh gate state. This is how you make a stale gate fresh before committing or pushing.

  <example>
  user: /tdd-guardian:gate push
  assistant: |
    Resolving which lanes gate a push — every lane with `commit` or `push` in `gateOn`, since push subsumes commit. I run each in order (setup, command, coverage report, teardown), merge coverage across contributing lanes, compare against thresholds, run the mutation gate if it is bound to push, then write per-lane results to state.json so the PreToolUse hook sees a fresh gate.
  </example>

  <example>
  user: /tdd-guardian:gate e2e
  assistant: |
    `e2e` matches a lane name rather than a trigger, so I run that single lane — including its setupCommand and teardownCommand — and record its result. Coverage thresholds are not evaluated, because a single-lane run cannot produce the merged total the thresholds apply to.
  </example>
argument-hint: "[commit | push | taskCompleted | manual | <lane name>]"
allowed-tools: Read, Write, Bash, Glob, Grep
model: inherit
---

Run gate lanes on demand and refresh state.

## Steps

### Step 1 — Load config

Follow `commands/shared/load-config.md`. Stop on missing or disabled config. Surface validation warnings.

### Step 2 — Resolve the target

Treat `$ARGUMENTS` as untrusted. Accept only an exact match against a trigger name or a configured lane name — never interpolate it into a shell command.

| `$ARGUMENTS` | Lanes selected |
|--------------|----------------|
| `commit` | `gateOn` includes `commit` |
| `push` | `gateOn` includes `commit` **or** `push` (push subsumes commit) |
| `taskCompleted` | `gateOn` includes `taskCompleted` |
| `manual` | `gateOn` includes `manual` |
| a lane name | that lane alone |
| empty | `commit` — the common case |

If it matches neither, list the valid triggers and the configured lane names, then stop.

If the selection is empty, say so explicitly — "No lane is bound to `push`. Add `\"push\"` to a lane's `gateOn` to gate it." Silence here would read as approval.

### Step 3 — Preflight

If `preflightCommand` is set, run it once before any lane. On failure, stop with its output. Do not run lanes against a broken environment.

### Step 4 — Run each lane

For each selected lane, follow `commands/shared/run-lane.md`: setup → command → coverage report → teardown.

| Result | Action |
|--------|--------|
| `pass` | Continue to the next lane |
| `fail` | Stop, unless the lane is `optional`. Report the failing tests |
| `no-tests` | Stop. Test discovery is broken; point at `/tdd-guardian:probe` |
| `coverage-missing` | Stop. The coverage command or path is wrong |
| `runner-missing` / `runner-error` / `killed` / `timeout` | Stop. Report the environment error. **Do not** propose code changes |
| `interrupted` | Stop silently |

An `optional: true` lane records its failure and continues. Say clearly in the report that it failed and was not blocking — never let an optional failure read as a pass.

### Step 5 — Coverage gate

Merge the reports from every lane with `coverage: "include"` per `commands/shared/parse-coverage.md`, then apply the `tdd-guardian:coverage-gate` rules:

- Reject a merge measuring zero lines.
- Compare against thresholds (`absolute`) or the recorded baseline (`no-decrease`).
- Report a `weighted` merge as approximate, naming the lane that forced the fallback.
- Treat a `null` metric with a non-zero threshold as a WARNING, never a failure.

Skip this step when a single lane was selected by name — thresholds apply to the merged total across all contributing lanes, and evaluating them against a subset would produce a misleading verdict. Say that you skipped it and why.

### Step 6 — Mutation gate

If `requireMutation` is true and `mutationGateOn` includes the resolved trigger, run `mutationCommand` and parse per `commands/shared/parse-mutation.md`. Skip silently when it is not bound to this trigger.

### Step 7 — Write state

Update `.claude/tdd-guardian/state.json`:

```json
{
  "schemaVersion": 2,
  "lanes": {
    "<name>": {
      "last_passed_at": "<ISO, only on pass>",
      "last_run_at": "<ISO>",
      "last_head_sha": "<git rev-parse HEAD, only on pass>",
      "last_result": "passed | fail | no-tests | ...",
      "duration_ms": 0
    }
  },
  "coverage": { "timestamp": "<ISO>", "status": "PASS|FAIL|BASELINE", "method": "single|union|weighted", "approximate": false, "formats": [], "totals": {} },
  "mutation": { "timestamp": "<ISO>", "status": "PASS|FAIL" },
  "baseline": { "branch": "", "recorded_at": "", "coverage": {} }
}
```

A failing lane must **not** advance `last_passed_at` or `last_head_sha`. Those record the last known-green commit, and moving them on a failure would make a red gate look fresh.

Prefer writing state through the library so the shape stays in sync with what the hooks read:

```bash
node -e "
const l=require('<plugin-root>/scripts/tdd-guardian/lib/lanes.js');
const s=l.loadState(process.cwd());
l.recordLaneResult(s,'<lane>',{ok:true,status:'pass',durationMs:0},l.headSha(process.cwd()));
l.saveState(process.cwd(),s);
"
```

### Step 8 — Report

## Output format

```markdown
# Gate — {PASS | FAIL} ({trigger})

**Lanes run**: {names}
**Duration**: {total}s

| Lane | Result | Tests | Duration | Coverage |
|------|--------|-------|----------|----------|
| unit | PASS | 148 passed, 0 failed | 3.2s | included |
| integration | PASS | 22 passed, 0 failed | 47.1s | included |
| e2e | FAIL | 18 passed, 2 failed | 214.0s | — |

## Coverage

| Metric | Actual | Threshold | Status |
|--------|--------|-----------|--------|
| Lines | 97.40% (1123/1153) | 100% | FAIL |
| Functions | 100.00% (204/204) | 100% | PASS |
| Branches | n/a | 100% | WARN — not measured by go-cover |
| Statements | 97.40% (1123/1153) | 100% | FAIL |

Merge method: union across lcov, cobertura.

## Failures

{Per failing lane: phase, exit code, stdout/stderr tails, and whether it is an
environment failure or a test failure.}

## Next step

{Gates green → "Gates are fresh. Commit/push is unblocked."}
{Otherwise → the specific fix, and the command to re-run.}
```

## Contract

- Input: optional trigger or lane name.
- Output: one markdown gate report.
- Side effects: **runs real test suites**, may start and stop services, writes `state.json`.
- Failure modes: missing config → init instructions; unknown target → list valid names; empty selection → explicit "no lane gates this" message.

## Rules

1. Never run `git commit`, `git push`, or `gh pr create`. This command makes gates green; committing is the user's decision.
2. Never write a passing state for a lane that did not pass.
3. An environment failure never triggers a code fix. Report it and stop.
4. When a single lane is selected by name, skip the coverage gate and say why.
