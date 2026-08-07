#!/usr/bin/env node
"use strict";
// PreToolUse hook — checks that every lane gating this action has a fresh pass
// before allowing a commit or a push.
//
// Commit-class and push-class commands are gated separately: a lane bound only to
// `push` (typically e2e) does not have to be fresh to commit, but does to push.
// `push` subsumes `commit`.
//
// Hook output schema: { permissionDecision: "allow"|"deny", permissionDecisionReason: string }

const fs = require("fs");

const configLib = require("./lib/config");
const lanesLib = require("./lib/lanes");

function respond(decision, reason) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    })
  );
}

function deny(reason) {
  respond("deny", reason);
}

function warn(reason) {
  respond("allow", "⚠ TDD Guardian warning: " + reason);
}

function readPayload() {
  let raw;
  try {
    raw = fs.readFileSync(0, "utf8").trim();
  } catch {
    // Fail open on a broken stdin: the hook must never wedge the session.
    console.error("[tdd-guardian] Warning: stdin read failed, allowing command (fail-open)");
    return null;
  }
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildReason(action, freshness, config) {
  const label = action === "push" ? "push/publish" : "commit";
  const lines = [
    `Quality gates are not fresh for this ${label}.`,
    "",
    "Stale lanes:",
    ...freshness.stale.map((s) => `  • ${s.name} — ${s.reason}`),
  ];

  if (freshness.fresh.length) {
    lines.push("", "Fresh lanes:", ...freshness.fresh.map((s) => `  • ${s.name} — ${s.reason}`));
  }

  lines.push(
    "",
    `Run \`/tdd-guardian:gate ${action}\` to run the required lanes, then retry.`,
    `To proceed without gates, set ${config.bypassEnv}=1 — only with explicit user consent.`
  );

  return lines.join("\n");
}

function main() {
  const payload = readPayload();
  if (!payload) return;
  if (payload.tool_name !== "Bash") return;

  const command = String((payload.tool_input || {}).command || "").trim();
  if (!command) return;

  const action = lanesLib.classifyCommand(command);
  if (!action) return;

  const cwd = payload.cwd || process.cwd();
  const loaded = configLib.load(cwd);

  // Uninitialised project — never block.
  if (!loaded.exists) return;

  if (loaded.errors.length) {
    const raw = loaded.raw || {};
    if (raw.enabled === false || raw.blockCommitWithoutFreshGate !== true) return;
    deny(
      ["TDD Guardian config is invalid, so gate freshness cannot be verified.", "", ...loaded.errors, "", "Fix the config or run /tdd-guardian:init."].join("\n")
    );
    return;
  }

  const config = loaded.config;
  if (!config.enabled) return;
  if (configLib.isBypassed(config)) return;
  if (!config.blockCommitWithoutFreshGate) return;

  const state = lanesLib.loadState(cwd);
  const freshness = lanesLib.checkFreshness(config, state, action, cwd);

  if (freshness.required.length === 0) {
    // No lane claims this trigger. Say so rather than implying gates passed —
    // silence here would read as approval.
    console.error(`[tdd-guardian] No lane gates '${action}'; allowing. Add "${action}" to a lane's gateOn to enforce.`);
    return;
  }

  if (freshness.ok) return;

  const reason = buildReason(action, freshness, config);
  if (config.staleGateAction === "warn") {
    warn(reason);
  } else {
    deny(reason);
  }
}

main();
