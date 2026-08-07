#!/usr/bin/env node
"use strict";
// TaskCompleted hook — runs every lane bound to the taskCompleted trigger, then
// the coverage and mutation gates.
//
// Hook output schema: { decision: "block"|"allow", reason: string }

const fs = require("fs");

const configLib = require("./lib/config");
const lanesLib = require("./lib/lanes");
const coverageLib = require("./lib/coverage");
const exec = require("./lib/exec");

const MAX_CONTEXT_CHARS = 8000;

function block(reason, context) {
  console.log(
    JSON.stringify({
      decision: "block",
      reason,
      hookSpecificOutput: {
        hookEventName: "TaskCompleted",
        additionalContext: String(context || "").slice(-MAX_CONTEXT_CHARS),
      },
    })
  );
}

function readPayload() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function laneFailureReport(lane, result) {
  const lines = [`Lane '${lane.name}' failed at the ${result.phase} phase (status: ${result.status}).`, ""];

  if (result.phase === "setup") {
    lines.push(`Setup command: ${lane.setupCommand}`);
  } else if (result.phase === "coverage-report") {
    lines.push(result.coverageError || `Coverage report command: ${lane.coverageReportCommand}`);
  } else {
    lines.push(`Command: ${lane.command}`);
  }

  if (result.exitCode !== null) lines.push(`Exit code: ${result.exitCode}`);
  if (result.testCounts) {
    const c = result.testCounts;
    lines.push(`Tests: ${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped, ${c.total} total`);
  }

  if (exec.isEnvironmentFailure(result.status)) {
    lines.push("", "This is an environment failure, not a test failure. Fix the runner before changing code or tests.");
  }
  if (result.status === "no-tests") {
    lines.push(
      "",
      "The runner discovered zero tests, and this lane HAS had tests before — so this is a regression, not a greenfield state.",
      "Either the tests were deleted, or test discovery broke (a moved directory, a changed glob, a renamed config).",
      "Run /tdd-guardian:probe to see what the lane currently discovers."
    );
  }
  if (result.status === "timeout") {
    lines.push("", `The lane exceeded its ${Math.round(lane.timeoutMs / 1000)}s timeout. Raise lane.timeoutMs, or move this suite to the push trigger.`);
  }

  if (result.stdoutTail) lines.push("", "--- stdout (tail) ---", result.stdoutTail);
  if (result.stderrTail) lines.push("", "--- stderr (tail) ---", result.stderrTail);
  if (result.teardownWarning) lines.push("", result.teardownWarning);

  return lines.join("\n");
}

function runCoverageGate(config, laneResults, state, cwd, bootstrapLanes) {
  const reports = laneResults.filter((r) => r.coverageReport).map((r) => r.coverageReport);
  const inBootstrap = bootstrapLanes.length > 0;

  if (reports.length === 0) {
    const wantsCoverage = Object.values(config.coverageThresholds).some((v) => Number(v) > 0);
    if (!wantsCoverage) return { ok: true, message: "Coverage gate skipped (all thresholds are 0).", record: null };
    // A lane with no tests yet produces no coverage. That is the greenfield state,
    // not a misconfiguration.
    if (inBootstrap) {
      return {
        ok: true,
        message: `Coverage gate skipped — ${bootstrapLanes.join(", ")} has no tests yet, so there is nothing to measure.`,
        record: null,
      };
    }
    return {
      ok: false,
      message:
        "Coverage thresholds are set but no lane produced a coverage report.\n" +
        'Set coverage:"include" and coverageSummaryPath on the lane that emits coverage, or set all thresholds to 0.',
      record: null,
    };
  }

  const merged = coverageLib.mergeReports(reports);

  // A report that measured nothing scores 100% under the 0/0 convention. Passing
  // on that would turn a silent no-op coverage run into a green gate — unless the
  // lane genuinely has no tests yet, which the bootstrap ratchet distinguishes.
  if (coverageLib.isEmpty(merged.totals)) {
    if (inBootstrap) {
      return {
        ok: true,
        message: `Coverage gate skipped — ${bootstrapLanes.join(", ")} has no tests yet, so the report is empty.`,
        record: null,
      };
    }
    return {
      ok: false,
      message:
        "Coverage report contains zero measurable lines. The coverage run almost certainly produced nothing.\n" +
        `Formats read: ${merged.formats.join(", ")}. Check that the coverage command instruments your source and writes to coverageSummaryPath.`,
      record: null,
    };
  }

  const percentages = coverageLib.totalsToPercentages(merged.totals);
  const record = {
    timestamp: new Date().toISOString(),
    method: merged.method,
    formats: merged.formats,
    approximate: merged.approximate,
    totals: percentages,
  };

  const notes = [];
  if (merged.approximate) {
    notes.push(
      `NOTE: coverage from ${merged.formats.length} lanes was combined as a weighted average, not a true union, ` +
        `because at least one report lacks per-line detail (${merged.formats.join(", ")}). ` +
        `Lines covered by more than one lane are counted more than once. Emit LCOV or Cobertura from every lane for an exact merge.`
    );
  }

  if (String(config.coverageMode) === "no-decrease") {
    const branch = lanesLib.currentBranch(cwd) || "unknown";
    const baseline = state.baseline;

    if (!baseline || !baseline.coverage || baseline.branch !== branch) {
      record.status = "BASELINE";
      return {
        ok: true,
        message: [`Coverage baseline recorded for branch '${branch}': ${describeTotals(percentages)}`, ...notes].join("\n"),
        record,
        newBaseline: { branch, recorded_at: new Date().toISOString(), coverage: percentages },
      };
    }

    const cmp = coverageLib.compareToBaseline(merged.totals, baseline.coverage);
    record.status = cmp.ok ? "PASS" : "FAIL";
    return {
      ok: cmp.ok,
      message: cmp.ok
        ? [`Coverage gate passed (no decrease from baseline): ${cmp.summary}`, ...notes].join("\n")
        : ["Coverage decreased from baseline: " + cmp.failures.join("; "), ...notes].join("\n"),
      record,
    };
  }

  const cmp = coverageLib.compareToThresholds(merged.totals, config.coverageThresholds);
  record.status = cmp.ok ? "PASS" : "FAIL";
  const warnings = cmp.warnings.length ? ["", ...cmp.warnings.map((w) => "WARNING: " + w)] : [];

  return {
    ok: cmp.ok,
    message: cmp.ok
      ? [`Coverage gate passed: ${cmp.summary}`, ...notes, ...warnings].join("\n")
      : ["Coverage gate failed: " + cmp.failures.join("; "), ...notes, ...warnings].join("\n"),
    record,
  };
}

