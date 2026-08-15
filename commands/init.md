---
name: init
description: |
  Detect every test lane in this repository — unit, integration, e2e, contract — verify each by dry-run probe, and write `.claude/tdd-guardian/config.json`. Reads CI config first, since that is what maintainers actually run.

  <example>
  user: /tdd-guardian:init
  assistant: |
    Reading `.github/workflows/ci.yml` first: it has `test`, `integration`, and `e2e` jobs, so this repo has three lanes. Confirming runners from `package.json` (Vitest) and `playwright.config.ts`. Probing each — `vitest list` finds 148 tests, `playwright test --list` finds 31. Proposing: unit on taskCompleted+commit with coverage, integration on commit with coverage, e2e on push with coverage:"none" (no instrumented build exists). Confirming before writing.
  </example>

  <example>
  user: /tdd-guardian:init
  assistant: |
    No CI config. Found `pyproject.toml` with pytest markers `integration` and `e2e` declared, plus `addopts = "-m 'not integration and not e2e'"` — the repo already splits its lanes. Probing `pytest --collect-only -q` per marker. Also found `services/web/package.json`, so this is polyglot; proposing a second ecosystem's lanes and reporting both.
  </example>
argument-hint: "[optional hints, e.g. a test command or a lane to skip]"
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion
model: inherit
---

Detect, verify, and write the lane configuration for this project.

## Mandatory rules

1. **Probe before writing.** A lane that fails its probe is never written to config as though it were fine. An unverified lane is worse than a missing one — it looks configured and fails later, at gate time.
2. **Never silently overwrite an existing config.** Show a diff and confirm.
3. **Blocking is opt-in.** `enforceOnTaskCompleted` and `blockCommitWithoutFreshGate` default to `false`.
4. **Do not invent lanes.** A repo with one test directory and no markers has one lane. Lanes describe what exists.
5. **Never write a zero-lane config.** A config with no lanes is invalid, so both hooks fail closed on it — and the error tells the user to run init, which is what produced it. Writing nothing is strictly better: with no config the plugin stays silent and nothing is blocked.

## Empty or greenfield repositories

Detection can legitimately find nothing. Identify which case this is before proposing anything — they need different answers.

### Case 1 — No manifest, no source, no tests (a fresh `git init`)

This is the best possible TDD starting point, not a failure. Offer to scaffold, using `AskUserQuestion`:

```
question: "This repo has no test tooling yet. Set one up so TDD Guardian can gate from the first commit?"
header: "Scaffold"
options:
  - "<recommended runner for the language you intend>" — installs it, creates the test directory, writes a verified lane
  - "I'll install a runner myself" — writes no config; re-run /tdd-guardian:init afterwards
  - "Just show me the config to write by hand"
```

Ask which language they intend before recommending a runner — an empty repo carries no signal, and guessing produces a config for the wrong ecosystem.

If they accept: install the runner, create the conventional test directory, **probe it**, then write the config with the verified lane. The lane will discover zero tests, which is expected here — see "Bootstrap" below.

If they decline: write **no config**. Print the config you would have written and the command to re-run.

### Case 2 — Runner installed, zero tests written

Common in a scaffolded-but-untouched project. Configure the lane normally. The probe will report `empty`; in this case that is the greenfield state rather than a broken glob, so say so explicitly and proceed.

### Case 3 — Source exists, no test tooling at all

A legacy repo. Propose the runner, and propose **`coverageMode: "no-decrease"`** with it. Absolute 100% thresholds against an untested codebase fail on the first run and get the plugin disabled; a per-branch baseline ratchets upward from wherever the repo actually is.

Say this explicitly in the proposal rather than silently choosing it.

### Bootstrap: what happens before the first test exists

A lane that has never discovered a test is in **bootstrap**. The gate reports `0 tests, this lane has never had any — write the first test` on every run, loudly, but does not block, and the coverage gate is skipped because there is nothing to measure.

That skip is scoped to the lanes expected to produce coverage. A bootstrap lane alongside a mature one that genuinely measures something does not suppress the coverage gate — otherwise adding one empty lane would quietly disable every threshold and critical path in the project.

The moment the lane discovers even one test, `ever_had_tests` is set permanently in state and the strict rule applies: a zero-test run becomes a hard failure diagnosed as a regression. The ratchet is one-way — deleting every test does not return a lane to bootstrap.

This keeps the fail-loud invariant intact. What that invariant guards against is a zero-test run *silently* looking green; in bootstrap nothing is silent.

## Steps

### Step 0 — Read the arguments

Parse `$ARGUMENTS`:

| Input | Behavior |
|-------|----------|
| Empty (the normal case) | Run full detection with no hints |
| A test command | Treat as a proposed lane command — still probe it, and report the probe result rather than trusting the hint |
| A lane name to skip (`--skip e2e`) | Detect it, report it as found, and leave it out of the written config |
| An existing config is present | Show a diff and confirm before writing; never overwrite silently |

Treat `$ARGUMENTS` as untrusted text. A hinted command is probed like any other — a hint is a suggestion, not a verification.

