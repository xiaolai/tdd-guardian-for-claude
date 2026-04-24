---
description: "Shared: parse mutation testing output into score + survivor list across Stryker, mutmut, go-mutesting, cargo-mutants"
user-invocable: false
---
<!-- Shared partial: mutation result parser -->
<!-- Referenced by: tdd-guardian-audit-mutation, tdd-guardian-status, tdd-guardian-workflow. Do not use standalone. -->

## Purpose

Parse the output of the configured mutation tool into a normalized `{score, killed, survived, survivors[]}` shape. Only survivors get reported back to the user in detail — killed mutants are aggregated as a count.

## Steps

### Step 1 — Identify the tool

Inspect `mutationCommand` from config (and the produced output path):

| Command contains | Tool |
|------------------|------|
| `stryker` | Stryker (JS/TS) |
| `mutmut` | mutmut (Python) |
| `go-mutesting` | go-mutesting (Go) |
| `cargo mutants` / `cargo-mutants` | cargo-mutants (Rust) |

If the tool can't be identified, stop with: `Unknown mutation tool in mutationCommand '{cmd}'. Supported: stryker, mutmut, go-mutesting, cargo-mutants.`

### Step 2 — Locate and parse the output

#### Stryker

Default report: `reports/mutation/mutation.json` (Stryker `json` reporter).

Parse the `files` object; each file contains a `mutants` array. For each mutant:
- `status`: `Killed` | `Survived` | `NoCoverage` | `Timeout` | `RuntimeError` | `CompileError` | `Ignored`
- `mutatorName`: e.g., `ConditionalExpression`, `ArithmeticOperator`, `StringLiteral`
- `location.start.line`, `location.end.line`
- `replacement`: the mutated source
- `original`: reconstruct from source file + location

Score = `killed / (killed + survived + timeout + noCoverage)` × 100. Stryker also writes the score to `reports/mutation/mutation.json` as a top-level field — prefer that.

#### mutmut

Run `mutmut results --json` after `mutmut run`. Output contains:
- `total`, `killed`, `survived`, `timeout`, `suspicious`

Per-mutant detail via `mutmut show <id>`. Gather survivors by running `mutmut results` and parsing ids with status `Survived`, then `mutmut show {id}` for each.

Score = `killed / total` × 100.

#### go-mutesting

stdout-based. Parse lines like:

```
PASS "path/file.go" with checksum ... (1/42)
FAIL "path/file.go" with checksum ... (2/42) — mutant survived
```

- `PASS` means the mutant was killed (test caught it)
- `FAIL` means the mutant survived

Collect filename, line (from the diff output that follows), and the mutation operator (go-mutesting logs operator name per run). Score appears in the final line: `The mutation score is 0.750000 (6 passed, 2 failed, 0 duplicated, 0 skipped, total is 8)`.

#### cargo-mutants

Output: `mutants.out/outcomes.json`. Each entry has:
- `outcome`: `"caught"` (killed) | `"missed"` (survived) | `"timeout"` | `"unviable"`
- `scenario.mutants[0]`: includes `file`, `line`, `function`, `replacement`

Score = `caught / (caught + missed + timeout)` × 100.

### Step 3 — Classify mutant types

Normalize the tool-specific mutator name into a category for the auditor to display:

| Category | Stryker names | mutmut | go-mutesting | cargo-mutants |
|----------|---------------|--------|--------------|---------------|
| Conditional boundary | `ConditionalExpression`, `EqualityOperator` | `e` (equality) | `branch/case` | `replace_binary_operator_eq_ne` |
| Arithmetic | `ArithmeticOperator` | `o` (operator) | `expression/arithmetic` | `replace_binary_operator` |
| Logical | `LogicalOperator` | `l` (logical) | `branch/case` | `replace_binary_operator` |
| String / literal | `StringLiteral`, `BooleanLiteral` | `k` (constant) | n/a | `replace_string_literal` |
| Negation / unary | `UnaryOperator`, `BooleanLiteral` | `u` | `expression/remove` | `replace_unary_operator` |
| Removal | `BlockStatement` | `r` | `statement/remove` | `replace_function_body` |

Unknown mutator names pass through as `category: "other"` with the original name preserved.

### Step 4 — Return shape

```
{
  tool: "stryker" | "mutmut" | "go-mutesting" | "cargo-mutants",
  score: number,
  killed: number,
  survived: number,
  timeout: number,
  noCoverage: number,
  total: number,
  survivors: [
    {
      file: string,
      line: number,
      category: string,
      mutator: string,
      original: string,
      replacement: string
    }
  ]
}
```

Survivors are sorted by file, then line ascending. Cap the survivors list at 100 entries for caller display; return the remaining count separately as `additionalSurvivors` so the caller can say "N more survivors not shown; see report at {path}".

### Step 5 — Threshold comparison

The calling command owns threshold logic, not this partial. Return the raw score and let the caller compare against its own rule (e.g., mutation tool's own config threshold, or a config-level override). The tool's own exit code remains the source of truth for PASS/FAIL — this partial provides the detail view.
