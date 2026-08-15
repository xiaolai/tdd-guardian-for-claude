"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const verification = require("../scripts/tdd-guardian/lib/verification.js");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tddg-verify-"));
}

function write(dir, rel, content) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return rel;
}

function fingerprintOf(dir, file) {
  return verification.fingerprintFiles([file], dir);
}

// ---------------------------------------------------------------------------
// Red classification — the false-red distinction
// ---------------------------------------------------------------------------

test("a counted assertion failure is a genuine red", () => {
  const result = verification.classifyRedRun({ status: "fail", testCounts: { failed: 3, passed: 9, skipped: 0, total: 12 } });
  assert.equal(result.red, true);
  assert.equal(result.kind, "assertion-failure");
  assert.match(result.reason, /3 of 12/);
});

test("a failure with no parseable counts is red but explicitly weaker evidence", () => {
  const result = verification.classifyRedRun({ status: "fail", testCounts: null });
  assert.equal(result.red, true);
  assert.equal(result.kind, "opaque-failure");
  assert.match(result.reason, /[Ww]eaker evidence/);
});

test("a zero-test run is not a red — nothing ran, so nothing was specified", () => {
  const result = verification.classifyRedRun({ status: "no-tests", testCounts: null });
  assert.equal(result.red, false);
  assert.equal(result.kind, "no-tests");
});

test("a missing runner is not a red — a broken runner is not a failing test", () => {
  for (const status of ["runner-missing", "runner-error", "timeout", "killed", "interrupted"]) {
    const result = verification.classifyRedRun({ status, testCounts: null });
    assert.equal(result.red, false, `${status} must not count as red`);
    assert.equal(result.kind, "environment");
  }
});

test("a passing run is not a red, and says why that matters", () => {
  const result = verification.classifyRedRun({ status: "pass", testCounts: { failed: 0, passed: 5, skipped: 0, total: 5 } });
  assert.equal(result.red, false);
  assert.equal(result.kind, "green");
  assert.match(result.reason, /capable of failing/);
});

test("a fail status with zero counted failures is not treated as a counted red", () => {
  const result = verification.classifyRedRun({ status: "fail", testCounts: { failed: 0, passed: 0, skipped: 0, total: 0 } });
  assert.equal(result.kind, "opaque-failure");
});

// ---------------------------------------------------------------------------
// Test file recognition
// ---------------------------------------------------------------------------

test("recognises test files across the languages the catalog covers", () => {
  const positives = [
    "tests/coverage.test.js",
    "src/foo.spec.ts",
    "src/__tests__/bar.tsx",
    "test_parser.py",
    "pkg/queue_test.go",
    "src/test/java/com/x/QueueTest.java",
    "Sources/AppTests.swift",
    "spec/models/user_spec.rb",
    "features/login.feature",
    "e2e/checkout.ts",
  ];
  for (const file of positives) {
    assert.equal(verification.isTestFile(file), true, `${file} should be a test file`);
  }
});

test("does not mistake production code or gate bookkeeping for tests", () => {
  const negatives = ["src/queue.ts", "lib/protest.js", "README.md", ".claude/tdd-guardian/state.json", ".claude/tdd-guardian/receipts.json"];
  for (const file of negatives) {
    assert.equal(verification.isTestFile(file), false, `${file} should not be a test file`);
  }
});

// ---------------------------------------------------------------------------
// Path safety — both entry points take attacker-influenceable paths
// ---------------------------------------------------------------------------

test("an absolute path is refused rather than read", () => {
  const result = verification.resolveSpecPath("/etc/passwd", tmpDir());
  assert.equal(result.ok, false);
  assert.equal(result.state, "refused");
  assert.match(result.reason, /absolute/);
});

test("a path escaping the workspace is refused", () => {
  const result = verification.resolveSpecPath("../../../etc/passwd", tmpDir());
  assert.equal(result.ok, false);
  assert.equal(result.state, "refused");
  assert.match(result.reason, /escapes the workspace/);
});

