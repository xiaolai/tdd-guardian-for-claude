# End-to-end, integration, contract, and load tooling

Cross-language reference for the lanes above unit level. For which behaviour belongs at which level, see the `tdd-guardian:lane-policy` skill; this file is the tooling.

## Browser-driven e2e

| Tool | Fingerprint | Command | Probe |
|------|-------------|---------|-------|
| Playwright | `playwright.config.{ts,js,mjs}` | `<x> playwright test` | `<x> playwright test --list` |
| Cypress | `cypress.config.{ts,js}` | `<x> cypress run` | `<x> cypress verify` |
| WebdriverIO | `wdio.conf.{ts,js}` | `<x> wdio run wdio.conf.ts` | `<x> wdio config --help` |
| TestCafe | `.testcaferc.json` | `<x> testcafe chrome tests/` | `<x> testcafe --list-browsers` |
| Nightwatch | `nightwatch.conf.js` | `<x> nightwatch` | `<x> nightwatch --help` |
| Selenium | `selenium` dep in any manifest | language-specific | — |
| Puppeteer | `puppeteer` dep + `e2e/` | project-specific | — |

**Playwright is the one to check for first** — it is the current default and its config file answers most of your questions:

```ts
export default defineConfig({
  webServer: { command: "pnpm dev", url: "http://localhost:3000", reuseExistingServer: true },
  projects: [{ name: "chromium" }, { name: "firefox" }],
})
```

A `webServer` block means Playwright starts the app itself — **do not** duplicate that in `setupCommand`, or you get two servers fighting for a port. Leave `setupCommand` empty and let the config do it.

Browsers must be installed separately: `<x> playwright install --with-deps`. That is a one-time setup, not a per-run `setupCommand`.

Multiple `projects` (browsers) multiply the runtime. For a gate lane, pin one: `<x> playwright test --project=chromium`.

## API-level e2e (no browser)

Often mislabelled "integration". These are fast enough for `["commit"]`.

| Ecosystem | Tool | Notes |
|-----------|------|-------|
| Node | `supertest`, `app.inject()` (Fastify) | In-process; no port binding, no flakiness |
| Python | `httpx.AsyncClient(app=app)`, `TestClient` (FastAPI/Starlette) | In-process |
| Go | `httptest.NewServer` | In-process |
| Java | `@SpringBootTest(webEnvironment = RANDOM_PORT)` + RestAssured | Boots a real context; slower |
| .NET | `WebApplicationFactory<Program>` | Boots a real host |
| Ruby | `rack-test`, request specs | In-process |
| Rust | `axum::Router` + `tower::ServiceExt::oneshot` | In-process |

In-process HTTP testing is the highest-value tier in the whole pyramid: it exercises real routing, real serialisation, and real middleware without a network, a port, or a browser. It is also a Level 3 assertion under `policy-core`. Prefer it over both mocked unit tests and browser e2e wherever it can answer the question.

## Container-backed integration

| Signal | Meaning |
|--------|---------|
| `testcontainers` in any manifest | Tests start their own containers; needs a Docker daemon, no `setupCommand` |
| `docker-compose.test.yml`, `compose.test.yaml` | Explicit stack; needs `setupCommand`/`teardownCommand` |
| `services:` in a GitHub Actions job | CI starts them; you must start them locally |
| `.devcontainer/` | Dev environment, not necessarily a test dependency |

Testcontainers is the better pattern — the lane command stays plain and the lifecycle is the test's own problem:

```json
{ "name": "integration", "command": "./mvnw verify -DskipUTs", "gateOn": ["commit"], "timeoutMs": 900000 }
```

For an explicit compose stack, use the wait flag so the lane does not race the services:

```json
{
  "name": "integration",
  "setupCommand": "docker compose -f docker-compose.test.yml up -d --wait",
  "command": "pytest tests/integration",
  "teardownCommand": "docker compose -f docker-compose.test.yml down -v",
  "gateOn": ["commit"],
  "timeoutMs": 900000
}
```

`--wait` blocks until healthchecks pass. Without it, and without healthchecks defined, the lane starts testing against a database that is not accepting connections yet — the classic source of "flaky" integration tests that are not flaky at all.

`down -v` removes volumes. Omit `-v` and state leaks between runs, which makes the second run pass for reasons the first did not.

## Contract testing

| Tool | Fingerprint | Command |
|------|-------------|---------|
| Pact | `pact` deps, `pacts/` dir, `pact-broker` in CI | consumer: normal test run; provider: `<x> pact-provider-verifier` |
| Spring Cloud Contract | `spring-cloud-starter-contract-verifier` | `./mvnw test` (generates + runs) |
| Schemathesis | `schemathesis` dep | `schemathesis run openapi.json --url=$BASE_URL` |
| Dredd | `dredd.yml` | `dredd` |

