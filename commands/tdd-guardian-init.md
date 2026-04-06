---
name: tdd-guardian-init
description: Initialize TDD Guardian for this workspace (strict test and coverage gates)
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
