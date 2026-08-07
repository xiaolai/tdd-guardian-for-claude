"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../scripts/tdd-guardian/lib/config.js");

function tmpWorkspace(configObject) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tddg-cfg-"));
  if (configObject !== undefined) {
    const file = path.join(dir, ".claude", "tdd-guardian", "config.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof configObject === "string" ? configObject : JSON.stringify(configObject, null, 2));
  }
  return dir;
}

const V1_CONFIG = {
  enabled: true,
  enforceOnTaskCompleted: true,
  testCommand: "pnpm test",
  coverageCommand: "pnpm test -- --coverage",
  coverageSummaryPath: "coverage/coverage-summary.json",
  coverageThresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
};

const V2_LANE = {
  name: "unit",
  command: "pnpm vitest run --coverage",
  gateOn: ["taskCompleted", "commit"],
  coverage: "include",
  coverageSummaryPath: "coverage/coverage-summary.json",
};

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

test("migrate synthesises a unit lane from a v1 config", () => {
  const { config: migrated, migrated: didMigrate, notes } = config.migrate(V1_CONFIG);
  assert.equal(didMigrate, true);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.lanes.length, 1);

  const lane = migrated.lanes[0];
  assert.equal(lane.name, "unit");
  assert.equal(lane.command, "pnpm test");
  assert.deepEqual(lane.gateOn, ["taskCompleted", "commit"]);
  assert.equal(lane.coverage, "include");
  // v1 ran testCommand and then coverageCommand as two executions; migration
  // preserves that rather than silently changing what runs.
  assert.equal(lane.coverageReportCommand, "pnpm test -- --coverage");
  assert.equal(notes.length, 1);
});

test("migrate leaves a v2 config alone", () => {
  const { config: migrated, migrated: didMigrate } = config.migrate({ lanes: [V2_LANE] });
  assert.equal(didMigrate, false);
  assert.equal(migrated.lanes.length, 1);
  assert.equal(migrated.schemaVersion, 2);
});

test("migrate does not set coverageReportCommand when both v1 commands are identical", () => {
  const { config: migrated } = config.migrate({ ...V1_CONFIG, coverageCommand: "pnpm test" });
  assert.equal(migrated.lanes[0].coverageReportCommand, "");
});

test("migrate marks coverage as none when v1 had no summary path", () => {
  const { config: migrated } = config.migrate({ testCommand: "go test ./..." });
  assert.equal(migrated.lanes[0].coverage, "none");
});

test("migrate produces no lanes when a v1 config has no commands", () => {
  const { config: migrated, migrated: didMigrate } = config.migrate({ enabled: true });
  assert.equal(didMigrate, false);
  assert.deepEqual(migrated.lanes, []);
});

// ---------------------------------------------------------------------------
// Validation — lanes
// ---------------------------------------------------------------------------

test("validate accepts a well-formed v2 config", () => {
  const { config: validated, errors } = config.validate({ lanes: [V2_LANE] });
  assert.deepEqual(errors, []);
  assert.equal(validated.lanes[0].name, "unit");
  assert.equal(validated.lanes[0].timeoutMs, config.DEFAULT_LANE_TIMEOUT_MS);
});

test("validate rejects a lane with no command", () => {
  const { config: validated, errors } = config.validate({ lanes: [{ name: "unit" }] });
  assert.equal(validated, null);
  assert.match(errors.join("\n"), /missing required field 'command'/);
});

test("validate rejects a lane with no name", () => {
  const { errors } = config.validate({ lanes: [{ command: "pnpm test" }] });
  assert.match(errors.join("\n"), /missing required field 'name'/);
});

test("validate rejects a lane name that is not a slug", () => {
  const { errors } = config.validate({ lanes: [{ name: "E2E Suite", command: "x" }] });
  assert.match(errors.join("\n"), /lowercase alphanumeric with hyphens/);
});

test("validate rejects duplicate lane names", () => {
  const { errors } = config.validate({
    lanes: [
      { name: "unit", command: "a" },
      { name: "unit", command: "b" },
    ],
  });
  assert.match(errors.join("\n"), /Duplicate lane name 'unit'/);
});

test("validate rejects an unknown trigger", () => {
  const { errors } = config.validate({ lanes: [{ name: "unit", command: "x", gateOn: ["nightly"] }] });
  assert.match(errors.join("\n"), /unknown trigger 'nightly'/);
});