test("a symlink is refused rather than followed", () => {
  const dir = tmpDir();
  write(dir, "real.test.js", "expect(1).toBe(1);\n");
  fs.symlinkSync(path.join(dir, "real.test.js"), path.join(dir, "link.test.js"));

  const result = verification.resolveSpecPath("link.test.js", dir);
  assert.equal(result.ok, false);
  assert.match(result.reason, /symlink/);
});

test("a non-regular file is refused, because reading a FIFO would hang the gate", () => {
  const dir = tmpDir();
  const target = path.join(dir, "pipe.test.js");
  if (spawnSync("mkfifo", [target]).status !== 0) fs.mkdirSync(target);

  const result = verification.resolveSpecPath("pipe.test.js", dir);
  assert.equal(result.ok, false);
  assert.match(result.reason, /not a regular file/);
});

test("a file over the size cap is refused rather than hashed", () => {
  const dir = tmpDir();
  write(dir, "huge.test.js", "x".repeat(verification.MAX_SPEC_BYTES + 1));
  const result = verification.resolveSpecPath("huge.test.js", dir);
  assert.equal(result.ok, false);
  assert.match(result.reason, /cap/);
});

test("a missing file is 'missing', not 'refused' — the two mean different things", () => {
  assert.equal(verification.resolveSpecPath("nope.test.js", tmpDir()).state, "missing");
});

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

test("identical content fingerprints identically", () => {
  const dir = tmpDir();
  write(dir, "tests/a.test.js", "assert(1);\n");
  const before = verification.fingerprintFile("tests/a.test.js", dir);
  write(dir, "tests/a.test.js", "assert(1);\n");
  assert.equal(before.sha, verification.fingerprintFile("tests/a.test.js", dir).sha);
});

test("re-indenting is not the specification moving", () => {
  const dir = tmpDir();
  write(dir, "tests/a.test.js", "it('x', () => {\nexpect(f()).toBe(1);\n});\n");
  const before = verification.fingerprintFile("tests/a.test.js", dir);

  write(dir, "tests/a.test.js", "it('x', () => {\n    expect(f()).toBe(1);\n});\n");
  const after = verification.fingerprintFile("tests/a.test.js", dir);

  assert.notEqual(before.sha, after.sha, "the bytes did change");
  assert.deepEqual(before.lines, after.lines, "but no recorded line did");
});

test("an unreadable path fingerprints as a state, never as a silent null", () => {
  const result = verification.fingerprintFile("tests/missing.test.js", tmpDir());
  assert.equal(result.state, "missing");
  assert.equal(result.sha, null);
});

test("isSubsequence accepts insertions and rejects edits", () => {
  assert.equal(verification.isSubsequence(["a", "b"], ["a", "x", "b"]), true);
  assert.equal(verification.isSubsequence(["a", "b"], ["a"]), false);
  assert.equal(verification.isSubsequence(["a", "b"], ["b", "a"]), false, "order matters");
  assert.equal(verification.isSubsequence([], ["a"]), true);
});

// ---------------------------------------------------------------------------
// Diffing — additions vs edits vs deletions vs unknowns
// ---------------------------------------------------------------------------

test("adding a case to a recorded file is an extension, not a change", () => {
  // The whole-file hash moves; every recorded line survives. Reporting that as
  // "spec changed" contradicted the documented policy that additions are healthy.
  const dir = tmpDir();
  write(dir, "tests/a.test.js", "expect(charge(100)).toBe(100);\n");
  const before = fingerprintOf(dir, "tests/a.test.js");

  write(dir, "tests/a.test.js", "expect(charge(100)).toBe(100);\nexpect(charge(0)).toThrow();\n");
  const diff = verification.diffFingerprints(before, fingerprintOf(dir, "tests/a.test.js"));

  assert.equal(diff.extended.length, 1);
  assert.equal(diff.modified.length, 0);
});

