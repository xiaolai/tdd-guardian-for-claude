"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const lanes = require("../scripts/tdd-guardian/lib/lanes.js");
const configLib = require("../scripts/tdd-guardian/lib/config.js");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Some tests drive a real repository. Without git they would report as logic
// failures, conflating a missing binary with broken freshness code — the exact
// environment-vs-test-failure distinction lib/exec.js exists to draw. Skip them
// with a stated reason instead, so the gap is visible rather than silent.
const HAS_GIT = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const NO_GIT = "git is not installed — this test exercises real repository state";

function gitTest(name, fn) {
  return test(name, { skip: HAS_GIT ? false : NO_GIT }, fn);
}

function gitRepo() {
  const dir = tmpDir("tddg-git-");
  const run = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run("init", "-q", "--initial-branch=main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "src.js"), "module.exports = 1;\n");
  run("add", ".");
  run("commit", "-q", "-m", "initial");
  return { dir, run };
}

function laneConfig(laneOverrides = [], top = {}) {
  const { config } = configLib.validate({ lanes: laneOverrides, ...top });
  assert.ok(config, "fixture config must be valid");
  return config;
}

// ---------------------------------------------------------------------------
// Command classification
// ---------------------------------------------------------------------------

test("classifyCommand recognises commit-class commands", () => {
  assert.equal(lanes.classifyCommand("git commit -m wip"), "commit");
  assert.equal(lanes.classifyCommand("git commit --amend --no-edit"), "commit");
  assert.equal(lanes.classifyCommand("git -C /repo commit -m x"), "commit");
});

test("classifyCommand recognises push-class commands across ecosystems", () => {
  const pushCommands = [
    "git push origin main",
    "git push --force-with-lease",
    "gh pr create --fill",
    "gh pr merge 42 --squash",
    "npm publish",
    "pnpm publish --access public",
    "cargo publish",
    "poetry publish",
    "twine upload dist/*",
    "gem push mygem-1.0.gem",
    "dotnet nuget push pkg.nupkg",
    "mvn clean deploy",
    "./gradlew publish",
    "mix hex.publish",
  ];
  for (const command of pushCommands) {
    assert.equal(lanes.classifyCommand(command), "push", `expected push for: ${command}`);
  }
});

test("classifyCommand ignores dry runs, which publish nothing", () => {
  assert.equal(lanes.classifyCommand("npm publish --dry-run"), null);
  assert.equal(lanes.classifyCommand("git push --dry-run origin main"), null);
});

test("classifyCommand ignores unrelated commands", () => {
  assert.equal(lanes.classifyCommand("git status"), null);
  assert.equal(lanes.classifyCommand("git log --grep=commit"), null);
  assert.equal(lanes.classifyCommand("ls -la"), null);
  assert.equal(lanes.classifyCommand(""), null);
});

test("classifyCommand does not match a gated word inside quoted text", () => {
  assert.equal(lanes.classifyCommand('echo "git push origin main"'), null);
  assert.equal(lanes.classifyCommand('git commit -m "push to prod"'), "commit");
});

test("classifyCommand inspects every segment of a compound command", () => {
  assert.equal(lanes.classifyCommand("cd repo && git commit -m wip"), "commit");
  // push is the stricter gate, so it wins wherever it appears.
  assert.equal(lanes.classifyCommand("git commit -m wip && git push"), "push");
  // A dry run in one segment must not excuse a real action in another.
  assert.equal(lanes.classifyCommand("npm publish --dry-run && git commit -m x"), "commit");
});

test("classifyCommand resolves absolute paths and leading env assignments", () => {
  assert.equal(lanes.classifyCommand("/usr/bin/git push"), "push");
  assert.equal(lanes.classifyCommand("GIT_AUTHOR_NAME=x git commit -m y"), "commit");
});

// ---------------------------------------------------------------------------
// Lane selection
// ---------------------------------------------------------------------------

const THREE_LANES = [
  { name: "unit", command: "a", gateOn: ["taskCompleted", "commit"] },
  { name: "integration", command: "b", gateOn: ["commit"] },
  { name: "e2e", command: "c", gateOn: ["push"] },
];

test("lanesRequiredFor commit excludes push-only lanes", () => {
  const config = laneConfig(THREE_LANES);
  assert.deepEqual(
    lanes.lanesRequiredFor(config, "commit").map((l) => l.name),
    ["unit", "integration"]
  );
});

test("lanesRequiredFor push subsumes commit", () => {
  const config = laneConfig(THREE_LANES);
  assert.deepEqual(
    lanes.lanesRequiredFor(config, "push").map((l) => l.name),
    ["unit", "integration", "e2e"]
  );
});

test("lanesForTrigger taskCompleted selects only lanes that opted in", () => {
  const config = laneConfig(THREE_LANES);
  assert.deepEqual(
    lanes.lanesForTrigger(config, "taskCompleted").map((l) => l.name),
    ["unit"]
  );
});

test("a manual-only lane is required by no automatic trigger", () => {
  const config = laneConfig([{ name: "load", command: "k6 run", gateOn: ["manual"] }]);
  assert.deepEqual(lanes.lanesRequiredFor(config, "commit"), []);
  assert.deepEqual(lanes.lanesRequiredFor(config, "push"), []);
  assert.deepEqual(lanes.lanesForTrigger(config, "taskCompleted"), []);
  assert.deepEqual(
    lanes.lanesForTrigger(config, "manual").map((l) => l.name),
    ["load"]
  );
});

// ---------------------------------------------------------------------------
// Source-file classification
// ---------------------------------------------------------------------------

test("isSourceFile treats docs and media as non-source", () => {
  for (const file of ["README.md", "docs/guide.mdx", "notes.txt", "logo.svg", "shot.png", "LICENSE"]) {
    assert.equal(lanes.isSourceFile(file), false, `${file} should not be source`);
  }
});

test("isSourceFile treats manifests, lockfiles and configs as source", () => {
  // A dependency bump absolutely can change test outcomes, so these invalidate gates.
  for (const file of ["package.json", "pnpm-lock.yaml", "pyproject.toml", "go.mod", "pom.xml", "Cargo.toml"]) {
    assert.equal(lanes.isSourceFile(file), true, `${file} should be source`);
  }
});

test("isSourceFile treats extensionless scripts as source", () => {
  assert.equal(lanes.isSourceFile("Makefile"), true);
  assert.equal(lanes.isSourceFile("bin/run"), true);
});

test("isSourceFile ignores the gate's own bookkeeping", () => {
  assert.equal(lanes.isSourceFile(".claude/tdd-guardian/state.json"), false);
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

test("migrateState folds a v1 global timestamp into a unit lane", () => {
  const migrated = lanes.migrateState({
    last_gate_passed_at: "2026-01-01T00:00:00.000Z",
    last_head_sha: "abc123def456abc123def456abc123def456abcd",
    last_result: "passed",
    baseline: { branch: "main", coverage: { lines: 80 } },
  });
  assert.equal(migrated.schemaVersion, lanes.STATE_VERSION);
  assert.equal(migrated.lanes.unit.last_passed_at, "2026-01-01T00:00:00.000Z");
  assert.equal(migrated.lanes.unit.last_head_sha, "abc123def456abc123def456abc123def456abcd");
  assert.deepEqual(migrated.baseline, { branch: "main", coverage: { lines: 80 } });
});

test("saveState and loadState round-trip", () => {
  const dir = tmpDir("tddg-state-");
  const state = lanes.emptyState();
  state.lanes.unit = { last_passed_at: "2026-01-01T00:00:00.000Z", last_head_sha: "", last_result: "passed" };
  lanes.saveState(dir, state);
  assert.deepEqual(lanes.loadState(dir).lanes.unit, state.lanes.unit);
});

test("loadState returns an empty state when the file is missing or corrupt", () => {
  const dir = tmpDir("tddg-state-");
  assert.deepEqual(lanes.loadState(dir).lanes, {});

  const file = configLib.statePath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ broken");
  assert.deepEqual(lanes.loadState(dir).lanes, {});
});

test("recordLaneResult keeps the last passing timestamp when a later run fails", () => {
  const state = lanes.emptyState();
  lanes.recordLaneResult(state, "unit", { ok: true, status: "pass", durationMs: 10 }, "sha1");
  const passedAt = state.lanes.unit.last_passed_at;

  lanes.recordLaneResult(state, "unit", { ok: false, status: "fail", durationMs: 5 }, "sha2");
  assert.equal(state.lanes.unit.last_passed_at, passedAt, "a failure must not advance the pass timestamp");
  assert.equal(state.lanes.unit.last_result, "fail");
  assert.equal(state.lanes.unit.last_head_sha, "sha1", "the recorded sha must stay on the last green commit");
});

// ---------------------------------------------------------------------------
// Bootstrap ratchet
// ---------------------------------------------------------------------------

const noTests = { ok: false, status: "no-tests", durationMs: 5, testCounts: null };
const passed = { ok: true, status: "pass", durationMs: 10, testCounts: { total: 4, passed: 4, failed: 0, skipped: 0 } };
const failed = { ok: false, status: "fail", durationMs: 10, testCounts: { total: 4, passed: 3, failed: 1, skipped: 0 } };
const crashed = { ok: false, status: "runner-missing", durationMs: 2, testCounts: null };

test("isBootstrap is true for a lane that has never run", () => {
  assert.equal(lanes.isBootstrap(lanes.emptyState(), "unit"), true);
});

test("a greenfield lane with zero tests records as bootstrap, not as a failure", () => {
  const state = lanes.emptyState();
  const entry = lanes.recordLaneResult(state, "unit", noTests, "sha1");

  assert.equal(entry.last_result, "bootstrap");
  assert.equal(entry.ever_had_tests, false);
  // Freshness must be recorded, or a greenfield repo deadlocks: the commit is
  // blocked on a gate that can never pass until a test exists.
  assert.ok(entry.last_passed_at, "bootstrap must record freshness");
  assert.equal(entry.last_head_sha, "sha1");
});

test("a passing run flips the ratchet", () => {
  const state = lanes.emptyState();
  lanes.recordLaneResult(state, "unit", passed, "sha1");
  assert.equal(state.lanes.unit.ever_had_tests, true);
  assert.equal(lanes.isBootstrap(state, "unit"), false);
});

test("a failing run also proves tests exist and flips the ratchet", () => {
  const state = lanes.emptyState();
  lanes.recordLaneResult(state, "unit", failed, "sha1");
  assert.equal(state.lanes.unit.ever_had_tests, true, "tests that fail are still tests");
});

test("an environment failure leaves the ratchet untouched", () => {
  // A missing runner proves nothing either way about whether tests exist.
  const state = lanes.emptyState();
  lanes.recordLaneResult(state, "unit", crashed, "sha1");
  assert.equal(state.lanes.unit.ever_had_tests, false);
});

test("the ratchet is one-way — deleting every test does not restore bootstrap", () => {
  const state = lanes.emptyState();
  lanes.recordLaneResult(state, "unit", passed, "sha1");
  const entry = lanes.recordLaneResult(state, "unit", noTests, "sha2");

  assert.equal(entry.last_result, "no-tests", "a zero-test run after tests existed is a regression");
  assert.equal(entry.ever_had_tests, true, "the ratchet must not reset");
  assert.equal(entry.last_head_sha, "sha1", "a regression must not advance the green sha");
});

test("bootstrap survives a reload from disk", () => {
  const dir = tmpDir("tddg-boot-");
  const state = lanes.emptyState();
  lanes.recordLaneResult(state, "unit", passed, "sha1");
  lanes.saveState(dir, state);

  assert.equal(lanes.isBootstrap(lanes.loadState(dir), "unit"), false);
});

test("a v1 state migrates into bootstrap, since it recorded no test counts", () => {
  // Conservative on purpose: an upgrading project gets one loud warning rather
  // than a hard block it cannot explain.
  const migrated = lanes.migrateState({ last_gate_passed_at: "2026-01-01T00:00:00.000Z", last_result: "passed" });
  assert.equal(lanes.isBootstrap(migrated, "unit"), true);
});

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

test("isLaneFresh rejects a lane that has never passed", () => {
  const config = laneConfig(THREE_LANES);
  const result = lanes.isLaneFresh(lanes.emptyState(), "unit", config, os.tmpdir());
  assert.equal(result.fresh, false);
  assert.match(result.reason, /never passed/);
});

test("isLaneFresh accepts a pass inside the freshness window", () => {
  const config = laneConfig(THREE_LANES, { gateFreshnessMinutes: 120 });
  const state = lanes.emptyState();
  state.lanes.unit = { last_passed_at: new Date(Date.now() - 60000).toISOString(), last_head_sha: "" };

  const result = lanes.isLaneFresh(state, "unit", config, os.tmpdir());
  assert.equal(result.fresh, true);
});

test("isLaneFresh rejects an expired pass when smart staleness is off", () => {
  const config = laneConfig(THREE_LANES, { gateFreshnessMinutes: 10, smartStaleness: false });
  const state = lanes.emptyState();
  state.lanes.unit = { last_passed_at: new Date(Date.now() - 3600000).toISOString(), last_head_sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" };

  const result = lanes.isLaneFresh(state, "unit", config, os.tmpdir());
  assert.equal(result.fresh, false);
  assert.match(result.reason, /older than 10 min/);
});

test("isLaneFresh rejects a lane whose state timestamp is unparseable", () => {
  const config = laneConfig(THREE_LANES);
  const state = lanes.emptyState();
  state.lanes.unit = { last_passed_at: "not-a-date" };
  assert.equal(lanes.isLaneFresh(state, "unit", config, os.tmpdir()).fresh, false);
});

test("checkFreshness lists every stale lane required for the action", () => {
  const config = laneConfig(THREE_LANES, { gateFreshnessMinutes: 120 });
  const state = lanes.emptyState();
  state.lanes.unit = { last_passed_at: new Date().toISOString(), last_head_sha: "" };

  const commit = lanes.checkFreshness(config, state, "commit", os.tmpdir());
  assert.equal(commit.ok, false);
  assert.deepEqual(commit.stale.map((s) => s.name), ["integration"]);
  assert.deepEqual(commit.fresh.map((s) => s.name), ["unit"]);

  const push = lanes.checkFreshness(config, state, "push", os.tmpdir());
  assert.deepEqual(push.stale.map((s) => s.name), ["integration", "e2e"]);
});

// ---------------------------------------------------------------------------
// Smart staleness against a real repository
// ---------------------------------------------------------------------------

gitTest("hasSourceChangedSince is false when nothing changed", () => {
  const { dir, run } = gitRepo();
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  assert.equal(lanes.hasSourceChangedSince(sha, dir), false);
  run("status");
});

gitTest("hasSourceChangedSince detects a committed source change", () => {
  const { dir, run } = gitRepo();
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(dir, "src.js"), "module.exports = 2;\n");
  run("add", ".");
  run("commit", "-q", "-m", "change");
  assert.equal(lanes.hasSourceChangedSince(sha, dir), true);
});

gitTest("hasSourceChangedSince detects an UNCOMMITTED source change", () => {
  // Committed-only checking left a stale gate looking fresh while the working
  // tree had already diverged.
  const { dir } = gitRepo();
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(dir, "src.js"), "module.exports = 3;\n");
  assert.equal(lanes.hasSourceChangedSince(sha, dir), true);
});

gitTest("hasSourceChangedSince detects a new untracked source file", () => {
  const { dir } = gitRepo();
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(dir, "extra.js"), "module.exports = 4;\n");
  assert.equal(lanes.hasSourceChangedSince(sha, dir), true);
});

gitTest("hasSourceChangedSince ignores a docs-only change", () => {
  const { dir } = gitRepo();
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(dir, "NOTES.md"), "# notes\n");
  assert.equal(lanes.hasSourceChangedSince(sha, dir), false);
});

