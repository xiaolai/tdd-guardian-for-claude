---
description: "Shared: parse coverage output into normalized metrics across Jest/Vitest, LCOV, cobertura, Go cover, coverage.py"
user-invocable: false
---
<!-- Shared partial: coverage parser -->
<!-- Referenced by: tdd-guardian-audit-coverage, tdd-guardian-status, tdd-guardian-workflow. Do not use standalone. -->

## Purpose

Read the coverage summary file at `{coverageSummaryPath}` and normalize it into a single shape so the coverage-auditor and status commands can compare against thresholds without caring about the source format.

## Steps

### Step 1 — Locate the file

Read `{coverageSummaryPath}` from config (resolved against workspace root). If missing:

```
Coverage summary not found at {coverageSummaryPath}.

Likely causes:
1. Coverage command has not been run yet — run the full gate first.
2. Coverage command completed but wrote the output elsewhere — check your runner's coverage reporter config.
3. The `coverageSummaryPath` in config is wrong — re-run /tdd-guardian:tdd-guardian-init or edit it by hand.
```

And STOP.

### Step 2 — Detect format

Sniff the first non-whitespace bytes and the file extension:

| Hint | Format |
|------|--------|
| Starts with `{` and has a top-level `total` key | Istanbul JSON summary (Jest, Vitest, nyc) |
| Starts with `{` and has `coverage_percent` or `files` | coverage.py JSON |
| Starts with `{` and has `data[0].totals` with `percent_covered` | coverage.py v7+ JSON |
| Starts with `TN:` or `SF:` | LCOV info (node --test, cargo-llvm-cov lcov) |
| Starts with `<?xml` and root `<coverage>` | Cobertura XML (cargo-tarpaulin, others) |
| Starts with `mode:` and lines like `path/file.go:start.col,end.col N M` | Go cover profile |

If the file doesn't match any known format, stop with: `Unrecognized coverage format at {path}. First bytes: {first-80-chars}`.

### Step 3 — Extract per-format

#### Istanbul JSON summary

```
total.lines.pct       → lines
total.functions.pct   → functions
total.branches.pct    → branches
total.statements.pct  → statements
```

Per-file breakdown is available under the top-level object keys (one entry per source file).

#### coverage.py JSON

Older format (`coverage json` pre-v7):
- `totals.percent_covered` → lines (coverage.py tracks statements/branches; map statement coverage to both `lines` and `statements` fields)
- `totals.percent_covered_display` is a string — prefer the numeric `percent_covered`
- If `--branch` was enabled, use `totals.num_branches` / `totals.covered_branches` to compute branches %
- `functions` is not tracked by coverage.py — return `null` (callers must treat null as "not measured" and not fail thresholds on it)

v7+ format:
- `data[0].totals.percent_covered` and `.num_branches` / `.covered_branches` as above.

#### LCOV

Aggregate across all `SF:` blocks:
- `LH:` summed / `LF:` summed → lines %
- `FNH:` summed / `FNF:` summed → functions %
- `BRH:` summed / `BRF:` summed → branches %
- `statements` is not tracked — mirror `lines` into it.

#### Cobertura XML

- `coverage[@line-rate]` × 100 → lines (and statements — cobertura treats them as one)
- `coverage[@branch-rate]` × 100 → branches
- Functions: compute from `<method>` elements if present, else null.

#### Go cover profile

Parse every line `path:start.col,end.col NumStmt Count`. Sum `NumStmt` where `Count > 0` and where total.
- `statements` = covered / total × 100
- Mirror to `lines`.
- Go cover does not track functions or branches — return null for both.

### Step 4 — Normalize

Return to the caller:

```
{
  format: "istanbul-json" | "coverage-py" | "lcov" | "cobertura" | "go-cover",
  totals: {
    lines: number | null,
    functions: number | null,
    branches: number | null,
    statements: number | null
  },
  perFile: [
    { path: string, lines: number, functions: number | null, branches: number | null, statements: number | null, uncoveredLines: number[] }
  ]
}
```

All percentages are rounded to 2 decimal places. Uncovered lines come from the per-file data where available (`lines.details`, `SF:DA:` zero hits, or `Count == 0` ranges for Go).

### Step 5 — Null-aware comparison rule

Null means "this metric is not measured by this tool" — NOT zero. When comparing against thresholds:

- If the threshold is `> 0` and the metric is `null`, return a WARNING (not a failure) with: `{metric} coverage is not measured by {format}. Configure your coverage tool to emit it, or lower the threshold to 0.`
- If the metric is a number below threshold, that's a FAILURE.

This prevents false failures on tools that legitimately don't track a dimension (e.g., functions in LCOV-only output).
