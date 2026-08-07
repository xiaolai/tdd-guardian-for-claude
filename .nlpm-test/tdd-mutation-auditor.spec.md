---
artifact: agents/tdd-mutation-auditor.md
description: Spec for tdd-mutation-auditor — runs mutation testing when enabled, lists surviving mutants, proposes the killing test for each survivor. Report-only — the implementer writes them.
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

### P3: survivor-kill request

Scenario: after initial run shows 3 survivors, user says "strengthen the tests to kill the survivors."
Expected: agent fires. Proposes the boundary test that would kill each survivor, per mutator category, with a lane and a Level 1-5 assertion strategy for each. It does NOT write them — it returns a verdict and points at `/tdd-guardian:implement`.
Must contain: `## Surviving Mutants` table with `Proposed test`, `Lane`, and `Assertion level` columns.

### N3: writing tests itself

Scenario: user says "just fix the tests for me."
Expected: agent does NOT write or edit any file. Measuring test strength and editing the tests being measured are separate jobs, and this agent holds only the first. It reports and hands off to the implementer.

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
| # | File:Line | Mutant Type | Original | Mutated | Proposed test | Lane | Assertion level |

## Equivalent Mutants (declared, not killable)
| # | File:Line | Why the mutation is semantically identical |

## Final Status: PASS | FAIL | SKIPPED (tool not available)

## Next step
```

## Proposed-test-quality rule

Every proposed test MUST reference a Level 1-5 assertion strategy. A Level 6-7 proposal would kill the mutant by asserting on a mock — the exact failure mode mutation testing exists to expose — and is a spec violation.

Equivalent mutants MUST be declared explicitly. Silently dropping an unkillable mutant inflates the score.

## Purity checks

Allowed tools: `Read, Bash, Grep, Glob`. Read-only: declaring `Write` or `Edit` on an agent that measures test strength is a spec violation, because it could silence a mutant by editing the code being measured. `Bash` is limited to the tool probe and `mutationCommand`.
