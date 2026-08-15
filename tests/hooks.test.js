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

// ---------------------------------------------------------------------------
// TaskCompleted — critical paths
// ---------------------------------------------------------------------------

// istanbul-summary carries per-file entries, which is what criticalPaths need.
function summaryWith(files) {
  const entry = (covered, total) => {
    const pct = total === 0 ? 100 : Math.round((covered / total) * 10000) / 100;
    return { lines: { total, covered, pct }, statements: { total, covered, pct }, functions: { total, covered, pct }, branches: { total, covered, pct } };
  };
  const out = {};
  let covered = 0;
  let total = 0;
  for (const [file, [c, t]] of Object.entries(files)) {
    out[file] = entry(c, t);
    covered += c;
    total += t;
  }
  out.total = entry(covered, total);
  return JSON.stringify(out);
}

function coverageWorkspace(report, extra = {}) {
  return workspace({
    enabled: true,
    enforceOnTaskCompleted: true,
    coverageThresholds: { lines: 50, functions: 50, branches: 50, statements: 50 },
    lanes: [
      {
        name: "unit",
        command: `printf '%s' ${JSON.stringify(report)} > coverage.json && echo "Tests  1 passed (1)"`,
        gateOn: ["taskCompleted"],
        coverage: "include",
        coverageSummaryPath: "coverage.json",
      },
    ],
    ...extra,
  });
}

test("taskcompleted: a critical path below its threshold blocks even when the repo total passes", () => {
  // Repo-wide: 18/20 = 90%, comfortably over the 50% bar. The payments module
  // alone is 5/10 = 50%, under its own 100% bar. A single global threshold cannot
  // express that difference, which is the whole reason criticalPaths exist.
  const report = summaryWith({ "src/payments/charge.ts": [5, 10], "src/util/log.ts": [13, 10] });
  const dir = coverageWorkspace(report, {
    criticalPaths: [{ glob: "src/payments/**", thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 } }],
  });

  const { decision } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision.decision, "block");
  assert.equal(decision.reason, "Coverage gate failed");
  assert.match(decision.hookSpecificOutput.additionalContext, /Critical-path coverage failed/);
  assert.match(decision.hookSpecificOutput.additionalContext, /src\/payments\/\*\*/);
});

test("taskcompleted: a critical path that meets its threshold passes and is recorded", () => {
  const report = summaryWith({ "src/payments/charge.ts": [10, 10], "src/util/log.ts": [5, 10] });
  const dir = coverageWorkspace(report, {
    criticalPaths: [{ glob: "src/payments/**", thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 } }],
  });

  const { decision } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision, null, "green gate emits no decision");

  const recorded = readState(dir).coverage.criticalPaths;
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].glob, "src/payments/**");
  assert.equal(recorded[0].matchedFiles, 1);
  assert.equal(recorded[0].ok, true);
});

test("taskcompleted: a criticalPaths glob that matches nothing blocks the gate", () => {
  const report = summaryWith({ "src/util/log.ts": [10, 10] });
  const dir = coverageWorkspace(report, { criticalPaths: [{ glob: "src/paymnets/**" }] });

  const { decision } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision.decision, "block");
  assert.match(decision.hookSpecificOutput.additionalContext, /matched no file in the coverage report/);
  assert.match(decision.hookSpecificOutput.additionalContext, /src\/paymnets\/\*\*/);
  assert.equal(readState(dir).coverage.status, "FAIL");
});

// ---------------------------------------------------------------------------
// TaskCompleted — specification / implementation separation
// ---------------------------------------------------------------------------

function writeReceipts(dir, receipts) {
  fs.writeFileSync(path.join(dir, ".claude", "tdd-guardian", "receipts.json"), JSON.stringify({ schemaVersion: 2, receipts }, null, 2));
}

const GREEN_LANE = {
  enabled: true,
  enforceOnTaskCompleted: true,
  coverageThresholds: { lines: 0, functions: 0, branches: 0, statements: 0 },
  lanes: [{ name: "unit", command: 'echo "Tests  1 passed (1)"', gateOn: ["taskCompleted"] }],
};

test("taskcompleted: a test file edited between red and green is reported, without blocking", () => {
  const dir = workspace(GREEN_LANE);
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tests", "a.test.js"), "expect(charge(100)).toBe(100);\n");

  const verification = require("../scripts/tdd-guardian/lib/verification.js");
  writeReceipts(dir, [
    verification.buildReceipt({
      id: "WI-1",
      lane: "unit",
      result: { status: "fail", testCounts: { failed: 1, passed: 0, skipped: 0, total: 1 } },
      testFiles: ["tests/a.test.js"],
      cwd: dir,
    }),
  ]);

  // The implementation could not satisfy the spec, so the spec was relaxed.
  fs.writeFileSync(path.join(dir, "tests", "a.test.js"), "expect(charge(100)).toBeGreaterThan(0);\n");

  const { decision, stderr } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision, null, "separation findings report; they never block");
  assert.match(stderr, /\[HIGH\] WI-1 \(unit\)/);
  assert.match(stderr, /tests\/a\.test\.js/);
});

