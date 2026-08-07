---
name: lane-policy
description: Test-level taxonomy — which behavior belongs in a unit, integration, e2e, or contract lane, how lanes bind to gate triggers, and how each lane participates in coverage. Use when designing a test matrix, configuring lanes, or deciding where a given test should live.
---

# Lane Policy

A **lane** is one test tier with its own command, its own trigger, and its own coverage participation. Lanes exist because test tiers have genuinely different costs: a suite that takes 90 seconds and needs a browser cannot gate every task completion, and a suite that takes 900 milliseconds should not wait for one that does.

This is a separate axis from the assertion hierarchy in `policy-core`. That hierarchy asks *how strongly does this test verify anything*. This skill asks *at what level does this behavior get verified*. A test can be Level 1 in a unit lane or Level 7 in an e2e lane; both questions must be answered for every test.

## The four levels

| Lane | Boundary | Typical runtime | Default trigger | Coverage |
|------|----------|-----------------|-----------------|----------|
| `unit` | In-process, no I/O beyond a tmpdir | < 60s total | `["taskCompleted", "commit"]` | `include` |
| `integration` | Real adapters — DB, HTTP, filesystem, containers | 1–5 min | `["commit"]` | `include` |
| `e2e` | The deployed system through its real interface | 5–30 min | `["push"]` | `none` |
| `contract` | The agreement between two services | varies by side | consumer `["commit"]`, provider `["push"]` | `none` |

Additional lanes when a repo warrants them: `smoke` (a handful of checks against a live environment, `["manual"]`), `load` (`["manual"]`), `security` (`["push"]`).

## Where a behavior belongs

Assign each behavior to the **cheapest lane that can actually verify it**. Not the cheapest lane it can be written in — the cheapest lane where a failure would be real.

| Behavior | Lane | Why |
|----------|------|-----|
| Pure computation, formatting, parsing | unit | No collaborator is involved |
| Validation and guard clauses | unit | The rejection is the observable behavior |
| State machine transitions | unit | State is in-process |
| Error mapping and retry logic | unit | Inject the failure; the policy is the unit |
| SQL correctness, migrations, constraints | integration | A mocked DB cannot violate a constraint |
| ORM query semantics, lazy loading, N+1 | integration | The behavior lives in the driver, not your code |
| HTTP routing, middleware order, serialisation | integration | Use an in-process client — real routing, no port |
| Auth middleware actually rejecting a request | integration | A mocked guard proves nothing |
| Transaction rollback and isolation | integration | Only a real transaction has isolation |
| File and filesystem semantics | integration | Permissions, encoding, and locks are real behavior |
| Container security defaults | integration | Inspect the created resource, never the mock args |
| A user flow across more than one screen | e2e | The flow is the unit |
| Client-side routing, hydration, focus management | e2e | Only a real browser has a real DOM |
| Third-party redirect handshakes (OAuth, payments) | e2e | The other side is real |
| "The consumer's expectations still hold" | contract | Neither side alone can answer it |

### The rule that decides borderline cases

> If the test would still pass when the real collaborator is broken, it belongs one lane higher.

A test that mocks the database and asserts `expect(mockQuery).toHaveBeenCalledWith(sql)` passes when the SQL is invalid. That behavior is not verified at unit level and must have an integration test, or it is not verified at all.

## The mock-boundary obligation

`policy-core` requires that mocking a system boundary is paired with an integration test covering the real path. Lanes are what make that requirement checkable instead of aspirational.

When a unit test mocks a boundary:

1. Name the boundary in the test matrix (`Mock boundary:` field).
2. Name the integration test that covers the real path.
3. That integration test lives in the `integration` lane.
4. `review-gate` verifies the pairing exists.

A repo with mocked boundaries and **no** integration lane has an unmet obligation. That is a finding, not a style preference — say so during `/tdd-guardian:init` and during review.

## Trigger assignment

Bind a lane by its cost and its dependencies, not by its name:

| Lane characteristics | `gateOn` |
|----------------------|----------|
| Under ~60s, no external services | `["taskCompleted", "commit"]` |
| Needs Docker or a database, 1–5 min | `["commit"]` |
| Drives a browser or a deployed environment, over 5 min | `["push"]` |
| Costs money per run, or hits a third-party sandbox | `["manual"]` |

