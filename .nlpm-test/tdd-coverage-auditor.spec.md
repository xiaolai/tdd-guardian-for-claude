---
artifact: agents/tdd-coverage-auditor.md
description: Spec for tdd-coverage-auditor — runs the coverage-contributing lanes, merges their reports, compares against thresholds, lists uncovered code, proposes tests. Never edits source or test files.
---

# tdd-coverage-auditor

## Positive triggers (agent SHOULD fire)

### P1: coverage gate request

Scenario: "Verify the project meets the 100% branch coverage threshold."
Expected: agent fires. Runs every lane with `coverage: "include"`, merges the reports, compares the merged totals against thresholds, emits PASS/FAIL verdict.
Must contain: `# Coverage Audit Report`, `## Gate Result:`, a `**Merge**:` line, `## Coverage Summary` table with 4 rows (lines/functions/branches/statements) carrying covered/total counts.

### P2: dispatch from /tdd-guardian:audit-coverage

Scenario: user invokes `/tdd-guardian:audit-coverage`.
Expected: audit-coverage command dispatches the agent; agent returns the report.
Must contain: `## Uncovered Code` table, `## Proposed Tests` table with `Assertion Level` column populated.

### P3: scoped audit request

Scenario: "Audit coverage focused on src/queue.ts."
Expected: agent fires; per-file focus filters the Uncovered Code table to that path.

## Negative triggers (agent MUST NOT fire)

### N1: implementation request

Scenario: "Add the missing tests to bring coverage to 100%."
Expected: agent does NOT fire. It proposes tests in the report but does NOT write them. The implementer writes tests.
Must NOT write: test files, source files.

### N2: mutation testing request

Scenario: "Run mutation testing."
Expected: agent does NOT fire. Mutation-auditor is correct.

## Purity checks

Allowed tools: `Read, Bash, Grep, Glob`. Bash is for the coverage-contributing lanes only. Agent MUST NOT run test commands without coverage, run git commands, or edit files.

## Ignore-directive audit

The agent MUST include `## Coverage Ignore Audit` section per the coverage-gate skill — flagging any `/* v8 ignore next */` or `/* v8 ignore next N */` directives found in source files.

## Null-metric rule

A metric the report format does not measure is `null`, not zero. With a non-zero threshold the agent MUST emit `WARN — not measured by <format>`, never `FAIL`. Reporting `0%` or `FAIL` for an unmeasured dimension is a spec violation.

Applies to: go-cover (no functions, no branches), coverage.py (no functions), SimpleCov without branch coverage.

## Empty-report rule

A merge with zero measurable lines MUST fail. It scores 100% under the 0/0 convention, so passing it would turn a silent no-op coverage run into a green gate.

## Approximate-merge rule

When the merge method is `weighted`, the agent MUST say so and name the lane whose summary-only format forced the fallback. Presenting a weighted average as a union is a spec violation.

## Output schema

```
# Coverage Audit Report

## Gate Result: PASS | FAIL

**Lanes**: <names>
**Merge**: single | union | weighted (APPROXIMATE)
**Formats**: <formats read>

## Coverage Summary
| Metric | Actual | Threshold | Status |
|--------|--------|-----------|--------|
| Lines | X% (C/T) | X% | PASS/FAIL |
| Branches | n/a | X% | WARN — not measured by <format> |
| ... (4 rows)

## Uncovered Code
| # | File | Lines/Branches | Lane | Description |
|---|------|----------------|------|-------------|

## Proposed Tests
| # | Target | Lane | Test Description | Assertion Level |
|---|--------|------|------------------|-----------------|

## Coverage Ignore Audit
<results>
```

## Proposed-test-quality rule

Every row in the Proposed Tests table MUST reference a Level 1-5 assertion strategy. A proposed test at Level 6-7 is a spec violation.

Every row MUST also carry a lane. Closing an integration-level gap with a mocked unit test raises the number without verifying the behavior, and is a spec violation.
