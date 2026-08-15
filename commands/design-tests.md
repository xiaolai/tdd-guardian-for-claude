---
name: design-tests
description: |
  Dispatch the tdd-test-designer agent to produce a concrete behavior-driven test matrix for a plan. Rejects wiring-only designs. Does NOT write implementation code.

  <example>
  user: /tdd-guardian:design-tests .claude/tdd-guardian/plan-20260424-094500.md
  assistant: |
    Reading the plan file, then dispatching the tdd-test-designer for each work item. The output is a test matrix per unit — success cases, boundaries, guard clauses, failure paths, state transitions, async/concurrency cases — each with an assertion level (Level 1-5 per policy-core), a specification level (S1-S6), and mock boundary justification. The tdd-spec-adversary then attacks the finished matrix, looking for a wrong implementation that would pass every case. No implementation code is written.
  </example>

  <example>
  user: /tdd-guardian:design-tests
  assistant: |
    $ARGUMENTS is empty. I will look for the most recent plan under `.claude/tdd-guardian/plan-*.md`. If none exists, I will ask the user to run `/tdd-guardian:plan` first, or to paste the plan path/content inline.
  </example>
argument-hint: "<path to plan markdown>"
allowed-tools: Read, Write, Edit, Glob, Grep, Task, AskUserQuestion
model: inherit
---

Dispatch the `tdd-test-designer` agent to produce a test matrix for a generated plan.

## Steps

### Step 1 — Load config

Follow `commands/shared/load-config.md`. Stop on missing/disabled config.

### Step 2 — Resolve the plan file

Parse `$ARGUMENTS`:

| Input | Action |
|-------|--------|
| Explicit path (e.g. `.claude/tdd-guardian/plan-20260424.md`) | Read it |
| Empty | Glob `.claude/tdd-guardian/plan-*.md`, pick the most recent by filename (ISO-sortable timestamp). If none found, stop with: `No plan found. Run /tdd-guardian:plan first, or pass a plan path explicitly.` |
| Looks like inline markdown (contains `## Work Items`) | Treat as inline plan, write to a temp file first so the test-designer has a stable input |

### Step 3 — Dispatch the test designer

Use the `Task` tool to invoke the `tdd-test-designer` subagent. Pass:
- The resolved plan (path + content)
- A directive: "For each work item, produce a test matrix per `tdd-guardian:test-matrix`. Every test MUST specify assertion strategy (Level 1-5 from policy-core), specification level (S1-S6 from policy-core), mock boundary (what is mocked, why, and which integration test covers the real path), and the 'what refactor would break this test' answer. For every unit, state whether it has a law — conservation, round-trip, idempotence, ordering, monotonicity — and if it does, include at least one S4-S6 case covering it. A unit with no law must say so explicitly. Self-check each case: if replacing the function body with `return expectedValue` would still pass, the case is wiring-only and must be redesigned."

### Step 4 — Persist the matrix

Write the test-designer's output to `.claude/tdd-guardian/tests-{YYYYMMDD-HHMMSS}.md` referencing the plan's timestamp. This path is what `/tdd-guardian:implement` expects.

### Step 5 — Attack the matrix

Use the `Task` tool to invoke the `tdd-spec-adversary` subagent, passing the matrix path and the plan path.

This runs **before** any implementation exists, which is the only moment the specification is still independent of how the code was built. Every other gate in the plugin runs after.

| Adversary verdict | Action |
|-------------------|--------|
| `SURVIVED` | Continue to step 6 |
| `GAPS FOUND` | Re-dispatch `tdd-test-designer` with the gap report and a directive to add the named missing cases. Up to 2 rounds. |

After 2 rounds with gaps still open, do not silently continue: persist the adversary report to `.claude/tdd-guardian/attack-{YYYYMMDD-HHMMSS}.md`, list the surviving gaps in the output, and let the user decide whether to proceed. An unresolved gap is a known hole in the specification, and hiding it defeats the point of looking for it.

### Step 6 — Quality gate before returning

Scan the returned matrix for red flags:
- Any test case missing the "Assertion strategy" line → reject and re-dispatch with a correction prompt (up to 2 retries).
- Any test case with only Level 6-7 assertions → reject and re-dispatch.
- Any unit whose "has a law" question is unanswered → reject and re-dispatch. "No law" is a valid answer; silence is not.

If the designer still returns wiring-only cases after 2 retries, stop with: `Test designer produced wiring-only cases after retries. Manual review required — see .claude/tdd-guardian/tests-{ts}.md.`

## Output format

```markdown
# Test Matrix Generated

**Plan**: `{plan path}`
**Matrix file**: `.claude/tdd-guardian/tests-{timestamp}.md`
**Units covered**: {N}
**Total test cases**: {M}
**All cases have Level 1-5 assertions**: YES / NO (N violations)
**Units with a law, covered by an S4-S6 case**: {N} of {M}
**Adversary**: SURVIVED | {N} gaps closed after {R} round(s) | {N} gaps OPEN — see `attack-{timestamp}.md`

## Next step
Run `/tdd-guardian:implement WI-1` (or any work-item id from the plan) to begin red-green-refactor.

---

{full designer output verbatim}
```

## Contract

- Input: a plan file (path or inline).
- Output: a test matrix markdown file, plus an attack report when gaps remain open.
- Side effects: writes files under `.claude/tdd-guardian/` only. No source or test files are changed.
- Failure modes: no plan → stop; wiring-only matrix after retries → stop with manual-review prompt; adversary gaps still open after 2 rounds → report them explicitly and hand the decision to the user.
