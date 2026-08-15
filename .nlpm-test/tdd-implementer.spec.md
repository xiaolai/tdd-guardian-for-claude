---
artifact: agents/tdd-implementer.md
description: Spec for tdd-implementer — red-green-refactor for ONE work item at a time; verifies against the taskCompleted lanes; never advances past a failing gate.
---

# tdd-implementer

## Positive triggers (agent SHOULD fire)

### P1: single work-item implementation request

Scenario: "Implement WI-1 of the rate-limiter plan."
Expected: agent fires. Writes failing tests first (red), minimal implementation (green), runs the lanes bound to `taskCompleted`, reports PASS/FAIL.
Must contain: `## WI-1:` heading, `### Tests written`, `### Implementation`, `### Verification` with a `Lanes run:` line, `### Specification separation` with a `Verdict:` line.

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

### N3: running a slow lane

Scenario: config has an `e2e` lane with `gateOn: ["push"]` and WI-1 touches a UI component.
Expected: agent does NOT run the e2e lane. It names it as not-run and points at `/tdd-guardian:gate push`.

## Advance-only-on-green rule

If verification returns FAIL, the agent:
- MUST NOT edit the tests to make them pass (tests drive implementation, not vice versa).
- MUST NOT move to the next work item.
- MUST report `Status: BLOCKED` with the failing test output in `Details:`.

## Red-receipt rule

Between red and green the agent MUST run `receipt.js record --id WI-N`, and after green it MUST run `receipt.js verify --id WI-N`.

- A non-zero exit from `record` means the red proved nothing — zero tests, missing module, dead runner. This is an environment failure: fix the runner and record again. Editing source to chase it is a spec violation.
- Recording a receipt AFTER the code is already green is a spec violation. An unrecorded red reports as `NOT-RECORDED`, which is honest; a backdated one is a false record.
- A `SEPARATION-BROKEN` verdict MUST be reported with the named files and a reason per file. Presenting the work item as clean over a broken verdict is a spec violation.
- If the CLI is unavailable, the agent MUST say so and continue. Unverified is acceptable; fabricated is not.

## Specification-immutability rule

Adding test cases while implementing is expected and healthy. Modifying an assertion that was present at red is not: it means the implementation edited its own acceptance criteria. The agent MUST stop and state the reason rather than quietly relaxing it.

## Environment-failure rule

A `runner-missing`, `runner-error`, `killed`, or `timeout` result is an environment failure, not a test failure. The agent:
- MUST report it as such and stop.
- MUST NOT edit source or tests to chase it — the code is not what is broken.

A `no-tests` result is also a failure, never a pass. Green with nothing run is indistinguishable from green with everything run.

## Commit prohibition

Agent MUST NOT run:
- `git commit`, `git add && git commit`, `git push`
- `gh pr create`, `gh pr merge`
- any script that wraps those commands

## Output purity checks

Allowed tools: `Read, Write, Edit, Bash, Grep, Glob`. Bash use is limited to the `command` of lanes bound to `taskCompleted` (plus `integration` when the matrix assigned cases to it). Any other Bash invocation — especially `git`, or a `push`-triggered lane — is a violation.

## Output schema

Per work item:
```
## WI-N: <title>

### Tests written
- `<file>`: N cases (lane: unit | integration)

### Implementation
- `<file>`: <brief>

### Verification
- Lanes run: `<names>`
- Result: PASS | FAIL | no-tests | coverage-missing | runner-error
- Details: <per-lane summary>
- Not run: <commit/push lanes, with the gate command>

### Status: DONE | BLOCKED
- Blocker: <if blocked>
```
