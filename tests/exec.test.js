"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");

const exec = require("../scripts/tdd-guardian/lib/exec.js");

// ---------------------------------------------------------------------------
// Exit-code classification
// ---------------------------------------------------------------------------

test("classify maps the well-known exit codes", () => {
  assert.equal(exec.classify(0, "Tests  3 passed (3)", ""), "pass");
  assert.equal(exec.classify(1, "1 failed", ""), "fail");
  assert.equal(exec.classify(127, "", "sh: vitest: command not found"), "runner-missing");
  assert.equal(exec.classify(130, "", ""), "interrupted");
  assert.equal(exec.classify(137, "", ""), "killed");
  assert.equal(exec.classify(99, "", ""), "runner-error");
});

test("classify treats exit 2 as no-tests only when the output says so", () => {
  assert.equal(exec.classify(2, "No test files found, exiting with code 2", ""), "no-tests");
  assert.equal(exec.classify(2, "2 assertions failed", ""), "fail");
});

test("classify refuses to call a zero-test run a pass", () => {
  // Green with nothing run looks identical to green with everything run.
  assert.equal(exec.classify(0, "collected 0 items", ""), "no-tests");
  assert.equal(exec.classify(0, "?   github.com/x/y  [no test files]", ""), "no-tests");
});

test("classify upgrades a missing dependency from fail to runner-error", () => {
  assert.equal(exec.classify(1, "", "Error: Cannot find module 'vitest'"), "runner-error");
  assert.equal(exec.classify(1, "", "ModuleNotFoundError: No module named 'pytest'"), "runner-error");
});

test("classify upgrades an out-of-memory kill", () => {
  assert.equal(exec.classify(1, "", "FATAL ERROR: JavaScript heap out of memory"), "killed");
});

test("classify treats a parse error before any test output as a runner error", () => {
  assert.equal(exec.classify(1, "", "SyntaxError: Unexpected token"), "runner-error");
});

test("classify keeps a genuine failure when the suite asserts on SyntaxError", () => {
  // The runner clearly ran; the word SyntaxError is part of the test output.
  const stdout = "Tests  1 failed | 4 passed (5)\n  expected SyntaxError to be thrown";
  assert.equal(exec.classify(1, stdout, "SyntaxError: Unexpected token"), "fail");
});

test("classify treats silence with a non-zero exit as a missing runner", () => {
  assert.equal(exec.classify(1, "", ""), "runner-missing");
});

// ---------------------------------------------------------------------------
// Test-count parsing
// ---------------------------------------------------------------------------

test("parseCounts reads Vitest output", () => {
  assert.deepEqual(exec.parseCounts("Tests  1 failed | 12 passed (13)", ""), {
    failed: 1,
    passed: 12,
    skipped: 0,
    total: 13,
  });
});

test("parseCounts reads Jest output", () => {
  assert.deepEqual(exec.parseCounts("Tests:       1 failed, 12 passed, 13 total", ""), {
    failed: 1,
    skipped: 0,
    passed: 12,
    total: 13,
  });
});

test("parseCounts reads pytest output", () => {
  const counts = exec.parseCounts("=========== 1 failed, 12 passed, 2 skipped in 0.42s ===========", "");
  assert.deepEqual(counts, { failed: 1, passed: 12, skipped: 2, total: 15 });
});

test("parseCounts reads cargo output", () => {
  assert.deepEqual(exec.parseCounts("test result: FAILED. 12 passed; 1 failed; 2 ignored; 0 measured", ""), {
    passed: 12,
    failed: 1,
    skipped: 2,
    total: 15,
  });
});

test("parseCounts reads Maven Surefire output", () => {
  assert.deepEqual(exec.parseCounts("Tests run: 13, Failures: 1, Errors: 0, Skipped: 2", ""), {
    passed: 10,
    failed: 1,
    skipped: 2,
    total: 13,
  });
});

test("parseCounts reads dotnet test output", () => {
  assert.deepEqual(exec.parseCounts("Failed!  - Failed: 1, Passed: 12, Skipped: 0, Total: 13, Duration: 1 s", ""), {
    failed: 1,
    passed: 12,
    skipped: 0,
    total: 13,
  });
});

test("parseCounts reads go test verbose output", () => {
  const out = "--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.01s)\n--- SKIP: TestC (0.00s)";
  assert.deepEqual(exec.parseCounts(out, ""), { passed: 1, failed: 1, skipped: 1, total: 3 });
});

test("parseCounts reads ExUnit and RSpec output", () => {
  assert.deepEqual(exec.parseCounts("13 tests, 1 failure", ""), { total: 13, failed: 1, skipped: 0, passed: 12 });
  assert.deepEqual(exec.parseCounts("13 examples, 1 failure, 2 pending", ""), {
    total: 13,
    failed: 1,
    skipped: 2,
    passed: 10,
  });
});

test("parseCounts returns null rather than fabricating numbers", () => {
  assert.equal(exec.parseCounts("some entirely unrecognised runner output", ""), null);
});

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

test("run captures stdout and a zero exit", () => {
  const result = exec.run('echo "hello from the lane"', os.tmpdir());
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, "pass");
  assert.match(result.stdout, /hello from the lane/);
  assert.equal(result.timedOut, false);
});

test("run reports a non-zero exit code", () => {
  const result = exec.run("exit 3", os.tmpdir());
  assert.equal(result.exitCode, 3);
  assert.equal(result.status, "runner-error");
});

test("run captures stderr separately", () => {
  const result = exec.run('echo "boom" >&2; exit 1', os.tmpdir());
  assert.match(result.stderr, /boom/);
  assert.equal(result.exitCode, 1);
});

test("run enforces the timeout instead of hanging", () => {
  const result = exec.run("sleep 5", os.tmpdir(), { timeoutMs: 300 });
  assert.equal(result.status, "timeout");
  assert.equal(result.timedOut, true);
  assert.ok(result.durationMs < 4000, `expected an early return, got ${result.durationMs}ms`);
});

test("run never throws on a nonexistent command", () => {
  const result = exec.run("this-command-does-not-exist-12345", os.tmpdir());
  assert.ok(["runner-missing", "runner-error"].includes(result.status), `unexpected status ${result.status}`);
});

// ---------------------------------------------------------------------------
// Failure-class helpers
// ---------------------------------------------------------------------------

test("environment failures are kept distinct from test failures", () => {
  assert.equal(exec.isTestFailure("fail"), true);
  assert.equal(exec.isTestFailure("runner-error"), false);

  for (const status of ["runner-missing", "runner-error", "killed", "timeout", "interrupted"]) {
    assert.equal(exec.isEnvironmentFailure(status), true, `${status} should be an environment failure`);
  }
  assert.equal(exec.isEnvironmentFailure("fail"), false);
  assert.equal(exec.isEnvironmentFailure("pass"), false);
});