Contract tests split into two lanes with different needs: the **consumer** side runs offline and belongs with unit tests; the **provider** side needs the real provider running and belongs on `["push"]`.

## Load and performance

| Tool | Fingerprint | Command |
|------|-------------|---------|
| k6 | `*.k6.js`, `k6` in CI | `k6 run script.js` |
| Artillery | `artillery.yml` | `artillery run artillery.yml` |
| Locust | `locustfile.py` | `locust --headless -u 10 -r 1 -t 30s` |
| Gatling | `gatling` in `build.sbt`/`pom.xml` | `./mvnw gatling:test` |
| JMeter | `*.jmx` | `jmeter -n -t plan.jmx` |

These almost always belong on `["manual"]`. They are slow, they need a target environment, and their pass/fail thresholds are tuned rather than binary. Gating a commit on a load test is a mistake.

## BDD

| Tool | Language | Command |
|------|----------|---------|
| Cucumber.js | JS/TS | `<x> cucumber-js` |
| Behave | Python | `behave` |
| pytest-bdd | Python | `pytest` (ordinary lane) |
| Godog | Go | `go test ./features` |
| Cucumber-JVM | Java | `./mvnw test` |
| SpecFlow / Reqnroll | .NET | `dotnet test` |
| Behat | PHP | `vendor/bin/behat` |

`*.feature` files tell you BDD is in use but not which tier — a `.feature` can drive a pure function or a browser. Read the step definitions before assigning the trigger.

## Mobile

| Platform | Tool | Command |
|----------|------|---------|
| iOS | XCUITest | `xcodebuild test -scheme UITests -destination '<simulator>'` |
| Android | Espresso | `./gradlew connectedAndroidTest` |
| Cross-platform | Appium | `<x> wdio run wdio.conf.ts` |
| Cross-platform | Maestro | `maestro test flows/` |
| Flutter | integration_test | `flutter drive --target=integration_test/app_test.dart` |

All need a simulator, emulator, or device. `setupCommand` boots it, `teardownCommand` shuts it down, `gateOn: ["push"]`, and a generous `timeoutMs`.

## Collecting coverage from an e2e lane

Default to **not** collecting it. `coverage: "none"` on e2e lanes is the right answer for most repos, and it is honest: an uninstrumented e2e run contributes nothing, and pretending otherwise corrupts the merged totals.

Collect it only when e2e coverage would actually change a decision. When it would, here is what it takes:

| Stack | Mechanism |
|-------|-----------|
| Node server | Run the server under `c8`/`nyc`; write on exit; `--reporter=lcov` |
| Browser JS | Instrument the build with `babel-plugin-istanbul`, collect `window.__coverage__` via Playwright's `addInitScript`, merge with `nyc merge` |
| Playwright (V8) | `page.coverage.startJSCoverage()` → convert with `v8-to-istanbul` |
| Go binary | `go build -cover`, run with `GOCOVERDIR=/tmp/cov`, then `go tool covdata textfmt` |
| Java | JaCoCo agent on the server JVM (`-javaagent:jacocoagent.jar=output=tcpserver`), dump via `jacoco:dump` |
| .NET | coverlet cannot attach to a running host; use `dotnet-coverage collect -- <server>` |
| Python | `coverage run --parallel-mode` on the server, `coverage combine` after |

Every one of these is a separate instrumented build. That is why `coverage: "none"` is the default rather than an oversight.

If you do collect it, emit **LCOV or Cobertura** so the merge with the unit lane is a true union rather than a weighted average that double-counts shared lines.

## Flakiness

A flaky e2e test is a broken test, not a fact of life. Before reaching for a retry:

1. **Race on startup** — the app was not ready. Fix with a healthcheck and `--wait`, not a `sleep`.
2. **Shared state between runs** — a volume or database survived. Fix with `down -v` or a per-run schema.
3. **Time or ordering assumptions** — fix the test.
4. **Implicit waits** — replace `waitForTimeout` with a condition on the element or response.

`optional: true` on a lane exists for suites that are genuinely non-deterministic by nature, such as a smoke check against a third-party sandbox. It is not a way to keep a red suite green. A lane marked optional still records its failure in state and still reports it — it just does not block.

Playwright's `retries` setting has the same trap: a test that passes on retry 2 is telling you something, and the report says `flaky` rather than `passed` for exactly that reason.
