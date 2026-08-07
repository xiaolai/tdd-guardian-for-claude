---
name: init
description: Initialize workspace TDD Guardian config — detect test lanes, verify each by dry-run probe, and write the lane configuration.
---

# Initialize TDD Guardian

Create `.claude/tdd-guardian/config.json` describing every test lane the repository actually has.

## Steps

1. **Detect** — follow `commands/shared/detect-tooling.md`. Evidence order is CI config → manifests → test topology → dry-run probe → ask. Use the `tooling-catalog` skill for per-ecosystem facts.
2. **Probe** — run each proposed lane's probe command. A lane that fails its probe is never written to config as though it were fine.
3. **Assign triggers and coverage** — per `lane-policy`.
4. **Ask** about the blocking switches. Both default to `false`.
5. **Write** the config, then append `.claude/tdd-guardian/state.json` to `.gitignore`.

## Config shape

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
      "command": "<instrumented test command>",
      "gateOn": ["taskCompleted", "commit"],
      "coverage": "include",
      "coverageSummaryPath": "<report path>",
      "probeCommand": "<list-only command>",
      "timeoutMs": 600000
    }
  ],
  "coverageThresholds": { "lines": 100, "functions": 100, "branches": 100, "statements": 100 },
  "coverageMode": "absolute",
  "requireMutation": false,
  "mutationCommand": "",
  "mutationGateOn": ["taskCompleted"]
}
```

Include only the lanes the repo has. A pure library with no I/O gets one lane; do not add an integration or e2e lane to fill in a template.

## Lane fields

| Field | Purpose |
|-------|---------|
| `name` | Unique slug — `unit`, `integration`, `e2e`, `contract` |
| `command` | Runs this lane's tests |
| `gateOn` | `taskCompleted`, `commit`, `push`, `manual` |
| `coverage` | `"include"` joins the merged total; `"none"` does not |
| `coverageSummaryPath` | Required with `"include"`; must be unique per lane |
| `coverageReportCommand` | Extra step for tools that split running from reporting |
| `setupCommand` / `teardownCommand` | Start and stop services; teardown always runs |
| `probeCommand` | Dry-run listing used by `/tdd-guardian:probe` |
| `timeoutMs` | Default 600000 |
| `optional` | Failures record but do not block — for genuinely non-deterministic suites only |

## Coverage mode

- `"absolute"` (default): metrics must meet the configured thresholds.
- `"no-decrease"`: blocks only when coverage drops below a per-branch baseline. Use this on a repo with pre-existing gaps — an absolute 100% on day one just gets the plugin disabled.

## Smart staleness

With `smartStaleness: true` (default), an expired gate stays valid while no source file has changed since it passed — checked against both committed changes and the working tree. Documentation and media changes do not invalidate a gate; manifests, lockfiles, and configs do, because all of them can change test outcomes.

## Thresholds the tool can actually measure

Set a threshold to `0` for any dimension the coverage format does not track, rather than leaving a permanent warning:

| Format | Set to 0 |
|--------|----------|
| go-cover | `functions`, `branches` |
| coverage-py | `functions` |
| SimpleCov (default) | `functions`, `branches` |
| LCOV without `FNF`/`BRF` | `functions`, `branches` |

## Migrating a v1 config

A config with `testCommand`/`coverageCommand` and no `lanes` keeps working — the hooks migrate it in memory to one `unit` lane, preserving the original two-command behaviour. Offer the upgrade explicitly and never rewrite the file without confirmation.

## Scope

Covers the config schema: top-level settings, lane fields, coverage mode, smart staleness, and v1 migration.

Does NOT cover:

| Question | Where |
|----------|-------|
| How is a repo's tooling detected and verified? | `commands/shared/detect-tooling.md` |
| What runner and coverage tool does language X use? | `tdd-guardian:tooling-catalog` |
| Why does this lane get this trigger? | `tdd-guardian:lane-policy` |
