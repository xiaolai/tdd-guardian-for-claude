---
name: tdd-guardian-init
description: Initialize TDD Guardian in a Codex workspace by installing config, repo hooks, hook scripts, and optional custom agent templates.
---

# Initialize TDD Guardian

Use this skill when a user asks to install, initialize, or configure TDD Guardian for a repository.

## What This Installs

- `.codex/tdd-guardian/config.json`: project gate configuration.
- `.codex/tdd-guardian/scripts/`: Codex hook scripts copied from the plugin templates.
- `.codex/hooks.json`: repo-local hook registrations for `PreToolUse` and `Stop`.
- Optional `.codex/agents/*.toml`: custom Codex agents matching the original Claude specialist agents.
- `.gitignore` entries for generated state and logs.

Codex hooks are discovered from `<repo>/.codex/hooks.json` or `~/.codex/hooks.json` and require `[features] codex_hooks = true` in the user's Codex config.

## Steps

1. Detect the workspace root.
   - Prefer `git rev-parse --show-toplevel`.
   - If not inside git, use the current working directory.

2. Detect project commands.
   - Prefer existing package manager commands from `package.json`.
   - Common defaults:
     - `pnpm test` when `pnpm-lock.yaml` exists.
     - `npm test` when `package-lock.json` exists.
     - `yarn test` when `yarn.lock` exists.
     - `pytest` for Python projects with `pyproject.toml`, `pytest.ini`, or `tests/`.
   - Set `coverageCommand` only to a command that produces the configured coverage summary path.

3. Run the bundled installer:

   ```bash
   node <plugin-root>/scripts/tdd-guardian/install.js --workspace <repo-root>
   ```

   Add `--install-agents` if the user wants Codex custom agents installed.

4. Review `.codex/tdd-guardian/config.json`.
   - `enforceOnCodeChange`: runs gates from the `Stop` hook when source changes are detected.
   - `blockCommitWithoutFreshGate`: blocks commit/push/PR/publish commands when gates are stale or failing.
   - `coverageMode`: `absolute` or `no-decrease`.
   - `requireMutation`: enables mutation testing only when `mutationCommand` is configured.

5. Tell the user the exact files installed and the commands configured.

## Default Config

The bundled default lives at `templates/config.default.json`. It uses strict defaults:

```json
{
  "enabled": true,
  "enforceOnCodeChange": true,
  "blockCommitWithoutFreshGate": true,
  "gateFreshnessMinutes": 120,
  "bypassEnv": "TDD_GUARD_BYPASS",
  "preflightCommand": "",
  "testCommand": "pnpm test",
  "coverageCommand": "pnpm test -- --coverage",
  "coverageSummaryPath": "coverage/coverage-summary.json",
  "coverageMode": "absolute",
  "smartStaleness": true,
  "requireMutation": false,
  "mutationCommand": ""
}
```

## Migration From Claude Version

If `.claude/tdd-guardian/config.json` exists, migrate matching settings into `.codex/tdd-guardian/config.json`:

- `enforceOnTaskCompleted` becomes `enforceOnCodeChange`.
- `.claude/tdd-guardian/state.json` is not copied; Codex uses source fingerprints rather than Claude task completion state.

## Guardrails

- Do not overwrite unrelated hook entries in `.codex/hooks.json`.
- Do not edit `~/.codex/config.toml` unless the user explicitly asks.
- Keep every hook run fully logged under `.codex/tdd-guardian/logs/`.
