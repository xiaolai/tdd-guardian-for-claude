---
name: implement
description: |
  Dispatch the tdd-implementer agent for ONE work item — red, green, refactor — then verify with the project's test command.

  <example>
  user: /tdd-guardian:implement WI-1
  assistant: |
    Loading the most recent plan and test matrix, locating WI-1, then dispatching the tdd-implementer. It will write the failing tests first (red), add the minimal implementation (green), then verify against the `taskCompleted` lanes — the fast inner loop — and stop without touching the next work item. Slower `commit` and `push` lanes are named but not run; `/tdd-guardian:gate` handles those. If verification fails, it reports the blocker and I stop the workflow.
  </example>

  <example>
  user: /tdd-guardian:implement
  assistant: |
    $ARGUMENTS is empty. I will ask which work item to implement — listing the ids from the most recent plan file so the user can pick one. I will NOT iterate through all work items in a single invocation of this command.
  </example>
argument-hint: "<work-item id, e.g. WI-1>"
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Task, AskUserQuestion
model: inherit
---

Dispatch the `tdd-implementer` agent for a single work item, then verify via `commands/shared/run-lane.md`.

## Steps

### Step 1 — Load config

Follow `commands/shared/load-config.md`.

### Step 2 — Resolve work item, plan, and matrix

Parse `$ARGUMENTS` as a work-item id (e.g. `WI-1`, `WI-3`). If empty:

- Glob `.claude/tdd-guardian/plan-*.md`, pick the latest.
- Extract work-item ids from `### WI-N:` headings.
- Ask the user via `AskUserQuestion` to pick one. Do NOT auto-select all.

Locate the matching `### WI-N:` block from the latest plan file and the matching test-matrix entries from the latest `tests-*.md` file.

If either is missing, stop with a pointer to run `/tdd-guardian:plan` or `/tdd-guardian:design-tests` first.

### Step 3 — Dispatch the implementer

Use the `Task` tool to invoke `tdd-implementer` with:
- The single work item's block (acceptance criteria, required tests).
- The matching rows from the test matrix.
- The absolute path to the red-receipt CLI: `${CLAUDE_PLUGIN_ROOT}/scripts/tdd-guardian/receipt.js`. Resolve it here and pass the resolved path — the agent runs in its own context and must not have to guess it.
- A directive:
  - "Write the test file(s) first so they fail (red). Show the failing run."
  - "Then record the red: `node <resolved receipt.js path> record --id WI-N`. It runs the lane, checks that the failure is a real assertion failure rather than a missing module or a zero-test run, and fingerprints the test files."
  - "Write the minimal implementation to make tests pass (green). Show the passing run."
  - "Do NOT edit an existing assertion to make it pass. Adding cases is fine; changing a recorded one means the implementation is editing its own specification. If a recorded assertion is genuinely wrong, say so explicitly and state why."
  - "Do NOT proceed to any other work item. Do NOT commit, push, or open PRs."
  - "If tests cannot be made green, report a BLOCKED status with specific evidence."

### Step 3b — Record the red, if the implementer did not

If the implementer reports it could not run the receipt CLI, run it yourself between the red and green phases. A receipt recorded after the code is green certifies nothing and must not be written — say the receipt was skipped and why, rather than manufacturing one.

`record` exits non-zero when the observed failure was not a genuine red (zero tests discovered, a missing module, a broken runner). That is an environment problem, not a code problem: fix the runner and record again. Do not edit source to chase it.

### Step 4 — Verification gate

After the implementer reports completion, invoke `commands/shared/run-lane.md` for the lanes bound to `taskCompleted` — the fast inner loop. Do NOT run `commit` or `push` lanes here; verifying one work item against a browser suite is the wrong trade, and `/tdd-guardian:gate` exists for that.

If the work item's test matrix assigned cases to the `integration` lane, run that lane too and say that you did.

| run-lane result | Action |
|-----------------|--------|
| `pass` | Mark WI-N DONE. Print next-step hint. |
| `fail` | Print the failing tests; prompt user whether to re-dispatch the implementer with the failure output as context, or stop. |
| `no-tests` | Stop with: "Test runner reports no tests discovered. The implementer did not add tests as instructed." |
| `coverage-missing` | Stop. The lane's coverage command or path is wrong — point at `/tdd-guardian:probe`. |
| `runner-missing` / `runner-error` / `killed` / `timeout` | Stop with the environment-error text from run-lane.md — do NOT re-dispatch the implementer. It would edit correct code to chase a broken runner. |

### Step 4b — Verify the specification did not move

Once the lanes are green, run `node <resolved receipt.js path> verify --id WI-N`. It re-runs the recorded lane itself — a receipt is only judged against a lane that is demonstrably green, so verifying too early costs a lane run rather than banking a wrong verdict.

| Verdict | Action |
|---------|--------|
| `SEPARATION-HELD` | Continue. Report it — evidence that held is worth stating. |
| `SEPARATION-BROKEN` | Report every named file as a High finding. The work item is DONE only if the user accepts a stated reason for each changed assertion. |
| `NOT-RECORDED` | Report "separation unverified — no red receipt". This is not a failure; the check simply had nothing to check. |
| `PENDING` | Nothing could be judged yet — either the lane is not green, or a recorded specification file could not be read. Fix the cause and verify again; the receipt stays open rather than settling on a verdict nobody can support. |

Adding test cases while implementing does **not** break separation — verification compares recorded lines, so an addition leaves every one of them intact. Only editing or deleting a line that was present at red is a finding.

Never silently overwrite a broken verdict by re-recording the red after the fact. The receipt exists precisely because the ordering is otherwise unobservable.

### Step 5 — Persist status

Append to `.claude/tdd-guardian/state.json` (create if missing) a record:

```json
{
  "workItems": {
    "WI-N": {
      "status": "DONE" | "BLOCKED" | "FAILED-VERIFICATION",
      "testFiles": ["..."],
      "sourceFiles": ["..."],
      "updatedAt": "<ISO timestamp>"
    }
  }
}
```

This file is already in `.gitignore` (per `/tdd-guardian:init`).

## Output format

```markdown
# WI-{N}: {title} — {DONE | BLOCKED | FAILED-VERIFICATION}

## Tests written
- `{test file}`: {N} cases

## Implementation
- `{source file}`: {brief description}

## Verification
- Lanes run: `{names — the taskCompleted lanes, plus integration when the matrix assigned cases to it}`
- Result: PASS | FAIL | no-tests | coverage-missing | runner-error
- Details: {per lane — passed count, failed count, duration}
- Not run: {lanes on commit/push triggers, with "run /tdd-guardian:gate <trigger>"}

## Specification separation
- Red recorded: {kind — assertion-failure | opaque-failure | skipped, with the reason if skipped}
- Verdict: SEPARATION-HELD | SEPARATION-BROKEN | NOT-RECORDED
- Files whose assertions changed between red and green: {none | list, each with the stated reason}

## Next step
- On PASS: run `/tdd-guardian:implement WI-{N+1}` (or `/tdd-guardian:audit-coverage` if this was the last work item).
- On FAIL: inspect the failing tests, then re-dispatch with `/tdd-guardian:implement WI-{N}`.
- On BLOCKED: resolve the blocker and re-dispatch.
```

## Contract

- Input: one work-item id.
- Output: source + test file edits for that single work item, plus a verification result.
- Side effects: writes source/test files, updates `.claude/tdd-guardian/state.json`. Never commits.
- Failure modes: verification failure leaves the work item in `FAILED-VERIFICATION` state so the workflow command can decide whether to retry.
