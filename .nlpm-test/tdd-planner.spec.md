---
artifact: agents/tdd-planner.md
description: Spec for tdd-planner — decomposes a task into work items + acceptance criteria; never writes code or tests.
---

# tdd-planner

## Positive triggers (agent SHOULD fire)

### P1: explicit planning request

Scenario: "Break this authentication feature into work items with acceptance criteria."
Expected: agent fires, produces `# TDD Plan:` markdown with `### WI-N:` sections.
Must contain: at least one `Acceptance criteria` checklist and at least one `Required tests` list with assertion levels.

### P2: multi-component refactor request

Scenario: "Plan the payment-module currency refactor — list work items, risks, and test targets."
Expected: agent fires, produces plan with Risks & Assumptions section populated.
Must contain: `## Risks & Assumptions` heading with at least one entry.

### P3: dispatch from /tdd-guardian:plan

Scenario: user invokes `/tdd-guardian:plan add rate limiter to /login`.
Expected: plan command dispatches the agent; agent returns the plan-markdown structure.
Must contain: `# TDD Plan:`, at least one `### WI-1:`, `## Deferred / Out of Scope`.

## Negative triggers (agent MUST NOT fire)

### N1: implementation request

Scenario: "Implement the rate-limiter middleware now."
Expected: agent does NOT fire. The implementer is the correct destination.
Must NOT write: any source file, any test file, any partial implementation in the response.

### N2: coverage question

Scenario: "What's our current line coverage?"
Expected: agent does NOT fire. Status or coverage-auditor is the correct destination.

## Output purity checks

The planner MUST NOT:
- Write source code (no `src/` edits).
- Write test code (no `test/`, `tests/`, `*.test.*`, `*_test.*` edits).
- Run shell commands.
- Commit or push.

Allowed tools per agent frontmatter: `Read, Grep, Glob, LS, TodoWrite`. Verify the agent does not attempt to invoke `Write` on source files or `Bash`.

## Output schema

Required sections in order:
1. `# TDD Plan: <feature name>`
2. `## Work Items` with one or more `### WI-N: <title>` each containing `Description`, `Acceptance criteria`, `Required tests`.
3. `## Risks & Assumptions`
4. `## Deferred / Out of Scope`

## Smoke-test transcript

Input: "Add a rate limiter to /login that blocks after 5 failed attempts in 10 minutes."
Expected excerpt:
```
# TDD Plan: /login rate limiter

## Work Items

### WI-1: In-memory attempt counter per IP
- **Description**: ...
- **Acceptance criteria**:
  - [ ] 5 failed attempts within 10 minutes return 429
  - [ ] ...
```
