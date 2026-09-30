# tdd-guardian (Codex)

Strict test-driven development for Codex CLI: per-lane test gates, adversarial review of the
test matrix before code exists, red receipts, coverage and mutation gates, and a commit/push
guard. Same engine as the Claude Code plugin; the Codex layer is skills plus one hook.

## Skills

User-facing (auto-selectable):

| Skill | Purpose |
|---|---|
| `$tdd-guardian-init` | Detect every test lane (CI first), verify each by dry-run probe, write `.claude/tdd-guardian/config.json`. |
| `$tdd-guardian-probe` | Check that every configured lane still resolves. Runs no suites. |
| `$tdd-guardian-gate` | Run the lanes bound to a trigger (`commit`, `push`, `taskCompleted`, `manual`) or one lane, evaluate coverage and mutation gates, refresh freshness state. |
| `$tdd-guardian-status` | Read-only report of lanes, gates, receipts and work items. |
| `$tdd-guardian-plan` | Break a task into work items (runs the planner). |
| `$tdd-guardian-design-tests` | Design the test matrix, then have the spec adversary attack it. |
| `$tdd-guardian-implement` | One work item red → receipt → green, then the `taskCompleted` lanes. |
| `$tdd-guardian-audit-coverage` | Run coverage lanes, merge reports, propose tests for gaps. |
| `$tdd-guardian-audit-mutation` | Run mutation testing, propose tests that kill survivors. |
| `$tdd-guardian-review` | Final code + test quality review. Report-only. |
| `$tdd-guardian-workflow` | The whole chain, halting on the first failed gate. Never commits. |

Reference knowledge (auto-selectable): `$tdd-guardian-policy-core`, `$tdd-guardian-lane-policy`,
`$tdd-guardian-tooling-catalog` (with `references/` per ecosystem), `$tdd-guardian-test-matrix`,
`$tdd-guardian-coverage-gate`, `$tdd-guardian-mutation-gate`, `$tdd-guardian-review-gate`.

Roles (hidden from auto-selection; the user-facing skills run them): `$tdd-guardian-planner`,
`$tdd-guardian-test-designer`, `$tdd-guardian-spec-adversary`, `$tdd-guardian-implementer`,
`$tdd-guardian-coverage-auditor`, `$tdd-guardian-mutation-auditor`, `$tdd-guardian-reviewer`.

Shared procedures live in `codex/shared/` (load-config, detect-tooling, run-lane,
parse-coverage, parse-mutation). They are plain reference text read by path, not skills.

## How it differs from the Claude Code plugin

- **Same engine, same files.** Both tools run `scripts/tdd-guardian/` and read and write
  `.claude/tdd-guardian/` (config, state, receipts, reports). The scripts hardcode that path, so
  a project initialised from either tool is initialised for both.
- **Roles are skills, not subagents.** Claude Code runs the seven roles as subagents with pinned
  tool lists. In Codex a user-facing skill runs each role from its `SKILL.md` — in a subagent
  when Codex offers one, otherwise inline.
- **No tool restriction.** Claude Code enforces the roles' least-privilege tool lists (the
  planner, reviewer and spec adversary cannot edit anything). Codex skills carry no tool
  restriction, so each role states its boundary as a rule it keeps.
- **No model pinning.** Everything runs on the session model.
- **Plugin root.** Codex sets no plugin-root variable in a skill's shell. Skills resolve it as
  three directories above their own `SKILL.md`; `codex/shared/` files as two above themselves.
  Every command that runs a script checks the file exists first.
- **Hooks.** `codex/hooks.json` registers only the PreToolUse commit/push guard
  (`pretool_guard.js`, matcher `Bash`). Codex has no `TaskCompleted` event, so Claude Code's
  TaskCompleted gate is not ported and `enforceOnTaskCompleted` has no effect in Codex: the
  `taskCompleted` lanes run when `$tdd-guardian-implement` or `$tdd-guardian-gate taskCompleted`
  runs them. Mapping it to `Stop` was rejected — that would run test lanes at the end of every
  turn, and a blocking Stop re-prompts the model in a loop. Codex runs plugin hooks only after
  the user has reviewed and trusted them.

## Maintaining this port

`codex/` is hand-polished, not generated: do not re-run `build-codex.mjs --force` over it. When
a command, agent, skill or shared partial changes, make the matching edit under `codex/`:
commands map to `codex/skills/tdd-guardian-<command>/`, agents to
`codex/skills/tdd-guardian-<agent without tdd->/` (hidden from implicit selection by
`agents/openai.yaml`), skills to `codex/skills/tdd-guardian-<skill>/`, and partials to
`codex/shared/`. `codex-config.json` holds the interface overrides the bootstrap used.

- `.codex-plugin/plugin.json` sets `"commands": []` (otherwise Codex auto-migrates
  `commands/*.md` into duplicate Claude-flavoured skills) and `"hooks": "./codex/hooks.json"`
  (otherwise Codex loads the Claude `hooks/hooks.json`).
- Codex sets no `${CLAUDE_PLUGIN_ROOT}` in a skill's shell, so skills resolve the plugin root
  as three directories above their own `SKILL.md` and check each script exists before running
  it. Claude Code's TaskCompleted hook has no Codex event and is not ported.
- `codex/` is outside the nlpm score attestation's hashed set (`scripts/ci/nl-artifacts-hash.py`).
- Check the port with `codex debug prompt-input` under a temporary `CODEX_HOME`: the listing must
  show the 18 user-facing and knowledge skills as `tdd-guardian:tdd-guardian-*`, none of the
  seven roles, and no `source-command-*` entry.

## Prerequisites

Node.js 18+ and `git` on `PATH`, plus the test runners, coverage and mutation tools of the
project being guarded.
