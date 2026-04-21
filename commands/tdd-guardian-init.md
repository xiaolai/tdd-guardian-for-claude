# /tdd-guardian-init

Initialize TDD Guardian for the current repository.

## Arguments

- `testCommand`: project test command (optional)
- `coverageCommand`: project coverage command (optional)
- `coverageSummaryPath`: coverage summary JSON path (optional)
- `coverageMode`: `absolute` or `no-decrease` (optional)
- `installAgents`: install Codex custom agent templates into `.codex/agents/` (optional)

## Workflow

1. Use the `$tdd-guardian-init` skill.
2. Detect the package manager and test framework from project files.
3. Generate or update `.codex/tdd-guardian/config.json`.
4. Install hook scripts under `.codex/tdd-guardian/scripts/`.
5. Merge TDD Guardian entries into `.codex/hooks.json` without removing unrelated hooks.
6. Append `.codex/tdd-guardian/state.json` and `.codex/tdd-guardian/logs/` to `.gitignore` when missing.
7. Print the final gate commands and whether custom agents were installed.

## Guardrails

- Do not overwrite unrelated `.codex/hooks.json` hook entries.
- Migrate `.claude/tdd-guardian/config.json` if it exists.
- Keep `codex_hooks = true` as a user-level setup requirement; do not edit global config unless explicitly asked.
