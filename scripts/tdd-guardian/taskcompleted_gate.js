#!/usr/bin/env node
"use strict";

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const DEFAULT_THRESHOLDS = {
  lines: 100,
  functions: 100,
  branches: 100,
  statements: 100,
};

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function runCmd(command, cwd) {
  try {
    const output = execSync(command, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return [true, output.trim()];
  } catch (err) {
    const stdout = (err.stdout || "").trim();
    const stderr = (err.stderr || "").trim();
    const output = stdout + (stderr ? "\n" + stderr : "");
    return [false, output.trim()];
  }
}

function checkCoverage(config, cwd) {
  let summaryPath = String(config.coverageSummaryPath || "coverage/coverage-summary.json");
  if (!path.isAbsolute(summaryPath)) {
    summaryPath = path.join(cwd, summaryPath);
  }

  const summary = loadJson(summaryPath);
  if (!summary || typeof summary !== "object") {
    return [false, `Coverage summary not found or invalid: ${summaryPath}`];
  }

  const total = summary.total || {};
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(config.coverageThresholds || {}) };

  const failures = [];
  const checks = {};
  for (const [key, threshold] of Object.entries(thresholds)) {
    const data = total[key] || {};
    const actual = typeof data.pct === "number" ? data.pct : -1;
    checks[key] = actual;
    if (actual < Number(threshold)) {
      failures.push(`${key}: ${actual.toFixed(2)}% < ${Number(threshold).toFixed(2)}%`);
    }
  }

  if (failures.length > 0) {
    return [false, "Coverage gate failed: " + failures.join("; ")];
  }

  return [
    true,
    "Coverage gate passed: " + Object.entries(checks).map(([k, v]) => `${k}=${v.toFixed(2)}%`).join(", "),
  ];
}

function block(reason, context) {
  console.log(
    JSON.stringify({
      decision: "block",
      reason,
      hookSpecificOutput: {
        hookEventName: "TaskCompleted",
        additionalContext: context,
      },
    })
  );
}

function main() {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8").trim();
  } catch {
    return;
  }

  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }

  const cwd = payload.cwd || process.cwd();
  const configPath = path.join(cwd, ".claude", "tdd-guardian", "config.json");
  const statePath = path.join(cwd, ".claude", "tdd-guardian", "state.json");

  const config = loadJson(configPath) || {};
  if (!config.enabled) return;
  if (config.enforceOnTaskCompleted === false) return;

  const bypassEnv = String(config.bypassEnv || "TDD_GUARD_BYPASS");
  if (["1", "true", "yes"].includes((process.env[bypassEnv] || "").toLowerCase())) {
    writeJson(statePath, {
      last_gate_passed_at: new Date().toISOString(),
      last_result: "bypassed",
    });
    return;
  }

  const executionLog = [];

  const preflight = String(config.preflightCommand || "").trim();
  if (preflight) {
    const [ok, out] = runCmd(preflight, cwd);
    executionLog.push(`$ ${preflight}\n${out}`);
    if (!ok) {
      block("Preflight command failed", executionLog.join("\n\n").slice(-8000));
      return;
    }
  }

  for (const key of ["testCommand", "coverageCommand"]) {
    const command = String(config[key] || "").trim();
    if (!command) {
      block(
        `Missing required setting: ${key}`,
        "Run /tdd-guardian:init and provide project commands."
      );
      return;
    }
    const [ok, out] = runCmd(command, cwd);
    executionLog.push(`$ ${command}\n${out}`);
    if (!ok) {
      block(`${key} failed`, executionLog.join("\n\n").slice(-8000));
      return;
    }
  }

  const [coverageOk, coverageMsg] = checkCoverage(config, cwd);
  executionLog.push(coverageMsg);
  if (!coverageOk) {
    block("Coverage gate failed", executionLog.join("\n\n").slice(-8000));
    return;
  }

  const requireMutation = Boolean(config.requireMutation);
  const mutationCommand = String(config.mutationCommand || "").trim();
  if (requireMutation) {
    if (!mutationCommand) {
      block(
        "Mutation gate enabled but mutationCommand is missing",
        "Set mutationCommand in .claude/tdd-guardian/config.json"
      );
      return;
    }
    const [ok, out] = runCmd(mutationCommand, cwd);
    executionLog.push(`$ ${mutationCommand}\n${out}`);
    if (!ok) {
      block("Mutation gate failed", executionLog.join("\n\n").slice(-8000));
      return;
    }
  }

  writeJson(statePath, {
    last_gate_passed_at: new Date().toISOString(),
    last_result: "passed",
    require_mutation: requireMutation,
    coverage_summary_path: String(config.coverageSummaryPath || "coverage/coverage-summary.json"),
  });
}

main();