test("hasSourceChangedSince fails closed on an unusable sha or a non-repo", () => {
  assert.equal(lanes.hasSourceChangedSince("", os.tmpdir()), true);
  assert.equal(lanes.hasSourceChangedSince("not-a-sha", os.tmpdir()), true);
  assert.equal(lanes.hasSourceChangedSince("abc123def456abc123def456abc123def456abcd", tmpDir("tddg-nogit-")), true);
});

gitTest("smart staleness keeps an expired gate fresh when no source changed", () => {
  const { dir } = gitRepo();
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  const config = laneConfig(THREE_LANES, { gateFreshnessMinutes: 1, smartStaleness: true });
  const state = lanes.emptyState();
  state.lanes.unit = { last_passed_at: new Date(Date.now() - 3600000).toISOString(), last_head_sha: sha };

  const result = lanes.isLaneFresh(state, "unit", config, dir);
  assert.equal(result.fresh, true);
  assert.match(result.reason, /no source changed since/);
});

gitTest("smart staleness expires the gate once source changes", () => {
  const { dir } = gitRepo();
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(dir, "src.js"), "module.exports = 9;\n");

  const config = laneConfig(THREE_LANES, { gateFreshnessMinutes: 1, smartStaleness: true });
  const state = lanes.emptyState();
  state.lanes.unit = { last_passed_at: new Date(Date.now() - 3600000).toISOString(), last_head_sha: sha };

  const result = lanes.isLaneFresh(state, "unit", config, dir);
  assert.equal(result.fresh, false);
  assert.match(result.reason, /source has changed since/);
});

