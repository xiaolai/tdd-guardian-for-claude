---
name: workflow
description: Orchestrate strict TDD implementation across planner, implementer, test designer, coverage auditor, mutation auditor, and reviewer subagents.
---

# TDD Workflow

Use this workflow when user asks for implementation with strict TDD enforcement.

## Orchestration order

1. `tdd-planner`
   - Produce work items and acceptance criteria.
2. `tdd-test-designer`
   - Produce full edge-case/boundary/guard test matrix, with a **lane** and an assertion level per case.
3. `tdd-implementer`
   - Implement work items in small batches, verifying against the `taskCompleted` lanes only — the fast inner loop.
4. `tdd-coverage-auditor`
   - Run every lane with `coverage: "include"`, merge the reports, enforce thresholds against the merge.
5. `tdd-mutation-auditor` (if mutation gate enabled)
   - Validate test strength and report surviving mutants with the boundary test that would kill each. The implementer writes them.
6. `tdd-reviewer`
   - Findings-first final review, including the lane audit: every mocked boundary paired with an integration-lane test.

## Lanes in the workflow

The inner loop (step 3) runs only `taskCompleted` lanes. Slower lanes run once, at the end:

- Before handing back, run `/tdd-guardian:gate commit` so the commit lanes are fresh.
- If the change touches anything a `push` lane covers, say so and point at `/tdd-guardian:gate push`. Do not run it unprompted — it can take tens of minutes and may need services the user has not started.

## Mandatory stop conditions

1. Stop if any gate fails.
2. A lane that discovered zero tests is a failure, not a pass.
3. An environment failure (missing runner, OOM, timeout) stops the workflow and never triggers a code fix.
4. Do not commit/push until gates are green.
5. Provide a final checklist with pass/fail for each lane and each gate.

## Scope

Covers orchestration only: the order the six subagents run in, which lanes run at which stage, and the stop conditions.

Each stage's own rules live elsewhere — `tdd-guardian:policy-core` for test quality, `tdd-guardian:lane-policy` for tiers, `tdd-guardian:test-matrix` for the matrix format, `tdd-guardian:coverage-gate` and `tdd-guardian:mutation-gate` for the gates, and `tdd-guardian:review-gate` for the final review.
