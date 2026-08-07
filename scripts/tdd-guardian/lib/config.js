"use strict";
// Config loading, v1 -> v2 migration, and validation.
//
// Schema v2 replaces the single testCommand/coverageCommand pair with a `lanes`
// array. A lane is one test tier (unit, integration, e2e, contract, ...) with its
// own command, its own trigger points, and its own coverage participation. This is
// what lets a slow e2e suite gate `git push` without running on every task
// completion, and lets an uninstrumented e2e lane stay out of the coverage maths.
//
// v1 configs load unchanged: migrate() synthesises an equivalent single lane, so
// existing projects keep their exact behaviour without editing anything.

const fs = require("fs");
const path = require("path");

const SCHEMA_VERSION = 2;

// Trigger points a lane can be bound to.
//   taskCompleted — the TaskCompleted hook, after Claude finishes a task
//   commit        — `git commit`
//   push          — `git push`, `gh pr create|merge`, package publish
//   manual        — only via /tdd-guardian:gate
const TRIGGERS = ["taskCompleted", "commit", "push", "manual"];

const TRIGGER_ALIASES = {
  taskcompleted: "taskCompleted",
  "task-completed": "taskCompleted",
  task_completed: "taskCompleted",
  oncommit: "commit",
  precommit: "commit",
  "pre-commit": "commit",
  onpush: "push",
  prepush: "push",
  "pre-push": "push",
  publish: "push",
  ondemand: "manual",
  "on-demand": "manual",
};

const COVERAGE_PARTICIPATION = ["include", "none"];
const COVERAGE_MODES = ["absolute", "no-decrease"];
const STALE_ACTIONS = ["deny", "warn"];

const DEFAULT_THRESHOLDS = { lines: 100, functions: 100, branches: 100, statements: 100 };
const DEFAULT_LANE_TIMEOUT_MS = 600000;
const LANE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

const DEFAULTS = {
  schemaVersion: SCHEMA_VERSION,
  enabled: true,
  enforceOnTaskCompleted: false,
  blockCommitWithoutFreshGate: false,
  staleGateAction: "deny",
  gateFreshnessMinutes: 120,
  bypassEnv: "TDD_GUARD_BYPASS",
  preflightCommand: "",
  lanes: [],
  coverageThresholds: { ...DEFAULT_THRESHOLDS },
  coverageMode: "absolute",
  smartStaleness: true,
  requireMutation: false,
  mutationCommand: "",
  mutationGateOn: ["taskCompleted"],
};

function normalizeTrigger(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (TRIGGERS.includes(raw)) return raw;
  const alias = TRIGGER_ALIASES[raw.toLowerCase()];
  if (alias) return alias;
  const ci = TRIGGERS.find((t) => t.toLowerCase() === raw.toLowerCase());
  return ci || null;
}

function normalizeLane(raw, index) {
  const errors = [];
  const lane = {};

  lane.name = String(raw?.name || "").trim();
  if (!lane.name) {
    errors.push(`lanes[${index}]: missing required field 'name'.`);
  } else if (!LANE_NAME_RE.test(lane.name)) {
    errors.push(`lanes[${index}] ('${lane.name}'): name must be lowercase alphanumeric with hyphens, e.g. "unit", "e2e", "contract".`);
  }

  lane.command = String(raw?.command || "").trim();
  if (!lane.command) errors.push(`lanes[${index}] ('${lane.name || index}'): missing required field 'command'.`);

  // Omitted gateOn defaults to the fast triggers. An explicit [] means the lane
  // only ever runs on demand, which is a legitimate choice for an expensive suite.
  const gateOnRaw = Array.isArray(raw?.gateOn) ? (raw.gateOn.length ? raw.gateOn : ["manual"]) : ["taskCompleted", "commit"];
  const gateOn = [];
  for (const entry of gateOnRaw) {
    const trigger = normalizeTrigger(entry);
    if (!trigger) {
      errors.push(`lanes[${index}] ('${lane.name || index}'): unknown trigger '${entry}'. Valid: ${TRIGGERS.join(", ")}.`);
      continue;
    }
    if (!gateOn.includes(trigger)) gateOn.push(trigger);
  }
  lane.gateOn = gateOn;

  const participation = String(raw?.coverage || "none").trim().toLowerCase();
  if (!COVERAGE_PARTICIPATION.includes(participation)) {
    errors.push(`lanes[${index}] ('${lane.name || index}'): coverage must be one of ${COVERAGE_PARTICIPATION.join(", ")} — got '${raw?.coverage}'.`);
    lane.coverage = "none";
  } else {
    lane.coverage = participation;
  }

  // Optional extra report step, for tools that split running from reporting
  // (mvn jacoco:report, nyc report, gcovr, llvm-cov report). Leave empty when
  // `command` already emits the coverage file.
  lane.coverageReportCommand = String(raw?.coverageReportCommand || "").trim();
  lane.coverageSummaryPath = String(raw?.coverageSummaryPath || "").trim();

  if (lane.coverage === "include" && !lane.coverageSummaryPath) {
    errors.push(
      `lanes[${index}] ('${lane.name || index}'): coverage is "include" but coverageSummaryPath is empty. ` +
        `Set the path to the report this lane writes, or set coverage to "none".`
    );
  }

  const timeout = Number(raw?.timeoutMs);
  lane.timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_LANE_TIMEOUT_MS;

  lane.setupCommand = String(raw?.setupCommand || "").trim();
  lane.teardownCommand = String(raw?.teardownCommand || "").trim();
  lane.probeCommand = String(raw?.probeCommand || "").trim();
  lane.description = String(raw?.description || "").trim();
  // An optional lane reports failures without blocking. Use for suites that are
  // genuinely flaky by nature (third-party smoke checks), never to duck a red test.
  lane.optional = raw?.optional === true;

  return { lane, errors };
}

