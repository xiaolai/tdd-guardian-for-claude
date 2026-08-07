"use strict";
// Integration tests: the hook scripts are driven exactly as Claude Code drives
// them — a JSON payload on stdin, a JSON decision on stdout.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PRETOOL = path.join(__dirname, "..", "scripts", "tdd-guardian", "pretool_guard.js");
const TASKCOMPLETED = path.join(__dirname, "..", "scripts", "tdd-guardian", "taskcompleted_gate.js");

function workspace(config, state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tddg-hook-"));
  const base = path.join(dir, ".claude", "tdd-guardian");
  fs.mkdirSync(base, { recursive: true });
  if (config !== undefined) {
    fs.writeFileSync(path.join(base, "config.json"), typeof config === "string" ? config : JSON.stringify(config, null, 2));
  }
  if (state !== undefined) {
    fs.writeFileSync(path.join(base, "state.json"), JSON.stringify(state, null, 2));
  }
  return dir;
}

function readState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, ".claude", "tdd-guardian", "state.json"), "utf8"));
}

function runHook(script, payload, env = {}) {
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60000,
  });

  const stdout = (result.stdout || "").trim();
  let decision = null;
  if (stdout) {
    try {
      decision = JSON.parse(stdout);
    } catch {
      decision = { parseError: stdout };
    }
  }
  return { decision, stdout, stderr: result.stderr || "", exitCode: result.status };
}

const bashPayload = (cwd, command) => ({ tool_name: "Bash", tool_input: { command }, cwd });

const FRESH = () => new Date().toISOString();
const STALE = () => new Date(Date.now() - 86400000).toISOString();

const UNIT_AND_E2E = [
  { name: "unit", command: "true", gateOn: ["taskCompleted", "commit"] },
  { name: "e2e", command: "true", gateOn: ["push"] },
];

// ---------------------------------------------------------------------------
// PreToolUse
// ---------------------------------------------------------------------------

test("pretool: an uninitialised project is never blocked", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tddg-bare-"));
  const { decision } = runHook(PRETOOL, bashPayload(dir, "git commit -m x"));
  assert.equal(decision, null, "no config means no opinion");
});

test("pretool: non-Bash tools are ignored", () => {
  const dir = workspace({ enabled: true, blockCommitWithoutFreshGate: true, lanes: UNIT_AND_E2E });
  const { decision } = runHook(PRETOOL, { tool_name: "Read", tool_input: { file_path: "/x" }, cwd: dir });
  assert.equal(decision, null);
});

test("pretool: ungated commands pass through untouched", () => {
  const dir = workspace({ enabled: true, blockCommitWithoutFreshGate: true, lanes: UNIT_AND_E2E });
  const { decision } = runHook(PRETOOL, bashPayload(dir, "git status"));
  assert.equal(decision, null);
});

test("pretool: a stale gate denies the commit", () => {
  const dir = workspace(
    { enabled: true, blockCommitWithoutFreshGate: true, smartStaleness: false, lanes: UNIT_AND_E2E },
    { schemaVersion: 2, lanes: { unit: { last_passed_at: STALE(), last_head_sha: "" } } }
  );

  const { decision } = runHook(PRETOOL, bashPayload(dir, "git commit -m x"));
  assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /Stale lanes:/);
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /• unit/);
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /tdd-guardian:gate commit/);
});

test("pretool: staleGateAction warn allows with a warning instead of denying", () => {
  const dir = workspace(
    { enabled: true, blockCommitWithoutFreshGate: true, staleGateAction: "warn", smartStaleness: false, lanes: UNIT_AND_E2E },
    { schemaVersion: 2, lanes: {} }
  );

  const { decision } = runHook(PRETOOL, bashPayload(dir, "git commit -m x"));
  assert.equal(decision.hookSpecificOutput.permissionDecision, "allow");
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /TDD Guardian warning/);
});

test("pretool: a fresh gate allows the commit", () => {
  const dir = workspace(
    { enabled: true, blockCommitWithoutFreshGate: true, lanes: UNIT_AND_E2E },
    { schemaVersion: 2, lanes: { unit: { last_passed_at: FRESH(), last_head_sha: "" } } }
  );

  const { decision } = runHook(PRETOOL, bashPayload(dir, "git commit -m x"));
  assert.equal(decision, null);
});

