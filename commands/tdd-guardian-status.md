---
name: tdd-guardian-status
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
    `.claude/tdd-guardian/state.json` does not exist. I respond with: "No TDD Guardian runs recorded yet. Start with /tdd-guardian:plan or /tdd-guardian:tdd-guardian-workflow." and stop.
  </example>
argument-hint: ""
allowed-tools: Read, Glob
model: inherit
---

Read-only status reporter. No agents dispatched. No commands run.

## Steps

### Step 1 — Load config (soft)

Unlike other commands, DO NOT hard-fail on missing config — the user may be invoking `/tdd-guardian:status` to diagnose exactly that. Try `commands/shared/load-config.md`, but if it stops, downgrade to: `Config missing or disabled. Run /tdd-guardian:tdd-guardian-init to initialize.` and continue rendering whatever state exists.

### Step 2 — Read state

Try to read `.claude/tdd-guardian/state.json`. If missing, respond: `No TDD Guardian runs recorded yet. Start with /tdd-guardian:plan or /tdd-guardian:tdd-guardian-workflow.` and STOP.

If present, parse it. Expected keys:
- `workItems` — map of WI-N → `{status, testFiles, sourceFiles, updatedAt}`
- `lastCoverageRun` — `{timestamp, status, totals, reportPath}`
- `lastMutationRun` — `{timestamp, status, score, killed, survived, reportPath}`
- `lastReview` — `{timestamp, findings, reportPath}`

Missing keys mean "not run yet" — render as `—`.

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
**Config**: {present | missing} — `{testCommand}` / `{coverageCommand}`
**Mutation**: {required | disabled}{if required: " — " + mutationCommand}

## Last gate runs

| Gate      | When                 | Status      | Detail |
|-----------|----------------------|-------------|--------|
| Coverage  | {YYYY-MM-DD HH:MM}   | PASS / FAIL | L {lines}% / F {functions}% / B {branches}% / S {statements}% |
| Mutation  | {YYYY-MM-DD HH:MM}   | PASS / FAIL / SKIPPED | score {n.nn}% ({killed} killed / {survived} survived) |
| Review    | {YYYY-MM-DD HH:MM}   | APPROVED / BLOCKED / etc. | High {n} / Medium {n} / Low {n} |

{If any section has no recorded run, show "—" in all columns for that row.}

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
- No plan yet → "Run /tdd-guardian:plan <task>"
- Plan exists, no matrix → "Run /tdd-guardian:design-tests"
- Matrix exists, some WIs not DONE → "Run /tdd-guardian:implement WI-{next}"
- All WIs DONE, no coverage run → "Run /tdd-guardian:audit-coverage"
- Coverage PASS, mutation required but not run → "Run /tdd-guardian:audit-mutation"
- All gates PASS, no review → "Run /tdd-guardian:review"
- All gates PASS + review APPROVED → "Ready to commit. Gates are fresh."
- Any gate FAIL → Point at the report and the relevant fix command
```

## Contract

- Input: none.
- Output: one markdown status report printed to the user.
- Side effects: NONE. No files written, no agents dispatched, no shell commands run.
- Failure modes: missing config → soft warning + continue; missing state.json → short "no runs yet" message.
