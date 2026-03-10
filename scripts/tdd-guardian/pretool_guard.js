#!/usr/bin/env node
"use strict";
// Hook output schema (PreToolUse): { permissionDecision: "allow"|"deny", permissionDecisionReason: string }

const { execSync } = require("child_process");
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

// Non-source file extensions — changes to these don't invalidate gates
const NON_SOURCE_EXTS = new Set([
  ".md", ".mdx", ".txt", ".json", ".yaml", ".yml", ".toml",
  ".lock", ".log", ".csv", ".svg", ".png", ".jpg", ".jpeg",
  ".gif", ".ico", ".woff", ".woff2", ".ttf", ".eot",
]);

function isSourceFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext !== "" && !NON_SOURCE_EXTS.has(ext);
}

// SHA comes from our own state.json (written by taskcompleted_gate.js via git rev-parse),
// not from user input, so execSync is safe here.
function hasSourceChangedSince(sha, cwd) {
  if (!sha || !/^[0-9a-f]{40,64}$/i.test(sha)) return true;
  try {
    const output = execSync("git diff --name-only " + sha + " HEAD", {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!output) return false;
    return output.split("\n").some((f) => isSourceFile(f.trim()));
  } catch {
    return true;
  }
}

function main() {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8").trim();
  } catch {
    console.error("[tdd-guardian] Warning: stdin read failed, allowing command (fail-open)");
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

  const config = loadJson(configPath);
  if (!config || !config.enabled) {
    // No config or not enabled — silently allow (don't block uninitialised projects)
    return;
  }

  const bypassEnv = String(config.bypassEnv || "TDD_GUARD_BYPASS");
  if (["1", "true", "yes"].includes((process.env[bypassEnv] || "").toLowerCase())) return;

  if (config.blockCommitWithoutFreshGate === false) return;

  const state = loadJson(statePath) || {};
  const freshnessMinutes = Number(config.gateFreshnessMinutes) || 120;
  if (!isGateFresh(state, freshnessMinutes)) {
    // Smart staleness: if enabled and no source files changed since last gate, allow
    const smartStaleness = config.smartStaleness !== false; // default: true
    if (smartStaleness && state.last_head_sha && !hasSourceChangedSince(state.last_head_sha, cwd)) {
      return; // Gates still valid — no code changed
    }
    deny(
      "Blocked by TDD Guardian: quality gates are stale or missing. " +
        "Run your gate commands (tests, coverage, mutation if enabled), then retry."
    );
  }
}

main();
