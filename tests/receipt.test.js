"use strict";
// The red-receipt CLI is driven exactly as an agent drives it: argv in, exit code
// and stderr out, receipts.json on disk.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");

const receiptLib = require("../scripts/tdd-guardian/receipt.js");

const RECEIPT = path.join(__dirname, "..", "scripts", "tdd-guardian", "receipt.js");

// `record` reads the working tree through git to find the specification files.
// Without git this would report as a logic failure rather than the environment
// gap it is.
const HAS_GIT = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const NO_GIT = "git is not installed — the CLI discovers specification files through the working tree";

function gitTest(name, fn) {
  return test(name, { skip: HAS_GIT ? false : NO_GIT }, fn);
}

const RED_LANE = 'echo "Tests  1 failed | 0 passed (1)" && exit 1';
const GREEN_LANE = 'echo "Tests  1 passed (1)"';

function repo(laneCommand, configOverrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tddg-receipt-"));
  const run = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run("init", "-q", "--initial-branch=main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "src.js"), "module.exports = 1;\n");
  run("add", ".");
  run("commit", "-q", "-m", "initial");

  fs.mkdirSync(path.join(dir, ".claude", "tdd-guardian"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".claude", "tdd-guardian", "config.json"),
    JSON.stringify(
      { enabled: true, lanes: [{ name: "unit", command: laneCommand, gateOn: ["taskCompleted"] }], ...configOverrides },
      null,
      2
    )
  );
  return dir;
}

function cli(dir, args) {
  const result = spawnSync(process.execPath, [RECEIPT, ...args, "--cwd", dir], { encoding: "utf8", timeout: 60000 });
  return { exitCode: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function receipts(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, ".claude", "tdd-guardian", "receipts.json"), "utf8"));
}

function writeTest(dir, content) {
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tests", "charge.test.js"), content);
}

function receiptsExist(dir) {
  return fs.existsSync(path.join(dir, ".claude", "tdd-guardian", "receipts.json"));
}

// ---------------------------------------------------------------------------
// Argument parsing — a permissive parser records the wrong thing convincingly
// ---------------------------------------------------------------------------

test("a flag missing its value is an error, not the boolean true", () => {
  // `--id` with no value used to become the literal work-item id "true".
  const { errors } = receiptLib.parseArgs(["record", "--id"]);
  assert.match(errors[0], /needs a value/);
});

test("a flag followed by another flag does not swallow it as a value", () => {
  const { errors } = receiptLib.parseArgs(["record", "--id", "--json"]);
  assert.match(errors[0], /needs a value/);
});

test("an unknown flag is rejected rather than ignored", () => {
  const { errors } = receiptLib.parseArgs(["record", "--identify", "WI-1"]);
  assert.match(errors[0], /Unknown option/);
});

test("a repeated flag is rejected rather than silently last-wins", () => {
  const { errors } = receiptLib.parseArgs(["record", "--id", "a", "--id", "b"]);
  assert.match(errors[0], /more than once/);
});

test("an inline value splits at the first equals only", () => {
  const { args, errors } = receiptLib.parseArgs(["record", "--files=a=b.test.js"]);
  assert.deepEqual(errors, []);
  assert.equal(args.files, "a=b.test.js");
});

test("control characters are stripped from anything echoed", () => {
  const esc = String.fromCharCode(27);
  assert.equal(receiptLib.clean(`WI-1${esc}[31mFAKE`), "WI-1?[31mFAKE");
  assert.equal(receiptLib.ID_RE.test(`WI-1${esc}`), false);
  assert.equal(receiptLib.ID_RE.test("WI-1"), true);
});

// ---------------------------------------------------------------------------
// record
// ---------------------------------------------------------------------------

