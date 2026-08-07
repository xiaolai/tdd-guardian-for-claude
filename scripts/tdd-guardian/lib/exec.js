"use strict";
// Command execution + outcome classification.
//
// A crashed runner is not a failing test. Callers need that distinction to decide
// whether to dispatch a fix-it agent (test failure) or stop and surface an
// environment problem (runner failure). Exit codes alone are not enough — several
// runners exit 1 on a missing dependency — so exit-code mapping is followed by
// output heuristics that can upgrade the classification.

const { spawnSync } = require("child_process");

const DEFAULT_TIMEOUT_MS = 600000;
const MAX_BUFFER = 32 * 1024 * 1024;

// Exit code -> classification. Anything unlisted and non-zero is "runner-error".
const EXIT_CLASS = {
  0: "pass",
  1: "fail",
  126: "runner-missing",
  127: "runner-missing",
  130: "interrupted",
  137: "killed",
  143: "killed",
};

// Applied to stderr (and stdout when noted) to upgrade a "fail" that is really a
// broken environment. Ordered most-specific first.
const UPGRADE_PATTERNS = [
  { re: /JavaScript heap out of memory|Out of memory|MemoryError|OutOfMemoryError/i, status: "killed" },
  { re: /Cannot find module|ModuleNotFoundError|ImportError: No module named|error: could not find|package .* is not in (std|GOROOT)/i, status: "runner-error" },
  { re: /command not found|is not recognized as an internal or external command|No such file or directory/i, status: "runner-missing" },
  { re: /error: unknown (option|flag|argument)|unrecognized arguments|Unknown option/i, status: "runner-error" },
];

// Runners that found zero tests. Distinct from failure: nothing ran.
const NO_TESTS_PATTERNS = [
  /no tests? (were )?found/i,
  /no test files found/i,
  /no tests ran/i,
  /collected 0 items/i,
  /Test suites: 0 total/i,
  /\[no test files\]/i,
];

// Evidence that the runner started and produced results, which suppresses the
// syntax-error heuristic (a suite may legitimately assert a SyntaxError).
const TEST_OUTPUT_MARKERS = [
  /\bTests?:\s+\d/i,
  /\d+ (passed|passing|failed|failing)/i,
  /test result:/i,
  /=+ .*(passed|failed).* =+/i,
  /^(ok|FAIL|PASS|---)\s/m,
  /Tests run:/i,
];

function hasTestOutput(text) {
  return TEST_OUTPUT_MARKERS.some((re) => re.test(text));
}

function classify(exitCode, stdout, stderr) {
  const combined = stdout + "\n" + stderr;

  let status = EXIT_CLASS[exitCode];
  if (status === undefined) status = exitCode === null ? "runner-error" : "runner-error";

  if (exitCode === 2) {
    status = NO_TESTS_PATTERNS.some((re) => re.test(combined)) ? "no-tests" : "fail";
  }

  if (status === "pass") {
    // Some runners exit 0 having discovered nothing. Green with zero tests is not
    // evidence that anything was verified.
    if (NO_TESTS_PATTERNS.some((re) => re.test(combined))) return "no-tests";
    return "pass";
  }

  // Upgrade a "fail" that is really a broken environment.
  if (status === "fail") {
    for (const { re, status: upgraded } of UPGRADE_PATTERNS) {
      if (re.test(stderr) || re.test(stdout)) return upgraded;
    }
    // A parse error before any test output means the runner never got going.
    if (/SyntaxError|TSError|Parse error|parsing error|compilation (failed|error)/i.test(stderr) && !hasTestOutput(combined)) {
      return "runner-error";
    }
    if (!combined.trim()) return "runner-missing";
  }

  return status;
}

