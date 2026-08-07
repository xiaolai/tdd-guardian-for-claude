---
description: "Shared: parse and merge coverage across 9 formats — Istanbul, coverage.py, LCOV, Cobertura, JaCoCo, Clover, go-cover, SimpleCov"
user-invocable: false
---
<!-- Shared partial: coverage parser -->
<!-- Referenced by: audit-coverage, status, gate, workflow. Do not use standalone. -->

## Purpose

Read each contributing lane's coverage report, normalize it, and merge the results so the gate can compare against thresholds without caring which tools produced them.

This is implemented in `scripts/tdd-guardian/lib/coverage.js` and covered by `tests/coverage.test.js`. **Run it rather than parsing by hand** — hand-parsing XML and LCOV in a prompt is where wrong numbers come from:

```bash
node -e "
const c=require('<plugin-root>/scripts/tdd-guardian/lib/coverage.js');
const r=['<path1>','<path2>'].map(p=>c.parseFile(p,process.cwd()));
const errs=r.filter(x=>x.error).map(x=>x.error);
if(errs.length){console.error(errs.join('\n'));process.exit(1)}
const merged=c.mergeReports(r.map(x=>x.report));
console.log(JSON.stringify({merged:merged.totals,method:merged.method,approximate:merged.approximate,formats:merged.formats},null,2));
"
```

## Step 1 — Locate each report

For every lane with `coverage: "include"`, resolve its `coverageSummaryPath` against the workspace root. If a file is missing:

```
Coverage summary not found at {coverageSummaryPath}.

Likely causes:
1. The coverage command has not run yet.
2. The coverage command ran but wrote elsewhere — check your reporter config.
3. coverageSummaryPath in config is wrong — re-run /tdd-guardian:init.
```

And STOP. A missing report is never zero coverage.

## Step 2 — Detect the format

Detection is by content, with the file extension as a last resort only.

| Signal | Format |
|--------|--------|
| `mode: set\|count\|atomic` on the first line | `go-cover` |
| Lines starting `TN:` or `SF:` | `lcov` |
| XML with `<report>` and a jacoco DTD/marker | `jacoco` |
| XML with `<coverage line-rate=…>` or `lines-valid=` | `cobertura` |
| XML with `<coverage>` and `<project>` | `clover` |
| JSON with `totals.num_statements`, or `files.*.summary` | `coverage-py` |
| JSON with `total.lines.pct` | `istanbul-summary` |
| JSON whose values have `statementMap` and `s` | `istanbul-final` |
| JSON whose values have a `coverage` key | `simplecov` |

Unrecognized content stops with the format list and the first 80 characters, so the user can see what was actually read.

## Step 3 — Normalize

Every parser returns:

```
{
  format: string,
  hasLineDetail: boolean,
  totals: { lines: M|null, functions: M|null, branches: M|null, statements: M|null },
  files: [{ path, lines: M|null, functions: M|null, branches: M|null, statements: M|null,
            lineHits: {line: hits}|null, uncoveredLines: [n] }]
}
```

where `M` is `{covered, total, pct}` and percentages are rounded to 2 decimals.

Format-specific mappings worth knowing:

| Format | Notes |
|--------|-------|
| `istanbul-summary` | Totals only, **no per-line detail** — forces the weighted merge fallback |
| `istanbul-final` | Line hits derived from `statementMap` + `s`; branches from `b` arrays |
| `coverage-py` | Statements and lines are the same axis; functions `null`; branches only with `branch = true` |
| `lcov` | `LF`/`LH` for lines, `FNF`/`FNH` for functions, `BRF`/`BRH` for branches; statements mirror lines |
| `cobertura` | Root `lines-valid`/`lines-covered` preferred over the per-class scan; branches from `condition-coverage` |
| `jacoco` | `LINE`/`BRANCH`/`METHOD` counters; `INSTRUCTION` is bytecode-level so statements mirror lines instead |
| `clover` | Project `<metrics>` preferred; `type="method"` lines are functions, `type="cond"` lines carry `truecount`/`falsecount` rather than `count` |
| `go-cover` | Statements weighted by `NumStmt`; functions and branches `null` |
| `simplecov` | Array indexed by line; `null` entries are lines the tool does not track and must not count toward the total |

## Step 4 — Merge across lanes

| Lanes | Method | Accuracy |
|-------|--------|----------|
| 1 | `single` | Exact |
| 2+, all with `hasLineDetail` | `union` | Exact — a line hit by any lane counts once |
| 2+, at least one without | `weighted` | **Approximate** — sums covered/total, so a line hit by two lanes is counted twice |

When the merge is `weighted`, the report MUST say so. A weighted number quoted as if it were a union is a wrong number presented confidently. Tell the user which lane forced the fallback and that emitting LCOV or Cobertura from it would make the merge exact.

## Step 5 — Null-aware comparison

`null` means "this tool does not measure this dimension" — NOT zero.

- Threshold `> 0` and metric is `null` → **WARNING**: `{metric} coverage is not measured by {format}. Configure your coverage tool to emit it, or set the {metric} threshold to 0.`
- Metric is a number below threshold → **FAILURE**, reported with covered/total counts, not just the percentage.

This prevents false failures on tools that legitimately do not track a dimension — go-cover has no functions or branches, coverage.py has no functions, SimpleCov has neither by default.

## Step 6 — Reject an empty report

If the merged totals have zero measurable lines and statements, FAIL with:

```
Coverage report contains zero measurable lines. The coverage run almost certainly produced nothing.
Formats read: {formats}. Check that the coverage command instruments your source and writes to coverageSummaryPath.
```

By the 0/0 convention an empty report scores 100%, so without this check a silent no-op coverage run passes every threshold and looks perfect.
