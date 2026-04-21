#!/usr/bin/env node
"use strict";

const {
  computeSourceFingerprint,
  createRunLog,
  guardPaths,
  isBypassed,
  isGateFreshForCurrentSource,
  loadConfig,
  loadState,
  readStdinJson,
} = require("./shared");

const BLOCK_PATTERNS = [
  /\bgit\s+commit\b/,
  /\bgit\s+push\b/,
  /\bgh\s+pr\s+(create|merge)\b/,
  /\b(npm|pnpm|yarn)\s+publish\b/,
];

function deny(reason) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
      systemMessage: reason,
    })
  );
}

function main() {
  const payload = readStdinJson();
  const cwd = payload.cwd || process.cwd();
  let log;

  try {
    log = createRunLog(cwd, "pretool", payload);

    const toolName = String(payload.tool_name || "");
    if (toolName && !/^(Bash|exec_command)$/.test(toolName)) {
      log.append(`skip: unsupported tool_name ${toolName}`);
      log.flush();
      return;
    }

    const command = String((payload.tool_input || {}).command || "").trim();
    log.append(`command: ${command}`);

    if (!command || !BLOCK_PATTERNS.some((pattern) => pattern.test(command))) {
      log.append("skip: command is not a guarded release action");
      log.flush();
      return;
    }

    const config = loadConfig(cwd);
    if (!config || !config.enabled) {
      log.append("skip: no enabled .codex/tdd-guardian/config.json found");
      log.flush();
      return;
    }

    if (isBypassed(config)) {
      log.append(`allow: bypass env ${config.bypassEnv} is set`);
      log.flush();
      return;
    }

    if (config.blockCommitWithoutFreshGate === false) {
      log.append("allow: blockCommitWithoutFreshGate=false");
      log.flush();
      return;
    }

    const state = loadState(cwd);
    const current = computeSourceFingerprint(cwd, config);
    log.append(`source_files: ${current.files.length}`);
    log.append(`fingerprint: ${current.fingerprint}`);
    log.append(`last_passed_fingerprint: ${state.last_passed_fingerprint || ""}`);

    if (isGateFreshForCurrentSource(config, state, current, cwd)) {
      log.append("allow: gates are fresh for current source fingerprint");
      log.flush();
      return;
    }

    const paths = guardPaths(cwd);
    const reason =
      "TDD Guardian blocked this release command because quality gates are stale, missing, or failing. " +
      `Run the configured gates or let the code-change gate pass first. State: ${paths.state}`;
    log.append("deny: " + reason);
    log.flush();
    deny(reason);
  } catch (error) {
    if (log) {
      log.append(`error: ${error && error.stack ? error.stack : String(error)}`);
      log.flush();
    }
    deny("TDD Guardian failed while checking gate freshness; blocking release command by default.");
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
};
