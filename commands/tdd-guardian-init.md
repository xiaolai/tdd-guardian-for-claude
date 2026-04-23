---
name: tdd-guardian-init
description: |
  Initialize TDD Guardian for this workspace (strict test and coverage gates).

  <example>
  user: set up TDD Guardian
  assistant: I'll detect the project stack and propose a config. [Globs for package.json, finds it with a "test" script using vitest] This is a Node project using pnpm. I'll propose: testCommand="pnpm test", coverageCommand="pnpm test -- --coverage", coverageSummaryPath="coverage/coverage-summary.json", thresholds at 100 for lines/functions/branches/statements, then write .claude/tdd-guardian/config.json and append .claude/tdd-guardian/state.json to .gitignore.
  </example>

  <example>
  user: /tdd-guardian:tdd-guardian-init
  assistant: [Globs for pyproject.toml, finds it with pytest configured] Detected a Python project using pytest. Proposing: testCommand="pytest", coverageCommand="pytest --cov --cov-report=json:coverage.json", coverageSummaryPath="coverage.json", enabled=true with 100% thresholds. Confirming before writing .claude/tdd-guardian/config.json.
  </example>
argument-hint: "[optional test command hints]"
allowed-tools: Read, Write, Glob, Grep, AskUserQuestion
---

Initialize `.claude/tdd-guardian/config.json` for the current project.

Process:
1. Detect project stack and package manager.
2. Propose concrete values for:
   - `testCommand`
   - `coverageCommand`
   - `coverageSummaryPath`
   - `mutationCommand` (if available)
3. Update config with strict defaults:
   - `enabled=true`
   - coverage thresholds at 100 for lines/functions/branches/statements
4. Print final config and the exact gate commands.
5. Update `.gitignore` — append the following lines if not already present:

```
# tdd-guardian generated artifacts
.claude/tdd-guardian/state.json
```

Use skills:
- `tdd-guardian:init`
- `tdd-guardian:policy-core`