gitTest("record captures a counted red and the files it is evidence for", () => {
  const dir = repo(RED_LANE);
  writeTest(dir, "expect(charge(100)).toBe(100);\n");

  const { exitCode, stderr } = cli(dir, ["record", "--id", "WI-1"]);
  assert.equal(exitCode, 0, stderr);

  const store = receipts(dir);
  assert.equal(store.receipts[0].red.kind, "assertion-failure");
  assert.deepEqual(Object.keys(store.receipts[0].test_files), ["tests/charge.test.js"]);
});

gitTest("record refuses when no test file changed, because the receipt would certify nothing", () => {
  const dir = repo(RED_LANE);
  fs.writeFileSync(path.join(dir, "src.js"), "module.exports = 2;\n");

  const { exitCode, stderr } = cli(dir, ["record", "--id", "WI-1"]);
  assert.equal(exitCode, 1);
  assert.match(stderr, /no new or modified test files/);
  assert.equal(receiptsExist(dir), false);
});

gitTest("record refuses when the plugin is disabled", () => {
  // Running the repository's test command is the most consequential thing the CLI
  // does; a project that switched the plugin off has withdrawn consent for it.
  const dir = repo(RED_LANE, { enabled: false });
  writeTest(dir, "expect(1).toBe(2);\n");

  const { exitCode, stderr } = cli(dir, ["record", "--id", "WI-1"]);
  assert.equal(exitCode, 1);
  assert.match(stderr, /disabled for this project/);
  assert.equal(receiptsExist(dir), false);
});

gitTest("record refuses to guess when several lanes gate taskCompleted", () => {
  const dir = repo(RED_LANE, {
    lanes: [
      { name: "unit", command: RED_LANE, gateOn: ["taskCompleted"] },
      { name: "integration", command: RED_LANE, gateOn: ["taskCompleted"] },
    ],
  });
  writeTest(dir, "expect(1).toBe(2);\n");

  const { exitCode, stderr } = cli(dir, ["record", "--id", "WI-1"]);
  assert.equal(exitCode, 1);
  assert.match(stderr, /2 lanes are bound to taskCompleted/);
  assert.match(stderr, /Pass --lane/);
});

gitTest("record accepts an explicit lane when the choice is ambiguous", () => {
  const dir = repo(RED_LANE, {
    lanes: [
      { name: "unit", command: RED_LANE, gateOn: ["taskCompleted"] },
      { name: "integration", command: RED_LANE, gateOn: ["taskCompleted"] },
    ],
  });
  writeTest(dir, "expect(1).toBe(2);\n");

  assert.equal(cli(dir, ["record", "--id", "WI-1", "--lane", "integration"]).exitCode, 0);
  assert.equal(receipts(dir).receipts[0].lane, "integration");
});

gitTest("record refuses a path outside the workspace", () => {
  const dir = repo(RED_LANE);
  writeTest(dir, "expect(1).toBe(2);\n");

  const { exitCode, stderr } = cli(dir, ["record", "--id", "WI-1", "--files", "../../../etc/passwd"]);
  assert.equal(exitCode, 1);
  assert.match(stderr, /not usable evidence/);
  assert.match(stderr, /absolute|escapes the workspace/);
});

gitTest("record refuses a missing --files entry rather than fingerprinting it as null", () => {
  const dir = repo(RED_LANE);
  writeTest(dir, "expect(1).toBe(2);\n");

  const { exitCode, stderr } = cli(dir, ["record", "--id", "WI-1", "--files", "tests/nope.test.js"]);
  assert.equal(exitCode, 1);
  assert.match(stderr, /not usable evidence/);
  assert.match(stderr, /does not exist/);
});

gitTest("record refuses when the lane rewrites a specification file mid-run", () => {
  // A formatter or generator running inside the lane would otherwise become the
  // baseline, erasing the change from the record entirely.
  const rewriting = 'printf "expect(1).toBe(99);\\n" > tests/charge.test.js && echo "Tests  1 failed | 0 passed (1)" && exit 1';
  const dir = repo(rewriting);
  writeTest(dir, "expect(charge(100)).toBe(100);\n");

  const { exitCode, stderr } = cli(dir, ["record", "--id", "WI-1"]);
  assert.equal(exitCode, 1);
  assert.match(stderr, /changed while the lane was running/);
  assert.equal(receiptsExist(dir), false);
});

