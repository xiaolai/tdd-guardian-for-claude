---
name: tooling-catalog
description: Per-language catalog of test runners, coverage tools, coverage formats, mutation tools, and dry-run probe commands. Use when detecting a repository's test tooling or configuring a lane for any language.
---

# Tooling Catalog

Reference data for configuring TDD Guardian lanes in any language. The detection *method* lives in `commands/shared/detect-tooling.md`; this skill holds the *facts* it needs.

**Read the index below, identify the ecosystem, then read only that reference file.** Loading the whole catalog wastes context — each file is self-contained.

## Reference index

| File | Languages |
|------|-----------|
| `references/js-ts.md` | JavaScript, TypeScript, Node.js, Deno, Bun |
| `references/python.md` | Python |
| `references/jvm.md` | Java, Kotlin, Scala, Clojure, Groovy |
| `references/dotnet.md` | C#, F#, VB.NET |
| `references/native.md` | C, C++, Rust, Go, Zig, Swift, Objective-C |
| `references/dynamic.md` | Ruby, PHP, Perl, Lua |
| `references/functional.md` | Elixir, Erlang, Haskell, OCaml |
| `references/data-mobile.md` | Dart/Flutter, R, Julia, Shell |
| `references/e2e.md` | Cross-language e2e, integration, contract, and load tooling |

## Manifest fingerprints

Find every match, not just the first — a repo matching more than one is polyglot, and each ecosystem needs its own lane.

| Manifest | Ecosystem | Reference |
|----------|-----------|-----------|
| `package.json` | Node/TS | `js-ts.md` |
| `deno.json`, `deno.jsonc` | Deno | `js-ts.md` |
| `bunfig.toml` | Bun | `js-ts.md` |
| `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt`, `tox.ini` | Python | `python.md` |
| `pom.xml` | Java/Kotlin (Maven) | `jvm.md` |
| `build.gradle`, `build.gradle.kts` | Java/Kotlin (Gradle) | `jvm.md` |
| `build.sbt` | Scala | `jvm.md` |
| `deps.edn`, `project.clj` | Clojure | `jvm.md` |
| `*.csproj`, `*.fsproj`, `*.sln`, `Directory.Build.props` | .NET | `dotnet.md` |
| `go.mod` | Go | `native.md` |
| `Cargo.toml` | Rust | `native.md` |
| `CMakeLists.txt`, `Makefile`, `meson.build`, `conanfile.txt` | C/C++ | `native.md` |
| `build.zig` | Zig | `native.md` |
| `Package.swift`, `*.xcodeproj` | Swift | `native.md` |
| `Gemfile`, `*.gemspec` | Ruby | `dynamic.md` |
| `composer.json` | PHP | `dynamic.md` |
| `cpanfile`, `Makefile.PL` | Perl | `dynamic.md` |
| `*.rockspec` | Lua | `dynamic.md` |
| `mix.exs` | Elixir | `functional.md` |
| `rebar.config` | Erlang | `functional.md` |
| `*.cabal`, `stack.yaml`, `package.yaml` | Haskell | `functional.md` |
| `dune-project` | OCaml | `functional.md` |
| `pubspec.yaml` | Dart/Flutter | `data-mobile.md` |
| `DESCRIPTION` + `tests/testthat/` | R | `data-mobile.md` |
| `Project.toml` | Julia | `data-mobile.md` |
| `*.bats`, `test/bats/` | Shell | `data-mobile.md` |

## Coverage formats the gate can read

Every parser is implemented in `scripts/tdd-guardian/lib/coverage.js` and covered by `tests/coverage.test.js`.

| Format | Produced by | Per-line detail |
|--------|-------------|-----------------|
| `istanbul-summary` | Jest, Vitest, nyc (`coverage-summary.json`) | No |
| `istanbul-final` | Jest, Vitest, nyc (`coverage-final.json`) | Yes |
| `lcov` | node:test, c8, cargo-llvm-cov, lcov, Flutter, bisect_ppx, Deno | Yes |
| `cobertura` | tarpaulin, coverlet, gcovr, scoverage, covr, pytest-cov | Yes |
| `jacoco` | JaCoCo (Java/Kotlin/Scala/Groovy) | Yes |
| `clover` | PHPUnit, Pest | Yes |
| `coverage-py` | coverage.py / pytest-cov JSON | Yes |
| `go-cover` | `go test -coverprofile` | Yes |
| `simplecov` | SimpleCov `.resultset.json` (Ruby) | Yes |

**Prefer a per-line format whenever more than one lane contributes coverage.** Only per-line data merges as a true union; summary-only reports fall back to a weighted average that double-counts any line exercised by two lanes. Most tools can emit LCOV or Cobertura with one flag — take it.

## Metrics each format actually measures

