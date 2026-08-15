---
name: review-gate
description: Produce findings-first code review with severity ordering, test-gap findings, and test-quality audit.
---

# Review Gate

## Output order

1. **Findings first**, sorted by severity.
2. For each finding include:
   - severity
   - file and line
   - risk/impact
   - concrete fix
3. **Test quality findings** (see audit below).
4. **Missing-test findings** explicitly.
5. Only then provide short summary and residual risks.

## Test quality audit (mandatory)

Follow the assertion hierarchy and mock rules defined in the `policy-core` skill.

For every test file the change touches, and every test file covering a changed source file, evaluate:

### Check 1: Wiring-only tests

Scan for tests where the ONLY assertions are Level 6-7 (wiring) per the `policy-core` assertion hierarchy. If a test has NO assertion on return values, thrown errors, formatted output, DB state, or other observable behavior — flag it as **High severity: wiring-only test**.

### Check 2: Mock boundary violations

Apply the mock rules from `policy-core`. Flag tests that mock internal modules, pure functions, or types/schemas. See `policy-core` for the full list of acceptable vs. unacceptable mock targets.

### Check 3: Security verification method

Flag security tests that verify config via mock call args:
```typescript
// FLAG THIS:
expect(callArgs.HostConfig.ReadonlyRootfs).toBe(true);
// when callArgs comes from a mock, not from inspecting a real resource
```

Security properties must be verified via integration tests or by inspecting the actual resource.

### Check 4: Unreliable coverage ignore directives

Scan source files for `/* v8 ignore next */` or `/* v8 ignore next N */`. These silently fail on `??`, ternaries, `catch` bodies, and short-circuit operators (`&&`, `||`) — the directive is not applied but no error is reported, producing false coverage numbers. Flag as **High severity**. Fix: replace with `/* v8 ignore start */` / `/* v8 ignore stop */`.

### Check 5: Unpaired mock boundaries

For every unit test that mocks a system boundary, verify a corresponding test exists in the `integration` lane. Resolve the lane from `.claude/tdd-guardian/config.json` — its `command` tells you which paths or markers the integration lane actually runs, so check there rather than assuming a directory name.

| Finding | Severity |
|---------|----------|
| Mocked boundary with no integration-lane counterpart | Medium |
| Mocked boundary and the repo has **no** integration lane at all | Medium — report once, against the config, not per test |
| Security property verified via mock args, no integration counterpart | High (also Check 3) |

Report the missing lane against the config rather than repeating it per test. One configuration finding is actionable; forty duplicates are noise.

### Check 6: Lane assignment

For each test under review, ask the `lane-policy` question: would this test still pass if the real collaborator were broken? If yes, it is in the wrong lane. Flag as **Medium severity** with the lane it belongs in.

Common cases: SQL correctness verified against a mocked driver, auth middleware verified against a stubbed guard, file permissions verified against a mocked `fs`.

### Check 7: Under-specified units (specification strength)

Checks 1-6 all ask whether the test verifies the real thing. This one asks whether the claim is strong enough to be worth verifying.

For each changed unit, identify whether it has a **law** — a conserved quantity, a round-trip, an idempotent operation, an ordering, a monotonic relation, or a stated invariant. If it does and every test for it is S1/S2 (examples and boundaries only), flag it.

| Finding | Severity |
|---------|----------|
| Unit has a law; no S4-S6 case covers it | Medium |
| Unit is on a `criticalPaths` entry with `requireSpecLevel` and does not meet it | High |
| Every test for a unit would still pass against a hard-coded return value | High |
| Matrix omits the question entirely (no law identified, no statement that none exists) | Low |

The hard-coded-return check is the cheap version: if replacing the function body with `return <the expected value>` would keep every test green, the tests specify one example, not the behavior. Run that check on every changed unit before reaching for the law question.

### Check 8: Change tax (the symmetric pathology)

Checks 1-6 push toward more verification. Unchecked, that produces a suite so coupled to structure that nobody refactors. These findings push back, and they are findings in the same sense as the others — see the change-tax table in `policy-core`.

| Finding | Severity |
|---------|----------|
| A change with no behavior change edits existing assertions | Medium — the tests specify structure |
| An interface with exactly one production implementation and one test double | Medium — the seam exists only to be mocked |
| More distinct mocks in a test than the unit has collaborators | Medium |
| A test that must change when a private method is renamed | Medium |

Read the diff for this one. Assertions **added** are healthy at any volume. Assertions **modified** while the described behavior is unchanged are the signal — that is the specification moving to fit the implementation, which is the same defect the red receipts catch, seen in the diff rather than in the receipt.

If `.claude/tdd-guardian/receipts.json` exists, read it: a receipt with verdict `SEPARATION-BROKEN` names the exact files, and its finding is High.

### Output format for test quality findings

```markdown
### Test Quality Findings

| # | Severity | File:Line | Finding | Fix |
|---|----------|-----------|---------|-----|
| 1 | High | docker/container.test.ts:52 | Wiring-only: security defaults verified via mock args, no behavioral assertion | Add integration test that inspects real container |
| 2 | Med | cli/lifecycle.test.ts:50 | Mock-was-called as sole verification for stop command | Assert formatted output or inspect container state |
| 3 | High | src/config.ts:42 | `/* v8 ignore next 3 */` on `??` expression — silently fails | Replace with `/* v8 ignore start */` / `/* v8 ignore stop */` |
```

## Scope

Covers the final review rubric: finding order, the test-quality audit checks, the specification-strength and change-tax audits, the lane audit, and severity assignment.

Does NOT cover:

| Question | Skill |
|----------|-------|
| What do assertion Levels 1-7 mean? | `tdd-guardian:policy-core` |
| What do specification levels S1-S6 mean? | `tdd-guardian:policy-core` |
| Which lane should a test live in? | `tdd-guardian:lane-policy` |
| How are coverage numbers computed? | `tdd-guardian:coverage-gate` |
| Which property library fits this language? | `tdd-guardian:tooling-catalog` |