test("pretool: a stale push-only lane does not block a commit", () => {
  // This is the whole point of lanes: a slow e2e suite must not gate every commit.
  const dir = workspace(
    { enabled: true, blockCommitWithoutFreshGate: true, lanes: UNIT_AND_E2E },
    { schemaVersion: 2, lanes: { unit: { last_passed_at: FRESH(), last_head_sha: "" } } }
  );

  assert.equal(runHook(PRETOOL, bashPayload(dir, "git commit -m x")).decision, null);
});

test("pretool: a stale push-only lane does block a push", () => {
  const dir = workspace(
    { enabled: true, blockCommitWithoutFreshGate: true, lanes: UNIT_AND_E2E },
    { schemaVersion: 2, lanes: { unit: { last_passed_at: FRESH(), last_head_sha: "" } } }
  );

  const { decision } = runHook(PRETOOL, bashPayload(dir, "git push origin main"));
  assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /• e2e/);
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /Fresh lanes:[\s\S]*• unit/);
});

test("pretool: the bypass env var allows everything", () => {
  const dir = workspace(
    { enabled: true, blockCommitWithoutFreshGate: true, bypassEnv: "TDD_HOOK_TEST_BYPASS", lanes: UNIT_AND_E2E },
    { schemaVersion: 2, lanes: {} }
  );

  const { decision } = runHook(PRETOOL, bashPayload(dir, "git push"), { TDD_HOOK_TEST_BYPASS: "1" });
  assert.equal(decision, null);
});

test("pretool: blockCommitWithoutFreshGate=false disables the check", () => {
  const dir = workspace({ enabled: true, blockCommitWithoutFreshGate: false, lanes: UNIT_AND_E2E }, { schemaVersion: 2, lanes: {} });
  assert.equal(runHook(PRETOOL, bashPayload(dir, "git commit -m x")).decision, null);
});

test("pretool: an invalid config denies only when the project asked to be blocked", () => {
  const enforcing = workspace({ enabled: true, blockCommitWithoutFreshGate: true, lanes: [{ name: "unit" }] });
  const denied = runHook(PRETOOL, bashPayload(enforcing, "git commit -m x"));
  assert.equal(denied.decision.hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied.decision.hookSpecificOutput.permissionDecisionReason, /config is invalid/);

  const passive = workspace({ enabled: true, blockCommitWithoutFreshGate: false, lanes: [{ name: "unit" }] });
  assert.equal(runHook(PRETOOL, bashPayload(passive, "git commit -m x")).decision, null);
});

test("pretool: a v1 config still gates after migration", () => {
  const dir = workspace(
    {
      enabled: true,
      blockCommitWithoutFreshGate: true,
      smartStaleness: false,
      testCommand: "pnpm test",
      coverageCommand: "pnpm test -- --coverage",
      coverageSummaryPath: "coverage/coverage-summary.json",
    },
    { last_gate_passed_at: STALE(), last_head_sha: "", last_result: "passed" }
  );

  const { decision } = runHook(PRETOOL, bashPayload(dir, "git commit -m x"));
  assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /• unit/);
});

// ---------------------------------------------------------------------------
// TaskCompleted
// ---------------------------------------------------------------------------

test("taskcompleted: does nothing when enforcement is off", () => {
  const dir = workspace({ enabled: true, enforceOnTaskCompleted: false, lanes: UNIT_AND_E2E });
  const { decision } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision, null);
});

test("taskcompleted: runs the taskCompleted lanes and records per-lane state", () => {
  const dir = workspace({
    enabled: true,
    enforceOnTaskCompleted: true,
    coverageThresholds: { lines: 0, functions: 0, branches: 0, statements: 0 },
    lanes: [{ name: "unit", command: 'echo "Tests  4 passed (4)"', gateOn: ["taskCompleted"] }],
  });

  const { decision } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision, null, "a green run must not block");

  const state = readState(dir);
  assert.equal(state.lanes.unit.last_result, "passed");
  assert.ok(state.lanes.unit.last_passed_at);
  assert.equal(state.last_result, "passed");
});