A dimension a tool does not measure is reported as `null`, not zero, and produces a WARNING rather than a gate failure. Set that threshold to 0 rather than chasing a number the tool cannot produce.

| Format | Lines | Functions | Branches | Statements |
|--------|-------|-----------|----------|------------|
| istanbul | yes | yes | yes | yes |
| lcov | yes | yes (when `FNF`/`FNH` present) | yes (when `BRF`/`BRH` present) | mirrors lines |
| cobertura | yes | from `<method>` elements | yes | mirrors lines |
| jacoco | yes | yes (METHOD) | yes (BRANCH) | mirrors lines |
| clover | yes | yes | yes (conditionals) | mirrors lines |
| coverage-py | yes | **no** | yes (with `--branch`) | same as lines |
| go-cover | yes | **no** | **no** | yes |
| simplecov | yes | **no** | **no** (without the branch flag) | mirrors lines |

## Property-testing libraries

`policy-core` requires an S4-S6 case for every unit that has a law. That requirement is only real if a library exists to express it, so the catalog names one per ecosystem. Where the column says **none in wide use**, that is the honest answer: fall back to table-driven S2/S3 cases over a hand-written input set, and say so in the matrix rather than pretending a property was checked.

| Ecosystem | Library | Notes |
|-----------|---------|-------|
| JavaScript / TypeScript | `fast-check` | Integrates with Vitest, Jest, and node:test; shrinks counterexamples |
| Python | `hypothesis` | Also has `stateful` testing for S5 state-machine invariants |
| Java / Kotlin | `jqwik` | JUnit 5 engine; `@Property` alongside ordinary `@Test` |
| Scala | `ScalaCheck` | Bundled with ScalaTest and munit |
| Clojure | `test.check` | `clojure.spec` generators feed it directly |
| C# / F# | `FsCheck`, `CsCheck` | FsCheck drives xUnit/NUnit from both languages |
| Go | `pgregory.net/rapid` | Stdlib `testing/quick` exists but does not shrink; prefer rapid |
| Rust | `proptest`, `quickcheck` | proptest shrinks structurally; both integrate with `cargo test` |
| C / C++ | `RapidCheck` | Integrates with GoogleTest and Catch2 |
| Swift | `SwiftCheck` | SPM package; XCTest-compatible |
| Ruby | `rantly`, `prop_check` | Either works with RSpec and minitest |
| PHP | `eris` | PHPUnit integration |
| Elixir | `StreamData` | `ExUnitProperties` ships in the ecosystem; strongest fit for S5 |
| Erlang | `PropEr` | Also supports stateful/statem models |
| Haskell | `QuickCheck`, `hedgehog` | hedgehog generates and shrinks integrally |
| OCaml | `qcheck` | Alcotest and OUnit integrations |
| Dart / Flutter | `glados` | Smaller ecosystem; verify it still fits the project's Dart version |
| R | `hedgehog` | testthat-compatible |
| Julia | `Supposition.jl` | Hypothesis-derived |
| Zig, Lua, Perl, Shell | none in wide use | Use table-driven S2/S3 cases and record the absence |

### Where properties pay and where they do not

| Unit shape | Worth a property? |
|------------|-------------------|
| Serializer/parser pair | Yes — round-trip is the law: `parse(print(x)) == x` |
| Money, quantities, ledgers | Yes — conservation across operations |
| Sorting, ranking, dedup | Yes — ordering, permutation, and idempotence |
| Retry, cache, upsert | Yes — idempotence under repetition |
| Rate limiter, state machine | Yes — invariants across transitions (S5, stateful generators) |
| Search, ranking, compression | Yes, as a metamorphic relation (S6) — there is no oracle to compare against |
| A formatter with three hard-coded strings | No — S1/S2 says everything there is to say |
| A thin adapter over one HTTP call | No — the behavior is at the `integration` lane, not in a generator |

## When a language is not in the catalog

Do not guess a command. Instead:

1. Read the CI config — the repo tells you what it runs.
2. Read the project's own README/CONTRIBUTING for the documented test command.
3. Ask the user, and state plainly that the ecosystem is not in the catalog.

Then check whether the tool can emit LCOV or Cobertura. Almost every coverage tool can, and either one makes the lane fully supported without any change to the plugin.

## Scope

Covers the per-language facts: runners, coverage tools, report formats and paths, mutation tools, property-testing libraries, and probe commands. It is a reference table, not a procedure.

Does NOT cover:

| Question | Where |
|----------|-------|
| How do I detect which of these a repo uses? | `commands/shared/detect-tooling.md` |
| Which tier should this suite gate? | `tdd-guardian:lane-policy` |
| How are thresholds enforced against the report? | `tdd-guardian:coverage-gate` |
| How is the report parsed and merged? | `commands/shared/parse-coverage.md` |