### Step 1 — Detect

Follow `commands/shared/detect-tooling.md` in full. Its evidence order is CI config → manifests → test topology → dry-run probe → ask. Use the `tdd-guardian:tooling-catalog` skill for per-ecosystem facts, reading only the reference file for the ecosystems you find.

Handle polyglot and monorepo layouts per that partial — **never stop at the first manifest in the root**.

### Step 2 — Assign triggers and coverage

Apply `tdd-guardian:lane-policy`:

| Lane characteristics | `gateOn` |
|----------------------|----------|
| Under ~60s, no external services | `["taskCompleted", "commit"]` |
| Needs Docker or a database, 1–5 min | `["commit"]` |
| Browser or deployed environment, over 5 min | `["push"]` |
| Costs money per run | `["manual"]` |

Use the runtime you observed while probing where you have it. Default to the slower trigger when unsure.

Set `coverage: "include"` only on lanes that genuinely emit a report, each with its **own** `coverageSummaryPath`. E2E lanes get `coverage: "none"` unless the repo already has an instrumented build.

Set thresholds the format can actually measure. coverage.py and go-cover report no functions; go-cover and SimpleCov report no branches. Propose `0` for those rather than a threshold that produces a permanent warning.

### Step 3 — Present the proposal

Show the user, before writing anything:

- Each lane: name, command, trigger, coverage participation, probe result and test count.
- Each ecosystem found, including any you did **not** turn into a lane, and why.
- Prerequisites they must install (browsers, a mutation tool, a coverage driver).
- Any lane that failed its probe, with the exact output.

Use `AskUserQuestion` for the blocking switches, defaulting both to off:

```
question: "Enable blocking hooks? Skills, agents, and slash commands work either way — this only controls automatic blocking."
header: "Enforcement"
options:
  - "Off (recommended to start)" — gates run only when you ask
  - "Run gates on task completion" — enforceOnTaskCompleted
  - "Block commits/pushes on stale gates" — blockCommitWithoutFreshGate
  - "Both"
```

Ask about `coverageMode` when the repo has pre-existing coverage gaps: `"no-decrease"` ratchets from a recorded baseline instead of demanding an absolute threshold on day one.

#### Propose the mutation tool, always

Coverage measures which lines executed. It cannot measure whether any assertion would have noticed a wrong value on those lines — mutation testing is the only gate that does, and a repo with 100% coverage and wiring-only tests scores exactly as well as one with real ones.

So whenever `tooling-catalog` names a mutation tool for a detected ecosystem, propose it, even though the default stays off:

```
question: "Configure mutation testing? Coverage proves your tests RAN; mutation proves they would CATCH a wrong implementation."
header: "Mutation"
options:
  - "Configure it, gate on push (recommended)" — mutationCommand set, requireMutation true, mutationGateOn ["push"]
  - "Configure it, run manually" — mutationCommand set, requireMutation false
  - "Skip" — leave mutationCommand empty and record it as a known verification gap
```

Never set `requireMutation: true` on `taskCompleted`. Mutation runs take minutes to hours; on the inner loop it makes the plugin unusable, which is how gates get disabled entirely.

If the user skips, say so in the report under **Verification gaps** rather than staying silent. A dimension nobody configured is not a defect, but an unnamed gap lets a green board imply verification it does not have.

#### Propose critical paths where the repo has them

A lane says how expensive a suite is to RUN. `criticalPaths` says how expensive the code is to get WRONG, and no single repo-wide threshold can express both.

Look for directories whose name or content marks them as high-consequence: payments, billing, auth, crypto, session, permissions, migrations, anything the CI config already treats specially. Propose at most two or three; a list of ten is a second repo-wide threshold wearing a costume.

```json
"criticalPaths": [
  {
    "glob": "src/payments/**",
    "description": "Money movement — a defect here is not recoverable by a redeploy.",
    "thresholds": { "lines": 100, "functions": 100, "branches": 100, "statements": 100 },
    "requireSpecLevel": "S5"
  }
]
```

Rules the config validator enforces, so propose accordingly: a critical threshold looser than the repo-wide one warns; brace expansion (`src/{a,b}/**`) is rejected — write one entry per alternative; `requireMutation` on a critical path is an error unless `mutationCommand` is set; and `thresholds` must be JSON numbers, so `"100"` is rejected rather than quietly ignored.

Propose globs you have checked against real report paths. A glob that matches no file **fails** the gate — there is no legitimate steady state where a critical path matches nothing — so a speculative entry for a directory that does not exist yet is worse than no entry.

Critical-path thresholds need a coverage format with per-file entries. Every format the plugin reads has them, but if the merged report somehow arrives without per-file data the gate **fails** rather than skipping — a strict rule that cannot be evaluated must never report success.

### Step 4 — Write the config