/**
 * Migrate a raw config object to schema v2.
 *
 * v1 -> v2 is behaviour-preserving: v1 ran testCommand and then coverageCommand as
 * two separate executions, so the synthesised lane keeps both. Configs generated by
 * /tdd-guardian:init use a single instrumented command instead.
 *
 * @returns {{config: object, migrated: boolean, notes: string[]}}
 */
function migrate(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const notes = [];

  if (Array.isArray(input.lanes) && input.lanes.length > 0) {
    return { config: { ...input, schemaVersion: SCHEMA_VERSION }, migrated: false, notes };
  }

  const testCommand = String(input.testCommand || "").trim();
  const coverageCommand = String(input.coverageCommand || "").trim();
  const coverageSummaryPath = String(input.coverageSummaryPath || "").trim();

  if (!testCommand && !coverageCommand) {
    return { config: { ...input, schemaVersion: SCHEMA_VERSION, lanes: [] }, migrated: false, notes };
  }

  const lane = {
    name: "unit",
    description: "Migrated from schema v1 testCommand/coverageCommand.",
    command: testCommand || coverageCommand,
    gateOn: ["taskCompleted", "commit"],
    coverage: coverageSummaryPath ? "include" : "none",
    coverageReportCommand: testCommand && coverageCommand && coverageCommand !== testCommand ? coverageCommand : "",
    coverageSummaryPath,
    timeoutMs: DEFAULT_LANE_TIMEOUT_MS,
  };

  notes.push(
    `Migrated schema v1 config to v2: created lane "unit" from testCommand${coverageCommand ? " + coverageCommand" : ""}. ` +
      `Run /tdd-guardian:init to add integration and e2e lanes.`
  );

  const config = { ...input, schemaVersion: SCHEMA_VERSION, lanes: [lane] };
  // Leave the v1 keys in place so a downgrade still works, but they are no longer read.
  return { config, migrated: true, notes };
}

/**
 * Apply defaults and validate.
 * @returns {{config: object|null, errors: string[], warnings: string[], notes: string[]}}
 */
