#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_THRESHOLDS = {
  lines: 100,
  functions: 100,
  branches: 100,
  statements: 100,
};

const DEFAULT_SOURCE_EXTENSIONS = [
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".php",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".sql",
  ".html",
  ".css",
  ".scss",
  ".vue",
  ".svelte",
];

const DEFAULT_IGNORE_PATHS = [
  ".git",
  ".codex/tdd-guardian/logs",
  "node_modules",
  "coverage",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "target",
  ".venv",
  "venv",
];

const DEFAULT_CONFIG = {
  enabled: true,
  enforceOnCodeChange: true,
  blockCommitWithoutFreshGate: true,
  gateFreshnessMinutes: 120,
  bypassEnv: "TDD_GUARD_BYPASS",
  preflightCommand: "",
  testCommand: "pnpm test",
  coverageCommand: "pnpm test -- --coverage",
  coverageSummaryPath: "coverage/coverage-summary.json",
  coverageThresholds: DEFAULT_THRESHOLDS,
  coverageMode: "absolute",
  smartStaleness: true,
  requireMutation: false,
  mutationCommand: "",
  sourceExtensions: DEFAULT_SOURCE_EXTENSIONS,
  ignorePaths: DEFAULT_IGNORE_PATHS,
};

function normalizeRel(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

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

function readStdinJson() {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8").trim();
  } catch {
    return {};
  }

  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function guardPaths(cwd) {
  const root = path.join(cwd, ".codex", "tdd-guardian");
  return {
    root,
    config: path.join(root, "config.json"),
    state: path.join(root, "state.json"),
    logs: path.join(root, "logs"),
  };
}

function mergeConfig(config) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...(config || {}),
    coverageThresholds: {
      ...DEFAULT_THRESHOLDS,
      ...((config && config.coverageThresholds) || {}),
    },
    sourceExtensions:
      config && Array.isArray(config.sourceExtensions)
        ? config.sourceExtensions
        : DEFAULT_SOURCE_EXTENSIONS,
    ignorePaths:
      config && Array.isArray(config.ignorePaths) ? config.ignorePaths : DEFAULT_IGNORE_PATHS,
  };

  if (Object.prototype.hasOwnProperty.call(merged, "enforceOnTaskCompleted")) {
    merged.enforceOnCodeChange = Boolean(merged.enforceOnTaskCompleted);
  }

  return merged;
}

function loadConfig(cwd) {
  const paths = guardPaths(cwd);
  const config = loadJson(paths.config);
  if (!config) return null;
  return mergeConfig(config);
}

function loadState(cwd) {
  return loadJson(guardPaths(cwd).state) || {};
}

function writeState(cwd, state) {
  writeJson(guardPaths(cwd).state, state);
}

function boolEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function isBypassed(config) {
  return boolEnv(process.env[String(config.bypassEnv || "TDD_GUARD_BYPASS")]);
}

function runCommand(command, cwd) {
  const startedAt = Date.now();
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  return {
    command,
    cwd,
    ok: result.status === 0,
    status: result.status,
    signal: result.signal || null,
    stdout,
    stderr,
    output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n"),
    durationMs: Date.now() - startedAt,
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

function gitOutput(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return null;
  return String(result.stdout || "").trim();
}

function getHeadSha(cwd) {
  return gitOutput(cwd, ["rev-parse", "HEAD"]) || "";
}

function getCurrentBranch(cwd) {
  return gitOutput(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) || "";
}

function isIgnored(relPath, ignorePaths) {
  const rel = normalizeRel(relPath);
  return ignorePaths.map(normalizeRel).some((ignored) => {
    if (!ignored) return false;
    return rel === ignored || rel.startsWith(ignored + "/");
  });
}

function isSourceFile(relPath, config) {
  const rel = normalizeRel(relPath);
  if (!rel || isIgnored(rel, config.ignorePaths || DEFAULT_IGNORE_PATHS)) return false;
  const ext = path.extname(rel).toLowerCase();
  return Boolean(ext) && new Set(config.sourceExtensions || DEFAULT_SOURCE_EXTENSIONS).has(ext);
}

function gitFiles(cwd) {
  const result = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(normalizeRel);
}

function walkFiles(root, dir = root, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = normalizeRel(path.relative(root, full));
    if (entry.isDirectory()) {
      if (!isIgnored(rel, DEFAULT_IGNORE_PATHS)) walkFiles(root, full, acc);
      continue;
    }
    if (entry.isFile()) acc.push(rel);
  }
  return acc;
}

function listSourceFiles(cwd, config) {
  const files = gitFiles(cwd) || walkFiles(cwd);
  return [...new Set(files)].filter((file) => isSourceFile(file, config)).sort();
}

function computeSourceFingerprint(cwd, config) {
  const files = listSourceFiles(cwd, config);
  const entries = [];
  for (const rel of files) {
    const fullPath = path.join(cwd, rel);
    try {
      const data = fs.readFileSync(fullPath);
      entries.push({
        path: rel,
        size: data.length,
        hash: sha256(data),
      });
    } catch {
      entries.push({
        path: rel,
        missing: true,
      });
    }
  }

  const payload = {
    version: 1,
    files: entries,
  };

  return {
    fingerprint: sha256(JSON.stringify(payload)),
    files,
    entries,
    head: getHeadSha(cwd),
  };
}

function hasSourceChangedSince(sha, cwd, config) {
  if (!sha || !/^[0-9a-f]{40,64}$/i.test(sha)) return true;
  const output = gitOutput(cwd, ["diff", "--name-only", sha, "HEAD"]);
  if (output === null) return true;
  if (!output) return false;
  return output.split(/\r?\n/).some((file) => isSourceFile(file, config));
}

function isTimestampFresh(stamp, freshnessMinutes) {
  if (!stamp) return false;
  const time = new Date(stamp).getTime();
  if (!Number.isFinite(time)) return false;
  return (Date.now() - time) / 60000 <= Number(freshnessMinutes || 120);
}

function isGateFreshForCurrentSource(config, state, current, cwd) {
  if (!state || state.last_result === "failed") return false;

  const smart = config.smartStaleness !== false;
  const timestampFresh = isTimestampFresh(state.last_gate_passed_at, config.gateFreshnessMinutes);

  if (state.last_passed_fingerprint && state.last_passed_fingerprint === current.fingerprint) {
    return smart || timestampFresh;
  }

  if (smart && cwd && state.last_head_sha && !hasSourceChangedSince(state.last_head_sha, cwd, config)) {
    return true;
  }

  return false;
}

function parseCoverageMetrics(config, cwd) {
  let summaryPath = String(config.coverageSummaryPath || "coverage/coverage-summary.json");
  if (!path.isAbsolute(summaryPath)) summaryPath = path.join(cwd, summaryPath);

  const summary = loadJson(summaryPath);
  if (!summary || typeof summary !== "object") {
    return [null, `Coverage summary not found or invalid: ${summaryPath}`];
  }

  const total = summary.total || {};
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(config.coverageThresholds || {}) };
  const metrics = {};
  for (const key of Object.keys(thresholds)) {
    const data = total[key] || {};
    metrics[key] = typeof data.pct === "number" ? data.pct : -1;
  }
  return [metrics, null];
}

