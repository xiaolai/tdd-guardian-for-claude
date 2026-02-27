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

For every test file touched or relevant to the change, evaluate:

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

### Check 5: Missing integration test coverage

For any unit test that mocks a system boundary, check if a corresponding integration test exists (in `__tests__/integration/`). Flag missing integration coverage as **Medium severity**.

### Output format for test quality findings

```markdown
### Test Quality Findings

| # | Severity | File:Line | Finding | Fix |
|---|----------|-----------|---------|-----|
| 1 | High | docker/container.test.ts:52 | Wiring-only: security defaults verified via mock args, no behavioral assertion | Add integration test that inspects real container |
| 2 | Med | cli/lifecycle.test.ts:50 | Mock-was-called as sole verification for stop command | Assert formatted output or inspect container state |
| 3 | High | src/config.ts:42 | `/* v8 ignore next 3 */` on `??` expression — silently fails | Replace with `/* v8 ignore start */` / `/* v8 ignore stop */` |
```