// ---------------------------------------------------------------------------
// Lane execution
// ---------------------------------------------------------------------------

test("runLane passes a green lane and records duration", () => {
  const config = laneConfig([{ name: "unit", command: 'echo "Tests  3 passed (3)"' }]);
  const result = lanes.runLane(config.lanes[0], os.tmpdir());
  assert.equal(result.ok, true);
  assert.equal(result.status, "pass");
  assert.deepEqual(result.testCounts, { failed: 0, passed: 3, skipped: 0, total: 3 });
  assert.ok(result.durationMs >= 0);
});

test("runLane reports which phase failed", () => {
  const config = laneConfig([{ name: "e2e", command: "echo never", setupCommand: "exit 1" }]);
  const result = lanes.runLane(config.lanes[0], os.tmpdir());
  assert.equal(result.ok, false);
  assert.equal(result.phase, "setup");
});

test("runLane runs teardown even when the lane fails, without masking the verdict", () => {
  const dir = tmpDir("tddg-lane-");
  const marker = path.join(dir, "torn-down");
  const config = laneConfig([
    { name: "e2e", command: "exit 1", setupCommand: "true", teardownCommand: `touch ${JSON.stringify(marker)}` },
  ]);

  const result = lanes.runLane(config.lanes[0], dir);
  assert.equal(result.ok, false, "the lane verdict must survive a successful teardown");
  assert.equal(fs.existsSync(marker), true, "teardown must run after a failure");
});

