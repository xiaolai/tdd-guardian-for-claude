---
artifact: agents/tdd-coverage-auditor.md
description: Spec for tdd-coverage-auditor — runs coverage, compares against thresholds, lists uncovered code, proposes tests. Never edits source or test files.
---

# tdd-coverage-auditor

## Positive triggers (agent SHOULD fire)

### P1: coverage gate request

Scenario: "Verify the project meets the 100% branch coverage threshold."
Expected: agent fires. Runs `coverageCommand`, parses summary, compares against thresholds, emits PASS/FAIL verdict.
Must contain: `# Coverage Audit Report`, `## Gate Result:`, `## Coverage Summary` table with 4 rows (lines/functions/branches/statements).

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

Allowed tools: `Read, Bash, Grep, Glob, LS, TodoWrite`. Bash is for `coverageCommand` only. Agent MUST NOT run test commands without coverage, run git commands, or edit files.

## Ignore-directive audit

The agent MUST include `## Coverage Ignore Audit` section per the coverage-gate skill — flagging any `/* v8 ignore next */` or `/* v8 ignore next N */` directives found in source files.

## Output schema

```
# Coverage Audit Report

## Gate Result: PASS | FAIL

## Coverage Summary
| Metric | Actual | Threshold | Status |
|--------|--------|-----------|--------|
| Lines | X% | X% | PASS/FAIL |
| ... (4 rows)

## Uncovered Code
| # | File | Lines/Branches | Description |
|---|------|----------------|-------------|

## Proposed Tests
| # | Target | Test Description | Assertion Level |
|---|--------|------------------|-----------------|

## Coverage Ignore Audit
<results>
```

## Proposed-test-quality rule

Every row in the Proposed Tests table MUST reference a Level 1-5 assertion strategy. A proposed test at Level 6-7 is a spec violation.
