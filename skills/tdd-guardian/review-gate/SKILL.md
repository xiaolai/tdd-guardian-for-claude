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

For every test file touched or relevant to the change, evaluate:

### Check 1: Wiring-only tests

Scan for tests where the ONLY assertions are:
- `expect(mockFn).toHaveBeenCalled()`
- `expect(mockFn).toHaveBeenCalledWith(...)`
- `expect(mockFn).toHaveBeenCalledTimes(...)`

If a test has NO assertion on return values, thrown errors, formatted output, DB state, or other observable behavior — flag it as **High severity: wiring-only test**.

### Check 2: Mock boundary violations

Flag tests that mock:
- Internal modules from the same repo (use real imports instead)
- Pure functions (use real implementation)
- Types or schemas (use real Zod parse)

Acceptable mocks: Docker daemon, network I/O, child_process, Date.now, crypto.randomBytes.

### Check 3: Security verification method

Flag security tests that verify config via mock call args:
```typescript
// FLAG THIS:
expect(callArgs.HostConfig.ReadonlyRootfs).toBe(true);
// when callArgs comes from a mock, not from inspecting a real resource
```

Security properties must be verified via integration tests or by inspecting the actual resource.

### Check 4: Missing integration test coverage

For any unit test that mocks a system boundary, check if a corresponding integration test exists (in `__tests__/integration/`). Flag missing integration coverage as **Medium severity**.

### Output format for test quality findings

```markdown
### Test Quality Findings

| # | Severity | File:Line | Finding | Fix |
|---|----------|-----------|---------|-----|
| 1 | High | docker/container.test.ts:52 | Wiring-only: security defaults verified via mock args, no behavioral assertion | Add integration test that inspects real container |
| 2 | Med | cli/lifecycle.test.ts:50 | Mock-was-called as sole verification for stop command | Assert formatted output or inspect container state |
```