gitTest("record stores a green run but exits non-zero, so a false red is never silent", () => {
  const dir = repo(GREEN_LANE);
  writeTest(dir, "expect(true).toBe(true);\n");

  const { exitCode, stderr } = cli(dir, ["record", "--id", "WI-1"]);
  assert.equal(exitCode, 1);
  assert.match(stderr, /NOT A VALID RED \(green\)/);
  assert.equal(receipts(dir).receipts[0].red.kind, "green");
});

gitTest("an invalid re-record does not destroy a valid receipt", () => {
  const dir = repo(RED_LANE);
  writeTest(dir, "expect(charge(100)).toBe(100);\n");
  assert.equal(cli(dir, ["record", "--id", "WI-1"]).exitCode, 0);

  // Same id, but now the lane passes — an accidental rerun must not overwrite
  // good evidence with an attempt that proves nothing.
  fs.writeFileSync(
    path.join(dir, ".claude", "tdd-guardian", "config.json"),
    JSON.stringify({ enabled: true, lanes: [{ name: "unit", command: GREEN_LANE, gateOn: ["taskCompleted"] }] })
  );
  const { exitCode, stderr } = cli(dir, ["record", "--id", "WI-1"]);

  assert.equal(exitCode, 1);
  assert.match(stderr, /Refusing to overwrite the existing valid receipt/);
  assert.equal(receipts(dir).receipts[0].red.kind, "assertion-failure", "the good receipt survived");
});

gitTest("record surfaces non-test files that were already modified", () => {
  const dir = repo(RED_LANE);
  writeTest(dir, "expect(charge(100)).toBe(100);\n");
  fs.writeFileSync(path.join(dir, "src.js"), "module.exports = 2;\n");

  const { exitCode, stderr } = cli(dir, ["record", "--id", "WI-1"]);
  assert.equal(exitCode, 0);
  assert.match(stderr, /non-test file\(s\) were already modified/);
  assert.deepEqual(receipts(dir).receipts[0].dirty_source, ["src.js"]);
});

gitTest("record rejects an id carrying control characters", () => {
  const dir = repo(RED_LANE);
  writeTest(dir, "expect(1).toBe(2);\n");

  const { exitCode, stderr } = cli(dir, ["record", "--id", `WI-1${String.fromCharCode(27)}[31m`]);
  assert.equal(exitCode, 1);
  assert.match(stderr, /Invalid --id/);
});

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

gitTest("verify leaves a receipt PENDING while its lane is still red", () => {
  // Settling here would bank a verdict about a red-to-green transition that has
  // not happened, and the real one would never be examined.
  const dir = repo(RED_LANE);
  writeTest(dir, "expect(charge(100)).toBe(100);\n");
  assert.equal(cli(dir, ["record", "--id", "WI-1"]).exitCode, 0);

  const { exitCode, stderr } = cli(dir, ["verify"]);
  assert.equal(exitCode, 0);
  assert.match(stderr, /PENDING — lane not green/);
  assert.equal(receipts(dir).receipts[0].verdict, null, "a pending receipt must not settle");
});

gitTest("verify holds once the lane is green and nothing moved", () => {
  const dir = repo(RED_LANE);
  writeTest(dir, "expect(charge(100)).toBe(100);\n");
  assert.equal(cli(dir, ["record", "--id", "WI-1"]).exitCode, 0);

  fs.writeFileSync(
    path.join(dir, ".claude", "tdd-guardian", "config.json"),
    JSON.stringify({ enabled: true, lanes: [{ name: "unit", command: GREEN_LANE, gateOn: ["taskCompleted"] }] })
  );

  const { exitCode, stderr } = cli(dir, ["verify"]);
  assert.equal(exitCode, 0);
  assert.match(stderr, /Specification held for WI-1/);
  assert.equal(receipts(dir).receipts[0].verdict, "SEPARATION-HELD");
});