function checkCoverageAbsolute(metrics, thresholds) {
  const failures = [];
  for (const [key, threshold] of Object.entries(thresholds)) {
    const actual = metrics[key];
    if (actual < Number(threshold)) {
      failures.push(`${key}: ${actual.toFixed(2)}% < ${Number(threshold).toFixed(2)}%`);
    }
  }

  if (failures.length > 0) return [false, "Coverage gate failed: " + failures.join("; "), null];

  const summary = Object.entries(metrics)
    .map(([key, value]) => `${key}=${value.toFixed(2)}%`)
    .join(", ");
  return [true, "Coverage gate passed: " + summary, null];
}

function checkCoverageNoDecrease(metrics, state, cwd) {
  const branch = getCurrentBranch(cwd) || "unknown";
  const baseline = state.baseline;
  const summary = Object.entries(metrics)
    .map(([key, value]) => `${key}=${value.toFixed(2)}%`)
    .join(", ");

  if (!baseline || !baseline.coverage || baseline.branch !== branch) {
    return [
      true,
      `Baseline recorded for branch '${branch}': ${summary}`,
      {
        branch,
        recorded_at: new Date().toISOString(),
        coverage: { ...metrics },
      },
    ];
  }

  const failures = [];
  for (const [key, current] of Object.entries(metrics)) {
    const base = typeof baseline.coverage[key] === "number" ? baseline.coverage[key] : -1;
    if (current < base) {
      failures.push(
        `${key}: ${current.toFixed(2)}% < baseline ${base.toFixed(2)}% (delta ${(current - base).toFixed(2)}%)`
      );
    }
  }

  if (failures.length > 0) {
    return [false, "Coverage decreased from baseline: " + failures.join("; "), null];
  }

  return [true, "Coverage gate passed (no decrease from baseline): " + summary, null];
}

function checkCoverage(config, cwd, state) {
  const [metrics, err] = parseCoverageMetrics(config, cwd);
  if (!metrics) return [false, err, null];

  if (String(config.coverageMode || "absolute") === "no-decrease") {
    return checkCoverageNoDecrease(metrics, state, cwd);
  }

  return checkCoverageAbsolute(metrics, { ...DEFAULT_THRESHOLDS, ...(config.coverageThresholds || {}) });
}

function logFileName(kind) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${kind}-${process.pid}.log`;
}

function createRunLog(cwd, kind, payload) {
  const paths = guardPaths(cwd);
  fs.mkdirSync(paths.logs, { recursive: true });
  const filePath = path.join(paths.logs, logFileName(kind));
  const lines = [];

  function append(value) {
    lines.push(String(value));
  }

  append(`kind: ${kind}`);
  append(`cwd: ${cwd}`);
  append(`pid: ${process.pid}`);
  append(`platform: ${process.platform}`);
  append(`node: ${process.version}`);
  append(`start: ${new Date().toISOString()}`);
  append(`payload: ${JSON.stringify(payload || {})}`);
  append("");

  function flush(extra) {
    if (extra) append(extra);
    append("");
    append(`end: ${new Date().toISOString()}`);
    fs.writeFileSync(filePath, lines.join(os.EOL) + os.EOL);
  }

  return {
    path: filePath,
    append,
    flush,
  };
}

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_IGNORE_PATHS,
  DEFAULT_SOURCE_EXTENSIONS,
  DEFAULT_THRESHOLDS,
  checkCoverage,
  computeSourceFingerprint,
  createRunLog,
  getHeadSha,
  guardPaths,
  isBypassed,
  isGateFreshForCurrentSource,
  isSourceFile,
  listSourceFiles,
  loadConfig,
  loadJson,
  loadState,
  mergeConfig,
  readStdinJson,
  runCommand,
  writeJson,
  writeState,
};
