---
artifact: agents/tdd-mutation-auditor.md
description: Spec for tdd-mutation-auditor — runs mutation testing when enabled, lists surviving mutants, hardens assertions until threshold met.
---

# tdd-mutation-auditor

## Positive triggers (agent SHOULD fire)

### P1: mutation audit request with requireMutation=true

Scenario: config has `requireMutation=true` and `mutationCommand=npx stryker run`; user invokes `/tdd-guardian:audit-mutation`.
Expected: agent fires after pre-check. Runs Stryker, parses results, reports survivors.
Must contain: `# Mutation Audit Report`, `## Gate Result:`, `## Mutation Summary` table, `## Surviving Mutants` table.

### P2: tool pre-check with missing binary

Scenario: `mutationCommand=npx stryker run` but Stryker is not installed.
Expected: agent runs the availability probe, detects missing binary, reports `SKIPPED (tool not available)` with install instructions.
Must contain: `Gate Result: SKIPPED`, install-hint command.

### P3: survivor-kill iteration request

Scenario: after initial run shows 3 survivors, user says "strengthen the tests to kill the survivors."
Expected: agent fires. Proposes boundary tests per mutator category, iterates until threshold passes or BLOCKED with explicit evidence.
Must contain: `## Actions Taken` table linking each survivor to a test added/modified.

## Negative triggers (agent MUST NOT fire)

### N1: requireMutation=false

Scenario: config has `requireMutation=false`; user invokes `/tdd-guardian:audit-mutation`.
Expected: agent does NOT fire. The command responds with a "disabled" message and stops.

### N2: coverage gate request

Scenario: "Check coverage thresholds."
Expected: agent does NOT fire. Coverage-auditor is correct.

## Tool-availability pre-check rule

Before ANY mutation run, agent MUST probe the tool:
- `npx stryker --version` (Stryker)
- `mutmut --version` (mutmut)
- `go-mutesting --help` (go-mutesting)
- `cargo mutants --version` (cargo-mutants)

If probe fails, agent MUST stop with `SKIPPED` verdict and install hint. MUST NOT attempt to install the tool itself.

## Equivalent-mutant declaration rule

Any mutant ignored as "equivalent" MUST be declared in `## Surviving Mutants` with a `Fix: equivalent mutant — {rationale}` entry. Silent tolerance is a spec violation.

## Output schema

```
# Mutation Audit Report

## Gate Result: PASS | FAIL | SKIPPED (tool not available)

## Mutation Summary
| Metric | Value |
|--------|-------|
| Total mutants | N |
| Killed | N |
| Survived | N |
| Score | X% |

## Surviving Mutants
| # | File:Line | Mutant Type | Original | Mutated | Fix |

## Actions Taken
| # | Mutant | Test Added/Modified | Result |

## Final Status: PASS | BLOCKED
```

## Purity checks

Allowed tools: `Read, Write, Edit, Bash, Grep, Glob, LS, TodoWrite`. `Write`/`Edit` is limited to test files when iterating on survivors — agent MUST NOT edit source files to "silence" mutants.
