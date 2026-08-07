"use strict";
// Lane selection, execution, state persistence, and freshness.
//
// Trigger escalation: `push` subsumes `commit`. Code being pushed must satisfy
// everything that gates a commit plus everything that gates a push. `taskCompleted`
// is independent — it RUNS gates rather than checking their freshness.

const fs = require("fs");
const path = require("path");

const exec = require("./exec");
const coverage = require("./coverage");
const { statePath } = require("./config");

const STATE_VERSION = 2;

// ---------------------------------------------------------------------------
// Command classification
// ---------------------------------------------------------------------------

// A dry run publishes nothing, so it must not be gated.
const DRY_RUN_RE = /--dry-run\b|--dryrun\b/;

// git's global options that consume the following token. Without this list,
// `git -C /repo commit` reads as subcommand "/repo".
const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

// Split a compound command into independently-classified segments, so that
// `git commit -m x && npm publish --dry-run` still registers the commit.
function splitSegments(command) {
  return command
    .split(/\|\||&&|;|\||\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Drop leading `FOO=bar` environment assignments and resolve `/usr/bin/git` to `git`.
function tokenize(segment) {
  const tokens = segment.split(/\s+/).filter(Boolean);
  let start = 0;
  while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start])) start++;
  const rest = tokens.slice(start);
  if (rest.length) rest[0] = path.basename(rest[0]);
  return rest;
}

// First non-flag token after the binary, honouring value-taking flags.
function subcommandOf(tokens) {
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (GIT_VALUE_FLAGS.has(token)) {
      i++;
      continue;
    }
    if (token.startsWith("-")) continue;
    return token;
  }
  return null;
}

function classifySegment(segment) {
  if (DRY_RUN_RE.test(segment)) return null;

  const tokens = tokenize(segment);
  if (tokens.length === 0) return null;

  const binary = tokens[0];
  const sub = subcommandOf(tokens);
  const args = tokens.slice(1).filter((t) => !t.startsWith("-"));

  switch (true) {
    case binary === "git":
      if (sub === "commit") return "commit";
      if (sub === "push") return "push";
      return null;
    case binary === "gh":
      return args[0] === "pr" && ["create", "merge"].includes(args[1]) ? "push" : null;
    case ["npm", "pnpm", "yarn", "bun", "cargo", "poetry", "uv"].includes(binary):
      return sub === "publish" ? "push" : null;
    case binary === "twine":
      return sub === "upload" ? "push" : null;
    case binary === "gem":
      return sub === "push" ? "push" : null;
    case binary === "dotnet":
      return args.includes("nuget") && args.includes("push") ? "push" : null;
    case binary === "mvn":
      return args.includes("deploy") ? "push" : null;
    case /^gradlew?(\.bat)?$/.test(binary):
      return args.some((a) => a.startsWith("publish")) ? "push" : null;
    case binary === "flutter":
      return args[0] === "pub" && args[1] === "publish" ? "push" : null;
    case binary === "mix":
      return sub === "hex.publish" ? "push" : null;
    default:
      return null;
  }
}

/**
 * Classify a shell command as a gated action.
 *
 * Works on tokenized segments rather than on the raw string, so quoted text such
 * as `echo "git push"` and `git commit -m "push to prod"` classify correctly.
 * When a compound command contains both, push wins — it is the stricter gate.
 *
 * @returns {"commit"|"push"|null}
 */
function classifyCommand(command) {
  const text = String(command || "");
  if (!text.trim()) return null;

  let result = null;
  for (const segment of splitSegments(text)) {
    const action = classifySegment(segment);
    if (action === "push") return "push";
    if (action === "commit") result = "commit";
  }
  return result;
}

/**
 * Lanes that must be fresh before the given action is allowed.
 * push subsumes commit; taskCompleted lanes are not implied by either.
 */