function describeTotals(percentages) {
  return Object.entries(percentages)
    .map(([k, v]) => `${k}=${v === null ? "n/a" : v.toFixed(2) + "%"}`)
    .join(", ");
}

function main() {
  const payload = readPayload();
  const cwd = payload.cwd || process.cwd();

  const loaded = configLib.load(cwd);

  // No config at all: this project has not opted in. Stay silent.
  if (!loaded.exists) return;

  if (loaded.errors.length) {
    // Consult the user's own flags before blocking on a broken config — a project
    // that never enabled enforcement should not be stopped by a config it ignores.
    const raw = loaded.raw || {};
    if (raw.enabled === false || raw.enforceOnTaskCompleted !== true) return;
    block("TDD Guardian config is invalid", loaded.errors.join("\n\n"));
    return;
  }

  const config = loaded.config;
  if (!config.enabled) return;
  if (!config.enforceOnTaskCompleted) return;

  const state = lanesLib.loadState(cwd);
  state.config_warnings = loaded.warnings;
  for (const warning of loaded.warnings) console.error(`[tdd-guardian] ${warning}`);

  if (configLib.isBypassed(config)) {
    state.bypassed_at = new Date().toISOString();
    lanesLib.saveState(cwd, state);
    console.error(`[tdd-guardian] Gates bypassed via ${config.bypassEnv}.`);
    return;
  }

  const log = [];
  if (loaded.notes.length) log.push(...loaded.notes);

  if (config.preflightCommand) {
    const result = exec.run(config.preflightCommand, cwd, { timeoutMs: 300000 });
    log.push(`$ ${config.preflightCommand}\n${result.stdoutTail}\n${result.stderrTail}`.trim());
    if (result.status !== "pass") {
      block(
        "Preflight command failed",
        [
          `Preflight failed: \`${config.preflightCommand}\``,
          `Exit code: ${result.exitCode}`,
          "",
          result.stderrTail || result.stdoutTail,
          "",
          "Fix the preflight (missing dependencies? stale lockfile?) before the gates can run.",
        ].join("\n")
      );
      return;
    }
  }

  const lanes = lanesLib.lanesForTrigger(config, "taskCompleted");
  if (lanes.length === 0) {
    console.error("[tdd-guardian] No lanes are bound to the taskCompleted trigger — nothing to run.");
    return;
  }

  const sha = lanesLib.headSha(cwd) || "";
  const laneResults = [];
  const bootstrapLanes = [];

  for (const lane of lanes) {
    const result = lanesLib.runLane(lane, cwd);
    laneResults.push(result);
    const entry = lanesLib.recordLaneResult(state, lane.name, result, sha);

    // A lane that has never had a test is greenfield, not broken. Report it loudly
    // on every run — the invariant this protects is "a silent zero-test run must
    // not look green", and nothing here is silent.
    if (entry.last_result === "bootstrap") {
      bootstrapLanes.push(lane.name);
      const note =
        `Lane '${lane.name}': BOOTSTRAP — 0 tests, and this lane has never had any.\n` +
        `  Write the first test. Once this lane has run even one, a zero-test run becomes a hard failure.`;
      log.push(note);
      console.error(`[tdd-guardian] ${note.replace(/\n\s*/g, " ")}`);
      continue;
    }

    log.push(lanesLib.describeResult(result));

    if (!result.ok) {
      if (lane.optional) {
        log.push(`Lane '${lane.name}' is marked optional — recording the failure without blocking.`);
        continue;
      }
      lanesLib.saveState(cwd, state);
      block(`Lane '${lane.name}' failed`, [laneFailureReport(lane, result), "", "--- gate log ---", ...log].join("\n"));
      return;
    }
  }

  const coverageGate = runCoverageGate(config, laneResults, state, cwd, bootstrapLanes);
  log.push(coverageGate.message);
  if (coverageGate.record) state.coverage = coverageGate.record;
  if (coverageGate.newBaseline) state.baseline = coverageGate.newBaseline;

  if (!coverageGate.ok) {
    lanesLib.saveState(cwd, state);
    block("Coverage gate failed", log.join("\n\n"));
    return;
  }

  if (config.requireMutation && config.mutationGateOn.includes("taskCompleted")) {
    const result = exec.run(config.mutationCommand, cwd, { timeoutMs: 1800000 });
    log.push(`$ ${config.mutationCommand}\n${result.stdoutTail}`);
    state.mutation = {
      timestamp: new Date().toISOString(),
      status: result.status === "pass" ? "PASS" : "FAIL",
      command: config.mutationCommand,
    };
    if (result.status !== "pass") {
      lanesLib.saveState(cwd, state);
      block("Mutation gate failed", log.join("\n\n"));
      return;
    }
  }

  state.last_gate_passed_at = new Date().toISOString();
  state.last_head_sha = sha;
  state.last_result = "passed";
  lanesLib.saveState(cwd, state);
}

main();
