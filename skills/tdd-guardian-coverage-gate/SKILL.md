---
name: tdd-guardian-coverage-gate
description: Enforce coverage thresholds and test quality in Codex TDD workflows.
---

# Coverage Gate

## Gate 1: Coverage thresholds

1. Run project test command.
2. Run project coverage command.
3. Verify coverage summary exists.
4. Enforce thresholds based on `coverageMode`:

### Coverage modes

**`"absolute"` (default)**: Current behavior — all metrics must meet configured thresholds.

**`"no-decrease"`**: Blocks only if coverage decreased from a recorded baseline.

- On first run (or branch change), records current coverage as the baseline and passes.
- On subsequent runs, compares against baseline:
  - Decreased → **block** (with delta details)
  - Equal or improved → **pass**
- Baseline is per-branch. Switching branches records a new baseline automatically.

| Scenario | `absolute` | `no-decrease` |
|----------|-----------|---------------|
| Coverage 72%, threshold 100% | BLOCK | PASS (if baseline ≤ 72%) |
| Coverage dropped 72% → 70% | BLOCK | BLOCK (decreased) |
| Coverage improved 72% → 75% | BLOCK | PASS (improved) |

Default threshold policy (absolute mode): `100` for all metrics.

### If coverage fails:

1. List exact metric deltas (against thresholds in absolute mode, against baseline in no-decrease mode).
2. Identify uncovered branches/functions by file.
3. Add missing tests, then rerun full gate.

## Gate 2: Test quality (new — enforced alongside coverage)

Coverage alone is insufficient. A test that touches every line but only asserts `expect(mock).toHaveBeenCalled()` provides zero regression safety.

Follow the assertion hierarchy and mock rules defined in the `policy-core` skill.

### Quality scan procedure

For each test file in the coverage report:

1. **Count assertion types** per test using the assertion hierarchy from `policy-core`:
   - Level 1-5 (behavior): return value checks, error checks, output checks, state checks, integration checks
   - Level 6-7 (wiring): mock call args, mock call counts

2. **Flag violations**:
   - **FAIL**: Any `it()` block where ALL assertions are Level 6-7
   - **WARN**: Any `it()` block where Level 6-7 assertions outnumber Level 1-5 assertions by 3:1 or more
   - **PASS**: At least one Level 1-5 assertion exists

3. **Report format**:
   ```
   Test Quality Summary:
   ✓ 45/48 tests have behavioral assertions
   ✗ 3 tests are wiring-only:
     - docker/container.test.ts: "applies security defaults" (line 52) — mock args only
     - cli/lifecycle.test.ts: "stops container" (line 48) — mock-was-called only
     - docker/network.test.ts: "creates network" (line 28) — mock args only
   ```

4. **Gate result**: FAIL if any wiring-only tests exist in changed files. WARN (non-blocking) for existing wiring-only tests in unchanged files.

### Gate 3: Coverage ignore directive audit

Scan all source files (not test files) for V8 coverage ignore comments. Flag misuse:

- **FAIL**: `/* v8 ignore next */` or `/* v8 ignore next N */` — silently fails on `??`, ternaries, `catch` bodies, and short-circuit operators (`&&`, `||`). Replace with `/* v8 ignore start */` / `/* v8 ignore stop */`.
- **PASS**: `/* v8 ignore start */` / `/* v8 ignore stop */` range pairs.

```
Coverage Ignore Audit:
✗ 2 files use unreliable /* v8 ignore next N */:
  - src/config.ts:42 — covers ?? expression, will silently fail
  - src/handler.ts:88 — covers ternary, will silently fail
Fix: replace with /* v8 ignore start */ / /* v8 ignore stop */ range comments
```

### How to fix wiring-only tests

| Current assertion | Add this | Example |
|------------------|----------|---------|
| `expect(mockCreate).toHaveBeenCalledWith(opts)` | Verify return value | `expect(result.id).toMatch(/^mx-/)` |
| `expect(mockStop).toHaveBeenCalled()` | Verify formatted output | `expect(formatter.success).toHaveBeenCalledWith("Mecha stopped.")` |
| `expect(mockCreate).toHaveBeenCalledWith(securityOpts)` | Add integration test | `const info = await inspect(container); expect(info.HostConfig.ReadonlyRootfs).toBe(true)` |
