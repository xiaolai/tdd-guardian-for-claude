---
description: "Shared: load .claude/tdd-guardian/config.json, validate fields, fail loudly if missing"
user-invocable: false
---
<!-- Shared partial: TDD Guardian configuration loader -->
<!-- Referenced by: tdd-guardian-plan, tdd-guardian-design-tests, tdd-guardian-implement, tdd-guardian-audit-coverage, tdd-guardian-audit-mutation, tdd-guardian-review, tdd-guardian-status, tdd-guardian-workflow. Do not use standalone. -->

## Purpose

Load and validate the per-project configuration at `.claude/tdd-guardian/config.json`. All TDD Guardian commands depend on this file — a missing or malformed config is a hard stop.

## Steps

### Step 1 — Locate config

Resolve `${WORKSPACE}/.claude/tdd-guardian/config.json`, where `${WORKSPACE}` is the current working directory of the invoking command.

Use the Read tool on that absolute path.

### Step 2 — Fail loudly if missing

If the file does not exist, respond verbatim:

```
TDD Guardian config not found at .claude/tdd-guardian/config.json.

Run `/tdd-guardian:tdd-guardian-init` first to detect your stack and generate the config.
```

And STOP. Do not attempt to auto-create, guess commands, or proceed with defaults.

### Step 3 — Fail loudly if malformed

If the file exists but `JSON.parse` fails, respond:

```
TDD Guardian config at .claude/tdd-guardian/config.json is not valid JSON.

Parser error: {error message}

Fix the file by hand, or delete it and re-run `/tdd-guardian:tdd-guardian-init`.
```

And STOP.

### Step 4 — Extract fields

Parse and expose the following fields to the calling command:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `enabled` | boolean | yes | If false, commands should respond "TDD Guardian is disabled in config — no-op." and STOP |
| `testCommand` | string | yes | Shell command to run the project's test suite |
| `coverageCommand` | string | yes | Shell command to run tests with coverage |
| `coverageSummaryPath` | string | yes | Relative path to coverage output file (JSON/LCOV/XML) |
| `coverageThresholds.lines` | number | yes | 0-100 |
| `coverageThresholds.functions` | number | yes | 0-100 |
| `coverageThresholds.branches` | number | yes | 0-100 |
| `coverageThresholds.statements` | number | yes | 0-100 |
| `coverageMode` | string | optional | `"absolute"` (default) or `"no-decrease"` |
| `requireMutation` | boolean | optional | Defaults to `false` |
| `mutationCommand` | string | conditional | Required if `requireMutation=true` |
| `bypassEnv` | string | optional | Env var name whose presence bypasses gates |
| `preflightCommand` | string | optional | Run before any gate (e.g., `pnpm install --frozen-lockfile`) |
| `gateFreshnessMinutes` | number | optional | How long a passing gate stays "fresh" |
| `enforceOnTaskCompleted` | boolean | optional | Whether the TaskCompleted hook runs gates |
| `blockCommitWithoutFreshGate` | boolean | optional | Whether PreToolUse blocks commits |

### Step 5 — Validate required fields

For every field marked "required":
- If missing or empty, respond: `TDD Guardian config is missing required field '{field}'. Re-run /tdd-guardian:tdd-guardian-init or edit .claude/tdd-guardian/config.json.` — then STOP.

For `coverageThresholds.*`, each must be a number in `[0, 100]`. Out-of-range values are a hard stop.

If `requireMutation=true` but `mutationCommand` is empty, stop with:
`requireMutation is true but mutationCommand is empty — set one or disable mutation gate.`

### Step 6 — Return

Return the parsed, validated config object to the caller. The caller MUST NOT proceed without it.