test("relaxing a recorded assertion is a change", () => {
  const dir = tmpDir();
  write(dir, "tests/a.test.js", "expect(charge(100)).toBe(100);\n");
  const before = fingerprintOf(dir, "tests/a.test.js");

  write(dir, "tests/a.test.js", "expect(charge(100)).toBeGreaterThan(0);\n");
  const diff = verification.diffFingerprints(before, fingerprintOf(dir, "tests/a.test.js"));

  assert.equal(diff.modified.length, 1);
  assert.equal(diff.extended.length, 0);
});

test("deleting a recorded line is a change even when other lines are added", () => {
  const dir = tmpDir();
  write(dir, "tests/a.test.js", "expect(a()).toBe(1);\nexpect(b()).toBe(2);\n");
  const before = fingerprintOf(dir, "tests/a.test.js");

  write(dir, "tests/a.test.js", "expect(a()).toBe(1);\nexpect(c()).toBe(3);\n");
  assert.equal(verification.diffFingerprints(before, fingerprintOf(dir, "tests/a.test.js")).modified.length, 1);
});

test("a vanished file is removed; an unreadable one is unknown", () => {
  const before = { gone: { state: "ok", sha: "1", lines: ["a"] }, blocked: { state: "ok", sha: "2", lines: ["b"] } };
  const after = {
    gone: { state: "missing", sha: null, lines: null, reason: "file does not exist" },
    blocked: { state: "unreadable", sha: null, lines: null, reason: "cannot read: EACCES" },
  };

  const diff = verification.diffFingerprints(before, after);
  assert.deepEqual(diff.removed.map((d) => d.file), ["gone"]);
  assert.deepEqual(diff.unknown.map((d) => d.file), ["blocked"]);
});

// ---------------------------------------------------------------------------
// Receipt verification
// ---------------------------------------------------------------------------

function redReceipt(dir, files, overrides = {}) {
  return verification.buildReceipt({
    id: "WI-1",
    lane: "unit",
    result: { status: "fail", testCounts: { failed: 2, passed: 0, skipped: 0, total: 2 } },
    testFiles: files,
    cwd: dir,
    sha: "abc1234",
    ...overrides,
  });
}

test("an unchanged specification holds", () => {
  const dir = tmpDir();
  write(dir, "tests/a.test.js", "expect(charge(100)).toBe(100);\n");
  const result = verification.verifyReceipt(redReceipt(dir, ["tests/a.test.js"]), fingerprintOf(dir, "tests/a.test.js"));

  assert.equal(result.ok, true);
  assert.equal(result.verdict, "SEPARATION-HELD");
});

test("a recorded line edited between red and green is a HIGH finding", () => {
  const dir = tmpDir();
  write(dir, "tests/a.test.js", "expect(charge(100)).toBe(100);\n");
  const receipt = redReceipt(dir, ["tests/a.test.js"]);

  write(dir, "tests/a.test.js", "expect(charge(100)).toBeGreaterThan(0);\n");
  const result = verification.verifyReceipt(receipt, fingerprintOf(dir, "tests/a.test.js"));

  assert.equal(result.verdict, "SEPARATION-BROKEN");
  assert.equal(result.findings.find((f) => f.code === "spec-changed-under-green").severity, "high");
});

test("adding cases while implementing produces an info finding and still holds", () => {
  const dir = tmpDir();
  write(dir, "tests/a.test.js", "expect(charge(100)).toBe(100);\n");
  const receipt = redReceipt(dir, ["tests/a.test.js"]);

  write(dir, "tests/a.test.js", "expect(charge(100)).toBe(100);\nexpect(charge(0)).toThrow();\n");
  const result = verification.verifyReceipt(receipt, fingerprintOf(dir, "tests/a.test.js"));

  assert.equal(result.ok, true, "additions must not break separation");
  assert.equal(result.findings.find((f) => f.code === "spec-extended").severity, "info");
});

