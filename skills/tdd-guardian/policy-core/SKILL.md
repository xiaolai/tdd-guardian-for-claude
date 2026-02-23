---
name: policy-core
description: Global TDD governance policy. Enforces plan-first development, behavior-driven test quality, and strict completion gates.
---

# Policy Core

## Required behavior

1. Plan-first: map all work to explicit work items and acceptance criteria before edits.
2. Scope lock: implement only requested scope; document extras as deferred notes.
3. Small batches: complete one work item at a time with immediate verification.
4. Regression safety: every bug fix includes a failing reproducer test before the fix.
5. Findings-first review: report defects and risks before summary.

## Test quality requirements

### The core principle: Test BEHAVIOR, not WIRING

A test must verify what the code **does** (its observable output, side effects, or state changes), not **how** it does it (which internal functions it calls). If you can refactor the internals and the test still passes despite broken behavior, the test is worthless.

### Assertion hierarchy (prefer higher, justify lower)

| Level | Assertion type | Example | Quality |
|-------|---------------|---------|---------|
| 1 | **Output verification** | `expect(result).toEqual({ id: "mx-foo-abc123", port: 7700 })` | Best |
| 2 | **Side-effect verification** | `expect(await db.query("SELECT ...")).toHaveLength(1)` | Best |
| 3 | **Real integration** | `const res = await app.inject({ method: "GET", url: "/healthz" })` | Best |
| 4 | **State verification** | `expect(container.State.Running).toBe(true)` | Good |
| 5 | **Mock return + output** | Mock returns data, assert caller produces correct output from it | Good |
| 6 | **Mock call args** | `expect(mockFn).toHaveBeenCalledWith(...)` | Weak |
| 7 | **Mock was called** | `expect(mockFn).toHaveBeenCalled()` | Unacceptable alone |

### Mandatory rules

1. **Every test must have at least one Level 1-5 assertion.** A test that only verifies mock call arguments (Level 6-7) is a wiring test and MUST be upgraded.
2. **Mock call assertions are supplements, not replacements.** You may assert `expect(mockCreate).toHaveBeenCalledWith(opts)` but ONLY if you also verify the observable result (return value, formatted output, error thrown).
3. **Prefer real objects over mocks.** Use real implementations when feasible:
   - Real Fastify with `app.inject()` (not mocked HTTP)
   - Real SQLite in-memory DB (not mocked queries)
   - Real file I/O with `tmpdir()` (not mocked fs)
   - Real streams with actual write/read (not mocked EventEmitter)
   - Real Zod parse (not mocked validation)
4. **Mock only at boundaries.** Acceptable mock targets: Docker daemon, network I/O, child processes, `Date.now()`, `crypto.randomBytes()`. Unacceptable: mocking your own modules, mocking types/schemas, mocking pure functions.
5. **Security properties must be tested behaviorally.** Do NOT verify security by asserting mock call args like `expect(callArgs.HostConfig.CapDrop).toEqual(["ALL"])`. Instead, inspect the actual created resource or use integration tests.
6. Add tests for success, boundaries, invalid input, guard clauses, and error paths.
7. Include state-transition/idempotency tests when behavior is stateful.
8. Include timeout/retry/concurrency tests when logic is async or distributed.
9. Avoid assertion-free tests and snapshot-only logic verification.

### Anti-patterns (flag these in review)

```typescript
// BAD: Wiring-only test — would pass even if createContainer was gutted
it("creates container", async () => {
  await mechaUp(client, opts);
  expect(mockCreateContainer).toHaveBeenCalledWith(client, {
    containerName: "mecha-mx-foo-abc123",
    image: "mecha-runtime:latest",
    // ... 10 lines of expected args
  });
});

// GOOD: Behavior test — verifies the observable result
it("creates and starts a mecha, returning its ID and port", async () => {
  const result = await mechaUp(client, { projectPath: "/tmp/test" });
  expect(result.id).toMatch(/^mx-/);
  expect(result.port).toBeGreaterThanOrEqual(1024);
  expect(result.authToken).toHaveLength(64);
  expect(result.name).toBe(`mecha-${result.id}`);
});

// BAD: Security check via mock args — would miss if defaults were silently dropped
it("applies security defaults", async () => {
  await createContainer(client, opts);
  const callArgs = mockCreate.mock.calls[0][0];
  expect(callArgs.HostConfig.ReadonlyRootfs).toBe(true);
});

// GOOD: Security check via integration — verifies Docker actually received the config
it("applies security defaults", async () => {
  await createContainer(client, opts);
  const info = await inspectContainer(client, name);
  expect(info.HostConfig.ReadonlyRootfs).toBe(true);
  expect(info.HostConfig.CapDrop).toContain("ALL");
});

// BAD: Mock-was-called as sole assertion
it("stops the container", async () => {
  await mechaStop(client, "test-id");
  expect(mockStopContainer).toHaveBeenCalled();
});

// GOOD: Verify state change
it("stops a running container", async () => {
  await mechaStop(client, "test-id");
  const info = await inspectContainer(client, containerName("test-id"));
  expect(info.State.Running).toBe(false);
});
```

## Completion gates

1. Test command must pass.
2. Coverage command must pass.
3. Coverage totals must satisfy thresholds for lines/functions/branches/statements.
4. **Test quality audit**: no test file may have ONLY Level 6-7 assertions. Every test must include at least one Level 1-5 assertion.
5. Mutation gate must pass when enabled.
6. High-severity findings must be resolved or explicitly waived with rationale.
