# tdd-guardian

TDD Guardian for Claude Code — enforces strict test-driven development discipline with automated quality gates.

## What it does

TDD Guardian ensures Claude Code follows rigorous TDD practices:

- **Test-first workflow**: tests are written before or alongside implementation, never after
- **Coverage gates**: blocks commits when coverage drops below thresholds (default: 100% lines/functions/branches/statements)
- **Mutation testing**: validates test strength by catching surviving mutants (optional)
- **Behavior-driven test quality**: rejects wiring-only tests that assert mock calls without verifying observable behavior
- **Pre-commit enforcement**: hooks block `git commit`, `git push`, and `gh pr create` until all gates pass

## Installation

### Install the plugin

Add the marketplace (once):

```
/plugin marketplace add xiaolai/claude-plugin-marketplace
```

Then install:

```
/plugin install tdd-guardian@xiaolai
```

| Scope | Command | Effect |
|-------|---------|--------|
| **User** (default) | `/plugin install tdd-guardian@xiaolai` | Available in all your projects |
| **Project** | `/plugin install tdd-guardian@xiaolai --scope project` | Shared with team via `.claude/settings.json` |
| **Local** | `/plugin install tdd-guardian@xiaolai --scope local` | Only you, only this repo |

### Initialize for your project

Run `/tdd-guardian:init` inside your project to generate `.claude/tdd-guardian/config.json`. This auto-detects your stack and configures test/coverage commands.

## Commands

| Command | Description |
|---------|-------------|
| `/tdd-guardian:init` | Initialize TDD Guardian config for the current project |
| `/tdd-guardian:workflow` | Run the full TDD workflow with specialized subagents |

## How it works

### The TDD workflow (`/tdd-guardian:workflow`)

Runs 6 specialized subagents in sequence:

1. **tdd-planner** — breaks the task into work items with acceptance criteria
2. **tdd-test-designer** — designs behavior-driven tests with explicit assertion strategies
3. **tdd-implementer** — implements in small batches with test-first discipline
4. **tdd-coverage-auditor** — enforces coverage thresholds, identifies gaps
5. **tdd-mutation-auditor** — validates test robustness via mutation testing (when enabled)
6. **tdd-reviewer** — findings-first review auditing both code and test quality

The workflow stops if any gate fails. No commit/push is allowed until all gates are green.

### Hook enforcement

TDD Guardian installs two hooks:

- **PreToolUse hook** (`pretool_guard.js`): intercepts `git commit`, `git push`, `gh pr create`, and `npm publish` commands. Blocks them unless quality gates have passed recently (configurable freshness window).
- **TaskCompleted hook** (`taskcompleted_gate.js`): runs tests, coverage checks, and mutation tests automatically when a task completes. Updates gate state on success.

### Test quality philosophy

TDD Guardian enforces **behavior-driven testing** — tests must verify what code *does* (outputs, side effects, state changes), not *how* it does it (which internal functions it calls).

The assertion hierarchy:

| Level | Type | Quality |
|-------|------|---------|
| 1 | Output verification | Best |
| 2 | Side-effect verification | Best |
| 3 | Real integration | Best |
| 4 | State verification | Good |
| 5 | Mock return + output | Good |
| 6 | Mock call args | Weak |
| 7 | Mock was called | Unacceptable alone |

Tests with only Level 6-7 assertions are flagged and must be upgraded.

## Configuration

Config lives at `.claude/tdd-guardian/config.json`:

```json
{
  "enabled": true,
  "enforceOnTaskCompleted": true,
  "blockCommitWithoutFreshGate": true,
  "gateFreshnessMinutes": 120,
  "bypassEnv": "TDD_GUARD_BYPASS",
  "preflightCommand": "pnpm exec tsc --noEmit",
  "testCommand": "pnpm test",
  "coverageCommand": "pnpm test -- --coverage",
  "coverageSummaryPath": "coverage/coverage-summary.json",
  "coverageThresholds": {
    "lines": 100,
    "functions": 100,
    "branches": 100,
    "statements": 100
  },
  "requireMutation": false,
  "mutationCommand": ""
}
```

| Setting | Description | Default |
|---------|-------------|---------|
| `enabled` | Master switch | `true` |
| `enforceOnTaskCompleted` | Run gates on task completion | `true` |
| `blockCommitWithoutFreshGate` | Block commits without recent passing gates | `true` |
| `gateFreshnessMinutes` | How long a gate pass remains valid | `120` |
| `bypassEnv` | Environment variable to bypass all gates | `TDD_GUARD_BYPASS` |
| `preflightCommand` | Run before tests (e.g., type checking) | `""` |
| `testCommand` | Test runner command | `"pnpm test"` |
| `coverageCommand` | Coverage runner command | `"pnpm test -- --coverage"` |
| `coverageSummaryPath` | Path to coverage JSON summary | `"coverage/coverage-summary.json"` |
| `coverageThresholds` | Required coverage percentages | `100` for all |
| `requireMutation` | Enable mutation testing gate | `false` |
| `mutationCommand` | Mutation test runner command | `""` |

### Bypass

Set the bypass environment variable to skip all gates temporarily:

```bash
TDD_GUARD_BYPASS=1 claude
```

## Project structure

```
.claude-plugin/
  plugin.json             Plugin metadata
hooks/
  hooks.json              Hook registration (auto-discovered by Claude Code)
agents/
  tdd-planner.md          Work item planning specialist
  tdd-test-designer.md    Behavior-driven test design specialist
  tdd-implementer.md      Small-batch implementation specialist
  tdd-coverage-auditor.md Coverage gate enforcement specialist
  tdd-mutation-auditor.md Mutation testing specialist
  tdd-reviewer.md         Final code + test quality reviewer
commands/
  tdd-guardian-init.md    /init command definition
  tdd-guardian-workflow.md /workflow command definition
config/
  config.json             Default configuration template
scripts/
  tdd-guardian/
    pretool_guard.js      PreToolUse hook — blocks commits without fresh gates
    taskcompleted_gate.js TaskCompleted hook — runs gates on task completion
skills/
  tdd-guardian/
    init/SKILL.md         Workspace initialization skill
    workflow/SKILL.md     TDD workflow orchestration skill
    policy-core/SKILL.md  Global TDD governance policy
    test-matrix/SKILL.md  Test matrix design skill
    coverage-gate/SKILL.md Coverage enforcement skill
    mutation-gate/SKILL.md Mutation testing skill
    review-gate/SKILL.md  Code + test quality review skill
```

## License

MIT
