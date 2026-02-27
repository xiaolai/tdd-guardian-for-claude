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

## Output format

```markdown
## Test Matrix: <unit>

### Case: <descriptive name>
- **Category**: success|boundary|guard|failure|state|determinism
- **Input**: <concrete input values>
- **Expected output**: <exact return value or thrown error>
- **Observable side effect**: <what changes in the world — DB row, file, container state, stdout>
- **Assertion strategy**: <which assertion level from policy-core, and why>
- **Mock boundary**: <what is mocked and why, or "none — real implementation">
```

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

If you mock, you MUST also have an integration test (gated behind `INTEGRATION=true`) that tests the real path.
