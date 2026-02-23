# tdd-guardian-for-claude

TDD Guardian plugin for Claude Code. Enforces strict test-driven development with automated quality gates.

## Project structure

```
.claude-plugin/
  plugin.json             Plugin metadata
  marketplace.json        Marketplace manifest
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
  tdd-guardian-for-claude/
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

All tests must have at least one Level 1-5 (behavior) assertion. Tests with only Level 6-7 (wiring) assertions are rejected. See `skills/tdd-guardian-for-claude/policy-core/SKILL.md` for the full assertion hierarchy.

### Hook scripts

- `pretool_guard.py` intercepts Bash tool calls matching commit/push/publish patterns
- `taskcompleted_gate.py` runs test/coverage/mutation gates on task completion
- Both read config from `.claude/tdd-guardian/config.json` in the project workspace
- Gate freshness state is written to `.claude/tdd-guardian/state.json`

### Adding new skills

1. Create `skills/tdd-guardian-for-claude/<name>/SKILL.md` with YAML frontmatter
2. Reference `policy-core` skill for governance rules
3. Update `README.md`

### Adding new agents

1. Create `agents/tdd-<name>.md` with YAML frontmatter
2. List required tools and skills in frontmatter
3. Reference in `commands/tdd-guardian-workflow.md` if part of the workflow
4. Update `README.md`
