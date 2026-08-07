---
name: status
description: |
  Read-only status report — shows last-run coverage %, mutation score, review verdict, and per-work-item state from `.claude/tdd-guardian/state.json`. Does NOT run any agent, test, or gate.

  <example>
  user: /tdd-guardian:status
  assistant: |
    Reading `.claude/tdd-guardian/state.json` and the most recent `plan-*.md`, `tests-*.md`, `coverage-*.md`, `mutation-*.md`, `review-*.md` files. I render a summary table: last coverage run (timestamp + verdict + totals), last mutation run (score + survivors), last review (severity counts + verdict), and per-work-item state (DONE / BLOCKED / FAILED-VERIFICATION / not-started). No agents are dispatched; no tests or coverage commands are run.
  </example>

  <example>
  user: /tdd-guardian:status
  assistant: |
    `.claude/tdd-guardian/state.json` does not exist. I respond with: "No TDD Guardian runs recorded yet. Start with /tdd-guardian:plan or /tdd-guardian:workflow." and stop.
  </example>
argument-hint: ""
allowed-tools: Read, Glob, Bash
model: inherit
---

Read-only status reporter. No agents dispatched. No test suites run.

The only shell commands permitted are read-only git queries used for freshness
(`git rev-parse`, `git diff --name-only`, `git status --porcelain`). Never run a
lane command from here — that is `/tdd-guardian:gate`.

## Steps

### Step 1 — Load config (soft)

Unlike other commands, DO NOT hard-fail on missing config — the user may be invoking `/tdd-guardian:status` to diagnose exactly that. Try `commands/shared/load-config.md`, but if it stops, downgrade to: `Config missing or disabled. Run /tdd-guardian:init to initialize.` and continue rendering whatever state exists.

### Step 2 — Read state

Try to read `.claude/tdd-guardian/state.json`. If missing, respond: `No TDD Guardian runs recorded yet. Start with /tdd-guardian:plan or /tdd-guardian:workflow.` and STOP.

If present, parse it. Expected keys (schema v2):
- `lanes` — map of lane name → `{last_passed_at, last_run_at, last_head_sha, last_result, duration_ms}`
- `coverage` — `{timestamp, status, method, approximate, formats, totals}`
- `mutation` — `{timestamp, status, command}`
- `baseline` — `{branch, recorded_at, coverage}` (no-decrease mode only)
- `workItems` — map of WI-N → `{status, testFiles, sourceFiles, updatedAt}`
- `lastReview` — `{timestamp, findings, reportPath}`
- `config_warnings` — validation warnings recorded by the last hook run

A schema v1 state file has a single `last_gate_passed_at` instead of `lanes`. Render it as one `unit` lane and note that the state predates lanes.

Missing keys mean "not run yet" — render as `—`.

### Step 2b — Compute freshness per lane

For each configured lane, compare its `last_passed_at` against `gateFreshnessMinutes`. When the window has expired and `smartStaleness` is on, a lane is still fresh if no source file changed since `last_head_sha` — check both committed changes (`git diff --name-only <sha> HEAD`) and the working tree (`git status --porcelain`). Uncommitted edits invalidate a gate just as committed ones do.

Report the reason, not just the verdict: `fresh (no source changed since)` tells the user something `fresh` does not.

### Step 3 — Glob recent artifacts

Count files under `.claude/tdd-guardian/` by prefix:
- `plan-*.md` — N plans
- `tests-*.md` — N test matrices
- `coverage-*.md` — N coverage reports
- `mutation-*.md` — N mutation reports
- `review-*.md` — N reviews

Identify the most recent of each by filename (ISO-sortable).

### Step 4 — Render

## Output format