// Best-effort extraction of pass/fail counts. Returns null rather than guessing —
// a fabricated count is worse than no count.
const COUNT_PARSERS = [
  // Vitest: "Tests  12 passed | 1 failed (13)"
  (t) => {
    const m = /Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed(?:\s*\|\s*(\d+)\s+skipped)?\s*\((\d+)\)/i.exec(t);
    return m ? { failed: +(m[1] || 0), passed: +m[2], skipped: +(m[3] || 0), total: +m[4] } : null;
  },
  // Jest: "Tests:       1 failed, 12 passed, 13 total"
  (t) => {
    const m = /Tests:\s+(?:(\d+) failed,\s*)?(?:(\d+) skipped,\s*)?(?:(\d+) passed,\s*)?(\d+) total/i.exec(t);
    return m ? { failed: +(m[1] || 0), skipped: +(m[2] || 0), passed: +(m[3] || 0), total: +m[4] } : null;
  },
  // Pytest: "=== 1 failed, 12 passed, 2 skipped in 0.4s ==="
  (t) => {
    if (!/=+.*(passed|failed|error).*=+/i.test(t)) return null;
    const failed = +(/(\d+) failed/i.exec(t)?.[1] || 0);
    const passed = +(/(\d+) passed/i.exec(t)?.[1] || 0);
    const skipped = +(/(\d+) skipped/i.exec(t)?.[1] || 0);
    const errors = +(/(\d+) errors?/i.exec(t)?.[1] || 0);
    if (!failed && !passed && !skipped && !errors) return null;
    return { failed: failed + errors, passed, skipped, total: failed + passed + skipped + errors };
  },
  // Cargo: "test result: FAILED. 12 passed; 1 failed; 2 ignored"
  (t) => {
    const m = /test result:\s+\w+\.\s+(\d+) passed;\s*(\d+) failed;\s*(\d+) ignored/i.exec(t);
    return m ? { passed: +m[1], failed: +m[2], skipped: +m[3], total: +m[1] + +m[2] + +m[3] } : null;
  },
  // Maven Surefire / Gradle: "Tests run: 13, Failures: 1, Errors: 0, Skipped: 2"
  (t) => {
    const m = /Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/i.exec(t);
    if (!m) return null;
    const total = +m[1];
    const failed = +m[2] + +m[3];
    return { passed: total - failed - +m[4], failed, skipped: +m[4], total };
  },
  // dotnet test: "Passed!  - Failed: 0, Passed: 12, Skipped: 1, Total: 13"
  (t) => {
    const m = /Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)/i.exec(t);
    return m ? { failed: +m[1], passed: +m[2], skipped: +m[3], total: +m[4] } : null;
  },
  // Go: count per-test result lines.
  (t) => {
    const pass = (t.match(/^\s*--- PASS:/gm) || []).length;
    const fail = (t.match(/^\s*--- FAIL:/gm) || []).length;
    const skip = (t.match(/^\s*--- SKIP:/gm) || []).length;
    return pass + fail + skip > 0 ? { passed: pass, failed: fail, skipped: skip, total: pass + fail + skip } : null;
  },
  // ExUnit: "13 tests, 1 failure"
  (t) => {
    const m = /(\d+) tests?, (\d+) failures?(?:, (\d+) (?:skipped|excluded))?/i.exec(t);
    return m ? { total: +m[1], failed: +m[2], skipped: +(m[3] || 0), passed: +m[1] - +m[2] - +(m[3] || 0) } : null;
  },
  // RSpec: "13 examples, 1 failure, 2 pending"
  (t) => {
    const m = /(\d+) examples?, (\d+) failures?(?:, (\d+) pending)?/i.exec(t);
    return m ? { total: +m[1], failed: +m[2], skipped: +(m[3] || 0), passed: +m[1] - +m[2] - +(m[3] || 0) } : null;
  },
];

function parseCounts(stdout, stderr) {
  const text = stdout + "\n" + stderr;
  for (const parser of COUNT_PARSERS) {
    try {
      const counts = parser(text);
      if (counts && Number.isFinite(counts.total)) return counts;
    } catch {
      // A parser that throws on unexpected output must not take the run down.
    }
  }
  return null;
}

function tail(text, lines) {
  const split = String(text || "").split("\n");
  return split.slice(-lines).join("\n").trim();
}

/**
 * Run a shell command and classify the outcome.
 * Never throws — a failure to spawn is returned as a classified result.
 *
 * @returns {{status: string, exitCode: number|null, durationMs: number,
 *            stdout: string, stderr: string, stdoutTail: string,
 *            stderrTail: string, testCounts: object|null, timedOut: boolean}}
 */
function run(command, cwd, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const started = Date.now();

  const res = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(opts.env || {}) },
  });

  const durationMs = Date.now() - started;
  const stdout = res.stdout || "";
  const stderr = res.stderr || "";

  // spawnSync signals a timeout via error.code ETIMEDOUT (Node >=18) or by
  // killing with SIGTERM once the timeout elapses.
  const timedOut =
    (res.error && res.error.code === "ETIMEDOUT") ||
    (res.signal === "SIGTERM" && durationMs >= timeoutMs);

  if (timedOut) {
    return {
      status: "timeout",
      exitCode: null,
      durationMs,
      stdout,
      stderr,
      stdoutTail: tail(stdout, 80),
      stderrTail: tail(stderr, 40),
      testCounts: null,
      timedOut: true,
    };
  }

  if (res.error) {
    return {
      status: "runner-missing",
      exitCode: null,
      durationMs,
      stdout,
      stderr: stderr || String(res.error.message || res.error),
      stdoutTail: tail(stdout, 80),
      stderrTail: tail(stderr || String(res.error.message || res.error), 40),
      testCounts: null,
      timedOut: false,
    };
  }

  const exitCode = typeof res.status === "number" ? res.status : null;
  const status = classify(exitCode, stdout, stderr);

  return {
    status,
    exitCode,
    durationMs,
    stdout,
    stderr,
    stdoutTail: tail(stdout, 80),
    stderrTail: tail(stderr, 40),
    testCounts: parseCounts(stdout, stderr),
    timedOut: false,
  };
}

// A status the caller can act on by changing code or tests.
function isTestFailure(status) {
  return status === "fail";
}

// A status meaning the environment is broken; no fix-it agent should be dispatched.
function isEnvironmentFailure(status) {
  return ["runner-missing", "runner-error", "killed", "timeout", "interrupted"].includes(status);
}

module.exports = {
  run,
  classify,
  parseCounts,
  isTestFailure,
  isEnvironmentFailure,
  DEFAULT_TIMEOUT_MS,
};