Trigger semantics:

- **`taskCompleted`** — the hook *runs* these lanes when Claude finishes a task. This is the tight loop; anything slow here makes the plugin unusable.
- **`commit`** — checked for *freshness* before `git commit`. Not run automatically.
- **`push`** — checked for freshness before `git push`, `gh pr create`, and publish commands. **`push` subsumes `commit`**: pushing requires everything a commit requires, plus the push lanes.
- **`manual`** — only ever runs via `/tdd-guardian:gate <lane>`.

When unsure, choose the slower trigger. A fast suite on `push` is mildly annoying; a slow suite on `taskCompleted` makes people disable the plugin.

## Coverage participation

`coverage: "include"` means the lane's report joins the merged total that thresholds are checked against. `coverage: "none"` means it does not.

Rules:

1. **Each contributing lane needs its own `coverageSummaryPath`.** Two lanes writing the same file means the second overwrites the first, and coverage is silently undercounted.
2. **E2E lanes default to `none`.** Browser coverage needs an instrumented build and a browser-side collector. Unless that already exists, an e2e lane contributes nothing, and configuring it as though it does corrupts the totals.
3. **Prefer per-line formats when more than one lane contributes.** LCOV, Cobertura, JaCoCo, coverage.py JSON, and `coverage-final.json` carry per-line data and merge as a true union. Summary-only formats fall back to a weighted average that counts a shared line once per lane. The gate reports which method it used and flags the approximate one.
4. **Thresholds apply to the merge, not to any single lane.** Do not set per-lane thresholds; that reintroduces the coupling lanes exist to remove.

### Coverage does not transfer across lanes

An e2e suite that walks the whole application does not make the unit lane's uncovered branches covered. If e2e coverage is not collected, those branches are uncovered — that is accurate, not pessimistic. Adding e2e coverage to raise the number, without the instrumentation to make it real, is the coverage equivalent of a wiring-only test.

## Anti-patterns

| Anti-pattern | Why it fails | Fix |
|--------------|--------------|-----|
| One lane containing every test | The slowest test sets the feedback loop for every change | Split by tier |
| E2E on `taskCompleted` | Every task waits minutes; the plugin gets disabled | `gateOn: ["push"]` |
| E2E with `coverage: "include"` but no instrumentation | The report is missing, or empty and scored 100% | `coverage: "none"` |
| An integration lane that mocks the database | It is a unit lane wearing a costume | Use a real DB or testcontainers |
| `optional: true` to silence a red suite | Hides a real defect behind a flag | Fix the suite |
| A lane per package in a monorepo with a workspace runner | N× the setup cost, N× the config to maintain | One aggregate command |
| Retries as the fix for flakiness | Converts a signal into noise | Fix the race; see `tooling-catalog/references/e2e.md` |
| Thresholds set per lane | Recreates the coupling lanes remove | Threshold the merged total |

## Minimum viable configuration

A repo needs exactly **one** lane to be configured. Do not invent an integration lane for a pure library with no I/O, or an e2e lane for a CLI with no UI. Lanes describe what the repo has; they are not a checklist to fill in.

The honest progression:

| Repo shape | Lanes |
|------------|-------|
| Pure library, no I/O | `unit` |
| Library with filesystem or network adapters | `unit`, `integration` |
| Web service | `unit`, `integration` |
| Web service with a UI | `unit`, `integration`, `e2e` |
| Service in a mesh with declared consumers | `unit`, `integration`, `contract`, `e2e` |

## Scope

Covers the test-level taxonomy — which behavior belongs in a unit, integration, e2e, or contract lane, how lanes bind to gate triggers, and how each lane participates in coverage.

Does NOT cover:

| Question | Skill |
|----------|-------|
| How strongly does this test verify anything? | `tdd-guardian:policy-core` |
| What command runs this lane in language X? | `tdd-guardian:tooling-catalog` |
| How are multi-lane coverage reports merged? | `tdd-guardian:coverage-gate` |
| How is a lane detected and written to config? | `commands/shared/detect-tooling.md` |
