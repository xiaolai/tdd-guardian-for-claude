---
name: tdd-guardian-audit-mutation
description: |
  Dispatch the tdd-mutation-auditor agent to run mutation testing and list surviving mutants. Skips cleanly if `requireMutation=false` or the tool is not installed.

  <example>
  user: /tdd-guardian:audit-mutation
  assistant: |
    Loading config. Since `requireMutation=true` and `mutationCommand=npx stryker run`, I dispatch the tdd-mutation-auditor. It verifies Stryker is installed, runs it, parses `reports/mutation/mutation.json`, lists surviving mutants with file:line + mutator type, and proposes boundary tests to kill each one. Returns PASS/FAIL/SKIPPED.
  </example>

  <example>
  user: /tdd-guardian:audit-mutation
  assistant: |
    `requireMutation=false` in config. I respond with: "Mutation gate disabled (requireMutation=false). To enable, run /tdd-guardian:tdd-guardian-init or edit .claude/tdd-guardian/config.json." and stop — no dispatch, no tool install prompts.
  </example>
argument-hint: ""
allowed-tools: Read, Bash, Glob, Grep, Task
model: inherit
---

Dispatch the `tdd-mutation-auditor` agent.

## Steps

### Step 1 — Load config

Follow `commands/shared/load-config.md`.

### Step 2 — Enabled check

If `requireMutation` is `false` or missing, respond:

```
Mutation gate disabled (requireMutation=false).
To enable: run /tdd-guardian:tdd-guardian-init, or set requireMutation=true and mutationCommand in .claude/tdd-guardian/config.json.
```

And STOP. Do not dispatch the agent.

If `requireMutation=true` but `mutationCommand` is empty, stop with the validation message from `load-config.md`.

### Step 3 — Tool availability pre-check

Before dispatching, run the tool's version probe via Bash to verify installation:

| Tool detected | Probe command |
|---------------|---------------|
| Stryker | `npx stryker --version` |
| mutmut | `mutmut --version` |
| go-mutesting | `go-mutesting --help` (no --version flag; non-zero exit is OK as long as the binary exists) |
| cargo-mutants | `cargo mutants --version` |

If the probe fails (binary not found), respond with an install hint and STOP:

```
Mutation tool not installed. Configured command: `{mutationCommand}`.

Install:
- Stryker: `pnpm add -D @stryker-mutator/core @stryker-mutator/jest-runner` (or the runner plugin that matches your test framework)
- mutmut: `pip install mutmut`
- go-mutesting: `go install github.com/zimmski/go-mutesting/cmd/go-mutesting@latest`
- cargo-mutants: `cargo install cargo-mutants`
```

Do NOT proceed with the auditor when the tool is absent.

### Step 4 — Dispatch the auditor

Use the `Task` tool to invoke `tdd-mutation-auditor` with:
- The tool name detected in step 3.
- The configured `mutationCommand`.
- A directive: "Run the command. Parse the output via `commands/shared/parse-mutation.md`. List surviving mutants with file:line, original/replacement, and a boundary-test fix for each. Do NOT silently ignore mutants — equivalent mutants must be declared explicitly in the report."

### Step 5 — Persist result

Write the auditor's report to `.claude/tdd-guardian/mutation-{YYYYMMDD-HHMMSS}.md` and update `.claude/tdd-guardian/state.json`:

```json
{
  "lastMutationRun": {
    "timestamp": "<ISO>",
    "status": "PASS" | "FAIL" | "SKIPPED",
    "score": "{n.nn}%",
    "killed": N,
    "survived": N,
    "reportPath": ".claude/tdd-guardian/mutation-{ts}.md"
  }
}
```

## Output format

```markdown
# Mutation Audit — {PASS | FAIL | SKIPPED}

**Timestamp**: {ISO}
**Tool**: {stryker | mutmut | go-mutesting | cargo-mutants}
**Command**: `{mutationCommand}`
**Report**: `.claude/tdd-guardian/mutation-{timestamp}.md`

## Summary

| Metric | Value |
|--------|-------|
| Score | {n.nn}% |
| Killed | N |
| Survived | N |
| Timeout | N |
| NoCoverage | N |

{full auditor output follows, including surviving mutants table}
```

## Contract

- Input: none.
- Output: mutation report file + normalized summary in `state.json`.
- Side effects: runs the mutation command (may be SLOW — minutes to hours).
- Failure modes: disabled → clean skip; tool missing → install hint + stop; runner error → stop with evidence.
