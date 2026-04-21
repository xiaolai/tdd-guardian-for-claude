---
name: tdd-guardian-workflow
description: Orchestrate strict TDD implementation in Codex across planning, behavior-first tests, implementation, coverage, mutation, and review gates.
---

# TDD Guardian Workflow

Use this skill when the user asks Codex to implement, fix, or refactor code under strict TDD discipline.

## Required Skills

Follow these bundled skills as the governing references:

- `$tdd-guardian-policy-core`
- `$tdd-guardian-test-matrix`
- `$tdd-guardian-coverage-gate`
- `$tdd-guardian-mutation-gate`
- `$tdd-guardian-review-gate`

## Orchestration Order

1. Plan.
   - Use `$tdd-guardian-plan`.
   - Produce work items, acceptance criteria, risks, and required tests.

2. Design tests.
   - Use `$tdd-guardian-design-tests`.
   - Produce behavior-first test cases with assertion levels and mock-boundary decisions.

3. Implement.
   - Use `$tdd-guardian-implement`.
   - Work one item at a time.
   - Write failing tests before or alongside behavior changes.
   - Run the configured test command after each batch.

4. Audit coverage.
   - Use `$tdd-guardian-coverage-audit`.
   - Run the coverage command and enforce configured thresholds or no-decrease mode.

5. Audit mutation tests when enabled.
   - Use `$tdd-guardian-mutation-audit`.
   - Run mutation tests only when `requireMutation=true` and `mutationCommand` is configured.

6. Review.
   - Use `$tdd-guardian-review`.
   - Lead with findings, then missing tests, then residual risks.

## Optional Subagents

When the user explicitly asks for subagents or when the main task benefits from parallel sidecar work, use Codex subagents for the read-only planning, test design, coverage audit, mutation audit, and review roles. Keep implementation ownership clear and avoid overlapping write scopes.

## Mandatory Stop Conditions

- Stop if any gate fails.
- Do not commit, push, create a PR, merge, or publish until gates are green.
- Do not declare completion from reasoning alone; test and hook logs are the acceptance signal.
- Report the exact gate command, result, and log path for each gate.