test("validate normalises trigger aliases", () => {
  const { config: validated, errors } = config.validate({
    lanes: [{ name: "e2e", command: "x", gateOn: ["pre-push", "TASKCOMPLETED"] }],
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(validated.lanes[0].gateOn, ["push", "taskCompleted"]);
});

test("validate treats an explicitly empty gateOn as manual-only", () => {
  const { config: validated } = config.validate({ lanes: [{ name: "e2e", command: "x", gateOn: [] }] });
  assert.deepEqual(validated.lanes[0].gateOn, ["manual"]);
});

test("validate defaults an omitted gateOn to the fast triggers", () => {
  const { config: validated } = config.validate({ lanes: [{ name: "unit", command: "x" }] });
  assert.deepEqual(validated.lanes[0].gateOn, ["taskCompleted", "commit"]);
});

test("validate rejects coverage:include without a summary path", () => {
  const { errors } = config.validate({ lanes: [{ name: "unit", command: "x", coverage: "include" }] });
  assert.match(errors.join("\n"), /coverageSummaryPath is empty/);
});

test("validate rejects an unknown coverage participation value", () => {
  const { errors } = config.validate({ lanes: [{ name: "unit", command: "x", coverage: "merge" }] });
  assert.match(errors.join("\n"), /coverage must be one of include, none/);
});

test("validate requires at least one lane", () => {
  const { config: validated, errors } = config.validate({ enabled: true, lanes: [] });
  assert.equal(validated, null);
  assert.match(errors.join("\n"), /No lanes configured/);
});

// ---------------------------------------------------------------------------
// Validation — top level
// ---------------------------------------------------------------------------

test("validate rejects an out-of-range threshold", () => {
  const { errors } = config.validate({ lanes: [V2_LANE], coverageThresholds: { lines: 120 } });
  assert.match(errors.join("\n"), /coverageThresholds\.lines must be a number in \[0, 100\]/);
});

test("validate rejects an unknown coverage mode", () => {
  const { errors } = config.validate({ lanes: [V2_LANE], coverageMode: "ratchet" });
  assert.match(errors.join("\n"), /coverageMode must be one of absolute, no-decrease/);
});

test("validate rejects an unknown staleGateAction", () => {
  const { errors } = config.validate({ lanes: [V2_LANE], staleGateAction: "shrug" });
  assert.match(errors.join("\n"), /staleGateAction must be one of deny, warn/);
});

test("validate rejects requireMutation with no mutationCommand", () => {
  const { errors } = config.validate({ lanes: [V2_LANE], requireMutation: true });
  assert.match(errors.join("\n"), /requireMutation is true but mutationCommand is empty/);
});

test("validate defaults staleGateAction to deny", () => {
  const { config: validated } = config.validate({ lanes: [V2_LANE] });
  assert.equal(validated.staleGateAction, "deny");
});

test("validate defaults the blocking switches to off", () => {
  const { config: validated } = config.validate({ lanes: [V2_LANE] });
  assert.equal(validated.enforceOnTaskCompleted, false);
  assert.equal(validated.blockCommitWithoutFreshGate, false);
});

// ---------------------------------------------------------------------------
// Validation — warnings
// ---------------------------------------------------------------------------

test("validate warns when thresholds are set but no lane contributes coverage", () => {
  const { config: validated, warnings } = config.validate({
    lanes: [{ name: "unit", command: "x" }],
    coverageThresholds: { lines: 90 },
  });
  assert.ok(validated);
  assert.match(warnings.join("\n"), /no lane has coverage:"include"/);
});

test("validate warns when two lanes write to the same coverage path", () => {
  const { warnings } = config.validate({
    lanes: [
      { name: "unit", command: "a", coverage: "include", coverageSummaryPath: "coverage/lcov.info" },
      { name: "int", command: "b", coverage: "include", coverageSummaryPath: "coverage/lcov.info" },
    ],
  });
  assert.match(warnings.join("\n"), /share coverageSummaryPath/);
  assert.match(warnings.join("\n"), /overwrites/);
});

test("validate warns when a slow lane gates task completion", () => {
  const { warnings } = config.validate({
    lanes: [{ name: "e2e", command: "npx playwright test", gateOn: ["taskCompleted"], timeoutMs: 1800000 }],
  });
  assert.match(warnings.join("\n"), /Long suites belong on the push trigger/);
});

// ---------------------------------------------------------------------------
// Loading from disk
// ---------------------------------------------------------------------------

test("load reports a missing config as not existing rather than as an error", () => {
  const dir = tmpWorkspace();
  const loaded = config.load(dir);
  assert.equal(loaded.exists, false);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.config, null);
});

test("load reports malformed JSON with the parser message", () => {
  const dir = tmpWorkspace("{ nope");
  const loaded = config.load(dir);
  assert.equal(loaded.exists, true);
  assert.match(loaded.errors.join("\n"), /is not valid JSON/);
});

test("load migrates a v1 file on disk and returns the note", () => {
  const dir = tmpWorkspace(V1_CONFIG);
  const loaded = config.load(dir);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.config.lanes.length, 1);
  assert.match(loaded.notes.join("\n"), /Migrated schema v1 config to v2/);
});

test("load returns the raw object so callers can read flags from an invalid config", () => {
  const dir = tmpWorkspace({ enabled: true, enforceOnTaskCompleted: false, lanes: [{ name: "x" }] });
  const loaded = config.load(dir);
  assert.ok(loaded.errors.length);
  assert.equal(loaded.raw.enforceOnTaskCompleted, false);
});

// ---------------------------------------------------------------------------
// Bypass
// ---------------------------------------------------------------------------

test("isBypassed honours the configured env var and its truthy spellings", () => {
  const cfg = { bypassEnv: "TDD_TEST_BYPASS" };
  delete process.env.TDD_TEST_BYPASS;
  assert.equal(config.isBypassed(cfg), false);

  for (const value of ["1", "true", "TRUE", "yes"]) {
    process.env.TDD_TEST_BYPASS = value;
    assert.equal(config.isBypassed(cfg), true, `expected '${value}' to bypass`);
  }

  process.env.TDD_TEST_BYPASS = "0";
  assert.equal(config.isBypassed(cfg), false);
  delete process.env.TDD_TEST_BYPASS;
});
