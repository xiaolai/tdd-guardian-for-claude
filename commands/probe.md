---
name: probe
description: |
  Dry-run every configured lane to verify its command resolves and discovers tests, without executing the suites. Read-only; runs no tests and writes no files.

  <example>
  user: /tdd-guardian:probe
  assistant: |
    Loading config, then running each lane's `probeCommand` (or the ecosystem default from `tooling-catalog`). For each lane I report whether the command resolves and how many tests it discovers, then flag any lane that resolves but finds nothing — a lane discovering zero tests looks configured and fails later at gate time. No suites are executed.
  </example>

  <example>
  user: /tdd-guardian:probe e2e
  assistant: |
    Probing only the `e2e` lane. I run its probe command (e.g. `npx playwright test --list`), report the discovered test count, and separately verify that any `setupCommand` it declares is resolvable — without starting the services.
  </example>
argument-hint: "[optional lane name]"
allowed-tools: Read, Bash, Glob, Grep
model: inherit
---

Verify that every configured lane actually resolves. Runs no test suites.

## Why this exists

A lane written from manifest inspection is a guess. `/tdd-guardian:init` probes before writing config, but configs drift — a dependency is removed, a script is renamed, a test directory moves. This command re-verifies on demand, cheaply, before a gate run finds out the expensive way.

## Steps

### Step 1 — Load config

Follow `commands/shared/load-config.md`. Stop on missing or disabled config. Surface every validation warning — they describe ways the gate can silently do nothing.

### Step 2 — Select lanes

If `$ARGUMENTS` names a lane, probe only that one. Reject an unknown name by listing the configured lane names. With no argument, probe every lane.

### Step 3 — Resolve a probe command per lane

Use the lane's `probeCommand` if set. Otherwise infer one from the lane's `command` using the probe table in `commands/shared/detect-tooling.md` and the per-ecosystem files in the `tdd-guardian:tooling-catalog` skill.

If no probe is available for that runner, mark the lane `unprobeable` and say so plainly. **Do not** substitute the real test command — this command must never run a suite.

### Step 4 — Run each probe

Timeout 120000 ms. Capture exit code and output.

| Outcome | Verdict | Meaning |
|---------|---------|---------|
| Exit 0, non-empty listing | `verified` | Resolves and discovers tests |
| Exit 0, empty listing, lane has never had tests | `bootstrap` | Greenfield — expected, not a defect |
| Exit 0, empty listing, lane **has** had tests | `empty` | Discovery broke, or the tests were deleted |
| Exit 127, or "command not found" | `unresolved` | Runner not installed |
| Non-zero with a config error | `unresolved` | Runner config is broken |
| No probe available | `unprobeable` | Cannot verify cheaply; say so |

**Read `ever_had_tests` from `.claude/tdd-guardian/state.json` to tell `bootstrap` from `empty`.** They look identical at the probe and mean opposite things: one is a brand-new project behaving as designed, the other is a regression. Diagnosing a greenfield repo as "your glob is wrong" sends the user hunting for a bug that does not exist.

Extract a test count from the listing where the format allows it. Report `—` rather than guessing.

### Step 5 — Static checks that need no execution

For each lane, also verify without running anything:

- `coverage: "include"` lanes have a non-empty `coverageSummaryPath`, and no two lanes share one.
- A declared `setupCommand`'s binary exists (`command -v <first token>`), without starting services.
- `timeoutMs` is consistent with the trigger — over 15 minutes on `taskCompleted` is a misconfiguration.
- `requireMutation` is paired with a resolvable `mutationCommand`.

### Step 6 — Report

## Output format

```markdown
# Lane Probe — {N verified / M total}

**Workspace**: {pwd}
**Config**: `.claude/tdd-guardian/config.json` (schema v{n})

| Lane | Verdict | Tests found | Trigger | Coverage | Probe |
|------|---------|-------------|---------|----------|-------|
| unit | verified | 148 | taskCompleted, commit | include | `pnpm exec vitest list` |
| integration | verified | 22 | commit | include | `pytest --collect-only -q` |
| e2e | empty | 0 | push | none | `npx playwright test --list` |

## Findings

{One entry per non-verified lane, with the exact failing output and the fix.}

### e2e — discovers zero tests
`npx playwright test --list` exits 0 but lists nothing.
The config's `testDir` is `./tests/e2e`, which does not exist; the specs are in `./e2e`.
Fix: correct `testDir` in `playwright.config.ts`, or change the lane command to `npx playwright test e2e/`.

## Configuration warnings

{Validation warnings from load-config, plus the static checks from Step 5.}

## Verdict

{All lanes verified → "All lanes resolve and discover tests."}
{Otherwise → "N lane(s) will fail at gate time. Fix before relying on the gates."}
```

## Contract

- Input: optional lane name.
- Output: one markdown report.
- Side effects: **NONE.** No test suites run, no services start, no files are written.
- Failure modes: missing config → stop with init instructions; unknown lane name → list valid names.

## Rules

1. Never run a lane's real `command` — that is `/tdd-guardian:gate`.
2. Never start services via `setupCommand`; only check that its binary exists.
3. A lane that discovers zero tests is a finding only when the lane has had tests before. Check `ever_had_tests` in state; report `bootstrap` for a greenfield lane and `empty` for a regression, and never give the greenfield case a broken-glob diagnosis.
4. When no probe exists for a runner, say the lane is unverified. Do not imply it was checked.
5. A zero-lane config is a finding in itself. Report the three ways out — add a lane, install a runner and re-run init, or delete the config so the plugin goes silent — rather than telling the user to re-run the command that produced it.