test("a deleted specification file is a HIGH finding", () => {
  const dir = tmpDir();
  write(dir, "tests/a.test.js", "expect(charge(100)).toBe(100);\n");
  const receipt = redReceipt(dir, ["tests/a.test.js"]);
  fs.rmSync(path.join(dir, "tests/a.test.js"));

  const result = verification.verifyReceipt(receipt, fingerprintOf(dir, "tests/a.test.js"));
  assert.equal(result.findings.find((f) => f.code === "spec-deleted-under-green").severity, "high");
});

test("a file that cannot be re-read is unknown, not held and not deleted", () => {
  const dir = tmpDir();
  write(dir, "tests/a.test.js", "expect(1).toBe(1);\n");
  const receipt = redReceipt(dir, ["tests/a.test.js"]);

  const unreadable = { "tests/a.test.js": { state: "unreadable", sha: null, lines: null, reason: "cannot read: EACCES" } };
  const result = verification.verifyReceipt(receipt, unreadable);

  assert.equal(result.ok, true, "an unknown is not a violation");
  const finding = result.findings.find((f) => f.code === "spec-unverifiable");
  assert.equal(finding.severity, "medium");
  assert.match(finding.message, /worse than an admitted gap/);
});

test("a receipt whose red proved nothing is itself a HIGH finding", () => {
  const dir = tmpDir();
  write(dir, "tests/a.test.js", "// no assertions yet\n");
  const receipt = redReceipt(dir, ["tests/a.test.js"], { result: { status: "no-tests", testCounts: null } });

  const result = verification.verifyReceipt(receipt, fingerprintOf(dir, "tests/a.test.js"));
  assert.equal(result.ok, false);
  assert.match(result.findings.find((f) => f.code === "false-red").message, /proves nothing/);
});

test("an opaque red is accepted but flagged as weaker evidence", () => {
  const dir = tmpDir();
  write(dir, "tests/a.test.js", "expect(1).toBe(2);\n");
  const receipt = redReceipt(dir, ["tests/a.test.js"], { result: { status: "fail", testCounts: null } });

  const result = verification.verifyReceipt(receipt, fingerprintOf(dir, "tests/a.test.js"));
  assert.equal(result.verdict, "SEPARATION-HELD", "an unparsed runner must still be usable");
  assert.equal(result.findings.find((f) => f.code === "weak-red").severity, "medium");
});

test("source already dirty at record time is surfaced, not hidden", () => {
  const dir = tmpDir();
  write(dir, "tests/a.test.js", "expect(1).toBe(1);\n");
  const receipt = redReceipt(dir, ["tests/a.test.js"], { dirtySource: ["src/charge.js"] });

  const finding = verification
    .verifyReceipt(receipt, fingerprintOf(dir, "tests/a.test.js"))
    .findings.find((f) => f.code === "implementation-already-present");

  assert.equal(finding.severity, "medium");
  assert.match(finding.message, /src\/charge\.js/);
});

test("a missing receipt reports as unverified, never as a violation", () => {
  const result = verification.verifyReceipt(null, {});
  assert.equal(result.ok, true);
  assert.equal(result.verdict, "NOT-RECORDED");
  assert.match(result.findings[0].message, /not a violation/);
});

// ---------------------------------------------------------------------------
// Store integrity
// ---------------------------------------------------------------------------

test("receipts round-trip through disk and the newest wins per id", () => {
  const dir = tmpDir();
  write(dir, "tests/a.test.js", "x\n");

  let store = verification.upsertReceipt(verification.emptyReceipts(), redReceipt(dir, ["tests/a.test.js"]));
  store = verification.upsertReceipt(store, redReceipt(dir, ["tests/a.test.js"]));
  verification.saveReceipts(dir, store);

  const loaded = verification.loadReceipts(dir);
  assert.equal(loaded.error, null);
  assert.equal(loaded.store.receipts.length, 1);
});

