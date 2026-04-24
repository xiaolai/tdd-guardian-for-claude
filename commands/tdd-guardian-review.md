---
name: tdd-guardian-review
description: |
  Dispatch the tdd-reviewer agent for a final code + test-quality review. Classifies every expect() call as behavior vs wiring, flags mocked internal modules, and reports missing tests.

  <example>
  user: /tdd-guardian:review
  assistant: |
    Dispatching the tdd-reviewer. It reads the changed source and test files, classifies every `expect()` assertion as Level 1-5 (behavior) or Level 6-7 (wiring) per policy-core, flags wiring-only tests, mocked internal modules, security-via-mock-args anti-patterns, and missing error-path coverage. Output is a severity-ordered findings report.
  </example>

  <example>
  user: /tdd-guardian:review src/upload.ts
  assistant: |
    Scoping the reviewer to `src/upload.ts` and its sibling test file. The reviewer still applies the full test-quality audit — flagging wiring-only tests in that scope with High severity — but does not traverse the rest of the repo.
  </example>
argument-hint: "[optional file or directory to scope the review]"
allowed-tools: Read, Glob, Grep, Task
model: inherit
---

Dispatch the `tdd-reviewer` agent for the final gate.

## Steps

### Step 1 — Load config

Follow `commands/shared/load-config.md`.

### Step 2 — Determine scope

Parse `$ARGUMENTS`:

| Input | Scope |
|-------|-------|
| Empty | Uncommitted + staged changes (`git diff HEAD --name-only` union `git diff --cached --name-only`) |
| File path | Just that file and its sibling test file (`*.test.*`, `*_test.*`, `test_*`) |
| Directory path | All source + test files under it |

If scope is empty (no changed files and no path given), respond: "No changes to review. Pass a path explicitly to force a scoped review." and STOP.

### Step 3 — Dispatch the reviewer

Use the `Task` tool to invoke `tdd-reviewer` with:
- The scope file list.
- A directive: "Use `tdd-guardian:review-gate` and `tdd-guardian:policy-core`. For each test file, read it, and classify every `expect()` call. Flag any `it()` / `test()` block where ALL assertions are Level 6-7. Flag mocked internal modules (same repo paths). Flag security checks that only inspect mock args. Report code findings, test-quality findings, missing-test findings, and residual risk — in that order, severity-sorted."

### Step 4 — Persist the report

Write the reviewer's output to `.claude/tdd-guardian/review-{YYYYMMDD-HHMMSS}.md` and update state:

```json
{
  "lastReview": {
    "timestamp": "<ISO>",
    "findings": { "high": N, "medium": N, "low": N },
    "reportPath": ".claude/tdd-guardian/review-{ts}.md"
  }
}
```

### Step 5 — Verdict

| Condition | Verdict |
|-----------|---------|
| Zero findings | `APPROVED` |
| Only Low-severity findings | `APPROVED WITH NOTES` |
| Any Medium findings | `CHANGES REQUESTED` |
| Any High findings | `BLOCKED` |

## Output format

```markdown
# TDD Review — {APPROVED | APPROVED WITH NOTES | CHANGES REQUESTED | BLOCKED}

**Timestamp**: {ISO}
**Scope**: {N files reviewed}
**Report**: `.claude/tdd-guardian/review-{timestamp}.md`

## Finding summary

| Severity | Count |
|----------|-------|
| High     | N |
| Medium   | N |
| Low      | N |

{full reviewer output follows, sorted by severity}
```

## Contract

- Input: optional scope hint (path or nothing for diff).
- Output: review report file + findings summary in `state.json`.
- Side effects: reads only. No source or test files are modified.
- Failure modes: empty scope → stop; reviewer unavailable → surface error and stop (no inline review).