function lanesRequiredFor(config, action) {
  const lanes = Array.isArray(config?.lanes) ? config.lanes : [];
  if (action === "push") return lanes.filter((l) => l.gateOn.includes("commit") || l.gateOn.includes("push"));
  if (action === "commit") return lanes.filter((l) => l.gateOn.includes("commit"));
  return [];
}

/** Lanes bound to a trigger, for running (not freshness-checking). */
function lanesForTrigger(config, trigger) {
  const lanes = Array.isArray(config?.lanes) ? config.lanes : [];
  if (trigger === "push") return lanes.filter((l) => l.gateOn.includes("commit") || l.gateOn.includes("push"));
  return lanes.filter((l) => l.gateOn.includes(trigger));
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

// Checks the exit code directly rather than exec.run's classification, which is
// tuned for test runners and would misread git output.
function git(args, cwd) {
  const res = exec.run(`git ${args}`, cwd, { timeoutMs: 15000 });
  return res.exitCode === 0 ? res.stdout.trim() : null;
}

function headSha(cwd) {
  return git("rev-parse HEAD", cwd);
}

function currentBranch(cwd) {
  return git("rev-parse --abbrev-ref HEAD", cwd);
}

// Documentation and media only. Everything else — including manifests, lockfiles,
// configs, and fixtures — counts as source, because all of them can change test
// outcomes. Fail closed: a file we cannot classify invalidates the gate.
const NON_SOURCE_EXTS = new Set([
  ".md", ".mdx", ".txt", ".rst", ".adoc", ".org",
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".bmp",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".pdf", ".log",
]);

const NON_SOURCE_BASENAMES = new Set(["LICENSE", "COPYING", "NOTICE", "AUTHORS", "CHANGELOG", "CODEOWNERS"]);

// Paths whose changes are the gate's own bookkeeping.
const IGNORED_PATH_RE = /(^|\/)\.claude\/tdd-guardian\//;

function isSourceFile(filePath) {
  const clean = String(filePath || "").trim();
  if (!clean) return false;
  if (IGNORED_PATH_RE.test(clean)) return false;

  const base = path.basename(clean);
  if (NON_SOURCE_BASENAMES.has(base.replace(/\.(md|txt|rst)$/i, ""))) return false;

  const ext = path.extname(clean).toLowerCase();
  if (!ext) return true; // extensionless scripts (Makefile, Justfile, bin/run) are source
  return !NON_SOURCE_EXTS.has(ext);
}

/**
 * Has any source file changed since `sha`?
 *
 * Checks committed changes AND the working tree. Committed-only checking was a
 * hole: editing files without committing left a stale gate looking fresh.
 * Any git failure returns true — an unknown state must not grant freshness.
 */
function hasSourceChangedSince(sha, cwd) {
  if (!sha || !/^[0-9a-f]{7,64}$/i.test(sha)) return true;

  const committed = git(`diff --name-only ${sha} HEAD`, cwd);
  if (committed === null) return true;
  if (committed && committed.split("\n").some((f) => isSourceFile(f))) return true;

  // Uncommitted edits, staged or not, plus untracked files.
  const dirty = git("status --porcelain --untracked-files=all", cwd);
  if (dirty === null) return true;
  if (!dirty) return false;

  return dirty
    .split("\n")
    .map((line) => line.slice(3).trim())
    // Rename entries look like "old -> new"; the destination is what matters.
    .map((p) => (p.includes(" -> ") ? p.split(" -> ")[1] : p))
    .some((f) => isSourceFile(f));
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function emptyState() {
  return { schemaVersion: STATE_VERSION, lanes: {}, coverage: null, mutation: null, baseline: null };
}

function loadState(cwd) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(cwd), "utf8"));
    if (!parsed || typeof parsed !== "object") return emptyState();
    return migrateState(parsed);
  } catch {
    return emptyState();
  }
}