test("a corrupt receipts file is REPORTED, not silently treated as empty", () => {
  // Swallowing corruption erases the evidence while the gate stays green — the
  // exact silent-failure class this module exists to catch.
  const dir = tmpDir();
  write(dir, ".claude/tdd-guardian/receipts.json", "{ not json");

  const loaded = verification.loadReceipts(dir);
  assert.match(loaded.error, /not valid JSON/);
  assert.match(loaded.error, /not treated as empty/);
});

test("a missing receipts file is an empty store, which is not an error", () => {
  const loaded = verification.loadReceipts(tmpDir());
  assert.equal(loaded.error, null);
  assert.deepEqual(loaded.store.receipts, []);
});

test("a null entry is dropped with a problem rather than crashing verifyAll", () => {
  const dir = tmpDir();
  write(dir, ".claude/tdd-guardian/receipts.json", JSON.stringify({ schemaVersion: 2, receipts: [null, { id: "x" }] }));

  const loaded = verification.loadReceipts(dir);
  assert.equal(loaded.store.receipts.length, 0);
  assert.equal(loaded.problems.length, 2);
  assert.doesNotThrow(() => verification.verifyAll(loaded.store, dir));
});

test("a forged verdict is not trusted as settled", () => {
  // receipts.json is writable by the process being audited. An arbitrary truthy
  // value must not bypass hashing; only a verdict verification produced counts.
  const dir = tmpDir();
  write(dir, "tests/a.test.js", "expect(1).toBe(1);\n");
  const forged = { ...redReceipt(dir, ["tests/a.test.js"]), verdict: "TOTALLY-FINE" };
  write(dir, ".claude/tdd-guardian/receipts.json", JSON.stringify({ schemaVersion: 2, receipts: [forged] }));

  const loaded = verification.loadReceipts(dir);
  assert.equal(loaded.store.receipts[0].verdict, null, "an unrecognised verdict is discarded");
  assert.match(loaded.problems[0], /does not settle anything/);
});

test("an unknown schema version is refused rather than coerced", () => {
  const dir = tmpDir();
  write(dir, ".claude/tdd-guardian/receipts.json", JSON.stringify({ schemaVersion: 99, receipts: [] }));
  assert.match(verification.loadReceipts(dir).error, /schema v99/);
});

test("saveReceipts is atomic and leaves no temp file behind", () => {
  const dir = tmpDir();
  write(dir, "tests/a.test.js", "x\n");
  verification.saveReceipts(dir, verification.upsertReceipt(verification.emptyReceipts(), redReceipt(dir, ["tests/a.test.js"])));

  const leftovers = fs.readdirSync(path.join(dir, ".claude", "tdd-guardian")).filter((f) => f.includes("tmp"));
  assert.deepEqual(leftovers, []);
  assert.equal(verification.loadReceipts(dir).store.receipts.length, 1);
});

// ---------------------------------------------------------------------------
// verifyAll — the green-lane requirement and settling
// ---------------------------------------------------------------------------

test("a receipt whose lane is not green stays PENDING and unsettled", () => {
  // Verifying while the suite is still red would otherwise bank SEPARATION-HELD
  // and settle, after which the real red-to-green transition is never examined.
  const dir = tmpDir();
  write(dir, "tests/a.test.js", "expect(1).toBe(1);\n");
  const store = verification.upsertReceipt(verification.emptyReceipts(), redReceipt(dir, ["tests/a.test.js"]));

  const { store: after, reports } = verification.verifyAll(store, dir, { greenLanes: new Set() });
  assert.equal(reports[0].verdict, "PENDING");
  assert.equal(reports[0].pending, true);
  assert.equal(after.receipts[0].verdict, null, "a pending receipt must not settle");
});

