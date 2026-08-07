---
name: mutation-gate
description: Validate test strength with mutation testing and report weak assertions. Covers the Stryker family (JS/TS, .NET, Scala), PIT (JVM), Infection (PHP), mutmut and cosmic-ray (Python), go-mutesting and gremlins (Go), cargo-mutants (Rust), mutant (Ruby), and muter (Swift).
---

# Mutation Gate

Mutation testing answers the question coverage can't: "would a buggy version of this code slip past my tests?" A mutation tool introduces small, controlled edits ("mutants") — flipping `<` to `<=`, replacing `true` with `false`, deleting statements — and reruns the test suite. A mutant the tests catch is "killed"; one that slips through is a "survivor" and evidence of weak assertions.

## Requirements

1. Run mutation command when `requireMutation=true`.
2. Treat surviving mutants as test-quality defects — the test said "pass" when the code changed meaning.
3. Strengthen assertions or add missing cases until the tool's own score threshold passes.
4. The mutation command's exit code is the source of truth for PASS/FAIL. The score is what you iterate on, but the tool's threshold config decides the gate.

## Per-language tool reference

| Language | Tool | Install | Canonical command | Output path |
|----------|------|---------|-------------------|-------------|
| JS / TS | Stryker | `pnpm add -D @stryker-mutator/core @stryker-mutator/jest-runner` (or `vitest-runner`) | `npx stryker run` | `reports/mutation/mutation.json` |
| Python | mutmut | `pip install mutmut` | `mutmut run && mutmut results --json` | inspected via `mutmut show <id>` |
| Go | go-mutesting | `go install github.com/zimmski/go-mutesting/cmd/go-mutesting@latest` | `go-mutesting ./...` | stdout |
| Rust | cargo-mutants | `cargo install cargo-mutants` | `cargo mutants` | `mutants.out/outcomes.json` |
| Java / Kotlin | PIT | plugin in `pom.xml` / `build.gradle` | `./mvnw org.pitest:pitest-maven:mutationCoverage` | `target/pit-reports/mutations.xml` |
| C# / F# | Stryker.NET | `dotnet tool install -g dotnet-stryker` | `dotnet stryker` | `StrykerOutput/<ts>/reports/mutation-report.json` |
| Scala | stryker4s | plugin in `project/plugins.sbt` | `sbt stryker` | `target/stryker4s-report/<ts>/report.json` |
| PHP | Infection | `composer require --dev infection/infection` | `vendor/bin/infection --logger-json=infection-log.json` | `infection-log.json` |
| Python (alt) | cosmic-ray | `pip install cosmic-ray` | `cosmic-ray exec <cfg> <session>` | `cr-report --json` |
| Go (alt) | gremlins | `go install github.com/go-gremlins/gremlins/cmd/gremlins@latest` | `gremlins unleash` | stdout / JSON |
| Ruby | mutant | `bundle add mutant-rspec` | `bundle exec mutant run` | stdout |
| Swift | muter | `brew install muter-mutation-testing/formulae/muter` | `muter` | `muterReport.json` |

**PIT is the strongest mutation tool in any ecosystem** — if the project is JVM, prefer it over anything else here.

Every tool above is parsed by `commands/shared/parse-mutation.md`. Stryker, Stryker.NET, and stryker4s share one schema (mutation-testing-elements), so a tool not on this list is still supported if it can emit that format — configure that reporter rather than asking for a new parser.

Ecosystems with no mature mutation tool — Elixir (muzak is limited/commercial), Erlang, Haskell (MuCheck is unmaintained), Dart (`mutation_test` is immature) — should leave `requireMutation: false`. That is a fact about the ecosystem, not a gap to paper over; rely on the assertion-hierarchy rules in `policy-core` instead.

Choose the tool that matches the project's test runner — don't try to bolt a JS mutator onto a Python project. If the repo is polyglot, run one tool per language subtree.

## Configuration examples (key settings only)

### Stryker — `stryker.conf.json`

```jsonc
{
  "testRunner": "vitest",
  "coverageAnalysis": "perTest",
  "thresholds": { "high": 95, "low": 85, "break": 80 },
  "mutate": ["src/**/*.ts", "!src/**/*.test.ts"],
  "reporters": ["html", "json", "clear-text"]
}
```

Key knobs: `thresholds.break` is the exit-code gate. `coverageAnalysis: "perTest"` tells Stryker which tests touch which mutant — dramatically faster than re-running the whole suite per mutant.

### mutmut — `pyproject.toml`

```toml
[tool.mutmut]
paths_to_mutate = "src/"
tests_dir = "tests/"
runner = "pytest -x"
```

`runner = "pytest -x"` stops on the first failure per-mutant run, which speeds up the feedback loop. mutmut has no built-in score threshold; compare the returned score to a project constant in the auditor.

### go-mutesting — CLI flags

```
go-mutesting --exec-timeout=10 --disable=branch/case ./internal/...
```

Use `--exec-timeout` to cap slow mutant runs. `--disable` lets you skip equivalent-mutant-prone operators (e.g., `branch/case` often produces equivalent mutants in Go switch statements).