gitTest("verify fails when a recorded line was edited on the way to green", () => {
  const dir = repo(RED_LANE);
  writeTest(dir, "expect(charge(100)).toBe(100);\n");
  assert.equal(cli(dir, ["record", "--id", "WI-1"]).exitCode, 0);

  writeTest(dir, "expect(charge(100)).toBeGreaterThan(0);\n");
  fs.writeFileSync(
    path.join(dir, ".claude", "tdd-guardian", "config.json"),
    JSON.stringify({ enabled: true, lanes: [{ name: "unit", command: GREEN_LANE, gateOn: ["taskCompleted"] }] })
  );

  const { exitCode, stderr } = cli(dir, ["verify"]);
  assert.equal(exitCode, 1);
  assert.match(stderr, /separation broken/i);
  assert.equal(receipts(dir).receipts[0].verdict, "SEPARATION-BROKEN");
});

gitTest("verify holds when a case is ADDED to a recorded file", () => {
  // Adding cases while implementing is documented as healthy; a whole-file hash
  // alone reported it as the specification moving.
  const dir = repo(RED_LANE);
  writeTest(dir, "expect(charge(100)).toBe(100);\n");
  assert.equal(cli(dir, ["record", "--id", "WI-1"]).exitCode, 0);

  writeTest(dir, "expect(charge(100)).toBe(100);\nexpect(charge(0)).toThrow();\n");
  fs.writeFileSync(
    path.join(dir, ".claude", "tdd-guardian", "config.json"),
    JSON.stringify({ enabled: true, lanes: [{ name: "unit", command: GREEN_LANE, gateOn: ["taskCompleted"] }] })
  );

  const { exitCode } = cli(dir, ["verify"]);
  assert.equal(exitCode, 0);
  assert.equal(receipts(dir).receipts[0].verdict, "SEPARATION-HELD");
});

gitTest("verify refuses to run against a corrupt store rather than reporting no receipts", () => {
  const dir = repo(GREEN_LANE);
  fs.writeFileSync(path.join(dir, ".claude", "tdd-guardian", "receipts.json"), "{ not json");

  const { exitCode, stderr } = cli(dir, ["verify"]);
  assert.equal(exitCode, 1);
  assert.match(stderr, /not valid JSON/);
});

test("verify with no receipts reports unverified and exits clean", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tddg-receipt-bare-"));
  fs.mkdirSync(path.join(dir, ".claude", "tdd-guardian"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".claude", "tdd-guardian", "config.json"),
    JSON.stringify({ enabled: true, lanes: [{ name: "unit", command: "true", gateOn: ["taskCompleted"] }] })
  );

  const { exitCode, stderr } = cli(dir, ["verify"]);
  assert.equal(exitCode, 0);
  assert.match(stderr, /unverified, not violated/);
});

// ---------------------------------------------------------------------------
// show and usage
// ---------------------------------------------------------------------------

gitTest("show lists each receipt with its verdict", () => {
  const dir = repo(RED_LANE);
  writeTest(dir, "expect(charge(100)).toBe(100);\n");
  cli(dir, ["record", "--id", "WI-1"]);

  const out = cli(dir, ["show"]).stdout;
  assert.match(out, /WI-1 \[unit\] assertion-failure/);
  assert.match(out, /verdict: unverified/);
});

test("an unknown subcommand prints usage and exits non-zero", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tddg-receipt-usage-"));
  const { exitCode, stderr } = cli(dir, ["frobnicate"]);
  assert.equal(exitCode, 1);
  assert.match(stderr, /Usage:/);
});

test("record without --id refuses rather than inventing a work item name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tddg-receipt-noid-"));
  const { exitCode, stderr } = cli(dir, ["record"]);
  assert.equal(exitCode, 1);
  assert.match(stderr, /Missing --id/);
});
