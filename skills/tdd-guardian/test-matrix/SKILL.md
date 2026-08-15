---
name: test-matrix
description: Build a comprehensive test matrix for changed behavior with explicit assertion strategy per case.
---

# Test Matrix

For each changed unit/function, provide this matrix before coding tests:

## Categories

1. **Success path**: expected output and side effects.
2. **Boundary values**: min, max, empty, zero, one, large input.
3. **Guard clauses**: invalid type/shape/range; missing required values.
4. **Failure paths**: downstream failure, timeout, retries exhausted.
5. **State transitions**: create/update/delete/retry/idempotency.
6. **Determinism**: stable behavior across repeated runs.
7. **Properties and invariants**: the laws the unit must never violate, over generated inputs rather than listed ones.

## The law question, once per unit

Before writing cases, answer this for the unit as a whole:

> Does this unit have a **law** — a conserved quantity, a round-trip, an idempotent operation, a total ordering, a monotonic relation, or a stated invariant?

If yes, at least one case must be S4-S6 and must cover it. If no, write **"No law: {why}"** and move on. Categories 1-6 alone specify examples; a unit with a law and only examples is under-specified however many examples it has. See `policy-core` for the S1-S6 levels and `tooling-catalog` for the property library in this language.

## Output format

```markdown
## Test Matrix: <unit>

**Law**: <the invariant this unit must never violate> | No law: <why>

### Case: <descriptive name>
- **Category**: success|boundary|guard|failure|state|determinism|property
- **Spec level**: S1-S6 per `policy-core` — how much of the input space this case claims
- **Lane**: unit|integration|e2e|contract — per `lane-policy`, the cheapest lane where a failure would be real
- **Input**: <concrete input values>
- **Expected output**: <exact return value or thrown error>
- **Observable side effect**: <what changes in the world — DB row, file, container state, stdout>
- **Assertion strategy**: <which assertion level from policy-core, and why>
- **Mock boundary**: <what is mocked and why, or "none — real implementation">
- **Paired integration test**: <required whenever Mock boundary is not "none" — name the integration-lane case covering the real path>
```

Every case carries a lane, an assertion level, and a spec level. The three are independent axes: the lane says *where* the behavior is verified, the assertion level says *how strongly*, and the spec level says *how much of the input space* is claimed. A case missing any of the three is incomplete.

## Assertion strategy guide

Follow the assertion hierarchy and mock rules defined in the `policy-core` skill.

For each test case, explicitly state HOW you will verify it, preferring Level 1-5 (behavior) assertions over Level 6-7 (wiring) assertions per `policy-core`:

| If testing... | Assert via... | NOT via... |
|--------------|---------------|------------|
| Return value | `expect(result).toEqual(...)` | Mock call args |
| Error thrown | `expect(() => fn()).toThrow(ErrorType)` | Mock call count |
| Formatted output | `expect(formatter.success).toHaveBeenCalledWith("Mecha started")` + `expect(result.id)` | Mock call args alone |
| Docker state | `inspectContainer()` or integration test | `expect(mockCreate).toHaveBeenCalledWith(...)` |
| File written | Read file back and verify content | `expect(mockWriteFile).toHaveBeenCalled()` |
| DB state | Query the DB and verify rows | `expect(mockInsert).toHaveBeenCalled()` |
| Stream output | Write to stream, collect output, verify content | `expect(mockStream.on).toHaveBeenCalled()` |

## Mock decision tree

Apply the mock rules from `policy-core`. Before adding a mock, answer:

1. **Can I use the real thing?** (in-memory DB, tmpdir, real Zod parse) → Use real.
2. **Is it a system boundary?** (Docker daemon, network, child process) → Mock is OK.
3. **Is it my own code?** (another module in this repo) → Do NOT mock. Use the real module.
4. **Is it non-deterministic?** (Date.now, crypto.random) → Spy/stub the specific call.

## Lane assignment

Assign each case to the cheapest lane where a failure would be real — not the cheapest lane it can be written in. See `lane-policy` for the full mapping. The deciding question:

> Would this test still pass if the real collaborator were broken?

If yes, the case belongs one lane higher.

If you mock, you MUST also name an `integration`-lane case that exercises the real path, in the case's **Paired integration test** field. `review-gate` checks that the pairing exists; an unpaired mock is an unverified boundary.

## Scope

Covers the matrix format, the per-unit law question, and the per-case fields the designer must fill: category, lane, spec level, input, expected output, observable side effect, assertion strategy, mock boundary, paired integration test.

Does NOT cover:

| Question | Skill |
|----------|-------|
| What do assertion Levels 1-7 mean? | `tdd-guardian:policy-core` |
| What do specification levels S1-S6 mean? | `tdd-guardian:policy-core` |
| Which lane does a given behavior belong in? | `tdd-guardian:lane-policy` |
| Which property library fits this language? | `tdd-guardian:tooling-catalog` |
| How is the finished matrix reviewed? | `tdd-guardian:review-gate` |
| Who attacks the finished matrix? | `agents/tdd-spec-adversary.md` |
