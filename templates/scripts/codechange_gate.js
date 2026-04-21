#!/usr/bin/env node
"use strict";

const {
  checkCoverage,
  computeSourceFingerprint,
  createRunLog,
  getHeadSha,
  guardPaths,
  isBypassed,
  loadConfig,
  loadState,
  readStdinJson,
  runCommand,
  writeState,
} = require("./shared");

function shortLogPath(cwd, logPath) {
  if (!logPath) return "";
  if (logPath.startsWith(cwd)) return logPath.slice(cwd.length + 1);
  return logPath;
}

function outputFailure(eventName, reason, cwd, logPath) {
  const logRef = shortLogPath(cwd, logPath);
  const message = `${reason}. See ${logRef}`;

  if (eventName === "Stop") {
    console.log(
      JSON.stringify({
        decision: "block",
        reason: message,
        systemMessage: message,
      })
    );
    return;
  }

  console.log(
    JSON.stringify({
      decision: "block",
      reason: message,
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: message,
      },
      systemMessage: message,
    })
  );
}

function outputPass(eventName, cwd, logPath) {
  const message = `TDD Guardian gates passed after source changes. See ${shortLogPath(cwd, logPath)}`;
  if (eventName === "Stop") {
    console.log(JSON.stringify({ systemMessage: message }));
    return;
  }
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: message,
      },
      systemMessage: message,
    })
  );
}

function appendCommandLog(log, result) {
  log.append(`$ ${result.command}`);
  log.append(`exit: ${result.status}${result.signal ? ` signal=${result.signal}` : ""}`);
  log.append(`duration_ms: ${result.durationMs}`);
  if (result.error) log.append(`spawn_error: ${result.error}`);
  log.append("--- stdout ---");
  log.append(result.stdout || "");
  log.append("--- stderr ---");
  log.append(result.stderr || "");
  log.append("");
}

function runGateCommands(config, cwd, state, log) {
  const preflight = String(config.preflightCommand || "").trim();
  if (preflight) {
    const result = runCommand(preflight, cwd);
    appendCommandLog(log, result);
    if (!result.ok) return [false, "Preflight command failed", null];
  }

  for (const key of ["testCommand", "coverageCommand"]) {
    const command = String(config[key] || "").trim();
    if (!command) return [false, `Missing required setting: ${key}`, null];

    const result = runCommand(command, cwd);
    appendCommandLog(log, result);
    if (!result.ok) return [false, `${key} failed`, null];
  }

  const [coverageOk, coverageMessage, newBaseline] = checkCoverage(config, cwd, state);
  log.append(coverageMessage);
  if (!coverageOk) return [false, "Coverage gate failed", null];

  if (config.requireMutation) {
    const mutationCommand = String(config.mutationCommand || "").trim();
    if (!mutationCommand) {
      return [false, "Mutation gate enabled but mutationCommand is missing", null];
    }

    const result = runCommand(mutationCommand, cwd);
    appendCommandLog(log, result);
    if (!result.ok) return [false, "Mutation gate failed", null];
  }

  return [true, "All gates passed", newBaseline];
}

function stateWithCommonFields(state, current, result, cwd) {
  return {
    ...state,
    last_result: result,
    last_observed_fingerprint: current.fingerprint,
    last_observed_at: new Date().toISOString(),
    last_head_sha: getHeadSha(cwd) || current.head || "",
    source_file_count: current.files.length,
  };
}

function main() {
  const payload = readStdinJson();
  const cwd = payload.cwd || process.cwd();
  const eventName = String(payload.hook_event_name || "Stop");
  let log;

  try {
    log = createRunLog(cwd, "codechange", payload);

    const config = loadConfig(cwd);
    if (!config || !config.enabled) {
      log.append("skip: no enabled .codex/tdd-guardian/config.json found");
      log.flush();
      return;
    }

    if (config.enforceOnCodeChange === false) {
      log.append("skip: enforceOnCodeChange=false");
      log.flush();
      return;
    }

    const state = loadState(cwd);
    const current = computeSourceFingerprint(cwd, config);
    log.append(`event: ${eventName}`);
    log.append(`source_files: ${current.files.length}`);
    log.append(`fingerprint: ${current.fingerprint}`);
    log.append(`last_observed_fingerprint: ${state.last_observed_fingerprint || ""}`);
    log.append(`last_passed_fingerprint: ${state.last_passed_fingerprint || ""}`);

    if (isBypassed(config)) {
      const nextState = {
        ...stateWithCommonFields(state, current, "bypassed", cwd),
        last_gate_passed_at: new Date().toISOString(),
        last_passed_fingerprint: current.fingerprint,
      };
      writeState(cwd, nextState);
      log.append(`bypass: ${config.bypassEnv} is set`);
      log.flush();
      return;
    }

    if (current.files.length === 0) {
      writeState(cwd, stateWithCommonFields(state, current, "no-source-files", cwd));
      log.append("skip: no source files detected");
      log.flush();
      return;
    }

    const hasPassedCurrent = state.last_passed_fingerprint === current.fingerprint;
    if (hasPassedCurrent && state.last_result === "passed") {
      writeState(cwd, stateWithCommonFields(state, current, "passed", cwd));
      log.append("skip: current source fingerprint already passed");
      log.flush();
      return;
    }

    const firstObservation = !state.last_observed_fingerprint && !state.last_passed_fingerprint;
    if (firstObservation && config.runOnInitialDetection !== true) {
      writeState(cwd, stateWithCommonFields(state, current, "initialized", cwd));
      log.append("skip: initialized source fingerprint; gates run after the next source change");
      log.flush();
      return;
    }

    const [ok, reason, newBaseline] = runGateCommands(config, cwd, state, log);
    if (!ok) {
      const failedState = {
        ...stateWithCommonFields(state, current, "failed", cwd),
        last_failed_at: new Date().toISOString(),
        last_failed_fingerprint: current.fingerprint,
        last_failure_reason: reason,
        last_failure_log: log.path,
      };
      writeState(cwd, failedState);
      log.append(`result: failed`);
      log.append(`reason: ${reason}`);
      log.flush();
      outputFailure(eventName, reason, cwd, log.path);
      return;
    }

    const passedState = {
      ...stateWithCommonFields(state, current, "passed", cwd),
      last_gate_passed_at: new Date().toISOString(),
      last_passed_fingerprint: current.fingerprint,
      require_mutation: Boolean(config.requireMutation),
      coverage_summary_path: String(config.coverageSummaryPath || "coverage/coverage-summary.json"),
    };

    if (newBaseline) {
      passedState.baseline = newBaseline;
    } else if (state.baseline) {
      passedState.baseline = state.baseline;
    }

    writeState(cwd, passedState);
    log.append("result: passed");
    log.flush();
    outputPass(eventName, cwd, log.path);
  } catch (error) {
    if (log) {
      log.append(`error: ${error && error.stack ? error.stack : String(error)}`);
      log.flush();
      outputFailure(eventName, "TDD Guardian code-change gate crashed", cwd, log.path);
      return;
    }
    outputFailure(eventName, "TDD Guardian code-change gate crashed before log creation", cwd, "");
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  runGateCommands,
};
