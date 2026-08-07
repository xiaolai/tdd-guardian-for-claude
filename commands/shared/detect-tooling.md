---
description: "Shared: detect test lanes, runners, coverage tools, and e2e suites from CI config, manifests, and test topology — then verify each by dry-run probe"
user-invocable: false
---
<!-- Shared partial: tooling detection -->
<!-- Referenced by: init (primary), probe, gate. Do not use standalone. -->

## Purpose

Discover every test lane a repository actually has — unit, integration, e2e, contract — along with the runner, coverage tool, and coverage format for each, then **verify each proposed command actually resolves before it is written to config**.

Manifest presence is the weakest signal available. It tells you what is installed, not what is run. This partial orders evidence from strongest to weakest and ends with a probe, so a proposed config is verified rather than plausible.

## Evidence order

Work down this list. Stop when you have a lane's command; use lower steps only for what is still unknown.

| Order | Source | What it settles |
|-------|--------|-----------------|
| 1 | CI config | The commands maintainers actually run, already separated into lanes |
| 2 | Manifests + lockfiles | Which runner and coverage reporter are installed |
| 3 | Test topology | Lanes CI forgot, or runs from another repo |
| 4 | **Dry-run probe** | That the command resolves, and how many tests it discovers |
| 5 | Ask the user | Only what steps 1–4 left genuinely ambiguous |

### Step 1 — Read the CI config first

Glob for, in order: `.github/workflows/*.yml`, `.github/workflows/*.yaml`, `.gitlab-ci.yml`, `.circleci/config.yml`, `azure-pipelines.yml`, `Jenkinsfile`, `.buildkite/*.yml`, `Makefile`, `Justfile`, `Taskfile.yml`, `mise.toml`, `package.json` scripts.

This is ground truth. Extract:

- **Every distinct test invocation**, not just the first. A workflow with `test`, `integration-test`, and `e2e` jobs is telling you the repo has three lanes.
- **Job names and `needs:` ordering** — a job that runs only after a build, or only on `push` to main, is a slower tier and belongs on the `push` trigger.
- **Service containers** (`services:` in GitHub Actions, `docker-compose` invocations, `testcontainers`) — these become the lane's `setupCommand` / `teardownCommand`.
- **Coverage upload steps** (`codecov/codecov-action`, `coveralls`, `actions/upload-artifact` with a coverage path) — the uploaded path is the `coverageSummaryPath` you want, stated by the maintainers.
- **Matrix dimensions** — a matrix over OS or language version is one lane, not N. Take the command, drop the matrix.

Map each distinct invocation to a lane name: `unit`, `integration`, `e2e`, `contract`, `smoke`. Use the CI job's own name when it is clearer.

### Step 2 — Confirm the runner from manifests and lockfiles

Use the `tdd-guardian:tooling-catalog` skill. Read its `SKILL.md` index to pick the right reference file for the ecosystem you found, then read only that file. It carries, per language: manifest fingerprints, runner detection, coverage tool, coverage output format and path, mutation tool, and the probe command.

Detect the package manager from the lockfile, never from a guess:

| Lockfile | Manager |
|----------|---------|
| `pnpm-lock.yaml` | pnpm |
| `yarn.lock` | yarn |
| `bun.lockb` / `bun.lock` | bun |
| `package-lock.json` | npm |
| `uv.lock` | uv |
| `poetry.lock` | poetry |
| `Pipfile.lock` | pipenv |
| `Gemfile.lock` | bundler |
| `composer.lock` | composer |
| `gradle/wrapper/` | `./gradlew` (never bare `gradle`) |
| `.mvn/wrapper/` | `./mvnw` (never bare `mvn`) |

### Step 3 — Read the test topology

Glob for test directories and file patterns to find lanes that CI does not run, or runs from elsewhere:

- Directory split: `tests/unit/` vs `tests/integration/` vs `tests/e2e/`, `spec/` vs `features/`, `src/**/__tests__/` vs `e2e/`
- Filename split: `*.test.ts` vs `*.e2e.spec.ts` vs `*.integration.test.ts`, `*Test.java` vs `*IT.java`
- Marker-based split: pytest `markers` in `pyproject.toml` / `pytest.ini`, Go build tags (`//go:build integration`), RSpec tags, JUnit `@Tag`

A repo whose tests are all in one directory with no marker split has **one lane**. Do not invent lanes it does not have.

### Step 4 — Probe every proposed command

Run the lane's probe command. It lists tests without executing them, so it is fast and side-effect free, and it answers two questions at once: does the command resolve, and does it discover anything.