test("taskcompleted: an unchanged specification is reported as held", () => {
  const dir = workspace(GREEN_LANE);
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tests", "a.test.js"), "expect(charge(100)).toBe(100);\n");

  const verification = require("../scripts/tdd-guardian/lib/verification.js");
  writeReceipts(dir, [
    verification.buildReceipt({
      id: "WI-1",
      lane: "unit",
      result: { status: "fail", testCounts: { failed: 1, passed: 0, skipped: 0, total: 1 } },
      testFiles: ["tests/a.test.js"],
      cwd: dir,
    }),
  ]);

  const { decision, stderr } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision, null);
  assert.match(stderr, /Specification held for WI-1/);
});

test("taskcompleted: no receipts means silence, not a violation", () => {
  const dir = workspace(GREEN_LANE);
  const { decision, stderr } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision, null);
  assert.equal(/Specification/.test(stderr), false, "absence of evidence must not be reported as evidence");
});

// ---------------------------------------------------------------------------
// TaskCompleted — the two enforcement boundaries criticalPaths introduced
// ---------------------------------------------------------------------------

test("taskcompleted: a critical path is enforced even when every global threshold is zero", () => {
  // The legacy-repo setup: no repo-wide bar, one strict bar on the code that
  // matters. Deciding "is coverage wanted" from the global thresholds alone let
  // this configuration skip the gate entirely and report success.
  const report = summaryWith({ "src/payments/charge.ts": [5, 10] });
  const dir = workspace({
    enabled: true,
    enforceOnTaskCompleted: true,
    coverageThresholds: { lines: 0, functions: 0, branches: 0, statements: 0 },
    criticalPaths: [{ glob: "src/payments/**", thresholds: { lines: 100 } }],
    lanes: [
      {
        name: "unit",
        command: `printf '%s' ${JSON.stringify(report)} > coverage.json && echo "Tests  1 passed (1)"`,
        gateOn: ["taskCompleted"],
        coverage: "include",
        coverageSummaryPath: "coverage.json",
      },
    ],
  });

  const { decision } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision.decision, "block");
  assert.match(decision.hookSpecificOutput.additionalContext, /Critical-path coverage failed/);
});

test("taskcompleted: a per-path requireMutation runs the mutation gate", () => {
  // Validation accepted requireMutation on a criticalPaths entry while execution
  // checked only the top-level flag — a config that promised enforcement and
  // silently skipped it.
  const report = summaryWith({ "src/payments/charge.ts": [10, 10] });
  const dir = workspace({
    enabled: true,
    enforceOnTaskCompleted: true,
    coverageThresholds: { lines: 50, functions: 50, branches: 50, statements: 50 },
    criticalPaths: [{ glob: "src/payments/**", requireMutation: true }],
    requireMutation: false,
    mutationCommand: "exit 3",
    mutationGateOn: ["taskCompleted"],
    lanes: [
      {
        name: "unit",
        command: `printf '%s' ${JSON.stringify(report)} > coverage.json && echo "Tests  1 passed (1)"`,
        gateOn: ["taskCompleted"],
        coverage: "include",
        coverageSummaryPath: "coverage.json",
      },
    ],
  });

  const { decision } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /Mutation gate failed/);
  assert.match(decision.reason, /required by criticalPaths: src\/payments\/\*\*/);
});

test("taskcompleted: an unmatched glob is recorded as failed, never as a checked path", () => {
  const report = summaryWith({ "src/util/log.ts": [10, 10] });
  const dir = workspace({
    enabled: true,
    enforceOnTaskCompleted: true,
    coverageThresholds: { lines: 50, functions: 50, branches: 50, statements: 50 },
    criticalPaths: [{ glob: "src/paymnets/**" }],
    lanes: [
      {
        name: "unit",
        command: `printf '%s' ${JSON.stringify(report)} > coverage.json && echo "Tests  1 passed (1)"`,
        gateOn: ["taskCompleted"],
        coverage: "include",
        coverageSummaryPath: "coverage.json",
      },
    ],
  });

  const { decision } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision.decision, "block");
  const recorded = readState(dir).coverage.criticalPaths;
  assert.equal(recorded[0].matchedFiles, 0);
  assert.equal(recorded[0].ok, false, "a rule enforcing nothing is not a pass");
});

test("taskcompleted: a corrupt receipts store is reported, not treated as no receipts", () => {
  const dir = workspace(GREEN_LANE);
  fs.writeFileSync(path.join(dir, ".claude", "tdd-guardian", "receipts.json"), "{ truncated");

  const { decision, stderr } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision, null, "a bookkeeping problem must not fail an otherwise green gate");
  assert.match(stderr, /not valid JSON/);
});

