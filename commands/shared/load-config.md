---
description: "Shared: load .claude/tdd-guardian/config.json, migrate v1 to v2, validate lanes, fail loudly if missing"
user-invocable: false
---
<!-- Shared partial: TDD Guardian configuration loader -->
<!-- Referenced by: plan, design-tests, implement, audit-coverage, audit-mutation, review, status, probe, gate, workflow. Do not use standalone. -->

## Purpose

Load, migrate, and validate the per-project configuration at `.claude/tdd-guardian/config.json`. All TDD Guardian commands depend on this file — a missing or malformed config is a hard stop.

The same loading, migration, and validation logic is implemented in `scripts/tdd-guardian/lib/config.js` and used by the hooks. **Prefer running it over re-implementing the checks by hand:**

```bash
node -e "const c=require('<plugin-root>/scripts/tdd-guardian/lib/config.js');console.log(JSON.stringify(c.load(process.cwd()),null,2))"
```

That returns `{config, errors, warnings, notes, raw, exists}` in one call, already migrated and validated. Fall back to the manual steps below only when the plugin root is not resolvable.

## Steps

### Step 1 — Locate config

Resolve `${WORKSPACE}/.claude/tdd-guardian/config.json`, where `${WORKSPACE}` is the current working directory of the invoking command. Read that absolute path.

### Step 2 — Fail loudly if missing

If the file does not exist, respond verbatim:

```
TDD Guardian config not found at .claude/tdd-guardian/config.json.

Run `/tdd-guardian:init` first to detect your test lanes and generate the config.
```

And STOP. Do not auto-create, guess commands, or proceed with defaults.

### Step 3 — Fail loudly if malformed

If `JSON.parse` fails:

```
TDD Guardian config at .claude/tdd-guardian/config.json is not valid JSON.

Parser error: {error message}

Fix the file by hand, or delete it and re-run `/tdd-guardian:init`.
```

And STOP.

### Step 4 — Migrate schema v1 if needed

A config with no `lanes` array but with `testCommand` is schema v1. Migrate it in memory (do not rewrite the file unless the user asks):

- Create one lane named `unit` with `command` = `testCommand`.
- `gateOn` = `["taskCompleted", "commit"]`.
- If `coverageSummaryPath` is set, `coverage` = `"include"` and carry the path over.
- If `coverageCommand` differs from `testCommand`, set it as `coverageReportCommand` — v1 ran both as two executions, and migration preserves that rather than silently changing what runs.

Surface the migration to the user once, as a note, with a pointer to `/tdd-guardian:init` for adding integration and e2e lanes. Never migrate silently.

### Step 5 — Extract top-level fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `schemaVersion` | number | no | `2` for lane configs; absent means v1 |
| `enabled` | boolean | yes | If false, respond "TDD Guardian is disabled in config — no-op." and STOP |
| `lanes` | array | yes | At least one entry; see Step 6 |
| `coverageThresholds.{lines,functions,branches,statements}` | number | yes | 0-100 |
| `coverageMode` | string | no | `"absolute"` (default) or `"no-decrease"` |
| `staleGateAction` | string | no | `"deny"` (default) or `"warn"` — what PreToolUse does on a stale gate |
| `requireMutation` | boolean | no | Defaults to `false` |
| `mutationCommand` | string | conditional | Required when `requireMutation` is true |
| `mutationGateOn` | array | no | Defaults to `["taskCompleted"]` |
| `bypassEnv` | string | no | Env var whose truthy value bypasses gates |
| `preflightCommand` | string | no | Runs before any lane (e.g. a type check) |
| `gateFreshnessMinutes` | number | no | How long a passing lane stays fresh |
| `smartStaleness` | boolean | no | Default true — an expired pass stays valid while no source changed |
| `enforceOnTaskCompleted` | boolean | no | Whether the TaskCompleted hook runs lanes |
| `blockCommitWithoutFreshGate` | boolean | no | Whether PreToolUse checks freshness |

### Step 6 — Validate every lane

| Lane field | Type | Required | Notes |
|------------|------|----------|-------|
| `name` | string | yes | Unique; lowercase alphanumeric with hyphens |
| `command` | string | yes | The command that runs this lane's tests |
| `gateOn` | array | no | Subset of `taskCompleted`, `commit`, `push`, `manual`. Omitted defaults to `["taskCompleted","commit"]`; explicit `[]` means manual-only |
| `coverage` | string | no | `"include"` or `"none"` (default) |
| `coverageSummaryPath` | string | conditional | Required when `coverage` is `"include"` |
| `coverageReportCommand` | string | no | Extra report step for tools that split running from reporting |
| `setupCommand` | string | no | Starts services; runs before `command` |
| `teardownCommand` | string | no | Always runs once setup ran, even on failure |
| `probeCommand` | string | no | Dry-run listing used by `/tdd-guardian:probe` |
| `timeoutMs` | number | no | Default 600000 |
| `optional` | boolean | no | Failures record but do not block |

Hard stops:

- Any lane missing `name` or `command`.
- Duplicate lane names.
- A `gateOn` entry outside the valid set.
- `coverage: "include"` with no `coverageSummaryPath`.
- Zero lanes configured.
- A threshold outside `[0, 100]`.
- `requireMutation` true with an empty `mutationCommand`.

Warnings (report, do not stop):

- Non-zero thresholds with no lane setting `coverage: "include"` — the coverage gate cannot run.
- Two lanes sharing a `coverageSummaryPath` — the second overwrites the first and coverage is undercounted.
- A lane on `taskCompleted` with a timeout over 15 minutes — long suites belong on `push`.

### Step 7 — Return

Return the parsed, migrated, validated config plus the warning and note lists. The caller MUST NOT proceed without a config, and MUST surface warnings rather than swallowing them — every one of them describes a way the gate can silently do nothing.
