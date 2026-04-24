---
description: "Shared: detect project language/stack from manifest files, propose default commands"
user-invocable: false
---
<!-- Shared partial: language/stack detection -->
<!-- Referenced by: tdd-guardian-init (primary), and any command that needs to infer defaults when config is incomplete. Do not use standalone. -->

## Purpose

Detect the project's language, test runner, coverage tool, and mutation tool from manifest files in the workspace root. Used by `/tdd-guardian:tdd-guardian-init` to propose defaults; also used as a sanity check by other commands when invoked with an incomplete config.

## Detection priority (first match wins)

Use the Glob tool on the workspace root. The first manifest found determines the stack.

| Order | Manifest | Stack |
|-------|----------|-------|
| 1 | `package.json` | Node.js / TypeScript |
| 2 | `pyproject.toml` or `setup.cfg` or `setup.py` | Python |
| 3 | `go.mod` | Go |
| 4 | `Cargo.toml` | Rust |

If none match, return `stack = "unknown"` and let the caller ask the user.

## Node.js / TypeScript

Read `package.json` and inspect:
- `packageManager` field or lockfile: `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `bun.lockb` → bun, else npm
- `scripts.test` to confirm a test script exists
- `devDependencies` for the test runner (`vitest`, `jest`, `mocha`, `node --test`)

Defaults:

| Runner | testCommand | coverageCommand | coverageSummaryPath |
|--------|-------------|-----------------|---------------------|
| vitest | `<pm> test` | `<pm> test -- --coverage` | `coverage/coverage-summary.json` |
| jest | `<pm> test` | `<pm> test -- --coverage --coverageReporters=json-summary` | `coverage/coverage-summary.json` |
| mocha + nyc | `<pm> test` | `<pm> exec nyc --reporter=json-summary <pm> test` | `coverage/coverage-summary.json` |
| node --test | `node --test` | `node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=coverage/lcov.info` | `coverage/lcov.info` |

Mutation tool default: `npx stryker run` (requires `@stryker-mutator/core`).

## Python

Read `pyproject.toml` (or `setup.cfg`) and check for:
- `[tool.pytest]` section → pytest
- `[tool.coverage]` / presence of `pytest-cov` → coverage.py
- Package manager: `poetry.lock` → poetry, `uv.lock` → uv, `Pipfile.lock` → pipenv, else plain `pip`

Defaults:

| Runner | testCommand | coverageCommand | coverageSummaryPath |
|--------|-------------|-----------------|---------------------|
| pytest | `pytest` | `pytest --cov --cov-report=json:coverage.json` | `coverage.json` |
| unittest | `python -m unittest discover` | `coverage run -m unittest discover && coverage json -o coverage.json` | `coverage.json` |

Mutation tool default: `mutmut run` (requires `pip install mutmut`).

## Go

Detect via `go.mod`. Go has a built-in test runner and cover tool; no extra runner to pick.

Defaults:

| testCommand | coverageCommand | coverageSummaryPath |
|-------------|-----------------|---------------------|
| `go test ./...` | `go test ./... -coverprofile=coverage.out` | `coverage.out` |

Mutation tool default: `go-mutesting ./...` (requires `go install github.com/zimmski/go-mutesting/cmd/go-mutesting@latest`).

## Rust

Detect via `Cargo.toml`. Coverage requires `cargo-llvm-cov` or `cargo-tarpaulin`.

Defaults:

| Tool | testCommand | coverageCommand | coverageSummaryPath |
|------|-------------|-----------------|---------------------|
| cargo-llvm-cov (preferred) | `cargo test` | `cargo llvm-cov --json --output-path coverage.json` | `coverage.json` |
| cargo-tarpaulin | `cargo test` | `cargo tarpaulin --out Json --output-dir coverage` | `coverage/tarpaulin-report.json` |

Mutation tool default: `cargo mutants` (requires `cargo install cargo-mutants`).

## Return shape

Return an object with these fields for the caller:

```
{
  stack: "node" | "python" | "go" | "rust" | "unknown",
  runner: "<detected runner name>",
  packageManager: "<pm>" | null,
  testCommand: "<string>",
  coverageCommand: "<string>",
  coverageSummaryPath: "<relative path>",
  mutationCommand: "<string>" | "",
  notes: ["<any install prerequisites the user must confirm>"]
}
```

The caller (typically `/tdd-guardian:tdd-guardian-init`) SHOULD present these defaults to the user via AskUserQuestion before writing config. Never silently overwrite an existing config.
