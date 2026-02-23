#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const BLOCK_PATTERNS = [
  /\bgit\s+commit\b/,
  /\bgit\s+push\b/,
  /\bgh\s+pr\s+(create|merge)\b/,
  /\b(npm|pnpm|yarn)\s+publish\b/,
];

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function deny(reason) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
}

function isGateFresh(state, freshnessMinutes) {
  const stamp = state.last_gate_passed_at;
  if (!stamp) return false;
  const ts = new Date(stamp).getTime();
  if (isNaN(ts)) return false;
  const ageMinutes = (Date.now() - ts) / 60000;
  return ageMinutes <= freshnessMinutes;
}

function main() {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8").trim();
  } catch {
    return;
  }
  if (!raw) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  if (payload.tool_name !== "Bash") return;

  const command = String((payload.tool_input || {}).command || "").trim();
  if (!command) return;

  if (!BLOCK_PATTERNS.some((p) => p.test(command))) return;

  const cwd = payload.cwd || process.cwd();
  const configPath = path.join(cwd, ".claude", "tdd-guardian", "config.json");
  const statePath = path.join(cwd, ".claude", "tdd-guardian", "state.json");

  const config = loadJson(configPath) || {};
  if (!config.enabled) {
    deny("TDD Guardian is not enabled. Run /tdd-guardian:init first.");
    return;
  }

  const bypassEnv = String(config.bypassEnv || "TDD_GUARD_BYPASS");
  if (["1", "true", "yes"].includes((process.env[bypassEnv] || "").toLowerCase())) return;

  if (config.blockCommitWithoutFreshGate === false) return;

  const state = loadJson(statePath) || {};
  const freshnessMinutes = Number(config.gateFreshnessMinutes) || 120;
  if (!isGateFresh(state, freshnessMinutes)) {
    deny(
      "Blocked by TDD Guardian: quality gates are stale or missing. " +
        "Run your gate commands (tests, coverage, mutation if enabled), then retry."
    );
  }
}

main();