// v1 state recorded one global last_gate_passed_at. Fold it into a "unit" lane so
// an existing project is not forced to re-run every gate after upgrading.
function migrateState(state) {
  if (state.schemaVersion === STATE_VERSION && state.lanes) return state;

  const migrated = emptyState();
  migrated.baseline = state.baseline || null;

  if (state.last_gate_passed_at) {
    migrated.lanes.unit = {
      last_passed_at: state.last_gate_passed_at,
      last_head_sha: state.last_head_sha || "",
      last_result: state.last_result || "passed",
      duration_ms: null,
    };
  }
  return migrated;
}

function saveState(cwd, state) {
  const file = statePath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
}

/**
 * Has this lane ever discovered a test?
 *
 * A lane that never has is in BOOTSTRAP: zero tests is the expected greenfield
 * state, not a broken discovery glob. Blocking there would make the plugin
 * unusable on day one of a TDD project, which is when it should help most.
 */
function isBootstrap(state, laneName) {
  return state?.lanes?.[laneName]?.ever_had_tests !== true;
}

/**
 * Record a lane result, maintaining the one-way "has ever had tests" ratchet.
 * Returns the stored entry so the caller can branch on `last_result`.
 */
function recordLaneResult(state, laneName, result, sha) {
  state.lanes = state.lanes || {};
  const prior = state.lanes[laneName] || {};
  const now = new Date().toISOString();

  // A pass or a test failure both prove tests exist. Environment failures prove
  // nothing either way and leave the ratchet untouched.
  const provesTests = ["pass", "fail"].includes(result.status) || (result.testCounts?.total || 0) > 0;
  const everHadTests = prior.ever_had_tests === true || provesTests;

  // Once a lane has had tests, zero tests is a regression — someone deleted them
  // or discovery broke. The ratchet is one-way, so that cannot be undone by
  // deleting the rest of the suite.
  const bootstrap = result.status === "no-tests" && !everHadTests;
  const recordAsFresh = result.ok || bootstrap;

  state.lanes[laneName] = {
    last_passed_at: recordAsFresh ? now : prior.last_passed_at || null,
    last_run_at: now,
    last_head_sha: recordAsFresh ? sha || "" : prior.last_head_sha || "",
    last_result: bootstrap ? "bootstrap" : result.ok ? "passed" : result.status,
    ever_had_tests: everHadTests,
    duration_ms: result.durationMs,
  };
  return state.lanes[laneName];
}

/**
 * Is a lane's last pass still valid?
 * @returns {{fresh: boolean, reason: string}}
 */
function isLaneFresh(state, laneName, config, cwd) {
  const entry = state?.lanes?.[laneName];
  if (!entry || !entry.last_passed_at) {
    return { fresh: false, reason: "never passed" };
  }

  const ts = new Date(entry.last_passed_at).getTime();
  if (Number.isNaN(ts)) return { fresh: false, reason: "invalid timestamp in state" };

  const ageMinutes = (Date.now() - ts) / 60000;
  const limit = Number(config.gateFreshnessMinutes) || 120;
  if (ageMinutes <= limit) {
    return { fresh: true, reason: `passed ${Math.round(ageMinutes)} min ago` };
  }

  if (config.smartStaleness !== false && entry.last_head_sha) {
    if (!hasSourceChangedSince(entry.last_head_sha, cwd)) {
      return { fresh: true, reason: `passed ${Math.round(ageMinutes)} min ago; no source changed since` };
    }
    return { fresh: false, reason: `passed ${Math.round(ageMinutes)} min ago and source has changed since` };
  }

  return { fresh: false, reason: `passed ${Math.round(ageMinutes)} min ago, older than ${limit} min` };
}

/**
 * Freshness across every lane required for an action.
 * @returns {{ok: boolean, stale: Array<{name: string, reason: string}>, fresh: Array<{name: string, reason: string}>}}
 */