```markdown
# TDD Guardian Status

**Workspace**: {pwd}
**Config**: {present | missing} — schema v{n}, {N} lane(s)
**Enforcement**: taskCompleted {on|off} / commit-push blocking {on|off} ({staleGateAction})
**Mutation**: {required | disabled}{if required: " — " + mutationCommand}

## Lanes

| Lane | Trigger | Last pass | Freshness | Last result | Duration | Coverage |
|------|---------|-----------|-----------|-------------|----------|----------|
| unit | taskCompleted, commit | {YYYY-MM-DD HH:MM} | fresh (12 min ago) | passed | 3.2s | include |
| integration | commit | {YYYY-MM-DD HH:MM} | fresh (no source changed since) | passed | 47.1s | include |
| e2e | push | — | never run | — | — | none |

{Render `last_result: "bootstrap"` as **`bootstrap — no tests yet`**, never as `passed`.
The lane is fresh and unblocking, but it has verified nothing, and the two must
not look alike. Add a line beneath the table for each bootstrap lane:
"Lane `<name>` has never had a test. Write the first one — after that, a
zero-test run becomes a hard failure."}

## Can I commit / push right now?

| Action | Blocked? | Reason |
|--------|----------|--------|
| `git commit` | No | unit, integration both fresh |
| `git push` | **Yes** | e2e has never passed |

{Derive from the same rule the PreToolUse hook uses: commit needs every lane with
`commit` in gateOn; push needs every lane with `commit` OR `push`. If
`blockCommitWithoutFreshGate` is false, say "not blocked — enforcement is off"
rather than implying gates passed.}

## Last gate runs

| Gate      | When                 | Status      | Detail |
|-----------|----------------------|-------------|--------|
| Coverage  | {YYYY-MM-DD HH:MM}   | PASS / FAIL / BASELINE | L {lines}% / F {functions}% / B {branches}% / S {statements}% — merge: {method}{, approximate if weighted} |
| Mutation  | {YYYY-MM-DD HH:MM}   | PASS / FAIL / SKIPPED | score {n.nn}% ({killed} killed / {survived} survived) |
| Review    | {YYYY-MM-DD HH:MM}   | APPROVED / BLOCKED / etc. | High {n} / Medium {n} / Low {n} |

{If any section has no recorded run, show "—" in all columns for that row.}
{If coverage method is "weighted", add: "Coverage was combined as a weighted
average, not a union — lines covered by more than one lane are counted more than
once. Emit LCOV or Cobertura from every contributing lane for an exact merge."}

## Configuration warnings

{Any `config_warnings` from state, plus warnings from loading the config now.
Omit the section when there are none — never suppress them when there are.}

## Work items

| ID   | Status               | Tests                | Impl                 | Updated |
|------|----------------------|----------------------|----------------------|---------|
| WI-1 | DONE / BLOCKED / ... | `{test files}`       | `{source files}`     | {ts}    |
| WI-2 | ...                  | ...                  | ...                  | ...     |

{If no workItems recorded, omit this table and say "No work items recorded yet."}

## Artifacts

| Kind             | Count | Most recent                                          |
|------------------|-------|------------------------------------------------------|
| Plans            | N     | `.claude/tdd-guardian/plan-{ts}.md`                  |
| Test matrices    | N     | `.claude/tdd-guardian/tests-{ts}.md`                 |
| Coverage reports | N     | `.claude/tdd-guardian/coverage-{ts}.md`              |
| Mutation reports | N     | `.claude/tdd-guardian/mutation-{ts}.md`              |
| Reviews          | N     | `.claude/tdd-guardian/review-{ts}.md`                |

## Next step hint

{Based on state:}
- No config → "Run /tdd-guardian:init"
- A lane has never run → "Run /tdd-guardian:probe to verify it resolves, then /tdd-guardian:gate {lane}"
- No plan yet → "Run /tdd-guardian:plan <task>"
- Plan exists, no matrix → "Run /tdd-guardian:design-tests"
- Matrix exists, one or more WIs not DONE → "Run /tdd-guardian:implement WI-{next}"
- All WIs DONE, no coverage run → "Run /tdd-guardian:audit-coverage"
- Coverage PASS, mutation required but not run → "Run /tdd-guardian:audit-mutation"
- All gates PASS, no review → "Run /tdd-guardian:review"
- Push lanes stale → "Run /tdd-guardian:gate push before pushing"
- All gates PASS + review APPROVED → "Ready to commit. Gates are fresh."
- Any gate FAIL → Point at the report and the fix command it names
```

## Contract

- Input: none.
- Output: one markdown status report printed to the user.
- Side effects: NONE. No files written, no agents dispatched, no shell commands run.
- Failure modes: missing config → soft warning + continue; missing state.json → short "no runs yet" message.