test("taskcompleted: a failing lane blocks and names the phase", () => {
  const dir = workspace({
    enabled: true,
    enforceOnTaskCompleted: true,
    coverageThresholds: { lines: 0, functions: 0, branches: 0, statements: 0 },
    lanes: [{ name: "unit", command: 'echo "Tests  1 failed | 2 passed (3)"; exit 1', gateOn: ["taskCompleted"] }],
  });

  const { decision } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /Lane 'unit' failed/);
  assert.match(decision.hookSpecificOutput.additionalContext, /failed at the command phase/);
  assert.match(decision.hookSpecificOutput.additionalContext, /1 passed, 2 failed|2 passed, 1 failed/);
  assert.equal(readState(dir).lanes.unit.last_result, "fail");
});

test("taskcompleted: an environment failure is called out as such", () => {
  const dir = workspace({
    enabled: true,
    enforceOnTaskCompleted: true,
    coverageThresholds: { lines: 0, functions: 0, branches: 0, statements: 0 },
    lanes: [{ name: "unit", command: 'echo "Error: Cannot find module \'vitest\'" >&2; exit 1', gateOn: ["taskCompleted"] }],
  });

  const { decision } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision.decision, "block");
  assert.match(decision.hookSpecificOutput.additionalContext, /environment failure, not a test failure/);
});

test("taskcompleted: coverage below threshold blocks with the deltas", () => {
  const summary = JSON.stringify({
    total: {
      lines: { total: 10, covered: 8, pct: 80 },
      functions: { total: 2, covered: 2, pct: 100 },
      branches: { total: 2, covered: 2, pct: 100 },
      statements: { total: 10, covered: 8, pct: 80 },
    },
  });

  const dir = workspace({
    enabled: true,
    enforceOnTaskCompleted: true,
    coverageThresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    lanes: [
      {
        name: "unit",
        command: `printf '%s' ${JSON.stringify(summary)} > coverage.json && echo "Tests  1 passed (1)"`,
        gateOn: ["taskCompleted"],
        coverage: "include",
        coverageSummaryPath: "coverage.json",
      },
    ],
  });

  const { decision } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision.decision, "block");
  assert.equal(decision.reason, "Coverage gate failed");
  assert.match(decision.hookSpecificOutput.additionalContext, /lines: 80\.00% < 100\.00% \(8\/10\)/);
  assert.equal(readState(dir).coverage.status, "FAIL");
});

test("taskcompleted: a coverage report that measured nothing blocks instead of scoring 100%", () => {
  // 0/0 is 100% by convention, so a silent no-op coverage run would otherwise pass.
  const empty = JSON.stringify({ total: { lines: { total: 0, covered: 0, pct: 100 }, statements: { total: 0, covered: 0, pct: 100 } } });

  const dir = workspace({
    enabled: true,
    enforceOnTaskCompleted: true,
    lanes: [
      {
        name: "unit",
        command: `printf '%s' ${JSON.stringify(empty)} > coverage.json && echo "Tests  1 passed (1)"`,
        gateOn: ["taskCompleted"],
        coverage: "include",
        coverageSummaryPath: "coverage.json",
      },
    ],
  });

  const { decision } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision.decision, "block");
  assert.match(decision.hookSpecificOutput.additionalContext, /zero measurable lines/);
});

test("taskcompleted: thresholds with no coverage-producing lane blocks with guidance", () => {
  const dir = workspace({
    enabled: true,
    enforceOnTaskCompleted: true,
    coverageThresholds: { lines: 90 },
    lanes: [{ name: "unit", command: 'echo "Tests  1 passed (1)"', gateOn: ["taskCompleted"] }],
  });

  const { decision } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision.decision, "block");
  assert.match(decision.hookSpecificOutput.additionalContext, /no lane produced a coverage report/);
});