test("a receipt settles once its own lane is green", () => {
  const dir = tmpDir();
  write(dir, "tests/a.test.js", "expect(1).toBe(1);\n");
  const store = verification.upsertReceipt(verification.emptyReceipts(), redReceipt(dir, ["tests/a.test.js"]));

  const { store: after, reports } = verification.verifyAll(store, dir, { greenLanes: new Set(["unit"]) });
  assert.equal(reports[0].verdict, "SEPARATION-HELD");
  assert.equal(after.receipts[0].verdict, "SEPARATION-HELD");
});

test("a green lane with a different name does not settle another lane's receipt", () => {
  const dir = tmpDir();
  write(dir, "tests/a.test.js", "expect(1).toBe(1);\n");
  const store = verification.upsertReceipt(verification.emptyReceipts(), redReceipt(dir, ["tests/a.test.js"], { lane: "integration" }));

  const { reports } = verification.verifyAll(store, dir, { greenLanes: new Set(["unit"]) });
  assert.equal(reports[0].verdict, "PENDING");
});

test("a settled receipt is not re-verified when a later work item edits the same file", () => {
  const dir = tmpDir();
  write(dir, "tests/a.test.js", "expect(charge(100)).toBe(100);\n");
  const store = verification.upsertReceipt(verification.emptyReceipts(), redReceipt(dir, ["tests/a.test.js"]));

  const first = verification.verifyAll(store, dir, { greenLanes: new Set(["unit"]) });
  assert.equal(first.reports[0].settled, false);

  write(dir, "tests/a.test.js", "expect(charge(100)).toBeGreaterThan(0);\n");
  const second = verification.verifyAll(first.store, dir, { greenLanes: new Set(["unit"]) });

  assert.equal(second.reports[0].settled, true);
  assert.deepEqual(verification.describeReports(second.reports), []);
});

test("describeReports skips info findings and pending receipts", () => {
  const reports = [
    { id: "A", lane: "unit", settled: false, pending: true, findings: [{ severity: "medium", code: "x", message: "m" }] },
    { id: "B", lane: "unit", settled: false, pending: false, findings: [{ severity: "info", code: "y", message: "n" }] },
    { id: "C", lane: "unit", settled: false, pending: false, findings: [{ severity: "high", code: "z", message: "real" }] },
  ];
  const lines = verification.describeReports(reports);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[HIGH\] C \(unit\)/);
});

test("receiptIsUsable rejects a receipt whose files were never readable", () => {
  const dir = tmpDir();
  write(dir, "tests/a.test.js", "x\n");
  assert.equal(verification.receiptIsUsable(redReceipt(dir, ["tests/a.test.js"])), true);
  assert.equal(verification.receiptIsUsable(redReceipt(dir, ["tests/gone.test.js"])), false);
  assert.equal(verification.receiptIsUsable(redReceipt(dir, [])), false);
});

test("verifyAll settles nothing when the caller omits greenLanes", () => {
  // Fail closed: a caller that forgets the option gets PENDING, not a silent
  // reversion to settling every receipt regardless of lane state.
  const dir = tmpDir();
  write(dir, "tests/a.test.js", "expect(1).toBe(1);\n");
  const store = verification.upsertReceipt(verification.emptyReceipts(), redReceipt(dir, ["tests/a.test.js"]));

  const { store: after, reports } = verification.verifyAll(store, dir, {});
  assert.equal(reports[0].verdict, "PENDING");
  assert.equal(after.receipts[0].verdict, null);
});

test("a weaker assertion added ALONGSIDE the recorded one still holds, by design", () => {
  // The recorded specification is intact; a new weaker case sitting next to it
  // does not relax anything. Pinned so the limit is a decision, not a surprise.
  const dir = tmpDir();
  write(dir, "tests/a.test.js", "expect(f()).toBe(1);\n");
  const receipt = redReceipt(dir, ["tests/a.test.js"]);

  write(dir, "tests/a.test.js", "expect(f()).toBe(1);\nexpect(f()).toBeTruthy();\n");
  const result = verification.verifyReceipt(receipt, fingerprintOf(dir, "tests/a.test.js"));

  assert.equal(result.verdict, "SEPARATION-HELD");
});

