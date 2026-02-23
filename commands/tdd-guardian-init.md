---
description: Initialize TDD Guardian for this workspace (strict test and coverage gates)
argument-hint: "[optional test command hints]"
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

Use skills:
- `tdd-guardian-for-claude:init`
- `tdd-guardian-for-claude:policy-core`
