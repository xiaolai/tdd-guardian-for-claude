# Native — Go, Rust, C, C++, Zig, Swift, Objective-C

## Go

| | |
|---|---|
| Test command | `go test ./...` |
| With coverage | `go test ./... -coverprofile=coverage.out -covermode=atomic` |
| Summary path | `coverage.out` (format: `go-cover`) |
| Probe | `go test -list '.*' ./...` |

Go's cover profile measures **statements only**. Functions and branches are reported as `null`, so set both thresholds to 0 or accept a WARNING.

`-covermode`: `set` records hit/not-hit, `count` records hit counts, `atomic` is `count` made race-safe. Use `atomic` whenever tests run in parallel — the default `set` is fine otherwise.

By default a package's coverage counts only tests in that package. For cross-package coverage add `-coverpkg=./...`, which usually lowers the number and is the more honest figure.

**Lane splitting** is by build tag:

```go
//go:build integration
```

| Lane | Command | Trigger |
|------|---------|---------|
| unit | `go test ./...` | `["taskCompleted", "commit"]` |
| integration | `go test -tags=integration ./...` | `["commit"]` |
| e2e | `go test -tags=e2e ./...` | `["push"]` |

Go's test cache makes a re-run of unchanged packages exit 0 instantly without executing anything. Add `-count=1` to a gate lane when you need proof the tests ran.

Mutation: `go-mutesting ./...` (`go install github.com/zimmski/go-mutesting/cmd/go-mutesting@latest`) or `gremlins run`.

Binary-level coverage for e2e (Go 1.20+): build with `go build -cover`, run with `GOCOVERDIR=/tmp/cov`, then `go tool covdata textfmt -i=/tmp/cov -o=coverage.out`. That is the only way an e2e lane contributes real coverage in Go.

## Rust

| | |
|---|---|
| Test command | `cargo test` |
| With coverage | `cargo llvm-cov --lcov --output-path coverage/lcov.info` |
| Summary path | `coverage/lcov.info` (format: `lcov`) |
| Alternative | `cargo tarpaulin --out Xml` → `cobertura.xml` (format: `cobertura`) |
| Probe | `cargo test -- --list` |

`cargo-llvm-cov` is the better choice: it uses LLVM source-based coverage, works on stable, and handles workspaces. `cargo install cargo-llvm-cov`. Tarpaulin is Linux-x86_64-oriented and less accurate on other targets.

Rust separates test kinds natively:

| Location | Kind | Command |
|----------|------|---------|
| `#[cfg(test)]` inside `src/` | unit | `cargo test --lib` |
| `tests/*.rs` | integration | `cargo test --test '*'` |
| `///` doc examples | doc tests | `cargo test --doc` |

`cargo test` runs all three. Splitting into lanes is optional; a single lane is usually right.

Workspaces: `cargo test --workspace`. Do not make a lane per crate.

Mutation: `cargo mutants` (`cargo install cargo-mutants`) — well-maintained and fast enough to be useful.

## C / C++

Build system first:

| Signal | System | Test command |
|--------|--------|--------------|
| `CMakeLists.txt` | CMake + CTest | `ctest --test-dir build --output-on-failure` |
| `meson.build` | Meson | `meson test -C build` |
| `Makefile` with a `check`/`test` target | Make | `make check` |
| `conanfile.txt`/`.py` | Conan (dep manager, not a runner) | read what it wraps |
| `BUILD.bazel` | Bazel | `bazel test //...` |

Frameworks — GoogleTest, Catch2, doctest, Unity, CppUTest — all report through the build system, so the lane command rarely changes.

Coverage needs instrumentation at compile time, which means a separate build directory:

**GCC / gcov:**
```
cmake -B build-cov -DCMAKE_CXX_FLAGS="--coverage -O0 -g"
cmake --build build-cov
ctest --test-dir build-cov
gcovr --xml --output coverage.xml -r . build-cov
```

**Clang / llvm-cov:**
```
cmake -B build-cov -DCMAKE_CXX_FLAGS="-fprofile-instr-generate -fcoverage-mapping"
LLVM_PROFILE_FILE=cov.profraw ctest --test-dir build-cov
llvm-profdata merge -sparse cov.profraw -o cov.profdata
llvm-cov export --format=lcov --instr-profile=cov.profdata build-cov/tests > coverage/lcov.info
```

Either way it is multi-step: put the build in `setupCommand`, the test run in `command`, and the report generation in `coverageReportCommand`.

| Format | Produced by |
|--------|-------------|
| cobertura | `gcovr --xml` |
| lcov | `lcov --capture --directory build-cov --output-file coverage/lcov.info`, or `llvm-cov export --format=lcov` |

Probe: `ctest -N` (lists tests without running them) or `meson test --list`.

Mutation: `mull-runner` (LLVM-based) or `mutate++`. Both need clang instrumentation and are rarely worth it outside safety-critical work.

## Zig

| | |
|---|---|
| Test command | `zig build test` |
| Single file | `zig test src/main.zig` |
| Coverage | `kcov --include-pattern=src/ coverage/ zig-out/bin/test` → `coverage/**/cobertura.xml` |
| Probe | `zig build test --summary all` (runs; Zig has no list-only mode) |

Zig has no built-in coverage. kcov works on the compiled test binary and emits Cobertura. If coverage is not wired up, set `coverage: "none"` and all thresholds to 0 rather than pretending.

## Swift

| | |
|---|---|
| Test command (SwiftPM) | `swift test` |
| With coverage | `swift test --enable-code-coverage` |
| Report step | `xcrun llvm-cov export -format=lcov -instr-profile .build/debug/codecov/default.profdata .build/debug/<Target>PackageTests.xctest/Contents/MacOS/<Target>PackageTests > coverage/lcov.info` |
| Summary path | `coverage/lcov.info` |
| Probe | `swift test --list-tests` |

For an Xcode project rather than a package:

```
xcodebuild test -scheme MyApp -destination 'platform=iOS Simulator,name=iPhone 15' -enableCodeCoverage YES -resultBundlePath result.xcresult
xcrun xccov view --report --json result.xcresult > coverage.json
```

`xccov`'s JSON is not a format the gate parses. Convert to LCOV with `xcov` or `slather` (`slather coverage --cobertura-xml`), and point the lane at that.

Frameworks: XCTest (traditional) and swift-testing (`@Test` macro, Swift 6+). Both run under `swift test`.

Mutation: `muter` (`brew install muter-mutation-testing/formulae/muter`).

## Objective-C

Same as Swift on the Xcode path — `xcodebuild test` plus `slather`. XCTest is the only realistic runner.

## Gotchas

- **Go and Rust both cache aggressively.** `go test` and `cargo test` can exit 0 without running anything. Use `-count=1` / a clean target when the gate must prove execution.
- **Coverage-instrumented C/C++ builds must be separate.** Reusing the normal build directory either produces no coverage or forces a full rebuild every gate run.
- **`gcov` version must match the compiler.** A GCC 13 build read by `gcov-11` silently produces garbage percentages. Pin with `gcovr --gcov-executable gcov-13`.
- **Go's `-coverpkg=./...` lowers coverage and is the honest number.** Package-local coverage flatters the codebase.
- **Swift's llvm-cov export path contains the target name**, which changes when the package is renamed. Derive it rather than hardcoding, or the lane silently stops finding the profile.
- **Statement-only formats**: Go reports no functions and no branches; set those thresholds to 0.
