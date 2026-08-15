---
artifact: agents/tdd-reviewer.md
description: Spec for tdd-reviewer — final code + test-quality review. Classifies every expect() call; flags wiring-only tests, mocked internal modules, security-via-mock anti-patterns. Read-only.
---

# tdd-reviewer

## Positive triggers (agent SHOULD fire)

### P1: final review request

Scenario: after all gates PASS, user requests final sign-off.
Expected: agent fires. Reads changed source + test files, classifies assertions, produces severity-sorted findings.
Must contain: `## Code findings`, `## Test quality findings`, `## Missing-test findings`, residual risk summary.

### P2: dispatch from /tdd-guardian:review

Scenario: user invokes `/tdd-guardian:review`.
Expected: review command dispatches agent; agent returns findings categorized by severity.

### P3: wiring-only flag request

Scenario: "Flag every wiring-only test in the upload handler's test file."
Expected: agent fires; classifies every `expect()` call, flags `it()` blocks where ALL assertions are Level 6-7.
Must contain: file:line for each flagged test.

## Negative triggers (agent MUST NOT fire)

### N1: fix request

Scenario: "Fix the wiring-only tests."
Expected: agent does NOT fire — it only reports. Implementer is correct for fixes.
Must NOT write: source or test files.

### N2: coverage run request

Scenario: "Run coverage and tell me if we hit 100%."
Expected: agent does NOT fire. Coverage-auditor is correct.

## Severity calibration

Per the agent's documented severity guidelines:

| Finding | Severity |
|---------|----------|
| Wiring-only test in changed file | High |
| Wiring-only test in unchanged file | Medium |
| Mocked internal module | Medium |
| Security check via mock args only | High |
| Mocked boundary with no paired integration-lane test | Medium |
| Repo has mocked boundaries and no integration lane | Medium (reported once, against the config) |
| Test in the wrong lane per lane-policy | Medium |
| Missing test for error path | Medium |
| Missing test for happy path | High |
| Recorded red receipt with verdict SEPARATION-BROKEN | High |
| Every test for a unit passes against a hard-coded return | High |
| criticalPaths entry with requireSpecLevel unmet | High |
| Unit has a law but no S4-S6 case covers it | Medium |
| Refactor with no behavior change edits existing assertions | Medium |
| Interface with one production implementation and one test double | Medium |
| More distinct mocks in a test than the unit has collaborators | Medium |

Any deviation from these severities without explicit justification is a spec violation.

## Zero-findings rule

If no findings exist, agent MUST state that explicitly — not return an empty report or a "looks good" one-liner. Expected phrase: "No findings. All test files use Level 1-5 assertions; no internal-module mocks; no missing tests detected."

## Purity checks

Allowed tools: `Read, Grep, Glob`. No `Write`, no `Edit`, no `Bash`. Reviewer is strictly read-only.

## Bidirectional-audit rule

The reviewer must report BOTH directions of test defect, not only under-verification:

- **Under-verified**: wiring-only tests, mocked internals, unpaired boundaries, units with a law and no property.
- **Over-coupled (change tax)**: refactors editing existing assertions with no behavior change, single-implementation interfaces existing only to be mocked, mock counts exceeding collaborator counts.

A review that reports only the first direction is a spec violation. Pushing for more verification without the counterweight produces suites nobody dares refactor.

## Receipt-reading rule

If `.claude/tdd-guardian/receipts.json` exists, the reviewer must read it and report every `SEPARATION-BROKEN` verdict as High, naming the files. A missing receipts file is reported as `separation unverified`, never as a violation.

## Output schema

```
# TDD Review Findings

## Code findings
(severity-ordered list with file:line evidence)

## Test quality findings
(wiring-only tests, mocked internals, security via mock args, etc.)

## Specification-strength findings
(units with a law specified only by examples)

## Change-tax findings
(tests coupled to structure rather than behavior)

## Missing-test findings
(paths without coverage of an error branch or happy path)

## Residual risk
(short paragraph)
```