test("taskcompleted: a receipt for a lane that did not run stays open", () => {
  const dir = workspace(GREEN_LANE);
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tests", "a.test.js"), "expect(charge(100)).toBe(100);\n");

  const verification = require("../scripts/tdd-guardian/lib/verification.js");
  writeReceipts(dir, [
    verification.buildReceipt({
      id: "WI-9",
      lane: "integration", // never runs on taskCompleted in this config
      result: { status: "fail", testCounts: { failed: 1, passed: 0, skipped: 0, total: 1 } },
      testFiles: ["tests/a.test.js"],
      cwd: dir,
    }),
  ]);

  fs.writeFileSync(path.join(dir, "tests", "a.test.js"), "expect(charge(100)).toBeGreaterThan(0);\n");
  const { decision } = runHook(TASKCOMPLETED, { cwd: dir });

  assert.equal(decision, null);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "tdd-guardian", "receipts.json"), "utf8"));
  assert.equal(stored.receipts[0].verdict, null, "a lane that never ran cannot settle its receipt");
});

// ---------------------------------------------------------------------------
// TaskCompleted — enforcement that was configured but structurally unreachable
// ---------------------------------------------------------------------------

test("taskcompleted: enforcement configured with no taskCompleted lane blocks instead of going quiet", () => {
  // Returning early here skipped the coverage, critical-path, and mutation gates
  // entirely: enforcement requested, nothing enforced, no signal.
  const dir = workspace({
    enabled: true,
    enforceOnTaskCompleted: true,
    coverageThresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    criticalPaths: [{ glob: "src/payments/**" }],
    lanes: [{ name: "unit", command: "true", gateOn: ["commit"] }],
  });

  const { decision } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /nothing can be enforced/);
  assert.match(decision.hookSpecificOutput.additionalContext, /coverage thresholds/);
  assert.match(decision.hookSpecificOutput.additionalContext, /1 critical path/);
});

test("taskcompleted: no taskCompleted lane and nothing configured stays silent", () => {
  const dir = workspace({
    enabled: true,
    enforceOnTaskCompleted: true,
    coverageThresholds: { lines: 0, functions: 0, branches: 0, statements: 0 },
    lanes: [{ name: "unit", command: "true", gateOn: ["commit"] }],
  });

  const { decision, stderr } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision, null, "nothing to enforce is not a failure");
  assert.match(stderr, /nothing to run/);
});

test("taskcompleted: an unrelated bootstrap lane does not exempt a mature lane's critical paths", () => {
  // The exemption used to be global: any bootstrap lane skipped the whole
  // coverage gate, so a brand-new e2e lane hid the unit lane's critical paths.
  const report = summaryWith({ "src/payments/charge.ts": [5, 10] });
  const dir = workspace({
    enabled: true,
    enforceOnTaskCompleted: true,
    coverageThresholds: { lines: 0, functions: 0, branches: 0, statements: 0 },
    criticalPaths: [{ glob: "src/payments/**", thresholds: { lines: 100 } }],
    lanes: [
      {
        name: "unit",
        command: `printf '%s' ${JSON.stringify(report)} > coverage.json && echo "Tests  1 passed (1)"`,
        gateOn: ["taskCompleted"],
        coverage: "include",
        coverageSummaryPath: "coverage.json",
      },
      { name: "e2e", command: 'echo "No tests found"; exit 0', gateOn: ["taskCompleted"], coverage: "none" },
    ],
  });

  const { decision } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision.decision, "block");
  assert.match(decision.hookSpecificOutput.additionalContext, /Critical-path coverage failed/);
});

test("taskcompleted: a coverage lane that produced no report fails rather than merging a subset", () => {
  // An optional lane's failure means "do not block on its tests", not "measure
  // the project against whatever happens to be left".
  const report = summaryWith({ "src/a.ts": [10, 10] });
  const dir = workspace({
    enabled: true,
    enforceOnTaskCompleted: true,
    coverageThresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    lanes: [
      {
        name: "unit",
        command: `printf '%s' ${JSON.stringify(report)} > coverage.json && echo "Tests  1 passed (1)"`,
        gateOn: ["taskCompleted"],
        coverage: "include",
        coverageSummaryPath: "coverage.json",
      },
      {
        name: "integration",
        command: 'echo "Tests  1 failed | 0 passed (1)"; exit 1',
        gateOn: ["taskCompleted"],
        coverage: "include",
        coverageSummaryPath: "coverage-integration.json",
        optional: true,
      },
    ],
  });

  const { decision } = runHook(TASKCOMPLETED, { cwd: dir });
  assert.equal(decision.decision, "block");
  assert.match(decision.hookSpecificOutput.additionalContext, /produced no report: integration/);
  assert.match(decision.hookSpecificOutput.additionalContext, /measured against a subset/);
});