test("taskcompleted: a green coverage lane records merged totals in state", () => {
  const summary = JSON.stringify({
    total: {
      lines: { total: 10, covered: 10, pct: 100 },
      functions: { total: 2, covered: 2, pct: 100 },
      branches: { total: 2, covered: 2, pct: 100 },
      statements: { total: 10, covered: 10, pct: 100 },
    },
  });

  const dir = workspace({
    enabled: true,
    enforceOnTaskCompleted: true,
    lanes: [
      {
        name: "unit",
        command: `printf '%s' ${JSON.stringify(summary)} > coverage.json && echo "Tests  1 passed (1)"`,
        gateOn: ["taskCompleted"],
        coverage: "include",
        coverageSummaryPath: "coverage.json",
      },
    ],
  });

  const { decision } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision, null);

  const state = readState(dir);
  assert.equal(state.coverage.status, "PASS");
  assert.equal(state.coverage.method, "single");
  assert.deepEqual(state.coverage.totals, { lines: 100, functions: 100, branches: 100, statements: 100 });
});

test("taskcompleted: two coverage lanes merge as an exact union through the hook", () => {
  // unit covers lines 1-2 of a.js, integration covers lines 2-3. The union is 3/3.
  // A weighted merge would report 4/6 and wrongly fail a 100% threshold.
  const unitLcov = "SF:/repo/a.js\nDA:1,1\nDA:2,1\nDA:3,0\nLF:3\nLH:2\nend_of_record\n";
  const intLcov = "SF:/repo/a.js\nDA:1,0\nDA:2,1\nDA:3,4\nLF:3\nLH:2\nend_of_record\n";

  const dir = workspace({
    enabled: true,
    enforceOnTaskCompleted: true,
    coverageThresholds: { lines: 100, functions: 0, branches: 0, statements: 100 },
    lanes: [
      {
        name: "unit",
        command: `printf '%b' ${JSON.stringify(unitLcov)} > unit.info && echo "Tests  2 passed (2)"`,
        gateOn: ["taskCompleted"],
        coverage: "include",
        coverageSummaryPath: "unit.info",
      },
      {
        name: "integration",
        command: `printf '%b' ${JSON.stringify(intLcov)} > int.info && echo "Tests  1 passed (1)"`,
        gateOn: ["taskCompleted"],
        coverage: "include",
        coverageSummaryPath: "int.info",
      },
    ],
  });

  const { decision } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision, null, "the union reaches 100%, so the gate must pass");

  const state = readState(dir);
  assert.equal(state.coverage.method, "union");
  assert.equal(state.coverage.approximate, false);
  assert.equal(state.coverage.totals.lines, 100);
});

test("taskcompleted: a summary-only lane forces a weighted merge and says so", () => {
  const lcov = "SF:/repo/a.js\nDA:1,1\nDA:2,0\nLF:2\nLH:1\nend_of_record\n";
  const summary = JSON.stringify({
    total: { lines: { total: 2, covered: 2, pct: 100 }, statements: { total: 2, covered: 2, pct: 100 } },
  });

  const dir = workspace({
    enabled: true,
    enforceOnTaskCompleted: true,
    coverageThresholds: { lines: 0, functions: 0, branches: 0, statements: 0 },
    lanes: [
      {
        name: "unit",
        command: `printf '%s' ${JSON.stringify(summary)} > unit.json && echo "Tests  2 passed (2)"`,
        gateOn: ["taskCompleted"],
        coverage: "include",
        coverageSummaryPath: "unit.json",
      },
      {
        name: "integration",
        command: `printf '%b' ${JSON.stringify(lcov)} > int.info && echo "Tests  1 passed (1)"`,
        gateOn: ["taskCompleted"],
        coverage: "include",
        coverageSummaryPath: "int.info",
      },
    ],
  });

  const { decision } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision, null);

  const state = readState(dir);
  assert.equal(state.coverage.method, "weighted");
  assert.equal(state.coverage.approximate, true, "the report must record that the merge is approximate");
  // 2/2 + 1/2 summed => 3/4, not the 2/2 union a per-line merge would give.
  assert.equal(state.coverage.totals.lines, 75);
});

// ---------------------------------------------------------------------------
// Greenfield / bootstrap
// ---------------------------------------------------------------------------

const NO_TESTS_LANE = (extra = {}) => ({
  name: "unit",
  command: 'echo "no test files found"',
  gateOn: ["taskCompleted"],
  ...extra,
});