function checkFreshness(config, state, action, cwd) {
  const required = lanesRequiredFor(config, action);
  const stale = [];
  const fresh = [];

  for (const lane of required) {
    const result = isLaneFresh(state, lane.name, config, cwd);
    (result.fresh ? fresh : stale).push({ name: lane.name, reason: result.reason });
  }

  return { ok: stale.length === 0, stale, fresh, required: required.map((l) => l.name) };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Run one lane: setup -> command -> coverage report -> teardown.
 * Teardown always runs once setup has run, even when the lane fails.
 *
 * @returns {{name, ok, status, phase, exitCode, durationMs, stdoutTail, stderrTail,
 *            testCounts, coverageReport, coverageError, teardownWarning}}
 */
function runLane(lane, cwd, opts = {}) {
  const base = {
    name: lane.name,
    ok: false,
    status: "runner-error",
    phase: null,
    exitCode: null,
    durationMs: 0,
    stdoutTail: "",
    stderrTail: "",
    testCounts: null,
    coverageReport: null,
    coverageError: null,
    teardownWarning: null,
  };

  const finish = (result) => {
    if (lane.teardownCommand) {
      const teardown = exec.run(lane.teardownCommand, cwd, { timeoutMs: 120000 });
      if (teardown.status !== "pass") {
        // A failed teardown leaks resources but must not mask the lane's verdict.
        result.teardownWarning = `Teardown failed (${teardown.status}): ${lane.teardownCommand}\n${teardown.stderrTail || teardown.stdoutTail}`;
      }
    }
    return result;
  };

  if (lane.setupCommand) {
    const setup = exec.run(lane.setupCommand, cwd, { timeoutMs: opts.setupTimeoutMs || 300000 });
    if (setup.status !== "pass") {
      return finish({
        ...base,
        status: setup.status,
        phase: "setup",
        exitCode: setup.exitCode,
        durationMs: setup.durationMs,
        stdoutTail: setup.stdoutTail,
        stderrTail: setup.stderrTail,
      });
    }
  }

  const main = exec.run(lane.command, cwd, { timeoutMs: lane.timeoutMs });
  const result = {
    ...base,
    status: main.status,
    phase: "command",
    exitCode: main.exitCode,
    durationMs: main.durationMs,
    stdoutTail: main.stdoutTail,
    stderrTail: main.stderrTail,
    testCounts: main.testCounts,
    ok: main.status === "pass",
  };

  // Not-pass includes "no-tests": a lane that discovered zero tests has not
  // verified anything, and green-with-nothing-run looks identical to green.
  if (!result.ok) return finish(result);

  if (lane.coverage === "include") {
    if (lane.coverageReportCommand) {
      const report = exec.run(lane.coverageReportCommand, cwd, { timeoutMs: lane.timeoutMs });
      result.durationMs += report.durationMs;
      if (report.status !== "pass") {
        return finish({
          ...result,
          ok: false,
          status: report.status,
          phase: "coverage-report",
          exitCode: report.exitCode,
          stdoutTail: report.stdoutTail,
          stderrTail: report.stderrTail,
        });
      }
    }

    const { report, error } = coverage.parseFile(lane.coverageSummaryPath, cwd);
    if (error) {
      return finish({ ...result, ok: false, status: "coverage-missing", phase: "coverage-report", coverageError: error });
    }
    result.coverageReport = report;
  }

  return finish(result);
}

/** Human-readable one-liner for a lane result. */
function describeResult(result) {
  const counts = result.testCounts
    ? ` (${result.testCounts.passed} passed, ${result.testCounts.failed} failed, ${result.testCounts.skipped} skipped)`
    : "";
  const seconds = (result.durationMs / 1000).toFixed(1);
  return `${result.name}: ${result.ok ? "PASS" : result.status.toUpperCase()}${counts} in ${seconds}s`;
}

module.exports = {
  classifyCommand,
  lanesRequiredFor,
  lanesForTrigger,
  runLane,
  describeResult,
  loadState,
  saveState,
  emptyState,
  migrateState,
  recordLaneResult,
  isBootstrap,
  isLaneFresh,
  checkFreshness,
  hasSourceChangedSince,
  isSourceFile,
  headSha,
  currentBranch,
  STATE_VERSION,
};
