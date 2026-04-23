# tdd-guardian

TDD Guardian plugin for Claude Code. Enforces strict test-driven development with automated quality gates.

## Project structure

```
.claude-plugin/
  plugin.json             Plugin metadata
hooks/
  hooks.json              Hook registration (auto-discovered by Claude Code)
agents/                   Specialized subagents for TDD workflow
  tdd-planner.md          Work item planning
  tdd-test-designer.md    Behavior-driven test design
  tdd-implementer.md      Small-batch implementation
  tdd-coverage-auditor.md Coverage gate enforcement
  tdd-mutation-auditor.md Mutation testing
  tdd-reviewer.md         Final code + test quality review
commands/                 Slash command definitions
  tdd-guardian-init.md    /init — initialize config
  tdd-guardian-workflow.md /workflow — full TDD orchestration
config/
  config.json             Default configuration template
scripts/
  tdd-guardian/
    pretool_guard.js      PreToolUse hook — blocks commits without fresh gates
    taskcompleted_gate.js TaskCompleted hook — runs gates on task completion
skills/
  tdd-guardian/
    init/                 Workspace initialization
    workflow/             TDD workflow orchestration
    policy-core/          Global TDD governance policy
    test-matrix/          Test matrix design
    coverage-gate/        Coverage enforcement
    mutation-gate/        Mutation testing
    review-gate/          Code + test quality review
```

## Conventions

### Test quality enforcement

All tests must have at least one Level 1-5 (behavior) assertion. Tests with only Level 6-7 (wiring) assertions are rejected. See `skills/tdd-guardian/policy-core/SKILL.md` for the full assertion hierarchy.

### Hook scripts

- Hooks are registered via `hooks/hooks.json` using `${CLAUDE_PLUGIN_ROOT}` paths
- `pretool_guard.js` intercepts Bash tool calls matching commit/push/publish patterns
- `taskcompleted_gate.js` runs test/coverage/mutation gates on task completion
- Both read config from `.claude/tdd-guardian/config.json` in the project workspace
- Gate freshness state is written to `.claude/tdd-guardian/state.json`

### Adding new skills

1. Create `skills/tdd-guardian/<name>/SKILL.md` with YAML frontmatter
2. Reference `policy-core` skill for governance rules
3. Update `README.md`

### Adding new agents

1. Create `agents/tdd-<name>.md` with YAML frontmatter
2. List required tools and skills in frontmatter
3. Reference in `commands/tdd-guardian-workflow.md` if part of the workflow
4. Update `README.md`

## Prerequisites

- Node.js 18+ (hooks run via `node`; no package manager required — scripts are plain Node, no `npm install` step)
- Claude Code 1.0 or later (for `${CLAUDE_PLUGIN_ROOT}` expansion and `TaskCompleted` hook support)
- `jq` (optional, used for JSON validation snippets below)

## Development

### Testing hooks locally

The hooks read JSON payloads from stdin. Feed a sample payload to exercise them:

```bash
# PreToolUse — simulate a blocked `git commit` attempt
echo '{"tool_name":"Bash","tool_input":{"command":"git commit -m wip"},"cwd":"'"$PWD"'"}' \
  | node scripts/tdd-guardian/pretool_guard.js

# TaskCompleted — trigger the gate runner
echo '{"cwd":"'"$PWD"'"}' \
  | node scripts/tdd-guardian/taskcompleted_gate.js
```

Exit code `0` = allow; non-zero = block. stdout carries any message surfaced to Claude Code.

For end-to-end testing, install the plugin into a throwaway project, run `/tdd-guardian-init`, then attempt a commit — the hook should block until gates pass.

### JSON validation

Validate the plugin manifests before release:

```bash
jq . .claude-plugin/plugin.json
jq . hooks/hooks.json
jq . config/config.json
jq . .claude-plugin/marketplace.json  # if present in this repo
```

Any parse error fails fast. No separate test framework or build step exists for the plugin itself — the TDD workflow it enforces operates on target projects, not on the plugin's own source.
