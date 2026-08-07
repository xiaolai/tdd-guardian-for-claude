# Dart/Flutter, R, Julia, Shell

## Dart / Flutter

Detection: `pubspec.yaml`. A `flutter:` key or a `sdk: flutter` dependency means Flutter; otherwise plain Dart.

| | Dart | Flutter |
|---|------|---------|
| Test command | `dart test` | `flutter test` |
| With coverage | `dart test --coverage=coverage` | `flutter test --coverage` |
| Report step | `dart run coverage:format_coverage --lcov --in=coverage --out=coverage/lcov.info --report-on=lib` | none — written directly |
| Summary path | `coverage/lcov.info` (format: `lcov`) | `coverage/lcov.info` |
| Probe | `dart test --dry-run` | `flutter test --dry-run` |

Flutter writes LCOV directly, which is the friendliest coverage story of any ecosystem here. Plain Dart needs the two-step form — put `format_coverage` in `coverageReportCommand`.

Lane split for a Flutter app:

| Lane | Location | Command | Trigger |
|------|----------|---------|---------|
| unit | `test/` | `flutter test` | `["taskCompleted", "commit"]` |
| widget | `test/` (uses `testWidgets`) | same lane as unit | — |
| integration | `integration_test/` | `flutter test integration_test` | `["commit"]` |
| e2e (device) | `integration_test/` | `flutter drive --driver=test_driver/integration_test.dart --target=integration_test/app_test.dart` | `["push"]` |

The device lane needs a simulator or an attached device — set `setupCommand` to boot one (`xcrun simctl boot ...` / `emulator -avd ...`) and `teardownCommand` to shut it down.

LCOV from Flutter measures lines only; set `functions` and `branches` to 0.

Mutation: `mutation_test` package (`dart run mutation_test`). Immature; leave `requireMutation: false`.

## R

Detection: `DESCRIPTION`, `tests/testthat/`, `tests/testthat.R`.

| | |
|---|---|
| Test command | `Rscript -e 'devtools::test()'` |
| Alternative | `R CMD check --no-manual .` (fuller, much slower) |
| With coverage | `Rscript -e 'covr::to_cobertura(covr::package_coverage(), filename = "coverage.xml")'` |
| Summary path | `coverage.xml` (format: `cobertura`) |
| Probe | `Rscript -e 'length(list.files("tests/testthat", pattern="^test-"))'` |

`covr` also has `covr::report()` (HTML) and `covr::codecov()`; only the Cobertura output is machine-readable to the gate.

covr measures line coverage only — zero the functions and branches thresholds.

`package_coverage()` re-installs the package into a temporary library on every call, so it is slow. Keep it off `taskCompleted`.

## Julia

Detection: `Project.toml`, `test/runtests.jl`.

| | |
|---|---|
| Test command | `julia --project=. -e 'using Pkg; Pkg.test()'` |
| With coverage | `julia --project=. -e 'using Pkg; Pkg.test(coverage=true)'` |
| Report step | `julia -e 'using Coverage; LCOV.writefile("coverage/lcov.info", process_folder())'` |
| Summary path | `coverage/lcov.info` (format: `lcov`) |
| Probe | `julia --project=. -e 'using Pkg; Pkg.instantiate()'` (verifies the env resolves) |

Requires the `Coverage.jl` package. `Pkg.test(coverage=true)` scatters `.cov` files next to the sources; `process_folder()` collects them. Clean them up afterwards (`Coverage.clean_folder(".")`) or they accumulate and skew the next run — a good `teardownCommand`.

Julia's first-run compilation latency is significant. Expect 30s+ before any test executes, and set `timeoutMs` accordingly.

## Shell

Detection: `*.bats`, `test/bats/`, `.bats.yml`, or a `test/` directory of `*.sh` files.

| | |
|---|---|
| Test command | `bats test/` |
| With coverage | `kcov --include-path=. coverage/ bats test/` |
| Summary path | `coverage/**/cobertura.xml` (format: `cobertura`) |
| Probe | `bats --count test/` |

`bats-core` is the practical standard. `shellspec` is an alternative with built-in coverage via kcov.

kcov works by ptrace and does not run on macOS — a coverage lane for shell scripts is realistically Linux/CI only. Locally, set `coverage: "none"`.

`shellcheck` makes an excellent `preflightCommand`:

```
"preflightCommand": "shellcheck -x scripts/*.sh"
```

## Gotchas

- **Flutter's `--coverage` overwrites `coverage/lcov.info` every run.** Two Flutter lanes both writing coverage need distinct paths.
- **`flutter test integration_test` and `flutter drive` are different things.** The former runs on the host with a headless binding; the latter needs a real device or simulator. Only the second belongs on `["push"]` with a device `setupCommand`.
- **Julia leaves `.cov` files behind.** Without cleanup the next coverage run merges stale data and the numbers drift upward for no reason.
- **covr re-installs the package on every run.** It is correct but slow; do not put it on `taskCompleted`.
- **kcov is Linux-only.** A shell coverage lane that works in CI will fail locally on macOS — either mark it `optional: true` or scope it to `["push"]`.
- **All four of these measure lines only.** Set `functions` and `branches` thresholds to 0 rather than accepting a permanent WARNING.
