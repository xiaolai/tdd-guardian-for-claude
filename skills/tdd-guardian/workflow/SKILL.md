---
name: workflow
description: Orchestrate strict TDD implementation across planner, test designer, spec adversary, implementer, coverage auditor, mutation auditor, and reviewer subagents.
---

# TDD Workflow

Use this workflow when user asks for implementation with strict TDD enforcement.

## Orchestration order

1. `tdd-planner`
   - Produce work items and acceptance criteria.
2. `tdd-test-designer`
   - Produce full edge-case/boundary/guard test matrix, with a **lane**, an assertion level, and a **spec level** (S1-S6) per case, plus the law question answered once per unit.
3. `tdd-spec-adversary`
   - Attack the finished matrix for the simplest wrong implementation that passes every case. Loop back to step 2 with any gaps, up to twice. This is the only stage that runs before an implementation exists, and therefore the only one judging a specification that is still independent of one.
4. `tdd-implementer`
   - Implement work items in small batches, recording a red receipt per item, verifying against the `taskCompleted` lanes only — the fast inner loop.
5. `tdd-coverage-auditor`
   - Run every lane with `coverage: "include"`, merge the reports, enforce thresholds against the merge and against every `criticalPaths` entry.
6. `tdd-mutation-auditor` (if mutation gate enabled)
   - Validate test strength and report surviving mutants with the boundary test that would kill each. The implementer writes them.
7. `tdd-reviewer`
   - Findings-first final review: the lane audit, specification strength, the change tax, and any `SEPARATION-BROKEN` receipt.

## Lanes in the workflow

The inner loop (step 4) runs only `taskCompleted` lanes. Slower lanes run once, at the end:

- Before handing back, run `/tdd-guardian:gate commit` so the commit lanes are fresh.
- If the change touches anything a `push` lane covers, say so and point at `/tdd-guardian:gate push`. Do not run it unprompted — it can take tens of minutes and may need services the user has not started.

## Mandatory stop conditions

1. Stop if any gate fails.
2. A lane that discovered zero tests is a failure, not a pass.
3. An environment failure (missing runner, OOM, timeout) stops the workflow and never triggers a code fix.
4. Do not commit/push until gates are green.
5. Provide a final checklist with pass/fail for each lane and each gate, naming every dimension that was NOT configured rather than omitting it.
6. Adversary gaps still open after two redesign rounds do not silently proceed — surface them and let the user decide.

## Scope

Covers orchestration only: the order the seven subagents run in, which lanes run at which stage, and the stop conditions.

Each stage's own rules live elsewhere — `tdd-guardian:policy-core` for test quality, `tdd-guardian:lane-policy` for tiers, `tdd-guardian:test-matrix` for the matrix format, `tdd-guardian:coverage-gate` and `tdd-guardian:mutation-gate` for the gates, and `tdd-guardian:review-gate` for the final review.