function validate(rawInput) {
  const { config: migrated, notes } = migrate(rawInput);
  const errors = [];
  const warnings = [];

  const config = {
    ...DEFAULTS,
    ...migrated,
    coverageThresholds: { ...DEFAULT_THRESHOLDS, ...(migrated.coverageThresholds || {}) },
  };

  config.enabled = config.enabled !== false;
  config.enforceOnTaskCompleted = config.enforceOnTaskCompleted === true;
  config.blockCommitWithoutFreshGate = config.blockCommitWithoutFreshGate === true;
  config.smartStaleness = config.smartStaleness !== false;
  config.requireMutation = config.requireMutation === true;

  const staleAction = String(config.staleGateAction || "deny").toLowerCase();
  if (!STALE_ACTIONS.includes(staleAction)) {
    errors.push(`staleGateAction must be one of ${STALE_ACTIONS.join(", ")} — got '${config.staleGateAction}'.`);
  }
  config.staleGateAction = STALE_ACTIONS.includes(staleAction) ? staleAction : "deny";

  if (!COVERAGE_MODES.includes(String(config.coverageMode))) {
    errors.push(`coverageMode must be one of ${COVERAGE_MODES.join(", ")} — got '${config.coverageMode}'.`);
  }

  const freshness = Number(config.gateFreshnessMinutes);
  config.gateFreshnessMinutes = Number.isFinite(freshness) && freshness > 0 ? freshness : DEFAULTS.gateFreshnessMinutes;

  for (const [key, value] of Object.entries(config.coverageThresholds)) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      errors.push(`coverageThresholds.${key} must be a number in [0, 100] — got '${value}'.`);
    }
  }

  // Lanes
  const lanes = [];
  const seen = new Set();
  const rawLanes = Array.isArray(config.lanes) ? config.lanes : [];

  rawLanes.forEach((rawLane, index) => {
    const { lane, errors: laneErrors } = normalizeLane(rawLane, index);
    errors.push(...laneErrors);
    if (lane.name) {
      if (seen.has(lane.name)) {
        errors.push(`Duplicate lane name '${lane.name}'. Lane names must be unique.`);
      }
      seen.add(lane.name);
    }
    lanes.push(lane);
  });
  config.lanes = lanes;

  if (lanes.length === 0) {
    // Reached when a config was hand-edited down to nothing, or written before a
    // runner existed. Deleting the config is a real option and must be offered:
    // with no config the plugin is silent, which is better than a config that
    // blocks every commit while telling the user to re-run the command that
    // produced it.
    errors.push(
      `No lanes configured. TDD Guardian needs at least one lane.\n` +
        `Pick one:\n` +
        `  1. Add a lane by hand:\n` +
        `     "lanes": [{ "name": "unit", "command": "<your test command>", "gateOn": ["taskCompleted", "commit"] }]\n` +
        `  2. Install a test runner, then run /tdd-guardian:init to detect and verify it.\n` +
        `  3. Delete .claude/tdd-guardian/config.json — with no config the plugin stays silent and nothing is blocked.`
    );
  }

  // Mutation triggers
  const mutationTriggers = [];
  const rawMutationTriggers = Array.isArray(config.mutationGateOn) ? config.mutationGateOn : DEFAULTS.mutationGateOn;
  for (const entry of rawMutationTriggers) {
    const trigger = normalizeTrigger(entry);
    if (!trigger) {
      errors.push(`mutationGateOn contains unknown trigger '${entry}'. Valid: ${TRIGGERS.join(", ")}.`);
      continue;
    }
    if (!mutationTriggers.includes(trigger)) mutationTriggers.push(trigger);
  }
  config.mutationGateOn = mutationTriggers;
  config.mutationCommand = String(config.mutationCommand || "").trim();

  if (config.requireMutation && !config.mutationCommand) {
    errors.push(`requireMutation is true but mutationCommand is empty — set one or disable the mutation gate.`);
  }

  // Coverage sanity
  const coverageLanes = lanes.filter((l) => l.coverage === "include");
  const hasNonZeroThreshold = Object.values(config.coverageThresholds).some((v) => Number(v) > 0);

  if (coverageLanes.length === 0 && hasNonZeroThreshold) {
    warnings.push(
      `Coverage thresholds are set but no lane has coverage:"include" — the coverage gate cannot run. ` +
        `Set coverage:"include" and coverageSummaryPath on the lane that produces your report, or set all thresholds to 0.`
    );
  }

  const duplicateSummaryPaths = coverageLanes
    .map((l) => l.coverageSummaryPath)
    .filter((p, i, arr) => p && arr.indexOf(p) !== i);
  if (duplicateSummaryPaths.length) {
    warnings.push(
      `Lanes share coverageSummaryPath (${[...new Set(duplicateSummaryPaths)].join(", ")}). ` +
        `Each lane must write its own report, otherwise the later lane overwrites the earlier one and coverage is undercounted.`
    );
  }

  // A lane gating taskCompleted with a long timeout will stall every task.
  for (const lane of lanes) {
    if (lane.gateOn.includes("taskCompleted") && lane.timeoutMs > 900000) {
      warnings.push(
        `Lane '${lane.name}' gates taskCompleted with a ${Math.round(lane.timeoutMs / 60000)} min timeout. ` +
          `Long suites belong on the push trigger — set "gateOn": ["push"].`
      );
    }
  }

  config.preflightCommand = String(config.preflightCommand || "").trim();
  config.bypassEnv = String(config.bypassEnv || DEFAULTS.bypassEnv).trim() || DEFAULTS.bypassEnv;

  return { config: errors.length ? null : config, errors, warnings, notes };
}

function configPath(cwd) {
  return path.join(cwd, ".claude", "tdd-guardian", "config.json");
}

function statePath(cwd) {
  return path.join(cwd, ".claude", "tdd-guardian", "state.json");
}

/**
 * Read, migrate, and validate the workspace config.
 * @returns {{config: object|null, errors: string[], warnings: string[], notes: string[], exists: boolean}}
 */
function load(cwd) {
  const file = configPath(cwd);

  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return { config: null, errors: [], warnings: [], notes: [], exists: false };
    }
    return { config: null, errors: [`Could not read ${file}: ${err.message}`], warnings: [], notes: [], exists: true };
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      config: null,
      errors: [`TDD Guardian config at .claude/tdd-guardian/config.json is not valid JSON.\n\nParser error: ${err.message}`],
      warnings: [],
      notes: [],
      exists: true,
    };
  }

  // `raw` is returned alongside the validated config so callers can consult the
  // user's own enabled/enforce flags even when validation failed — otherwise a
  // malformed config in a project that never wanted enforcement would still block.
  return { ...validate(raw), raw, exists: true };
}

function isBypassed(config) {
  const name = String(config?.bypassEnv || DEFAULTS.bypassEnv);
  return ["1", "true", "yes"].includes(String(process.env[name] || "").toLowerCase());
}

module.exports = {
  load,
  validate,
  migrate,
  configPath,
  statePath,
  isBypassed,
  normalizeTrigger,
  SCHEMA_VERSION,
  TRIGGERS,
  COVERAGE_PARTICIPATION,
  COVERAGE_MODES,
  DEFAULT_THRESHOLDS,
  DEFAULT_LANE_TIMEOUT_MS,
  DEFAULTS,
};
