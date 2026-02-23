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
   - Produce full edge-case/boundary/guard test matrix.
3. `tdd-implementer`
   - Implement work items in small batches.
4. `tdd-coverage-auditor`
   - Enforce coverage gates and identify gaps.
5. `tdd-mutation-auditor` (if mutation gate enabled)
   - Validate test strength and close surviving mutants.
6. `tdd-reviewer`
   - Findings-first final review.

## Mandatory stop conditions

1. Stop if any gate fails.
2. Do not commit/push until gates are green.
3. Provide a final checklist with pass/fail for each gate.
