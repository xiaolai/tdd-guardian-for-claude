---
description: "Shared: parse mutation testing output into score + survivor list across the Stryker family, PIT, Infection, mutmut, go-mutesting, cargo-mutants, and any tool emitting the mutation-testing-elements schema"
user-invocable: false
---
<!-- Shared partial: mutation result parser -->
<!-- Referenced by: audit-mutation, status, workflow. Do not use standalone. -->

## Purpose

Parse the output of the configured mutation tool into a normalized `{score, killed, survived, survivors[]}` shape. Only survivors get reported back to the user in detail — killed mutants are aggregated as a count.

## Steps

### Step 1 — Identify the tool

Inspect `mutationCommand` from config (and the produced output path):

| Command contains | Tool | Report format |
|------------------|------|---------------|
| `stryker` (npx/npm) | Stryker (JS/TS) | mutation-testing-elements JSON |
| `dotnet stryker` | Stryker.NET (C#/F#) | mutation-testing-elements JSON |
| `sbt stryker` / `stryker4s` | stryker4s (Scala) | mutation-testing-elements JSON |
| `pitest` / `pitest-maven` / `gradlew pitest` | PIT (Java/Kotlin/Groovy) | PIT XML |
| `infection` | Infection (PHP) | Infection JSON |
| `mutmut` | mutmut (Python) | `mutmut results --json` |
| `cosmic-ray` | cosmic-ray (Python) | `cr-report --json` |
| `go-mutesting` | go-mutesting (Go) | text |
| `gremlins` | gremlins (Go) | text / JSON |
| `cargo mutants` / `cargo-mutants` | cargo-mutants (Rust) | `outcomes.json` |
| `mutant` (with `bundle exec`) | mutant (Ruby) | text |
| `muter` | muter (Swift) | JSON |

**Stryker, Stryker.NET, and stryker4s share one schema** — the [mutation-testing-elements](https://github.com/stryker-mutator/mutation-testing-elements) report format. Parse all three with the same code path; only the default output path differs.

If the tool cannot be identified from the command, do NOT stop immediately. Check whether the report file it produced matches a known schema:

| Report shape | Treat as |
|--------------|----------|
| JSON with a top-level `files` object whose values have a `mutants` array | mutation-testing-elements |
| XML with `<mutations>` and `<mutation status=…>` elements | PIT XML |
| JSON with `escaped` / `killed` / `notCovered` counters | Infection |

Only when neither the command nor the report shape resolves, stop with:

```
Unknown mutation tool in mutationCommand '{cmd}', and the report at '{path}' matches no known schema.

Supported commands: stryker, dotnet stryker, stryker4s, pitest, infection, mutmut,
cosmic-ray, go-mutesting, gremlins, cargo-mutants, mutant, muter.

If your tool can emit the mutation-testing-elements JSON schema, configure that
reporter — it is the widest-supported format and the gate parses it directly.
```

State which fields you used for any tool you parse by schema rather than by name, so the numbers can be checked.

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

#### Stryker.NET and stryker4s

Identical schema to Stryker above. Only the default path differs:

| Tool | Default report |
|------|----------------|
| Stryker.NET | `StrykerOutput/<timestamp>/reports/mutation-report.json` |
| stryker4s | `target/stryker4s-report/<timestamp>/report.json` |

Both nest under a timestamp directory, so resolve the newest match rather than hardcoding a path — or set the tool's `--output` flag in `mutationCommand` to pin it, which is the more reliable option.

#### PIT (Java, Kotlin, Groovy)

Default report: `target/pit-reports/mutations.xml` (Maven) or `build/reports/pitest/mutations.xml` (Gradle). Requires `<outputFormats><value>XML</value></outputFormats>` — the HTML default is not machine-readable.

Each mutant is a `<mutation detected="true|false" status="…">` element containing `<sourceFile>`, `<mutatedClass>`, `<mutatedMethod>`, `<lineNumber>`, `<mutator>`, and `<description>`.

| PIT status | Counts as |
|------------|-----------|
| `KILLED` | killed |
| `SURVIVED` | survived |
| `NO_COVERAGE` | survived — the line was never executed, which is worse than a survivor |
| `TIMED_OUT` | killed (the mutation broke the program badly enough to hang) |
| `NON_VIABLE` / `MEMORY_ERROR` | excluded from the denominator |
| `RUN_ERROR` | excluded, but report the count — a nonzero value means PIT itself failed on those mutants |

Score = `killed / (killed + survived)` × 100, after the exclusions above. The `<mutator>` value is a fully-qualified class name — report its last segment (`ConditionalsBoundaryMutator`) rather than the whole string.

#### Infection (PHP)

Default report: `infection-log.json` when `--logger-json` is set; the summary also prints to stdout.

- `stats.killedCount`, `stats.escapedCount`, `stats.errorCount`, `stats.timedOutCount`, `stats.notCoveredCount`
- `escaped[]` carries each survivor with `mutator.mutatorName`, `mutator.originalFilePath`, `mutator.originalStartLine`, and a unified `diff`

Infection reports two scores: **MSI** (mutation score indicator, over all mutants) and **covered MSI** (over covered code only). Report MSI as the gate score and mention covered MSI alongside — quoting only covered MSI hides untested code, which is the number that matters most.

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
