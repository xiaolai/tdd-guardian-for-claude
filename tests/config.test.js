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

// ---------------------------------------------------------------------------
// Critical paths — how expensive the code is to get WRONG
// ---------------------------------------------------------------------------

function withCriticalPaths(criticalPaths, extra = {}) {
  return config.validate({
    lanes: [{ name: "unit", command: "npm test" }],
    criticalPaths,
    ...extra,
  });
}

test("a criticalPaths entry normalizes with inherited thresholds", () => {
  const { config: cfg, errors } = withCriticalPaths([{ glob: "src/payments/**", description: "money" }]);
  assert.deepEqual(errors, []);
  assert.equal(cfg.criticalPaths.length, 1);
  assert.equal(cfg.criticalPaths[0].glob, "src/payments/**");
  assert.equal(cfg.criticalPaths[0].thresholds, null, "omitted thresholds must stay distinguishable from explicit ones");
  assert.equal(cfg.criticalPaths[0].requireSpecLevel, "");
});

test("criticalPaths defaults to empty, so existing configs are unaffected", () => {
  const { config: cfg } = config.validate({ lanes: [{ name: "unit", command: "npm test" }] });
  assert.deepEqual(cfg.criticalPaths, []);
});

test("a criticalPaths entry without a glob is an error", () => {
  const { errors } = withCriticalPaths([{ thresholds: { lines: 100 } }]);
  assert.ok(errors.some((e) => /criticalPaths\[0\]: missing required field 'glob'/.test(e)));
});

test("brace expansion is rejected rather than silently matching nothing", () => {
  const { errors } = withCriticalPaths([{ glob: "src/{a,b}/**" }]);
  assert.ok(errors.some((e) => /brace expansion is not supported/.test(e)));
});

test("an out-of-range critical threshold is an error", () => {
  const { errors } = withCriticalPaths([{ glob: "src/**", thresholds: { lines: 140 } }]);
  assert.ok(errors.some((e) => /thresholds\.lines must be a JSON number in \[0, 100\]/.test(e)));
});

test("an unknown threshold key is an error, not a silently ignored field", () => {
  const { errors } = withCriticalPaths([{ glob: "src/**", thresholds: { lnies: 90 } }]);
  assert.ok(errors.some((e) => /unknown threshold 'lnies'/.test(e)));
});

test("duplicate globs are an error, because the later entry would shadow the earlier", () => {
  const { errors } = withCriticalPaths([{ glob: "src/**" }, { glob: "src/**" }]);
  assert.ok(errors.some((e) => /Duplicate criticalPaths glob/.test(e)));
});

test("a critical path looser than the repo-wide bar warns", () => {
  const { config: cfg, warnings } = withCriticalPaths([{ glob: "src/**", thresholds: { lines: 50 } }], {
    coverageThresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
  });
  assert.ok(cfg, "a loose critical path is a warning, not an error");
  assert.ok(warnings.some((w) => /LOOSER than the repo-wide threshold/.test(w)));
});

test("requireSpecLevel accepts S1-S6 and rejects anything else", () => {
  const ok = withCriticalPaths([{ glob: "src/**", requireSpecLevel: "s4" }]);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.config.criticalPaths[0].requireSpecLevel, "S4", "spec levels normalize to upper case");

  const bad = withCriticalPaths([{ glob: "src/**", requireSpecLevel: "S9" }]);
  assert.ok(bad.errors.some((e) => /requireSpecLevel must be one of/.test(e)));
});

test("requireMutation without a mutation command is an unmeetable requirement, so it errors", () => {
  const { errors } = withCriticalPaths([{ glob: "src/**", requireMutation: true }]);
  assert.ok(errors.some((e) => /requireMutation but mutationCommand is empty/.test(e)));
});

test("requireMutation is accepted once a mutation command exists", () => {
  const { errors } = withCriticalPaths([{ glob: "src/**", requireMutation: true }], {
    mutationCommand: "npx stryker run",
  });
  assert.deepEqual(errors, []);
});

test("critical paths under no-decrease mode warn that the two bars are independent", () => {
  const { warnings } = withCriticalPaths([{ glob: "src/**" }], { coverageMode: "no-decrease" });
  assert.ok(warnings.some((w) => /coverageMode is "no-decrease"/.test(w)));
});

test("a non-string glob is rejected rather than coerced", () => {
  // String(123) is "123" and String(["src/**"]) is "src/**", so a coerced glob is
  // accepted and then selects nothing — or accidentally works, hiding the error.
  for (const [glob, label] of [[123, "number"], [["src/**"], "an array"], [{}, "object"], [true, "boolean"]]) {
    const { errors } = withCriticalPaths([{ glob }]);
    assert.ok(errors.some((e) => /glob must be a string/.test(e)), `${label} should be rejected`);
  }
});

test("a glob that selects nothing is rejected at config time", () => {
  for (const glob of [".", "..", "/", "./"]) {
    const { errors } = withCriticalPaths([{ glob }]);
    assert.ok(errors.some((e) => /selects no project file/.test(e)), `'${glob}' should be rejected`);
  }
});

test("a non-boolean requireMutation is rejected, not silently disabled", () => {
  // `"requireMutation": "true"` used to normalize to false, turning an explicit
  // requirement into nothing without a word.
  for (const value of ["true", 1, {}]) {
    const { errors } = withCriticalPaths([{ glob: "src/**", requireMutation: value }], { mutationCommand: "npx stryker run" });
    assert.ok(errors.some((e) => /requireMutation must be true or false/.test(e)), `${JSON.stringify(value)} should be rejected`);
  }
});

test("a non-string requireSpecLevel is rejected rather than coerced", () => {
  for (const value of [["S3"], 0, {}]) {
    const { errors } = withCriticalPaths([{ glob: "src/**", requireSpecLevel: value }]);
    assert.ok(errors.some((e) => /requireSpecLevel must be a string/.test(e)), `${JSON.stringify(value)} should be rejected`);
  }
});

test("a non-plain thresholds object is rejected", () => {
  const { errors } = withCriticalPaths([{ glob: "src/**", thresholds: new Date() }]);
  assert.ok(errors.some((e) => /thresholds must be an object/.test(e)));
});

test("null and {} thresholds both mean inherit, which is not an error", () => {
  // JSON has no undefined, so a generator emitting an explicit null means the
  // same as omitting the key. Both resolve to the repo-wide thresholds, so
  // nothing goes unenforced either way.
  for (const thresholds of [null, {}]) {
    const { config: cfg, errors } = withCriticalPaths([{ glob: "src/**", thresholds }]);
    assert.deepEqual(errors, []);
    assert.ok(cfg, `thresholds: ${JSON.stringify(thresholds)} should be accepted`);
  }
});
