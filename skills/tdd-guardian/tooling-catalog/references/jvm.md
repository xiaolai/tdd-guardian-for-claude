# JVM — Java, Kotlin, Scala, Clojure, Groovy

## Build tool detection

| Signal | Tool | Invoke as |
|--------|------|-----------|
| `pom.xml` | Maven | `./mvnw` if `.mvn/wrapper/` exists, else `mvn` |
| `build.gradle`, `build.gradle.kts` | Gradle | `./gradlew` if the wrapper exists, else `gradle` |
| `build.sbt` | sbt | `sbt` |
| `deps.edn` | Clojure CLI | `clojure` |
| `project.clj` | Leiningen | `lein` |

**Always prefer the wrapper.** A bare `mvn`/`gradle` uses whatever version is on `PATH`, which is frequently not the one the project builds with.

## Java / Kotlin — Maven

| | |
|---|---|
| Unit tests | `./mvnw test` |
| Integration tests | `./mvnw verify` (Failsafe) |
| With coverage | `./mvnw test jacoco:report` |
| Summary path | `target/site/jacoco/jacoco.xml` (format: `jacoco`) |
| Probe | `./mvnw -q test-compile` |

Maven splits lanes for you by naming convention, and this is the single most useful fact about JVM lane detection:

| Plugin | Pattern | Phase | Lane |
|--------|---------|-------|------|
| Surefire | `*Test.java`, `Test*.java`, `*Tests.java` | `test` | unit |
| Failsafe | `*IT.java`, `IT*.java`, `*ITCase.java` | `integration-test` | integration |

So a repo with both gives you:

| Lane | Command | Trigger |
|------|---------|---------|
| unit | `./mvnw test` | `["taskCompleted", "commit"]` |
| integration | `./mvnw verify -DskipUTs` | `["commit"]` |

JaCoCo requires the plugin in `pom.xml` with the `prepare-agent` goal bound. Without it, `jacoco:report` reports nothing and the gate blocks on an empty report, because nothing was measured:

```xml
<plugin>
  <groupId>org.jacoco</groupId><artifactId>jacoco-maven-plugin</artifactId>
  <executions>
    <execution><goals><goal>prepare-agent</goal></goals></execution>
    <execution><id>report</id><phase>test</phase><goals><goal>report</goal></goals></execution>
  </executions>
</plugin>
```

Add `<formats><format>XML</format></formats>` — HTML alone is unreadable to the gate.

## Java / Kotlin — Gradle

| | |
|---|---|
| Test command | `./gradlew test` |
| With coverage | `./gradlew test jacocoTestReport` |
| Summary path | `build/reports/jacoco/test/jacocoTestReport.xml` |
| Probe | `./gradlew test --dry-run` |

Gradle's XML report is **off by default**. Turn it on or the gate finds nothing:

```kotlin
tasks.jacocoTestReport { reports { xml.required.set(true) } }
```

In a multi-project build, `./gradlew test` runs every subproject but each writes its own report. Either aggregate with `jacocoRootReport`, or make one lane per subproject with distinct `coverageSummaryPath` values. Never point two lanes at the same path.

Gradle is heavily cached: an up-to-date `test` task exits 0 without running anything. Add `--rerun-tasks` on a gate lane if you need a guarantee that the tests actually executed.

## Kotlin specifics

Same tooling as Java. Kotest is a common runner (`io.kotest` deps, `*Spec.kt` files) and still reports through Surefire/Gradle test, so no lane change is needed. MockK replaces Mockito; the mock-boundary rules in `policy-core` apply unchanged.

## Scala — sbt

| | |
|---|---|
| Test command | `sbt test` |
| Integration | `sbt It/test` (sbt 1.9+) or `sbt it:test` |
| With coverage | `sbt clean coverage test coverageReport` |
| Summary path | `target/scala-<ver>/coverage-report/cobertura.xml` (format: `cobertura`) |
| Probe | `sbt "show test:definedTests"` |

Requires the `sbt-scoverage` plugin in `project/plugins.sbt`. Runners: ScalaTest (`*Spec.scala`), munit, specs2, weaver.

`sbt` boots a JVM and resolves dependencies on first run — often 30s+ before a single test runs. Prefer a longer `timeoutMs` and consider `["commit"]` over `["taskCompleted"]`.

## Clojure

| Build tool | Test command | Coverage |
|------------|--------------|----------|
| Leiningen | `lein test` | `lein cloverage --lcov` → `target/coverage/lcov.info` |
| CLI + kaocha | `clojure -M:test` | `clojure -M:coverage --lcov` |

Cloverage also emits `--codecov` (JSON) and `--coberatura`; prefer `--lcov` since it carries per-line detail.

Probe: `lein test :only nonexistent/probe` exits non-zero but proves the runner resolves.

## Groovy

Spock (`*Spec.groovy`) under Gradle or Maven. Identical to the Java configuration — JaCoCo, same report paths.

## Mutation testing

| | |
|---|---|
| Tool | PIT (pitest) — the strongest mutation tool in any ecosystem |
| Maven | `./mvnw org.pitest:pitest-maven:mutationCoverage` |
| Gradle | `./gradlew pitest` (needs the `info.solidsoft.pitest` plugin) |
| Report | `target/pit-reports/mutations.xml` |
| Scala | stryker4s (`sbt stryker`) |

PIT is slow but genuinely informative. `["push"]` or `["manual"]`.

## Gotchas

- **The wrapper matters.** `./mvnw` and `./gradlew` pin the build-tool version; the bare commands do not.
- **`mvn test` skips Failsafe entirely.** If integration tests are not running, the phase is wrong, not the tests.
- **Gradle up-to-date checks make a no-op look green.** A `test` task that ran nothing exits 0.
- **JaCoCo XML is opt-in on both build tools.** The HTML report existing is not evidence the XML does.
- **`INSTRUCTION` counters are bytecode-level.** The gate maps `LINE` onto statements instead, so JVM statement percentages stay comparable to other languages.
- **Set `functions` threshold from the METHOD counter**, which JaCoCo does provide — unlike coverage.py or go-cover, you do not need to zero it.
