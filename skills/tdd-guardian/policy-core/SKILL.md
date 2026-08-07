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

### Test levels (the second axis)

The hierarchy above asks *how strongly does this test verify anything*. A separate question must also be answered for every test: *at what level does this behavior get verified* — unit, integration, e2e, or contract.

The two axes are independent. A unit test can carry a Level 1 assertion; an e2e test can carry a Level 7 one. See the `tdd-guardian:lane-policy` skill for which behavior belongs at which level, and for how lanes bind to gate triggers.

The rule that settles borderline cases:

> If the test would still pass when the real collaborator is broken, it belongs one lane higher.

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
5. **Security properties must be tested behaviorally.** Do NOT verify security by asserting mock call args like `expect(callArgs.HostConfig.CapDrop).toEqual(["ALL"])`. Instead, inspect the actual created resource, in a test that lives in the `integration` lane.
6. **Mocking a boundary creates an obligation.** Every mocked system boundary must be paired with a named test in the `integration` lane that exercises the real path. A repo with mocked boundaries and no integration lane has an unmet obligation — that is a finding, not a preference.
7. Add tests for success, boundaries, invalid input, guard clauses, and error paths.
8. Include state-transition/idempotency tests when behavior is stateful.
9. Include timeout/retry/concurrency tests when logic is async or distributed.
10. Avoid assertion-free tests and snapshot-only logic verification.

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

## Coverage ignore directives

When excluding lines from coverage, **always use range comments**, never the line-count form:

```typescript
// BAD: /* v8 ignore next N */ silently fails on ??, ternaries, catch bodies, and short-circuit operators
/* v8 ignore next 3 */
const value = input ?? defaultValue;

// GOOD: range comments work reliably on all constructs
/* v8 ignore start */
const value = input ?? defaultValue;
/* v8 ignore stop */
```

`/* v8 ignore next N */` silently miscounts on these constructs — coverage appears covered but the ignore is not applied, or worse, it skips the wrong lines. The `start`/`stop` form is explicit and immune to this class of bugs.

**Mandatory rule**: flag any `/* v8 ignore next */` or `/* v8 ignore next N */` in review as a potential silent failure. Replace with `/* v8 ignore start */` / `/* v8 ignore stop */`.

## Completion gates

1. Every lane bound to the trigger must pass. A lane that discovered zero tests is a failure, not a pass — green with nothing run is indistinguishable from green with everything run. The one exception is a lane that has **never** had a test (bootstrap): a greenfield repo is not a broken one, so the gate reports it loudly on every run instead of blocking. That exception ends permanently the moment the lane discovers its first test.
2. Merged coverage across every lane with `coverage: "include"` must satisfy thresholds for lines/functions/branches/statements. A metric the tool does not measure is `null`, which WARNS; it is never treated as zero.
3. A coverage report measuring zero lines fails the gate. Under the 0/0 convention it scores 100%, so a silent no-op run would otherwise pass.
4. **Test quality audit**: no test file may have ONLY Level 6-7 assertions. Every test must include at least one Level 1-5 assertion.
5. **Lane audit**: every mocked boundary has a named integration-lane test covering the real path.
6. Mutation gate must pass when enabled.
7. High-severity findings must be resolved or explicitly waived with rationale.

## Scope

Covers the two axes every test is judged on — the assertion hierarchy (Level 1-7), the mock rules, the coverage-ignore directive rules, and the completion gates every agent enforces.

Does NOT cover:

| Question | Skill |
|----------|-------|
| Which tier does this behavior belong in? | `tdd-guardian:lane-policy` |
| What shape does the test matrix take? | `tdd-guardian:test-matrix` |
| How are thresholds computed and merged? | `tdd-guardian:coverage-gate` |
| What does the final review check? | `tdd-guardian:review-gate` |
| What command runs the tests in language X? | `tdd-guardian:tooling-catalog` |