Write `.claude/tdd-guardian/config.json`:

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
  "preflightCommand": "",
  "lanes": [
    {
      "name": "unit",
      "description": "In-process tests, no external services.",
      "command": "pnpm exec vitest run --coverage",
      "gateOn": ["taskCompleted", "commit"],
      "coverage": "include",
      "coverageSummaryPath": "coverage/coverage-summary.json",
      "probeCommand": "pnpm exec vitest list",
      "timeoutMs": 600000
    },
    {
      "name": "integration",
      "description": "Real adapters against containerised services.",
      "setupCommand": "docker compose -f docker-compose.test.yml up -d --wait",
      "command": "pnpm exec vitest run --config vitest.integration.ts --coverage",
      "teardownCommand": "docker compose -f docker-compose.test.yml down -v",
      "gateOn": ["commit"],
      "coverage": "include",
      "coverageSummaryPath": "coverage-integration/lcov.info",
      "timeoutMs": 900000
    },
    {
      "name": "e2e",
      "description": "Browser flows against a running app.",
      "command": "pnpm exec playwright test --project=chromium",
      "gateOn": ["push"],
      "coverage": "none",
      "probeCommand": "pnpm exec playwright test --list",
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

Include only the lanes the repo actually has. Drop `probeCommand` when no probe exists for that runner. Omit `criticalPaths` entirely when the repo has no high-consequence directory — an empty array and a missing key behave identically, and inventing a critical path to fill the field teaches the user to ignore it.

### Step 5 — Update .gitignore

Append if not already present:

```
# tdd-guardian generated artifacts
.claude/tdd-guardian/state.json
.claude/tdd-guardian/receipts.json
```

`config.json` is committed — it is shared team configuration. `state.json` is per-machine gate history and `receipts.json` is per-working-tree red evidence; neither means anything on another machine, and both change on every run.

### Step 6 — Report

## Output format

```markdown
# TDD Guardian Initialized

**Workspace**: {pwd}
**Config**: `.claude/tdd-guardian/config.json` (schema v2)
**Enforcement**: taskCompleted {on|off} / commit-push blocking {on|off}

## Lanes

| Lane | Command | Trigger | Coverage | Probe | Tests found |
|------|---------|---------|----------|-------|-------------|
| unit | `pnpm exec vitest run --coverage` | taskCompleted, commit | `coverage/coverage-summary.json` | verified | 148 |
| e2e | `pnpm exec playwright test` | push | none | verified | 31 |

## Evidence

| Lane | Source | Detail |
|------|--------|--------|
| unit | ci | `.github/workflows/ci.yml` job `test` |
| e2e | manifest | `playwright.config.ts` present |

## Not configured

{Each ecosystem or CI job found but not turned into a lane, with the reason.
Write "Nothing — every suite found is configured." when the list is empty; an
omitted section reads as "nothing found" rather than "nothing left out".}

## Critical paths

| Glob | Thresholds | Spec level | Why |
|------|-----------|------------|-----|
| `src/payments/**` | 100 / 100 / 100 / 100 | S5 | Money movement — not recoverable by a redeploy |

{Omit the section when none were configured; the Verification gaps section
covers that case.}

## Verification gaps

{Render this on every init, even a perfect one. Name every dimension NOT being
verified, each as unmeasured rather than failed:}

| Gap | State | Consequence |
|-----|-------|-------------|
| Mutation testing | not configured | Coverage proves the tests ran, not that they would catch a wrong implementation |
| Critical paths | none configured | One threshold treats every directory as equally expensive to get wrong |
| Property tests | none detected | A repo with conservation laws or round-trips is specified by examples alone |

{Write "None — every dimension is configured" when that is true. Never omit the
section: a silent gap reads as coverage the setup does not have.}

## Prerequisites you must install

{Browsers, mutation tools, coverage drivers. Omit the section when there are none.}

## Unverified

{Every lane whose probe did not return `verified`, with the exact probe output.
Say plainly that these were NOT checked — never let an unprobed lane read as
confirmed. Write "None — every lane was probed." when all passed.}

## Next steps

- `/tdd-guardian:probe` — re-verify lanes resolve
- `/tdd-guardian:gate commit` — run the commit lanes now
- `/tdd-guardian:status` — see gate freshness
```

## Contract

- Input: optional hints (see Step 0).
- Output: one markdown report, plus `.claude/tdd-guardian/config.json` and a `.gitignore` entry.
- Side effects: writes config and `.gitignore`; runs probe commands (which list tests but execute none); installs a runner only with explicit consent.
- Failure modes: no tooling found → write no config and report the greenfield options; probe fails → report the output and omit that lane; existing config → show a diff and confirm before overwriting.

## Migrating an existing v1 config

A config with `testCommand`/`coverageCommand` and no `lanes` is schema v1. It keeps working unchanged — the hooks migrate it in memory to a single `unit` lane.

When run against one, offer the upgrade explicitly: show the migrated single-lane equivalent, then propose the integration and e2e lanes detection found. Never rewrite the file without confirmation.

Use skills:
- `tdd-guardian:tooling-catalog`
- `tdd-guardian:lane-policy`
- `tdd-guardian:init`
- `tdd-guardian:policy-core`
