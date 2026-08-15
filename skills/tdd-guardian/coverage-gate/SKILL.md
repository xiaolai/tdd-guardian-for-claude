---
name: coverage-gate
description: Enforce coverage thresholds AND test quality — coverage without behavioral assertions is meaningless.
---

# Coverage Gate

## Gate 1: Coverage thresholds

1. Run every lane whose `gateOn` includes the active trigger.
2. Collect the report from each lane with `coverage: "include"`.
3. Merge them (see "Multi-lane coverage" below).
4. Verify the merge measured something — a report with zero measurable lines scores 100% under the 0/0 convention and must FAIL, not pass. A silent no-op coverage run looks identical to a perfect one.
5. Enforce thresholds against the merged totals based on `coverageMode`:

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

### Multi-lane coverage

Thresholds apply to the **merged** total across every contributing lane, never to a single lane. Two merge methods exist and the gate reports which one it used:

| Method | When | Accuracy |
|--------|------|----------|
| `single` | One contributing lane | Exact |
| `union` | Every report carries per-line detail | Exact — a line hit by any lane counts once |
| `weighted` | At least one report is summary-only | **Approximate** — a line hit by two lanes is counted twice |

To get an exact union, have every contributing lane emit a per-line format: LCOV, Cobertura, JaCoCo, coverage.py JSON, or `coverage-final.json`. Summary-only formats (`coverage-summary.json`) force the weighted fallback. When the gate falls back, it says so in the report — do not quote a weighted number as if it were a union.

Give every contributing lane its **own** `coverageSummaryPath`. Two lanes writing the same file means the second overwrites the first and coverage is silently undercounted.

### Unmeasured metrics are not zero

A metric the report format does not track is `null`. With a non-zero threshold that produces a WARNING, never a FAILURE:

- coverage.py and go-cover measure no functions
- go-cover and SimpleCov measure no branches by default
- LCOV measures functions and branches only when the producing tool emits `FNF`/`FNH` and `BRF`/`BRH`

Set those thresholds to 0 rather than living with a permanent warning. Treating null as zero would fail every Go and Python project for a dimension their tools cannot report.

### If coverage fails:

1. List exact metric deltas (against thresholds in absolute mode, against baseline in no-decrease mode), including the covered/total counts, not just percentages.
2. Identify uncovered branches/functions by file.
3. Name the lane each gap belongs in, per `lane-policy`. An uncovered error path in a DB adapter is an integration-lane gap; do not close it with a mock in the unit lane.
4. Add missing tests, then rerun the full gate.

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

### Gate 4: Critical-path thresholds

A repo-wide threshold is one number for code with wildly different consequences of failure. `criticalPaths` adds a second, stricter bar scoped by glob — see the value heuristic in `policy-core`.

Evaluated from the merged report's **per-file** entries, so it works across every format the plugin reads.

| Situation | Result |
|-----------|--------|
| Matched files meet the entry's thresholds | PASS |
| Matched files fall below | **FAIL**, naming the glob, the metric, and the shortfall |
| Entry omits `thresholds` | Inherits `coverageThresholds` |
| Glob matches zero files | **FAIL**, naming the glob. Unlike a lane in bootstrap there is no legitimate steady state: either the glob is wrong, or the named code has no measured coverage. Both are what the entry exists to catch |
| Merged report has no per-file data | **FAIL** — a configured strict rule that cannot be evaluated must not report success |
| A metric the format does not measure | WARNING, never FAIL — `null` is not zero |
| The merge was weighted rather than a union | Every critical-path percentage is flagged **APPROXIMATE** — a shared file is counted once per lane |
| A threshold is set on a dimension the merge could not compute exactly | **FAIL**. Functions and branches have no per-item identity across reports, so a multi-lane merge keeps the strongest lane — which can report 1/1 = 100% for a file with 100 functions. Emit one authoritative report for those files, or set that threshold to 0 on the entry |

Critical paths are absolute bars in **both** coverage modes. Under `no-decrease` the repo-wide comparison is against a moving baseline, but a critical path holds its fixed number regardless — and a failing critical path does not bank a new baseline, which would freeze the failure in as the new normal.

```
Critical Paths:
✗ src/payments/**  (7 files)  lines: 98.21% < 100.00% (110/112)
✓ src/auth/**      (4 files)  lines=100.00%, branches=100.00%
✗ src/paymnets/**  matched no file — check the glob against your reporter's paths
```

### How to fix wiring-only tests

| Current assertion | Add this | Example |
|------------------|----------|---------|
| `expect(mockCreate).toHaveBeenCalledWith(opts)` | Verify return value | `expect(result.id).toMatch(/^mx-/)` |
| `expect(mockStop).toHaveBeenCalled()` | Verify formatted output | `expect(formatter.success).toHaveBeenCalledWith("Mecha stopped.")` |
| `expect(mockCreate).toHaveBeenCalledWith(securityOpts)` | Add integration test | `const info = await inspect(container); expect(info.HostConfig.ReadonlyRootfs).toBe(true)` |

## Scope

Covers threshold enforcement: coverage modes, multi-lane merging, null-metric handling, critical-path thresholds, the test-quality scan, and the coverage-ignore directive audit.

Does NOT cover:

| Question | Where |
|----------|-------|
| How is each report format parsed? | `commands/shared/parse-coverage.md` |
| Which lanes contribute coverage, and why? | `tdd-guardian:lane-policy` |
| What coverage tool does language X use? | `tdd-guardian:tooling-catalog` |
| How is test strength measured beyond coverage? | `tdd-guardian:mutation-gate` |
| How strong is the claim a test makes? | `tdd-guardian:policy-core` (S1-S6) |
