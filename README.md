# TDD Guardian for Codex

TDD Guardian is a Codex-native port of `tdd-guardian-for-claude`. It preserves the original strict test-driven development workflow while using Codex plugin, skill, hook, and custom-agent conventions.

## What It Does

- Enforces plan-first implementation and explicit acceptance criteria.
- Requires behavior-driven tests before or alongside code changes.
- Runs configured tests, coverage checks, and optional mutation tests after source changes.
- Blocks `git commit`, `git push`, `gh pr create|merge`, and package publish commands when gates are stale or failing.
- Logs every hook run completely under `.codex/tdd-guardian/logs/`.

## Codex Architecture

The plugin itself bundles reusable skills and templates:

```text
.codex-plugin/plugin.json
skills/
commands/
templates/
  hooks.json
  config.default.json
  scripts/
  agents/
scripts/tdd-guardian/install.js
```

Codex discovers plugin skills from `skills/`. Runtime hooks are installed into the target repository because Codex loads hooks from `.codex/hooks.json` or `~/.codex/hooks.json`.

## Install In A Repository

From the plugin folder:

```bash
node scripts/tdd-guardian/install.js --workspace /path/to/repo --strict
```

Optional custom Codex agents:

```bash
node scripts/tdd-guardian/install.js --workspace /path/to/repo --strict --install-agents
```

Then ensure Codex hooks are enabled in `~/.codex/config.toml`:

```toml
[features]
codex_hooks = true
```

Restart Codex after adding hooks or changing the plugin installation.

## Installed Files

The installer writes these repo-local files:

```text
.codex/hooks.json
.codex/tdd-guardian/config.json
.codex/tdd-guardian/scripts/shared.js
.codex/tdd-guardian/scripts/pretool_guard.js
.codex/tdd-guardian/scripts/codechange_gate.js
.codex/tdd-guardian/logs/
.codex/tdd-guardian/state.json
```

If `--install-agents` is used, it also writes `.codex/agents/tdd-*.toml`.

## Hooks

### `PreToolUse`

`pretool_guard.js` intercepts guarded shell commands:

- `git commit`
- `git push`
- `gh pr create`
- `gh pr merge`
- `npm publish`
- `pnpm publish`
- `yarn publish`

When `blockCommitWithoutFreshGate=true`, it denies the command unless the current source fingerprint has a passing gate state.

### `Stop`

`codechange_gate.js` replaces the Claude `TaskCompleted` hook. Codex does not have an exact `TaskCompleted` equivalent, so the Stop hook checks whether source files changed since the last observed or passing fingerprint. If source changed, it runs:

1. `preflightCommand` when configured.
2. `testCommand`.
3. `coverageCommand`.
4. Coverage threshold or no-decrease validation.
5. `mutationCommand` when `requireMutation=true`.

Failures return a Codex continuation block and point to the full log.

## Configuration

Config lives at `.codex/tdd-guardian/config.json`.

Key settings:

- `enabled`: master switch.
- `enforceOnCodeChange`: run gates from the Stop hook when source changed.
- `blockCommitWithoutFreshGate`: deny release commands without fresh gates.
- `gateFreshnessMinutes`: timestamp freshness window when smart staleness is disabled.
- `smartStaleness`: allow old gate timestamps when the source fingerprint is unchanged.
- `coverageMode`: `absolute` or `no-decrease`.
- `requireMutation`: enable mutation gate.
- `sourceExtensions`: extensions that count as source changes.
- `ignorePaths`: paths excluded from source fingerprinting.

Set `TDD_GUARD_BYPASS=1` to bypass gates temporarily.

## Skills

- `$tdd-guardian-init`
- `$tdd-guardian-workflow`
- `$tdd-guardian-plan`
- `$tdd-guardian-design-tests`
- `$tdd-guardian-implement`
- `$tdd-guardian-coverage-audit`
- `$tdd-guardian-mutation-audit`
- `$tdd-guardian-review`
- `$tdd-guardian-policy-core`
- `$tdd-guardian-test-matrix`
- `$tdd-guardian-coverage-gate`
- `$tdd-guardian-mutation-gate`
- `$tdd-guardian-review-gate`

## Migration Notes

Claude `.claude/tdd-guardian/config.json` can be migrated by the installer. The mapping is:

- `.claude-plugin/plugin.json` -> `.codex-plugin/plugin.json`
- `.claude/tdd-guardian/config.json` -> `.codex/tdd-guardian/config.json`
- `.claude/tdd-guardian/state.json` -> not copied; Codex uses source fingerprints.
- `TaskCompleted` -> `Stop` hook with source-change detection.
- `${CLAUDE_PLUGIN_ROOT}` -> repo-root hook commands using `$(git rev-parse --show-toplevel)`.

## Validation

Run all plugin tests:

```bash
npm test
```

Run manifest and template validation:

```bash
npm run validate
```

## License

MIT
