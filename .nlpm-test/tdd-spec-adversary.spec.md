---
artifact: agents/tdd-spec-adversary.md
description: Spec for tdd-spec-adversary — attacks a test matrix before any implementation exists, looking for the simplest wrong implementation that passes every listed case. Report-only, read-only.
---

# tdd-spec-adversary

## Positive triggers (agent SHOULD fire)

### P1: dispatch from /tdd-guardian:design-tests

Scenario: the test designer has written `.claude/tdd-guardian/tests-{ts}.md` and the command reaches its attack step.
Expected: agent fires. Reads the matrix and the plan, works the ten attacks per unit, returns a verdict.
Must contain: `## Verdict: SURVIVED` or `## Verdict: GAPS FOUND ({n})`.

### P2: explicit attack request on an existing matrix

Scenario: "Attack the test matrix for the transfer function — could a wrong implementation pass all of it?"
Expected: agent fires; proposes concrete passing-but-wrong implementations.
Must contain: for each gap, a `Passing-but-wrong implementation` block and a named `Missing case` with an S-level.

### P3: under-specified example-only matrix

Scenario: a matrix for `transfer()` asserts only the resulting balances in three examples.
Expected: agent fires and reports the "half the operation" attack — an implementation that credits without debiting satisfies all three.
Must propose: a conservation invariant at S5, not three more balance examples.

## Negative triggers (agent MUST NOT fire)

### N1: after the implementation exists

Scenario: "The code is written and tests are green — check the tests are good."
Expected: agent does NOT fire. `tdd-reviewer` is correct; the adversary's value is that it runs before an implementation can contaminate the judgement.

### N2: fix request

Scenario: "Add the missing property test you found."
Expected: agent does NOT fire — it reports gaps only. `tdd-test-designer` redesigns the matrix; `tdd-implementer` writes tests.
Must NOT write: any file, including the matrix.

### N3: coverage or mutation question

Scenario: "Which branches are uncovered?"
Expected: agent does NOT fire. Coverage-auditor and mutation-auditor are correct.

## Attack coverage

The agent must work through all ten documented attacks per unit and report which were defeated:

hard-coded return, lookup table, half the operation, no state transition, ignored argument, wrong-but-close boundary, silent failure, non-idempotent, order-dependent, unbounded.

Reporting only the gaps without the `Attacks defeated by the existing matrix` table is a spec violation — a reader cannot tell an exhaustive attack from an abandoned one.

## Non-findings rule

The agent MUST NOT report as a gap:

- a behavior the plan's **Deferred / Out of Scope** section names
- an attack a listed case already defeats, even if the case is worded loosely
- a wrong implementation nobody would write and no refactor would produce by accident
- a missing property for a unit the matrix explicitly records as having no law

## Clean-verdict rule

If the matrix survives every attack, the agent MUST say so plainly with `## Verdict: SURVIVED` and the defeated-attacks table. Inventing a marginal gap to look thorough is a spec violation.

## Economy rule

Where one S4-S6 case would defeat several attacks, the agent MUST propose that case rather than one example per attack. A conservation invariant defeats "half the operation", "ignored argument", and "non-idempotent" together.

## Purity checks

Allowed tools: `Read, Grep, Glob`. No `Write`, no `Edit`, no `Bash`. The agent never runs tests and never edits the matrix it attacks.

## Output schema

```
# Specification Attack — {matrix path}

## Verdict: SURVIVED | GAPS FOUND ({n})

## Unit: {module}#{function}

### Gap {n}: {attack name}
- Attack:
- Passing-but-wrong implementation:
- Why every listed case passes:
- What it would break in production:
- Missing case: (Level S1-S6, Lane, Assertion)

## Attacks defeated by the existing matrix
(table)

## Units with no law
(list, with the reason each is exempt)
```
