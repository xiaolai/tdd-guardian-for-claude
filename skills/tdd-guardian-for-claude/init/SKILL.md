---
name: init
description: Initialize workspace TDD Guardian config and enable strict hooks for test/coverage enforcement.
---

# Initialize TDD Guardian

Create `.claude/tdd-guardian/config.json` using project-appropriate commands.

## Steps

1. Detect package manager and test stack from project files.
2. Propose commands for:
   - `testCommand`
   - `coverageCommand`
   - `mutationCommand` (optional)
3. Write config file with strict defaults.

Default config template:

```json
{
  "enabled": true,
  "enforceOnTaskCompleted": true,
  "blockCommitWithoutFreshGate": true,
  "gateFreshnessMinutes": 120,
  "bypassEnv": "TDD_GUARD_BYPASS",
  "preflightCommand": "",
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

If project is not Node-based, replace commands with project-native equivalents.