test("runLane surfaces a failing teardown as a warning, not as the verdict", () => {
  const config = laneConfig([{ name: "e2e", command: "true", teardownCommand: "exit 7" }]);
  const result = lanes.runLane(config.lanes[0], os.tmpdir());
  assert.equal(result.ok, true);
  assert.match(result.teardownWarning, /Teardown failed/);
});

test("runLane treats a zero-test run as a failure", () => {
  const config = laneConfig([{ name: "unit", command: 'echo "no test files found"' }]);
  const result = lanes.runLane(config.lanes[0], os.tmpdir());
  assert.equal(result.ok, false);
  assert.equal(result.status, "no-tests");
});

test("runLane parses the coverage report of a coverage lane", () => {
  const dir = tmpDir("tddg-lane-cov-");
  const summary = {
    total: {
      lines: { total: 10, covered: 9, pct: 90 },
      functions: { total: 2, covered: 2, pct: 100 },
      branches: { total: 4, covered: 3, pct: 75 },
      statements: { total: 10, covered: 9, pct: 90 },
    },
  };
  const config = laneConfig([
    {
      name: "unit",
      command: `printf '%s' ${JSON.stringify(JSON.stringify(summary))} > coverage.json && echo "Tests  1 passed (1)"`,
      coverage: "include",
      coverageSummaryPath: "coverage.json",
    },
  ]);

  const result = lanes.runLane(config.lanes[0], dir);
  assert.equal(result.ok, true);
  assert.equal(result.coverageReport.format, "istanbul-summary");
  assert.equal(result.coverageReport.totals.lines.pct, 90);
});

test("runLane fails a coverage lane whose report never appeared", () => {
  const dir = tmpDir("tddg-lane-cov-");
  const config = laneConfig([
    { name: "unit", command: 'echo "Tests  1 passed (1)"', coverage: "include", coverageSummaryPath: "coverage.json" },
  ]);

  const result = lanes.runLane(config.lanes[0], dir);
  assert.equal(result.ok, false);
  assert.equal(result.status, "coverage-missing");
  assert.match(result.coverageError, /Coverage summary not found/);
});

test("describeResult summarises a lane in one line", () => {
  const config = laneConfig([{ name: "unit", command: 'echo "Tests  3 passed (3)"' }]);
  const result = lanes.runLane(config.lanes[0], os.tmpdir());
  assert.match(lanes.describeResult(result), /^unit: PASS \(3 passed, 0 failed, 0 skipped\) in \d+\.\ds$/);
});
