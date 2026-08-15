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

### Specification strength (the third axis)

The assertion hierarchy asks *how implementation-independent is this check*. It does not ask *how much of the input space the claim covers*, and those are different questions. `expect(add(2, 3)).toBe(5)` is a Level 1 assertion — top of the hierarchy — and it specifies almost nothing. An implementation returning `5` for every input satisfies it.

| Level | The claim | Example |
|-------|-----------|---------|
| S1 | **Example** — one input, one expected output | `expect(fee(100)).toBe(3)` |
| S2 | **Boundary / equivalence class** — the edges of a partition | `fee(0)`, `fee(-1)`, `fee(MAX_SAFE_INTEGER)` |
| S3 | **Failure mode** — the named way it goes wrong | `expect(() => fee(NaN)).toThrow(RangeError)` |
| S4 | **Property** — holds across a generated input domain | for all `n >= 0`: `fee(n) <= n` |
| S5 | **Invariant across state transitions** — conservation, round-trip, idempotence | `transfer` preserves `a.balance + b.balance`; `parse(print(x))` equals `x`; `retry(id)` debits once |
| S6 | **Metamorphic relation** — a relation between outputs when no oracle exists | `search(q)` results are a superset of `search(q + " " + extraTerm)` |

The three axes are independent. A unit test can be Level 1 / S5. An e2e test can be Level 7 / S1.

**S4-S6 are not a target for every test.** Demanding properties everywhere produces contrived generators over units that have no law, which is its own waste. The rule is narrower and checkable:

> Where a unit **has a law** — a conserved quantity, a round-trip, an idempotent operation, a total ordering, a monotonic relation, or a stated invariant — at least one S4-S6 case must cover it. Where a unit has no law, the test matrix says so explicitly rather than leaving the question unasked.

The banking example is the canonical case. This is S1, and it is weak:

```typescript
// S1: passes against an implementation that credits without debiting
transfer(a, b, 100);
expect(a.balance).toBe(900);
expect(b.balance).toBe(1100);
```

This is S5, and it is what the code actually promises:

```typescript
// S5: conservation — no implementation that loses or invents money can pass
const before = a.balance + b.balance;
transfer(a, b, 100);
expect(a.balance + b.balance).toBe(before);

// S5: idempotence — a retried transfer must not debit twice
transfer(a, b, 100, { idempotencyKey: "k1" });
transfer(a, b, 100, { idempotencyKey: "k1" });
expect(a.balance + b.balance).toBe(before);

// S3 + S5: a failed transfer moves nothing
expect(() => transfer(a, b, 999999)).toThrow(InsufficientFunds);
expect(a.balance).toBe(startingA);
```

Tooling per language is in `tdd-guardian:tooling-catalog` — every language the catalog covers names a property-testing library, because a level the catalog cannot equip is aspiration, not policy.

### Test levels (the second axis)

The hierarchy above asks *how strongly does this test verify anything*. A separate question must also be answered for every test: *at what level does this behavior get verified* — unit, integration, e2e, or contract.

This axis is independent of both the assertion hierarchy and specification strength. A unit test can carry a Level 1 assertion; an e2e test can carry a Level 7 one. See the `tdd-guardian:lane-policy` skill for which behavior belongs at which level, and for how lanes bind to gate triggers.

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
11. **A unit with a law needs an S4-S6 case.** Conservation, round-trip, idempotence, ordering, and monotonicity are laws. A unit that has one and is specified only by examples is under-specified, however high its coverage. A unit with no law records that fact in the matrix instead of leaving the question unasked.
12. **The specification must not move while the implementation is made to satisfy it.** Editing an existing assertion to make a failing implementation pass destroys the independence the test was written for. Adding cases is always fine; changing recorded ones requires a stated reason for why the original specification was wrong. `/tdd-guardian:implement` records a red receipt so this is checkable rather than aspirational.
13. **Do not restructure production code purely to make it mockable.** An interface with exactly one production implementation and one test double is a testability artifact, not a design. Prefer moving the test one lane up over inventing a seam.

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

## What a test is worth, and what it costs

Every rule above pushes in one direction: verify more, verify more honestly. Pushed without a counterweight, that produces the opposite pathology — a suite so coupled to structure that a rename breaks two hundred tests and nobody refactors again. A test suite is not free, and the plugin must be able to say so.

**What tests buy is not fewer bugs today. It is a lower marginal cost of future change.** Without verification, changing existing code means unknown consequences, manual inspection, and the entirely rational fear that stops refactoring; the debt compounds and the next change costs more. That is the axis worth spending on.

Which gives a usable heuristic for how much verification a given piece of code deserves:

| Raises the value of verifying | Lowers it |
|-------------------------------|-----------|
| How often the code changes | How cheaply a defect is detected in production |
| What a failure costs | How fast a bad change can be rolled back |
| How long the system will live | How short-lived the code is |
| How many people and agents touch it | How much the test itself will cost to maintain |

A one-off 500-line migration script rationally gets no test suite. A payment core maintained for a decade rationally gets property tests, mutation testing, and a stricter coverage bar than the repo average. Express that difference with `criticalPaths` in config — one repo-wide threshold cannot, and a repo forced to choose one number for everything picks the low one.

### The change-tax anti-patterns

These are findings in the same way wiring-only tests are findings — they are the same defect seen from the other side.

| Anti-pattern | Why it fails | Fix |
|--------------|--------------|-----|
| A refactor with no behavior change edits dozens of existing assertions | The tests specify structure, not behavior | Assert observable results; move the test one lane up |
| An interface with one production implementation and one test double | The seam exists only to be mocked | Delete the interface; use the real collaborator |
| More mocks in a test than the unit has collaborators | The test reconstructs the implementation | Use real objects, or promote the case to `integration` |
| Classes split below the level of any behavior, one test file each | Test count tracks structure, not risk | Test the behavior the caller can observe |
| A test that must change whenever a private method is renamed | It reaches through the public surface | Assert through the public surface only |

The question to settle a borderline case is **not** "is everything unit-testable?" It is:

> Are the externally observable behaviors and the invariants cheaply verifiable?

Those are different questions, and only the second one is worth designing for.

## Completion gates

1. Every lane bound to the trigger must pass. A lane that discovered zero tests is a failure, not a pass — green with nothing run is indistinguishable from green with everything run. The one exception is a lane that has **never** had a test (bootstrap): a greenfield repo is not a broken one, so the gate reports it loudly on every run instead of blocking. That exception ends permanently the moment the lane discovers its first test.
2. Merged coverage across every lane with `coverage: "include"` must satisfy thresholds for lines/functions/branches/statements. A metric the tool does not measure is `null`, which WARNS; it is never treated as zero.
3. A coverage report measuring zero lines fails the gate. Under the 0/0 convention it scores 100%, so a silent no-op run would otherwise pass.
4. **Test quality audit**: no test file may have ONLY Level 6-7 assertions. Every test must include at least one Level 1-5 assertion.
5. **Lane audit**: every mocked boundary has a named integration-lane test covering the real path.
6. **Specification-strength audit**: every unit with a law has an S4-S6 case, and every `criticalPaths` entry with a `requireSpecLevel` meets it. A unit with no law is recorded as such, not skipped in silence.
7. **Critical-path coverage**: every `criticalPaths` entry meets its own thresholds. A glob matching nothing is reported — a strict rule enforcing nothing must never read as enforced.
8. **Separation check**: recorded red receipts still hold. A test file edited between red and green is a High finding unless the change carries a stated reason.
9. Mutation gate must pass when enabled.
10. High-severity findings must be resolved or explicitly waived with rationale.

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