test("a comment or blank line is not the specification moving", () => {
  const dir = tmpDir();
  write(dir, "tests/a.test.js", "expect(f()).toBe(1);\n");
  const receipt = redReceipt(dir, ["tests/a.test.js"]);

  write(dir, "tests/a.test.js", "\n// why this matters\nexpect(f()).toBe(1);\n\n");
  assert.equal(verification.verifyReceipt(receipt, fingerprintOf(dir, "tests/a.test.js")).verdict, "SEPARATION-HELD");
});

// ---------------------------------------------------------------------------
// Round-3 hardening
// ---------------------------------------------------------------------------

test("a symlinked PARENT directory does not escape the workspace", () => {
  // lstat only guards the leaf. `tests -> /etc` holds ordinary regular files, so
  // every earlier check passed and the gate read outside the workspace.
  const dir = tmpDir();
  const outside = tmpDir();
  write(outside, "secret.test.js", "not yours\n");
  fs.symlinkSync(outside, path.join(dir, "tests"));

  const result = verification.resolveSpecPath("tests/secret.test.js", dir);
  assert.equal(result.ok, false);
  assert.match(result.reason, /parent directory is a symlink/);
});

test("a legitimate name beginning with two dots is not mistaken for an escape", () => {
  const dir = tmpDir();
  write(dir, "..spec.test.js", "expect(1).toBe(1);\n");
  assert.equal(verification.resolveSpecPath("..spec.test.js", dir).ok, true);

  assert.equal(verification.escapesRoot("..spec.test.js"), false);
  assert.equal(verification.escapesRoot(".."), true);
  assert.equal(verification.escapesRoot(".." + path.sep + "x"), true);
});

test("readSpecFile reads through a descriptor it has fstat-ed", () => {
  const dir = tmpDir();
  write(dir, "a.test.js", "expect(1).toBe(1);\n");
  const ok = verification.readSpecFile("a.test.js", dir);
  assert.equal(ok.state, "ok");
  assert.match(ok.text, /expect/);

  assert.equal(verification.readSpecFile("nope.test.js", dir).state, "missing");
  assert.equal(verification.readSpecFile("/etc/passwd", dir).state, "refused");
});

test("an unreadable specification file leaves the receipt PENDING, not HELD", () => {
  // The finding already said "unknown rather than held". The verdict said HELD and
  // settled — the exact contradiction this module exists to prevent.
  const dir = tmpDir();
  write(dir, "tests/a.test.js", "expect(1).toBe(1);\n");
  const receipt = redReceipt(dir, ["tests/a.test.js"]);

  const unreadable = { "tests/a.test.js": { state: "unreadable", sha: null, lines: null, reason: "cannot read: EACCES" } };
  const result = verification.verifyReceipt(receipt, unreadable);

  assert.equal(result.verdict, "PENDING", "a question nobody could answer must not settle");
  assert.equal(result.ok, true, "and it is still not a violation");
});

test("a persisted PENDING verdict does not count as settled", () => {
  const dir = tmpDir();
  write(dir, "tests/a.test.js", "expect(1).toBe(1);\n");
  const pending = { ...redReceipt(dir, ["tests/a.test.js"]), verdict: "PENDING" };
  write(dir, ".claude/tdd-guardian/receipts.json", JSON.stringify({ schemaVersion: 2, receipts: [pending] }));

  const loaded = verification.loadReceipts(dir);
  assert.equal(loaded.store.receipts[0].verdict, null, "PENDING means not judged yet");

  // And verifyAll guards independently, since it is exported.
  const direct = verification.verifyAll({ schemaVersion: 2, receipts: [pending] }, dir, { greenLanes: new Set(["unit"]) });
  assert.equal(direct.reports[0].settled, false);
  assert.equal(direct.reports[0].verdict, "SEPARATION-HELD", "it was actually judged this time");
});