### cargo-mutants — `.cargo/mutants.toml`

```toml
timeout_multiplier = 5.0
examine_globs = ["src/**/*.rs"]
exclude_globs = ["**/tests/**", "**/benches/**"]
```

`cargo mutants` also accepts `--shard` for CI parallelism and `--in-place` to run mutants against the working tree instead of a clone (faster, less safe).

## Mutation operator reference

Mutation tools apply operators in these families. Knowing the family helps you pick the right assertion to kill the mutant.

| Family | Examples | How to kill |
|--------|----------|-------------|
| Conditional boundary | `>` ↔ `>=`, `<` ↔ `<=`, `==` ↔ `!=` | Test the exact boundary value (n, n-1, n+1) |
| Arithmetic | `+` ↔ `-`, `*` ↔ `/`, `%` ↔ `*` | Assert a numeric result, not just truthiness |
| Relational | `<` ↔ `>`, `<=` ↔ `>=` | Test asymmetric inputs (a > b vs a < b vs a == b) |
| Logical | `&&` ↔ `\|\|`, `!x` ↔ `x` | Test cases where the operators diverge (one side true, other false) |
| String literal | `"foo"` → `""`, `"foo"` → `"Stryker was here"` | Assert the exact string, not just non-emptiness |
| Numeric literal | `1` → `0`, `42` → `43` | Assert the exact number |
| Boolean literal | `true` ↔ `false` | Branch on both values |
| Unary / negation | `-x` → `x`, `!x` → `x` | Assert sign or boolean outcome explicitly |
| Statement removal | delete a statement | Assert the side effect the statement produced |

## Common surviving-mutant patterns

These survivors come up constantly. Each has a pattern fix.

### Off-by-one in loops

Survivor: `for (let i = 0; i < n; i++)` → `for (let i = 0; i <= n; i++)` and tests still pass.
Cause: tests never exercise the case where the extra iteration would overflow an array or produce a different result.
Fix: add a test where input length exactly equals `n`, assert the count or the last element.

### Boolean short-circuit

Survivor: `if (a && b)` → `if (a || b)` and tests still pass.
Cause: all tests have either both operands true or both false. The mixed case (`a=true, b=false` or vice versa) is untested.
Fix: add a test with asymmetric operands and assert the correct branch was taken.

### Off-by-zero in default values

Survivor: `const timeout = opts.timeout ?? 5000` → `const timeout = opts.timeout ?? 0` and tests still pass.
Cause: all tests provide a `timeout` opt; the default branch isn't exercised.
Fix: add a test that omits `timeout` and asserts the observable behavior (elapsed time, DB query setting, retry count).

### String-literal leak

Survivor: `throw new Error("Invalid input")` → `throw new Error("")` and tests still pass.
Cause: tests assert `toThrow()` or `toThrow(Error)` but not the message.
Fix: assert `toThrow(/Invalid input/)` or `toThrow(new Error("Invalid input"))`.

### Early-return leak

Survivor: `if (isAdmin) return value` is deleted and tests still pass.
Cause: the admin branch's observable effect is identical to the non-admin path in the test scenario.
Fix: add a test where admin-vs-user produces different output.

### Void return-value leak

Survivor: `void sendEmail(user)` removed, tests still pass.
Cause: no assertion on the side effect (email sent, queue enqueued).
Fix: assert the observable effect — mock transport count, queue length, log entry.

## When to ignore a surviving mutant

Not every survivor is a test-quality defect. Declare these explicitly in the report rather than silently tolerating them:

- **Equivalent mutants** — the mutated code is semantically identical to the original. Example: `x + 0` vs `x`. Common with arithmetic operators on identity elements. Declare with tool-specific syntax (Stryker `// Stryker disable next-line`, mutmut `# pragma: no mutate`).
- **Infeasible code paths** — the mutant only matters in a branch that cannot be reached given preconditions. Example: a null-check on a value that's always non-null by type. Add a type-narrowing test and then disable the mutant with a comment explaining why.
- **Performance-only constants** — a cache size or batch size that doesn't affect correctness. Prefer making the test cover at least one non-default value.

Never ignore a survivor because "it's flaky" — fix the flake first. Never disable a whole file without a paragraph-long rationale in the commit.

## Cross-references

- **coverage-gate** — coverage proves every line is touched; mutation proves every line is checked. Run coverage first; mutation runs on covered code.
- **test-matrix** — the test matrix's boundary and guard categories are what kill conditional-boundary mutants. If your matrix is weak, your mutation score will be weak.
- **policy-core** — the Level 1-5 assertion hierarchy and mock rules are the prerequisites for high mutation scores. Wiring-only tests have near-zero mutation strength because mock-call assertions ignore the code the mutator is changing.

## Scope

Covers mutation testing: per-language tools, mutation operators, and the patterns behind surviving mutants.

Does NOT cover:

| Question | Skill |
|----------|-------|
| How is line and branch coverage enforced? | `tdd-guardian:coverage-gate` |
| What assertion level should the killing test use? | `tdd-guardian:policy-core` |
| Which lane does the killing test belong in? | `tdd-guardian:lane-policy` |