test("taskcompleted: a greenfield lane with zero tests does NOT block", () => {
  // Day one of a TDD project. Blocking here would make the plugin unusable at
  // exactly the moment it should help most.
  const dir = workspace({
    enabled: true,
    enforceOnTaskCompleted: true,
    coverageThresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    lanes: [NO_TESTS_LANE()],
  });

  const { decision, stderr } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision, null, "a lane that has never had tests must not block");
  assert.match(stderr, /BOOTSTRAP/, "the state must be reported loudly, never silently");

  const state = readState(dir);
  assert.equal(state.lanes.unit.last_result, "bootstrap");
  assert.equal(state.lanes.unit.ever_had_tests, false);
});

test("taskcompleted: a bootstrap lane records freshness so the first commit is not deadlocked", () => {
  const dir = workspace({
    enabled: true,
    enforceOnTaskCompleted: true,
    blockCommitWithoutFreshGate: true,
    coverageThresholds: { lines: 0, functions: 0, branches: 0, statements: 0 },
    lanes: [NO_TESTS_LANE({ gateOn: ["taskCompleted", "commit"] })],
  });

  assert.equal(runHook(TASKCOMPLETED, { cwd: dir }).decision, null);
  assert.ok(readState(dir).lanes.unit.last_passed_at);
  assert.equal(
    runHook(PRETOOL, bashPayload(dir, "git commit -m 'initial'")).decision,
    null,
    "the first commit of a greenfield repo must be reachable"
  );
});

test("taskcompleted: the coverage gate is skipped while a lane is in bootstrap", () => {
  // No tests means no coverage report; that is the greenfield state, not a
  // misconfiguration, and an empty report would otherwise score 100% or block.
  const dir = workspace({
    enabled: true,
    enforceOnTaskCompleted: true,
    coverageThresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    lanes: [NO_TESTS_LANE({ coverage: "include", coverageSummaryPath: "coverage.json" })],
  });

  const { decision } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision, null);
  assert.equal(readState(dir).coverage, null, "no coverage should be recorded when there is none to measure");
});

test("taskcompleted: once a lane has had tests, zero tests blocks as a regression", () => {
  const dir = workspace({
    enabled: true,
    enforceOnTaskCompleted: true,
    coverageThresholds: { lines: 0, functions: 0, branches: 0, statements: 0 },
    lanes: [{ name: "unit", command: 'echo "Tests  3 passed (3)"', gateOn: ["taskCompleted"] }],
  });

  // First run: real tests, which flips the ratchet permanently.
  assert.equal(runHook(TASKCOMPLETED, { cwd: dir }).decision, null);
  assert.equal(readState(dir).lanes.unit.ever_had_tests, true);

  // Now discovery breaks. This must block, and must NOT be diagnosed as greenfield.
  const configPath = path.join(dir, ".claude", "tdd-guardian", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.lanes[0].command = 'echo "no test files found"';
  fs.writeFileSync(configPath, JSON.stringify(config));

  const { decision } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision.decision, "block");
  assert.match(decision.hookSpecificOutput.additionalContext, /regression, not a greenfield state/);
  assert.match(decision.hookSpecificOutput.additionalContext, /tdd-guardian:probe/);
});

test("taskcompleted: deleting every test cannot return a lane to bootstrap", () => {
  const dir = workspace({
    enabled: true,
    enforceOnTaskCompleted: true,
    coverageThresholds: { lines: 0, functions: 0, branches: 0, statements: 0 },
    lanes: [{ name: "unit", command: 'echo "Tests  3 passed (3)"', gateOn: ["taskCompleted"] }],
  });
  runHook(TASKCOMPLETED, { cwd: dir });

  const configPath = path.join(dir, ".claude", "tdd-guardian", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.lanes[0].command = 'echo "no tests found"';
  fs.writeFileSync(configPath, JSON.stringify(config));

  // Run twice — a ratchet that resets on the second attempt would be gameable.
  runHook(TASKCOMPLETED, { cwd: dir });
  const { decision } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision.decision, "block", "the strict rule must stay in force");
  assert.equal(readState(dir).lanes.unit.ever_had_tests, true);
});

test("taskcompleted: a zero-lane config explains the way out without circular advice", () => {
  const dir = workspace({ enabled: true, enforceOnTaskCompleted: true, lanes: [] });
  const { decision } = runHook(TASKCOMPLETED, { cwd: dir });

  assert.equal(decision.decision, "block");
  const context = decision.hookSpecificOutput.additionalContext;
  assert.match(context, /Add a lane by hand/);
  assert.match(context, /Install a test runner/);
  assert.match(context, /Delete \.claude\/tdd-guardian\/config\.json/);
});

