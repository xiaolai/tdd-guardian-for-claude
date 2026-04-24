---
name: tdd-guardian-implement
description: |
  Dispatch the tdd-implementer agent for ONE work item — red, green, refactor — then verify with the project's test command.

  <example>
  user: /tdd-guardian:implement WI-1
  assistant: |
    Loading the most recent plan and test matrix, locating WI-1, then dispatching the tdd-implementer. It will write the failing tests first (red), add the minimal implementation (green), run the testCommand to confirm green, and stop without touching the next work item. If verification fails, it reports the blocker and I stop the workflow.
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

Dispatch the `tdd-implementer` agent for a single work item, then verify via `commands/shared/run-tests.md`.

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
- A directive:
  - "Write the test file(s) first so they fail (red). Show the failing run."
  - "Write the minimal implementation to make tests pass (green). Show the passing run."
  - "Do NOT proceed to any other work item. Do NOT commit, push, or open PRs."
  - "If tests cannot be made green, report a BLOCKED status with specific evidence."

### Step 4 — Verification gate

After the implementer reports completion, invoke `commands/shared/run-tests.md` with the configured `testCommand`.

| run-tests result | Action |
|------------------|--------|
| `pass` | Mark WI-N DONE. Print next-step hint. |
| `fail` | Print the failing tests; prompt user whether to re-dispatch the implementer with the failure output as context, or stop. |
| `no-tests` | Stop with: "Test runner reports no tests discovered. The implementer did not add tests as instructed." |
| `runner-missing` / `runner-error` / `killed` | Stop with the environment-error text from run-tests.md — do NOT re-dispatch the implementer. |

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

This file is already in `.gitignore` (per `tdd-guardian-init`).

## Output format

```markdown
# WI-{N}: {title} — {DONE | BLOCKED | FAILED-VERIFICATION}

## Tests written
- `{test file}`: {N} cases

## Implementation
- `{source file}`: {brief description}

## Verification
- Command: `{testCommand}`
- Result: PASS | FAIL | runner-error
- Details: {summary — passed count, failed count, duration}

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