test("a receipt that could never be judged is dropped, not settled as HELD", () => {
  const dir = tmpDir();
  const base = redReceipt(dir, []);
  const cases = [
    [{ ...base, test_files: {} }, /names no specification files/],
    [{ ...base, lane: "" }, /has no lane/],
    [{ ...base, test_files: { "a.test.js": null } }, /malformed fingerprint/],
    [{ ...base, test_files: { "a.test.js": { state: "ok", sha: "x", lines: null } } }, /malformed fingerprint/],
  ];

  for (const [receipt, pattern] of cases) {
    write(dir, ".claude/tdd-guardian/receipts.json", JSON.stringify({ schemaVersion: 2, receipts: [receipt] }));
    const loaded = verification.loadReceipts(dir);
    assert.equal(loaded.store.receipts.length, 0, `should have been dropped: ${pattern}`);
    assert.match(loaded.problems[0], pattern);
    assert.doesNotThrow(() => verification.verifyAll(loaded.store, dir, { greenLanes: new Set(["unit"]) }));
  }
});

test("a store with no schemaVersion or no receipts array is refused", () => {
  const dir = tmpDir();
  write(dir, ".claude/tdd-guardian/receipts.json", JSON.stringify({ receipts: [] }));
  assert.match(verification.loadReceipts(dir).error, /schema v\(absent\)/);

  write(dir, ".claude/tdd-guardian/receipts.json", JSON.stringify({ schemaVersion: 2 }));
  assert.match(verification.loadReceipts(dir).error, /no receipts array/);
});

test("updateReceipts serialises a read-modify-write and releases its lock", () => {
  const dir = tmpDir();
  write(dir, "tests/a.test.js", "x\n");

  verification.updateReceipts(dir, (loaded) => verification.upsertReceipt(loaded.store, redReceipt(dir, ["tests/a.test.js"])));
  verification.updateReceipts(dir, (loaded) =>
    verification.upsertReceipt(loaded.store, { ...redReceipt(dir, ["tests/a.test.js"]), id: "WI-2" })
  );

  assert.equal(verification.loadReceipts(dir).store.receipts.length, 2, "neither write clobbered the other");
  assert.equal(fs.existsSync(path.join(dir, ".claude", "tdd-guardian", ".receipts.lock")), false, "lock released");
});

test("updateReceipts releases its lock even when the mutator throws", () => {
  const dir = tmpDir();
  assert.throws(() =>
    verification.updateReceipts(dir, () => {
      throw new Error("boom");
    })
  );
  assert.equal(fs.existsSync(path.join(dir, ".claude", "tdd-guardian", ".receipts.lock")), false);
});

test("updateReceipts breaks a stale lock rather than deadlocking forever", () => {
  const dir = tmpDir();
  const lock = path.join(dir, ".claude", "tdd-guardian", ".receipts.lock");
  fs.mkdirSync(lock, { recursive: true });
  const old = Date.now() / 1000 - 600;
  fs.utimesSync(lock, old, old);

  write(dir, "tests/a.test.js", "x\n");
  verification.updateReceipts(dir, (loaded) => verification.upsertReceipt(loaded.store, redReceipt(dir, ["tests/a.test.js"])));
  assert.equal(verification.loadReceipts(dir).store.receipts.length, 1);
});

test("a fresh lock held by someone else is waited on, then reported", () => {
  const dir = tmpDir();
  const lock = path.join(dir, ".claude", "tdd-guardian", ".receipts.lock");
  fs.mkdirSync(lock, { recursive: true });

  assert.throws(
    () => verification.updateReceipts(dir, (loaded) => loaded.store),
    /another tdd-guardian process is holding it/,
    "a contended write fails loudly rather than silently dropping data"
  );
  fs.rmdirSync(lock);
});
