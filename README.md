# tdd-guardian

[![Validated by NLPM](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/xiaolai/tdd-guardian-for-claude/main/nlpm-badge.json)](https://github.com/xiaolai/tdd-guardian-for-claude/blob/main/nlpm-badge.json)
[![nlpm score 100/100](https://img.shields.io/badge/nlpm%20score-100%2F100-success)](https://github.com/xiaolai/tdd-guardian-for-claude/blob/main/nlpm-score.json)
[![tests 292](https://img.shields.io/badge/tests-292%20passing-success)](https://github.com/xiaolai/tdd-guardian-for-claude/tree/main/tests)

TDD Guardian for Claude Code — enforces strict test-driven development discipline with automated quality gates across **unit, integration, e2e, and contract test lanes**.

## What it does

- **Test lanes** — each test tier gets its own command, trigger, and coverage participation. A 90-second browser suite gates `git push`; it does not run after every task.
- **Verified setup** — `/tdd-guardian:init` reads your CI config first, then dry-run probes every proposed command before writing it. A lane that discovers zero tests is reported, not configured.
- **Coverage gates** — 9 report formats parsed and merged, with an exact per-line union when the formats allow it and an explicitly-flagged approximation when they do not.
- **Mutation testing** — optional, per-trigger.
- **Behavior-driven test quality** — rejects wiring-only tests that assert mock calls without verifying observable behavior.
- **Specification strength** — a third axis beyond assertion level and lane: how much of the input space a test actually claims, S1 (one example) through S6 (metamorphic relation). A unit with a conservation law or a round-trip needs a property, not more examples.
- **Adversarial specification review** — `tdd-spec-adversary` attacks the test matrix *before* any implementation exists, hunting for the simplest wrong implementation that would pass every case.
- **Red receipts** — records that your tests failed for a real reason before the code existed, then checks that no assertion moved on the way to green. Opt-in evidence; its absence reports as unverified, never as a violation.
- **Critical paths** — per-glob coverage thresholds and specification requirements, because one repo-wide number treats the payment core and the logging helper alike.
- **Commit and push gating** — hooks check that every lane bound to the action has a fresh pass.
- **Greenfield-aware** — a lane that has never had a test is in *bootstrap*: reported loudly on every run, but not blocking. The strict "zero tests is a failure" rule switches on permanently the moment that lane runs its first test.

Part of the [xiaolai plugin marketplace](https://github.com/xiaolai/claude-plugin-marketplace).

## Installation

Add the marketplace (once):

```
/plugin marketplace add xiaolai/claude-plugin-marketplace
```

Then install:

```
/plugin install tdd-guardian@xiaolai
```

> **Install fails with "Plugin not found in marketplace 'xiaolai'"?** Your local marketplace clone is stale. Run `claude plugin marketplace update xiaolai` and retry — `plugin install` does not auto-refresh.

| Scope | Command | Effect |
|-------|---------|--------|
| **User** (default) | `/plugin install tdd-guardian@xiaolai` | Available in all your projects |
| **Project** | `/plugin install tdd-guardian@xiaolai --scope project` | Shared with team via `.claude/settings.json` |
| **Local** | `/plugin install tdd-guardian@xiaolai --scope local` | Only you, only this repo |

### Initialize for your project

Run `/tdd-guardian:init` inside your project. It detects your lanes, probes each one, and writes `.claude/tdd-guardian/config.json`.

## Commands

| Command | Description |
|---------|-------------|
| `/tdd-guardian:init` | Detect and verify test lanes, write config |
| `/tdd-guardian:probe` | Dry-run every lane to check it resolves and finds tests. Runs no suites |
| `/tdd-guardian:gate` | Run the lanes for a trigger (`commit`, `push`, a lane name) and refresh gate state |
| `/tdd-guardian:status` | Per-lane freshness, and whether commit/push is currently blocked |
| `/tdd-guardian:workflow` | Full TDD workflow with specialized subagents |
| `/tdd-guardian:plan` | Break a task into work items with acceptance criteria |
| `/tdd-guardian:design-tests` | Produce a behavior-driven test matrix |
| `/tdd-guardian:implement` | Red/green/refactor one work item, then verify |
| `/tdd-guardian:audit-coverage` | Run the coverage gate and list uncovered branches |
| `/tdd-guardian:audit-mutation` | Run mutation testing and list surviving mutants |
| `/tdd-guardian:review` | Final code + test quality review |

The red-receipt CLI is not a slash command — `/tdd-guardian:implement` drives it:

```bash
node <plugin>/scripts/tdd-guardian/receipt.js record --id WI-1   # before the implementation
node <plugin>/scripts/tdd-guardian/receipt.js verify --id WI-1   # after the implementation
```

`verify` re-runs the recorded lane itself and judges the receipt only if that lane is green. A receipt verified while the suite is still red stays `PENDING` rather than banking a verdict about a transition that has not happened.

## Lanes

A **lane** is one test tier with its own command, trigger, and coverage participation.

| Lane | Boundary | Typical runtime | Default trigger | Coverage |
|------|----------|-----------------|-----------------|----------|
| `unit` | In-process | < 60s | `taskCompleted`, `commit` | include |
| `integration` | Real adapters — DB, HTTP, containers | 1–5 min | `commit` | include |
| `e2e` | The deployed system through its real interface | 5–30 min | `push` | none |
| `contract` | The agreement between two services | varies | consumer `commit`, provider `push` | none |

Triggers:

- **`taskCompleted`** — the hook *runs* these lanes when Claude finishes a task.
- **`commit`** — checked for *freshness* before `git commit`.
- **`push`** — checked before `git push`, `gh pr create`, and publish commands. **`push` subsumes `commit`.**
- **`manual`** — only via `/tdd-guardian:gate <lane>`.

## Language support

`/tdd-guardian:init` reads your CI config first — the commands maintainers actually run — then confirms against manifests, then verifies by dry-run probe. The `tooling-catalog` skill carries per-language runners, coverage tools, formats, mutation tools, and probe commands for:

| Reference | Languages |
|-----------|-----------|
| `js-ts` | JavaScript, TypeScript, Node.js, Deno, Bun |
| `python` | Python |
| `jvm` | Java, Kotlin, Scala, Clojure, Groovy |
| `dotnet` | C#, F#, VB.NET |
| `native` | C, C++, Rust, Go, Zig, Swift, Objective-C |
| `dynamic` | Ruby, PHP, Perl, Lua |
| `functional` | Elixir, Erlang, Haskell, OCaml |
| `data-mobile` | Dart/Flutter, R, Julia, Shell |
| `e2e` | Playwright, Cypress, WebdriverIO, testcontainers, Pact, k6, Appium, Maestro, and more |

A language outside the catalog still works — the plugin reads your CI config and asks. If its coverage tool can emit LCOV or Cobertura, coverage gating works with no plugin change.

### Coverage formats

`istanbul-summary`, `istanbul-final`, `lcov`, `cobertura`, `jacoco`, `clover`, `coverage-py`, `go-cover`, `simplecov`.

When several lanes contribute coverage, reports carrying per-line detail merge as an **exact union**. Summary-only formats fall back to a weighted average, and the gate says so — a weighted number is not quoted as if it were a union.

A dimension the tool does not measure is `null`, not zero, and produces a warning rather than a failure. go-cover reports no functions or branches; coverage.py reports no functions.

## How it works

### The TDD workflow (`/tdd-guardian:workflow`)

Seven specialized subagents in sequence:

1. **tdd-planner** — work items with acceptance criteria
2. **tdd-test-designer** — a test matrix with a lane, an assertion level, and a spec level per case
3. **tdd-spec-adversary** — attacks that matrix before any code exists, looking for the wrong implementation that would pass every case
4. **tdd-implementer** — small batches, verified against the fast `taskCompleted` lanes, with a red receipt per work item
5. **tdd-coverage-auditor** — runs contributing lanes, merges, enforces thresholds and critical paths
6. **tdd-mutation-auditor** — mutation testing when enabled
7. **tdd-reviewer** — findings-first review of code, test quality, specification strength, and change tax

The workflow stops at the first gate failure.

The adversary is the only gate that runs *before* the implementation. Every other one reads code that already exists, by which point the specification has been shaped by knowing how the thing was built.

### Hook enforcement

- **PreToolUse** (`pretool_guard.js`) — classifies each Bash command as commit-class or push-class, then checks that every lane bound to that action has a fresh pass. With `blockCommitWithoutFreshGate: true` it **denies** by default; set `staleGateAction: "warn"` to warn instead. Both are `false`/`deny` out of the box, so nothing blocks until you opt in.
- **TaskCompleted** (`taskcompleted_gate.js`) — runs the `taskCompleted` lanes, merges coverage, runs the mutation gate if bound, and records per-lane state.

Freshness uses `gateFreshnessMinutes`, and with `smartStaleness` an expired pass stays valid while no source file has changed — checked against **both** committed changes and the working tree.

### Test quality philosophy

Three independent axes.

**How strongly does this test verify anything** — the assertion hierarchy:

| Level | Type | Quality |
|-------|------|---------|
| 1 | Output verification | Best |
| 2 | Side-effect verification | Best |
| 3 | Real integration | Best |
| 4 | State verification | Good |
| 5 | Mock return + output | Good |
| 6 | Mock call args | Weak |
| 7 | Mock was called | Unacceptable alone |

Tests with only Level 6-7 assertions are flagged and must be upgraded.

**At what level is it verified** — the lane. The rule that settles borderline cases:

> If the test would still pass when the real collaborator is broken, it belongs one lane higher.

Mocking a boundary creates an obligation: a named integration-lane test must cover the real path. The reviewer checks that the pairing exists.

**How much of the input space does it claim** — the specification level:

| Level | The claim |
|-------|-----------|
| S1 | Example — one input, one output |
| S2 | Boundary / equivalence class |
| S3 | Named failure mode |
| S4 | Property over a generated domain |
| S5 | Invariant across state transitions — conservation, round-trip, idempotence |
| S6 | Metamorphic relation, where no oracle exists |

`expect(add(2, 3)).toBe(5)` is a Level 1 assertion and an S1 claim: implementation-independent, and almost content-free. A unit **with a law** — a conserved quantity, a round-trip, an idempotent operation — needs an S4-S6 case covering it. A unit with no law records that fact rather than leaving the question unasked. Every language in the catalog names a property-testing library, because a level the catalog cannot equip is aspiration rather than policy.

### What tests cost

Every rule above pushes toward more verification. Pushed without a counterweight it produces a suite so coupled to structure that nobody dares refactor, so the reviewer also flags the symmetric pathology: refactors that edit dozens of existing assertions without changing behavior, interfaces with exactly one implementation and one test double, more mocks in a test than the unit has collaborators.

What tests buy is not fewer bugs today — it is a lower marginal cost of future change. That is why a one-off script rationally gets none and a payment core rationally gets properties, mutation testing, and its own `criticalPaths` entry.

## Configuration

`.claude/tdd-guardian/config.json`:

```json
{
  "schemaVersion": 2,
  "enabled": true,
  "enforceOnTaskCompleted": false,
  "blockCommitWithoutFreshGate": false,
  "staleGateAction": "deny",
  "gateFreshnessMinutes": 120,
  "smartStaleness": true,
  "bypassEnv": "TDD_GUARD_BYPASS",
  "preflightCommand": "pnpm exec tsc --noEmit",
  "lanes": [
    {
      "name": "unit",
      "command": "pnpm exec vitest run --coverage",
      "gateOn": ["taskCompleted", "commit"],
      "coverage": "include",
      "coverageSummaryPath": "coverage/coverage-summary.json",
      "probeCommand": "pnpm exec vitest list",
      "timeoutMs": 600000
    },
    {
      "name": "e2e",
      "setupCommand": "docker compose -f docker-compose.test.yml up -d --wait",
      "command": "pnpm exec playwright test --project=chromium",
      "teardownCommand": "docker compose -f docker-compose.test.yml down -v",
      "gateOn": ["push"],
      "coverage": "none",
      "timeoutMs": 1800000
    }
  ],
  "coverageThresholds": { "lines": 100, "functions": 100, "branches": 100, "statements": 100 },
  "criticalPaths": [
    {
      "glob": "src/payments/**",
      "description": "Money movement — a defect here is not recoverable by a redeploy.",
      "thresholds": { "lines": 100, "functions": 100, "branches": 100, "statements": 100 },
      "requireSpecLevel": "S5"
    }
  ],
  "coverageMode": "absolute",
  "requireMutation": false,
  "mutationCommand": "npx stryker run",
  "mutationGateOn": ["push"]
}
```

### Top-level settings

| Setting | Description | Default |
|---------|-------------|---------|
| `enabled` | Master switch | `true` |
| `lanes` | Test lanes — at least one required | — |
| `enforceOnTaskCompleted` | Run `taskCompleted` lanes on task completion | `false` |
| `blockCommitWithoutFreshGate` | Check lane freshness before commit/push | `false` |
| `staleGateAction` | `"deny"` or `"warn"` on a stale gate | `"deny"` |
| `gateFreshnessMinutes` | How long a passing lane stays fresh | `120` |
| `smartStaleness` | Keep an expired pass valid while no source changed | `true` |
| `bypassEnv` | Env var to bypass all gates | `TDD_GUARD_BYPASS` |
| `preflightCommand` | Runs once before any lane (e.g. a type check) | `""` |
| `coverageThresholds` | Applied to the **merged** total | `100` for all |
| `criticalPaths` | Per-glob thresholds and spec requirements | `[]` |
| `coverageMode` | `"absolute"` or `"no-decrease"` | `"absolute"` |
| `requireMutation` | Enable the mutation gate | `false` |
| `mutationCommand` | Mutation test runner | `""` |
| `mutationGateOn` | Triggers the mutation gate runs on | `["taskCompleted"]` |

### Lane settings

| Setting | Description | Default |
|---------|-------------|---------|
| `name` | Unique slug | required |
| `command` | Runs this lane's tests | required |
| `gateOn` | `taskCompleted`, `commit`, `push`, `manual` | `["taskCompleted","commit"]` |
| `coverage` | `"include"` or `"none"` | `"none"` |
| `coverageSummaryPath` | Required with `"include"`; unique per lane | — |
| `coverageReportCommand` | Extra report step for two-step coverage tools | `""` |
| `setupCommand` / `teardownCommand` | Start/stop services; teardown always runs | `""` |
| `probeCommand` | Dry-run listing for `/tdd-guardian:probe` | `""` |
| `timeoutMs` | Lane timeout | `600000` |
| `optional` | Record failures without blocking | `false` |

### Critical-path settings

A lane says how expensive a suite is to **run**. A critical path says how expensive the code is to get **wrong** — the axis a single repo-wide threshold cannot express.

| Setting | Description | Default |
|---------|-------------|---------|
| `glob` | Path pattern: `**`, `*`, `?`, with standard glob semantics — `**` is a whole segment and matches zero or more of them; `*` and `?` never cross `/`. Matches at any segment boundary, so it works against both absolute and relative report paths. **Case-sensitive**; matched by a segment walk, not a regex | required |
| `description` | Why this path is critical | `""` |
| `thresholds` | Overrides `coverageThresholds` for matched files | inherits |
| `requireSpecLevel` | `S1`–`S6` from `policy-core` | `""` |
| `requireMutation` | Demand a mutation run for this path | `false` |

Fail-loud rules, all enforced:

- A critical threshold **looser** than the repo-wide one warns — a critical path should tighten the gate, not loosen it.
- Brace expansion (`src/{a,b}/**`) is **rejected**, not silently ignored. Write one entry per alternative.
- An **empty** glob matches nothing rather than everything, and a `thresholds` value that is not a JSON number in `[0, 100]` is an error — `"100"`, `""`, `null`, and `false` are all rejected rather than quietly becoming 0.
- Matching is **case-sensitive**. `src/Auth/**` does not also cover `src/auth/**`; on a case-sensitive filesystem that would average an unrelated directory into the score.
- A glob matching **zero files** is a **failure**, not a warning. There is no legitimate steady state in which a critical path matches nothing — either the glob is wrong, or the code it names has no measured coverage, and both are the thing you configured it to find.
- A threshold on a dimension the merge cannot compute exactly (functions and branches, once more than one lane contributes) is a **failure** rather than a number quoted with false confidence. Emit one authoritative report for those files, or set that threshold to 0.
- A merged report with no per-file data **fails** rather than skipping — a strict rule that cannot be evaluated must not report success.
- `requireMutation` without a `mutationCommand` is an error: a requirement that can never be met.
- Critical paths are absolute bars in **both** coverage modes, and a failing one does not bank a new `no-decrease` baseline.

### Bypass

```bash
TDD_GUARD_BYPASS=1 claude
```

## Upgrading

**From 0.7.x (schema v1).** Existing configs keep working unchanged — the hooks migrate `testCommand`/`coverageCommand` in memory to a single `unit` lane, preserving the original two-command behaviour exactly. Nothing to do.

To adopt lanes, re-run `/tdd-guardian:init`. It detects your integration and e2e suites and shows a diff before writing.

Two behaviour changes worth knowing:

- **PreToolUse now denies rather than warns** when `blockCommitWithoutFreshGate` is `true`. The old behaviour always warned regardless, which contradicted the setting's name. Set `staleGateAction: "warn"` to keep warning.
- **Coverage parsing now handles all 9 formats.** Previously only Istanbul JSON was parsed in the hook, so Go, Rust, and Python projects saw the gate fail with "coverage summary not found or invalid" despite a valid report.

**From 0.8.x.** Nothing to do — `criticalPaths` defaults to `[]`, so existing configs validate and behave exactly as before. Three additions are opt-in:

- Add a `criticalPaths` entry to hold your highest-consequence code to a stricter bar than the repo average.
- Run `/tdd-guardian:implement` to start recording red receipts; without them the separation check reports `NOT-RECORDED`, which is honest rather than failing.
- Re-run `/tdd-guardian:init` to be offered a mutation tool and critical-path candidates for your ecosystem.

> **From 0.7.2:** command names lost their redundant prefix in 0.7.3. `/tdd-guardian:tdd-guardian-init` is now `/tdd-guardian:init`.

## Project structure

```
.claude-plugin/plugin.json     Plugin metadata
hooks/hooks.json               Hook registration
agents/                        Seven TDD subagents
commands/                      Slash commands (basename = command name)
  init, probe, gate, status, workflow, plan, design-tests,
  implement, audit-coverage, audit-mutation, review
  shared/                      Partials: load-config, detect-tooling,
                               run-lane, parse-coverage, parse-mutation
config/config.json             Default configuration template
scripts/tdd-guardian/
  lib/config.js                Load, migrate v1→v2, validate
  lib/coverage.js              9-format parser + union/weighted merge
  lib/lanes.js                 Lane selection, execution, state, freshness
  lib/exec.js                  Run + classify (runner failure vs test failure)
  lib/verification.js          Red receipts, spec fingerprints, separation check
  receipt.js                   Red-receipt CLI (record / verify / show)
  pretool_guard.js             PreToolUse hook
  taskcompleted_gate.js        TaskCompleted hook
skills/tdd-guardian/
  policy-core/                 Global TDD governance policy
  lane-policy/                 Test-level taxonomy
  tooling-catalog/             Per-language tooling reference (9 files)
  test-matrix/                 Test matrix design
  coverage-gate/               Coverage enforcement
  mutation-gate/               Mutation testing
  review-gate/                 Code + test quality review
  init/, workflow/             Setup and orchestration
tests/                         node --test suite for the libs and hooks
```

## Development

The plugin's own JavaScript is tested with Node's built-in runner — no dependencies, no install step:

```bash
node --test
```

292 tests cover every coverage format, config migration and validation, critical-path evaluation and glob matching, lane selection and freshness, exit-code classification, red-receipt classification and verification, the receipt CLI, and both hooks driven end to end through stdin.

## License

ISC
