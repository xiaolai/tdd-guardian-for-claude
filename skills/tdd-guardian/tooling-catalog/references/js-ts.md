# JavaScript / TypeScript

Covers Node.js, Deno, and Bun. Browser-driven suites live in `e2e.md`.

## Package manager

Read the lockfile, never guess: `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `bun.lockb`/`bun.lock` → bun, `package-lock.json` → npm. A `packageManager` field in `package.json` overrides all of them.

Below, `<pm>` is that manager and `<x>` is its exec form: `pnpm exec`, `yarn`, `bunx`, `npx`.

## Runner detection

Check `devDependencies` and config files, in this order:

| Signal | Runner |
|--------|--------|
| `vitest` dep, `vitest.config.*`, `test` block in `vite.config.*` | Vitest |
| `jest` dep, `jest.config.*`, `jest` key in `package.json` | Jest |
| `mocha` dep, `.mocharc.*` | Mocha |
| `ava` dep, `ava` key in `package.json` | AVA |
| `node:test` imports, `--test` in the test script | node:test |
| `@playwright/test` dep | Playwright — an e2e lane, see `e2e.md` |
| `deno.json` with a `test` task | Deno |

A repo can have both Vitest and Playwright. That is two lanes, not a tie to break.

## Vitest

| | |
|---|---|
| Test command | `<pm> exec vitest run` |
| With coverage | `<pm> exec vitest run --coverage` |
| Summary path | `coverage/coverage-summary.json` (istanbul) |
| Per-line path | `coverage/coverage-final.json` or `coverage/lcov.info` |
| Probe | `<pm> exec vitest list` |

Requires `@vitest/coverage-v8` or `@vitest/coverage-istanbul`. Reporters are set in config, not on the CLI:

```ts
test: { coverage: { reporter: ["text", "json-summary", "lcov"], reportsDirectory: "coverage" } }
```

Watch mode is the default for bare `vitest` — always use `vitest run` in a lane, or the gate hangs until it times out.

## Jest

| | |
|---|---|
| Test command | `<pm> exec jest` |
| With coverage | `<pm> exec jest --coverage --coverageReporters=json-summary --coverageReporters=lcov` |
| Summary path | `coverage/coverage-summary.json` |
| Per-line path | `coverage/lcov.info` |
| Probe | `<pm> exec jest --listTests` |

Jest defaults `--coverageReporters` to `["json","lcov","text","clover"]` — note `json` is `coverage-final.json`, not the summary. Add `json-summary` explicitly if you want the summary file.

## Mocha + nyc / c8

| | |
|---|---|
| Test command | `<pm> exec mocha` |
| With coverage | `<pm> exec c8 --reporter=lcov --reporter=json-summary mocha` |
| Summary path | `coverage/coverage-summary.json` |
| Probe | `<pm> exec mocha --dry-run` |

`c8` uses V8's native coverage and needs no instrumentation. `nyc` is the older Babel-instrumenting equivalent; both write to `coverage/`.

## node:test (built in, Node 18+)

| | |
|---|---|
| Test command | `node --test` |
| With coverage | `node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=coverage/lcov.info` |
| Summary path | `coverage/lcov.info` |
| Probe | `node --test --test-name-pattern='$^'` |

Zero dependencies, which makes it the right choice for a plugin or a library that refuses a devDependency tree. Coverage was experimental through Node 20 and stabilised in Node 22; on Node 18 treat the numbers as indicative.

## AVA

| | |
|---|---|
| Test command | `<pm> exec ava` |
| With coverage | `<pm> exec c8 --reporter=lcov ava` |
| Summary path | `coverage/lcov.info` |

## Deno

| | |
|---|---|
| Test command | `deno test --allow-all` |
| With coverage | `deno test --allow-all --coverage=cov_profile` |
| Report step | `deno coverage cov_profile --lcov --output=coverage/lcov.info` |
| Summary path | `coverage/lcov.info` |
| Probe | `deno test --dry-run` |

Coverage is two steps, so set `coverageReportCommand` to the `deno coverage` invocation rather than folding it into `command`.

## Bun

| | |
|---|---|
| Test command | `bun test` |
| With coverage | `bun test --coverage --coverage-reporter=lcov` |
| Summary path | `coverage/lcov.info` |
| Probe | `bun test --rerun-each=0 2>&1 \| head -1` (Bun has no dedicated list mode) |

## TypeScript preflight

If the repo has a `tsconfig.json`, set the config's `preflightCommand` to a type check. Types are a gate the test suite does not enforce, and a type error is cheaper to catch before the lanes run than inside them:

```
"preflightCommand": "<pm> exec tsc --noEmit"
```

## Mutation testing

| | |
|---|---|
| Tool | Stryker |
| Install | `<pm> add -D @stryker-mutator/core @stryker-mutator/vitest-runner` |
| Command | `<x> stryker run` |
| Report | `reports/mutation/mutation.json` |

Stryker needs a `stryker.config.json` naming the test runner. It is slow — put it on `["push"]` or `["manual"]`, never `taskCompleted`.

## Gotchas

- **Watch mode hangs the gate.** `vitest`, `jest --watch`, and `bun test --watch` never exit. Always use the run-once form.
- **`<pm> test -- --coverage` is not portable.** npm needs the `--` separator, pnpm and yarn mostly do not, and bun ignores it. Prefer invoking the runner directly (`<pm> exec vitest run --coverage`) over threading flags through a `test` script.
- **A `test` script that chains lint and types** makes lane failures ambiguous. Point the lane at the runner and move the rest to `preflightCommand`.
- **Monorepos**: prefer the one aggregate command (`pnpm -r test`, `turbo run test`) over one lane per package.