| Ecosystem | Probe command |
|-----------|---------------|
| Vitest | `<pm> exec vitest list` |
| Jest | `<pm> exec jest --listTests` |
| Mocha | `<pm> exec mocha --dry-run` |
| `node --test` | `node --test --test-name-pattern='$^'` |
| Playwright | `<pm> exec playwright test --list` |
| Cypress | `<pm> exec cypress verify` |
| pytest | `pytest --collect-only -q` |
| unittest | `python -m unittest discover -v --locals 2>&1 \| head -1` |
| Go | `go test -list '.*' ./...` |
| Rust | `cargo test -- --list` |
| Maven | `./mvnw -q test-compile` |
| Gradle | `./gradlew test --dry-run` |
| .NET | `dotnet test --list-tests` |
| RSpec | `bundle exec rspec --dry-run` |
| PHPUnit | `vendor/bin/phpunit --list-tests` |
| ExUnit | `mix test --trace --only nonexistent_tag_probe` |
| Swift | `swift test --list-tests` |
| CTest | `ctest -N` |
| Flutter | `flutter test --dry-run` |

Interpret the result:

| Probe outcome | Meaning | Action |
|---------------|---------|--------|
| Exit 0, non-empty list | Command resolves, tests exist | Accept the lane |
| Exit 0, empty list | Command resolves, discovers nothing | **Do not accept.** The glob or directory is wrong. Report it and ask |
| Exit 127 / "command not found" | Runner not installed | Report the install step; do not write the lane |
| Non-zero with a config error | Runner config is broken | Report the error verbatim; do not write the lane |
| No probe available for this runner | Cannot verify cheaply | Say so explicitly in the report; do not claim the lane is verified |

A lane that fails its probe must never be written to config as if it were fine. An unverified lane is worse than a missing one: it looks configured and fails later, at gate time.

### Step 5 — Ask only about what is left

Use `AskUserQuestion` for genuine ambiguity only:

- Two plausible e2e runners are both installed
- CI runs a suite whose services cannot be started locally
- The repo has no tests at all and the user must choose a runner

Do not ask about anything steps 1–4 already answered.

## When detection finds nothing

Return `lanes: []` and classify which empty case it is — the caller needs the distinction, and "no lanes" alone does not carry it:

| Evidence | Case | Caller's response |
|----------|------|-------------------|
| No manifest, no source, no tests | `greenfield` | Offer to scaffold a runner; ask which language first |
| Manifest + runner installed, zero test files | `no-tests-yet` | Configure the lane normally; the probe reporting `empty` is expected here |
| Source present, no test tooling | `untested-legacy` | Propose a runner **and** `coverageMode: "no-decrease"` |
| Manifest present, runner declared but not installed | `deps-missing` | Report the install step; write no lane until it resolves |

Put the classification in the return shape as `emptyReason`. **Never fabricate a lane to avoid returning an empty list** — a lane whose command does not resolve is worse than no lane, because it looks configured and fails at gate time.

## Monorepos and polyglot repositories

**Never stop at the first manifest in the root.** A root `package.json` beside a `services/api/pyproject.toml` and a `worker/go.mod` is three lanes, not one Node project.

Detection:

1. Check for a workspace declaration first — `pnpm-workspace.yaml`, `workspaces` in `package.json`, `[workspace]` in `Cargo.toml`, `go.work`, `settings.gradle`, `nx.json`, `turbo.json`, `lerna.json`, `pants.toml`, `MODULE.bazel`.
2. If one exists, the workspace tool usually has a single command that runs everything (`pnpm -r test`, `turbo run test`, `cargo test --workspace`, `go test ./...`, `./gradlew test`). **Prefer the one aggregate command over N per-package lanes** — it is what CI runs and what the maintainers maintain.
3. If there is no workspace declaration, glob for manifests up to 3 directories deep, excluding `node_modules`, `vendor`, `target`, `.venv`, `dist`, `build`. Each distinct ecosystem found becomes its own lane, named by directory: `api-unit`, `worker-unit`.
4. Set each lane's `command` to run from the repo root using the tool's own directory flag (`pytest services/api`, `go test ./worker/...`, `pnpm --filter api test`) rather than embedding `cd`.

Report every ecosystem found, including ones you did not turn into a lane, and say why.

## End-to-end and integration fingerprints

E2E suites are identified by config file, not by directory name. These fingerprints are unambiguous:

| Fingerprint file | Tool | Lane command | Services needed |
|------------------|------|--------------|-----------------|
| `playwright.config.{ts,js,mjs}` | Playwright | `<pm> exec playwright test` | Usually a dev server; check `webServer` in the config |
| `cypress.config.{ts,js}` | Cypress | `<pm> exec cypress run` | Check `baseUrl` |
| `wdio.conf.{ts,js}` | WebdriverIO | `<pm> exec wdio run wdio.conf.ts` | Browser/driver |
| `.testcaferc.json` | TestCafe | `<pm> exec testcafe chrome` | Browser |
| `nightwatch.conf.js` | Nightwatch | `<pm> exec nightwatch` | Browser |
| `puppeteer` in devDeps + `e2e/` | Puppeteer | project-specific | Browser |
| `conftest.py` + `pytest-playwright` / `selenium` | pytest e2e | `pytest tests/e2e` | Browser + app |
| `//go:build e2e` build tags | Go e2e | `go test -tags=e2e ./...` | Often testcontainers |
| `*IT.java` + failsafe in `pom.xml` | JUnit integration | `./mvnw verify -DskipUTs` | Often testcontainers |
| `testcontainers` in any manifest | Container-backed integration | the normal test command | Docker daemon |
| `docker-compose.test.yml` / `compose.test.yaml` | Compose-backed suite | see below | Compose stack |
| `*.feature` + step definitions | Cucumber / Behave / Godog / SpecFlow | per binding | Varies |
| `pact` in manifests, `pacts/` dir | Pact contract tests | `<pm> exec pact-broker` / per binding | Broker or local |
| `k6`/`artillery`/`locust` config | Load tests | tool-specific | Target env |

For a compose-backed suite, set the lane's service commands rather than folding them into `command`:

```json
{
  "name": "e2e",
  "setupCommand": "docker compose -f docker-compose.test.yml up -d --wait",
  "command": "npx playwright test",
  "teardownCommand": "docker compose -f docker-compose.test.yml down -v",
  "gateOn": ["push"],
  "coverage": "none",
  "timeoutMs": 1800000
}
```

Teardown runs even when the lane fails, so a red e2e run does not leak containers.

## Assigning triggers

Use the runtime measured during probing, plus what the suite needs, per the `tdd-guardian:lane-policy` skill:

| Lane characteristics | `gateOn` |
|----------------------|----------|
| Runs in under ~60s, no external services | `["taskCompleted", "commit"]` |
| Needs Docker/a database, roughly 1–5 min | `["commit"]` |
| Drives a browser or a deployed environment, over ~5 min | `["push"]` |
| Costs money per run, or hits a third-party sandbox | `["manual"]` |

Default to the slower trigger when unsure. A lane on the wrong side of this line either makes the plugin unusable (slow suite on `taskCompleted`) or is merely annoying (fast suite on `push`). Only one of those is recoverable.

## Coverage participation

Set `coverage: "include"` only on lanes that genuinely emit a coverage report, and give each one its **own** `coverageSummaryPath`. Two lanes writing the same path means the second overwrites the first and coverage is undercounted.

E2E lanes default to `coverage: "none"`. Browser-driven coverage requires an instrumented build and a browser-side collector; unless the repo already has that wired up, an e2e lane contributes no coverage and pretending otherwise corrupts the totals.

When more than one lane contributes coverage, prefer formats that carry per-line detail (LCOV, Cobertura, JaCoCo, coverage.py JSON, `coverage-final.json`) over summary-only formats (`coverage-summary.json`). Only per-line data can be merged as a true union; summary-only reports fall back to a weighted average that double-counts lines exercised by more than one lane. The gate reports which method it used.

## Return shape

Return this to the caller:

```
{
  ecosystems: [{ name, rootDir, manifest, packageManager }],
  lanes: [{
    name, command, gateOn, coverage, coverageSummaryPath, coverageReportCommand,
    setupCommand, teardownCommand, probeCommand, timeoutMs, description
  }],
  mutation: { command, available: boolean, installHint },
  probeResults: [{ lane, status: "verified" | "empty" | "unresolved" | "unprobeable", detail, testCount }],
  evidence: [{ lane, source: "ci" | "manifest" | "topology" | "user", detail }],
  emptyReason: "greenfield" | "no-tests-yet" | "untested-legacy" | "deps-missing" | null,
  unmapped: ["<ecosystem or CI job found but not turned into a lane, with the reason>"],
  notes: ["<install prerequisites the user must confirm>"]
}
```

`probeResults` and `evidence` are not optional. The caller shows the user which lanes were verified and which were inferred, so nothing is written to config under a false claim of verification.
