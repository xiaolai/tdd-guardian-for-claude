---
artifact: agents/tdd-implementer.md
description: Spec for tdd-implementer — red-green-refactor for ONE work item at a time; verifies with test command; never advances past a failing gate.
---

# tdd-implementer

## Positive triggers (agent SHOULD fire)

### P1: single work-item implementation request

Scenario: "Implement WI-1 of the rate-limiter plan."
Expected: agent fires. Writes failing tests first (red), minimal implementation (green), runs `testCommand`, reports PASS/FAIL.
Must contain: `## WI-1:` heading, `### Tests written`, `### Implementation`, `### Verification` with a `Command:` line.

### P2: dispatch from /tdd-guardian:implement WI-N

Scenario: user invokes `/tdd-guardian:implement WI-2`.
Expected: implement command dispatches the agent with only WI-2's block; agent produces the per-WI output format.
Must contain: `Status: DONE | BLOCKED` line.

### P3: green-before-advance check

Scenario: after WI-1 PASS, user asks "continue to WI-2" in the same agent turn.
Expected: agent does NOT advance. Must return control so the command can dispatch a fresh invocation for WI-2.

## Negative triggers (agent MUST NOT fire)

### N1: planning request

Scenario: "Plan a new authentication feature."
Expected: agent does NOT fire. Planner is correct.
Must NOT write: plan-markdown output.

### N2: batch implementation request

Scenario: "Implement all 8 work items in one go."
Expected: agent does NOT fire in batch mode. The command layer must invoke it one WI at a time; if given multiple, the agent itself processes only one and returns.

## Advance-only-on-green rule

If verification in step 5 returns FAIL, the agent:
- MUST NOT edit the tests to make them pass (tests drive implementation, not vice versa).
- MUST NOT move to the next work item.
- MUST report `Status: BLOCKED` with the failing test output in `Details:`.

## Commit prohibition

Agent MUST NOT run:
- `git commit`, `git add && git commit`, `git push`
- `gh pr create`, `gh pr merge`
- any script that wraps those commands

## Output purity checks

Allowed tools: `Read, Write, Edit, Bash, Grep, Glob, LS, TodoWrite`. Bash use is limited to the configured `testCommand`. Any other Bash invocation (especially `git`) is a violation.

## Output schema

Per work item:
```
## WI-N: <title>

### Tests written
- `<file>`: N cases

### Implementation
- `<file>`: <brief>

### Verification
- Command: `<testCommand>`
- Result: PASS | FAIL
- Details: <summary>

### Status: DONE | BLOCKED
- Blocker: <if blocked>
```
