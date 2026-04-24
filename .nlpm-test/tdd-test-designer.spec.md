---
artifact: agents/tdd-test-designer.md
description: Spec for tdd-test-designer — produces behavior-driven test matrices; rejects wiring-only designs; never writes implementation code.
---

# tdd-test-designer

## Positive triggers (agent SHOULD fire)

### P1: test matrix request

Scenario: "Design tests for the rate-limiter middleware covering success, boundaries, and concurrency."
Expected: agent fires, produces `## Test Matrix:` section with multiple `### Case:` entries.
Must contain: `Assertion strategy` line specifying a Level 1-5 value for every case; `Mock boundary` line for every case.

### P2: dispatch from /tdd-guardian:design-tests

Scenario: user invokes `/tdd-guardian:design-tests .claude/tdd-guardian/plan-20260101.md`.
Expected: design-tests command dispatches the agent; agent returns a matrix per work item.
Must contain: one `## Test Matrix:` heading per unit, at least one case per matrix.

### P3: edge-case enumeration request

Scenario: "Enumerate boundary and guard-clause tests for the CSV parser."
Expected: agent fires, produces cases categorized `boundary` and `guard`.
Must contain: `Category: boundary` and `Category: guard` lines.

## Negative triggers (agent MUST NOT fire)

### N1: implementation request

Scenario: "Write the CSV parser now."
Expected: agent does NOT fire. Implementer is correct.
Must NOT write: source code in the response.

### N2: coverage audit request

Scenario: "Run coverage and report uncovered branches."
Expected: agent does NOT fire. Coverage-auditor is correct.

## Wiring-only rejection

For each test case in the output, the self-check answer MUST be present or implicit — if replacing the function body with `return expectedValue` would still pass, the case is wiring-only and must be redesigned. Spec-level check:

- No case may list only a Level 6 or Level 7 assertion strategy.
- No case may have `Assertion strategy: expect(mockX).toHaveBeenCalled` as its sole strategy.

## Output purity checks

Allowed tools: `Read, Write, Edit, Grep, Glob, LS, TodoWrite`. `Write` is only used to materialize the matrix file (`.claude/tdd-guardian/tests-*.md`); MUST NOT write to `src/` paths or create `.test.*` source files before the implementer runs.

## Output schema

Per unit:
```
## Test Matrix: <unit>

### Case: <name>
- **Category**: success | boundary | guard | failure | state | determinism
- **Input**: ...
- **Expected output**: ...
- **Observable side effect**: ...
- **Assertion strategy**: Level N — ...
- **Mock boundary**: ... (or "none — real implementation")
```