test("pretool: an uninitialised greenfield repo blocks nothing at all", () => {
  // Writing no config is the correct init outcome when there is no tooling to
  // detect; the plugin must then be completely silent.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tddg-green-"));
  for (const command of ["git commit -m first", "git push -u origin main", "npm publish"]) {
    assert.equal(runHook(PRETOOL, bashPayload(dir, command)).decision, null, `expected silence for: ${command}`);
  }
});

test("taskcompleted: a preflight failure blocks before any lane runs", () => {
  const dir = workspace({
    enabled: true,
    enforceOnTaskCompleted: true,
    preflightCommand: 'echo "tsc: type error" >&2; exit 2',
    coverageThresholds: { lines: 0, functions: 0, branches: 0, statements: 0 },
    lanes: [{ name: "unit", command: "exit 1", gateOn: ["taskCompleted"] }],
  });

  const { decision } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision.decision, "block");
  assert.equal(decision.reason, "Preflight command failed");
  assert.match(decision.hookSpecificOutput.additionalContext, /tsc: type error/);
});

test("taskcompleted: an optional lane records its failure without blocking", () => {
  const dir = workspace({
    enabled: true,
    enforceOnTaskCompleted: true,
    coverageThresholds: { lines: 0, functions: 0, branches: 0, statements: 0 },
    lanes: [
      { name: "unit", command: 'echo "Tests  1 passed (1)"', gateOn: ["taskCompleted"] },
      { name: "smoke", command: 'echo "Tests  1 failed | 0 passed (1)"; exit 1', gateOn: ["taskCompleted"], optional: true },
    ],
  });

  const { decision } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision, null);
  assert.equal(readState(dir).lanes.smoke.last_result, "fail");
});

test("taskcompleted: the bypass env var records the bypass and runs nothing", () => {
  const dir = workspace({
    enabled: true,
    enforceOnTaskCompleted: true,
    bypassEnv: "TDD_HOOK_TEST_BYPASS",
    lanes: [{ name: "unit", command: "exit 1", gateOn: ["taskCompleted"] }],
  });

  const { decision } = runHook(TASKCOMPLETED, { cwd: dir }, { TDD_HOOK_TEST_BYPASS: "1" });
  assert.equal(decision, null);
  assert.ok(readState(dir).bypassed_at);
});

test("taskcompleted: an invalid config blocks only when enforcement was requested", () => {
  const enforcing = workspace({ enabled: true, enforceOnTaskCompleted: true, lanes: [{ name: "unit" }] });
  assert.equal(runHook(TASKCOMPLETED, { cwd: enforcing }).decision.decision, "block");

  const passive = workspace({ enabled: true, enforceOnTaskCompleted: false, lanes: [{ name: "unit" }] });
  assert.equal(runHook(TASKCOMPLETED, { cwd: passive }).decision, null);
});

test("taskcompleted: no-decrease mode records a baseline on the first run", () => {
  const summary = JSON.stringify({ total: { lines: { total: 10, covered: 7, pct: 70 }, statements: { total: 10, covered: 7, pct: 70 } } });

  const dir = workspace({
    enabled: true,
    enforceOnTaskCompleted: true,
    coverageMode: "no-decrease",
    lanes: [
      {
        name: "unit",
        command: `printf '%s' ${JSON.stringify(summary)} > coverage.json && echo "Tests  1 passed (1)"`,
        gateOn: ["taskCompleted"],
        coverage: "include",
        coverageSummaryPath: "coverage.json",
      },
    ],
  });

  assert.equal(runHook(TASKCOMPLETED, { cwd: dir }).decision, null, "the first run records rather than blocks");
  const state = readState(dir);
  assert.equal(state.coverage.status, "BASELINE");
  assert.equal(state.baseline.coverage.lines, 70);
});

test("taskcompleted: a malformed payload does not crash the hook", () => {
  const result = spawnSync(process.execPath, [TASKCOMPLETED], { input: "not json", encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0);
});
