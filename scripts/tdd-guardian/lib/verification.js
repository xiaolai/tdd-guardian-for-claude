"use strict";
// Specification–implementation separation.
//
// Every other gate in this plugin verifies that tests PASS. None of them looks at
// whether the specification stayed fixed while the implementation was made to
// satisfy it, which is the one thing test-first adds over test-after.
//
// WHAT A RECEIPT ACTUALLY PROVES — and what it does not. Read this before
// strengthening any claim made elsewhere in the plugin:
//
//   Proven: at time T, the recorded lane exited as a test failure, and the named
//   files had the recorded contents. At verification time, those same recorded
//   lines are still present, in order.
//
//   NOT proven:
//     * That the named files caused the failure. The receipt binds a lane-level
//       result to a file list; an unrelated pre-existing failure in the same lane
//       looks identical. `record` scopes the list to test files changed in the
//       working tree, which is a heuristic, not evidence.
//     * That no implementation existed yet. `record` reports when non-test source
//       is already dirty, which surfaces the common case, but a committed
//       implementation is invisible to it.
//     * That nothing changed *between* the two observations. A file edited and
//       then restored compares equal. That is deliberate: if it was restored, the
//       specification was not relaxed to fit the implementation, which is the
//       defect this module targets.
//     * That a surviving line still MEANS what it did. Comparison is per-line and
//       whitespace-insensitive, so text can be preserved while being disabled:
//       indenting a Python assertion under a new `if False:`, wrapping the
//       original in a block comment, or adding `.not` on a continuation line all
//       leave every recorded line present and in order. Catching that needs an
//       AST and a control-flow reading, which this does not have. The whitespace
//       insensitivity is deliberate — without it every formatter run would report
//       as the specification moving — and this is its price.
//     * Anything at all against a hostile agent. receipts.json is local,
//       gitignored, and writable by the same process being audited. This is
//       evidence for an honest workflow, not an integrity control.
//
// Three limits are deliberate:
//
//   1. Receipts are OPT-IN. Their absence reports as "not recorded", never as a
//      violation — absence of evidence is not evidence.
//   2. Nothing here blocks. A heuristic that blocks converts a signal into noise.
//   3. A receipt settles after its first verification against a GREEN lane. It is
//      evidence about one red-green cycle; re-judging it later would flag the
//      specification as broken forever the moment a different work item touches
//      the same file.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const RECEIPTS_VERSION = 2;

// Reasons a run can be red. Both prove the suite ran; only the first proves that
// counted assertions failed. See classifyRedRun.
const GENUINE_RED = new Set(["assertion-failure", "opaque-failure"]);

const VERDICTS = new Set(["SEPARATION-HELD", "SEPARATION-BROKEN", "NOT-RECORDED", "PENDING"]);

// Only these two SETTLE a receipt. PENDING and NOT-RECORDED describe "not judged
// yet" — persisting one and then treating it as settled would retire a receipt
// that was never actually examined.
const TERMINAL_VERDICTS = new Set(["SEPARATION-HELD", "SEPARATION-BROKEN"]);

// A specification file larger than this is not a specification. The cap exists so
// a hostile or accidental path cannot make the hook read a multi-gigabyte file.
const MAX_SPEC_BYTES = 4 * 1024 * 1024;

function receiptsPath(cwd) {
  return path.join(cwd, ".claude", "tdd-guardian", "receipts.json");
}

// ---------------------------------------------------------------------------
// Red classification
// ---------------------------------------------------------------------------

/**
 * Was this run a legitimate red?
 *
 * The distinction that matters is between a suite that ran and reported failing
 * assertions, and a suite that never got as far as running. A missing module, a
 * syntax error, or a zero-test discovery all exit non-zero and all look red to a
 * shell — and none of them proves a single assertion exists. `lib/exec.js` already
 * upgrades those out of "fail"; this function draws the remaining line.
 *
 * `opaque-failure` counts as red because most of the 25+ runners in the catalog
 * have no count format this plugin parses, and rejecting them would make receipts
 * unusable outside JavaScript. It is explicitly WEAKER evidence, and
 * verifyReceipt reports it as such rather than letting it pass as proof.
 *
 * @param {{status: string, testCounts: object|null}} result — an exec/runLane result
 * @returns {{red: boolean, kind: string, reason: string}}
 */
function classifyRedRun(result) {
  const status = String(result?.status || "");
  const counts = result?.testCounts || null;

  if (status === "pass") {
    return {
      red: false,
      kind: "green",
      reason:
        "The suite passed. A test that has never failed has not been shown to be capable of failing — " +
        "it may assert nothing, or the behaviour may already exist (in which case this is a regression test, not a specification).",
    };
  }

  if (status === "no-tests") {
    return {
      red: false,
      kind: "no-tests",
      reason: "The runner discovered zero tests. Nothing ran, so nothing was specified. Check where the lane looks for tests.",
    };
  }

  if (status === "fail") {
    if (counts && Number(counts.failed) > 0 && Number(counts.total) > 0) {
      return {
        red: true,
        kind: "assertion-failure",
        reason: `${counts.failed} of ${counts.total} tests failed. The suite ran and the new assertions rejected the current code.`,
      };
    }
    return {
      red: true,
      kind: "opaque-failure",
      reason:
        "The suite exited as a test failure but no test counts could be parsed, so it cannot be shown that assertions ran " +
        "rather than the runner falling over in a way exec.js does not recognise. Weaker evidence than a counted failure.",
    };
  }

  return {
    red: false,
    kind: "environment",
    reason:
      `Status '${status || "unknown"}' is an environment failure, not a failing test. ` +
      "A broken runner is not a red test — fix the runner, then record the red again.",
  };
}

// ---------------------------------------------------------------------------
// Test file recognition
// ---------------------------------------------------------------------------

const TEST_DIR_RE = /(^|\/)(tests?|specs?|__tests__|__specs__|testing|it|e2e|integration-tests)(\/|$)/i;

const TEST_FILE_RES = [
  /[._-](test|tests|spec|specs)\.[a-z0-9]+$/i, // foo.test.ts, foo_spec.rb, foo-test.js
  /^test_[^/]+\.py$/i, // test_foo.py
  /^[^/]+_test\.(go|py|rb|rs|dart|exs?)$/i, // foo_test.go
  /(Test|Tests|Spec|Specs|IT)\.(java|kt|kts|scala|cs|fs|swift|groovy)$/, // FooTest.java
  /^[^/]+Tests?\.swift$/, // FooTests.swift
  /\.feature$/i, // cucumber/gherkin specs
];

const BOOKKEEPING_RE = /(^|\/)\.claude\/tdd-guardian\//;

/**
 * Does this path look like a test file?
 *
 * Path shape is a heuristic, and it is the only signal available without asking
 * every runner in the catalog to enumerate its own suite. It decides what to HASH,
 * never what to run — a false positive costs one extra hashed file, and a false
 * negative is reported rather than silently dropped.
 */
function isTestFile(filePath) {
  const clean = String(filePath || "").trim().replace(/\\/g, "/");
  if (!clean) return false;
  if (BOOKKEEPING_RE.test(clean)) return false;

  const base = path.posix.basename(clean);
  if (TEST_FILE_RES.some((re) => re.test(base))) return true;
  return TEST_DIR_RE.test(clean);
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/**
 * Resolve a receipt path inside the workspace, or explain why it is refused.
 *
 * Both entry points are attacker-influenceable in a hostile repository: `--files`
 * comes from argv, and receipts.json is on disk. Without this, the automated hook
 * would follow `..`, absolute paths, and symlinks out of the workspace, and would
 * block forever on a FIFO — `readFileSync` on a named pipe never returns.
 *
 * @returns {{ok: boolean, resolved: string|null, state: string, reason: string}}
 *          state: "ok" | "missing" | "refused" | "unreadable"
 */
function escapesRoot(relative) {
  // `relative.startsWith("..")` alone rejects legitimate names such as
  // `..spec.test.js`. Only a `..` SEGMENT is an escape.
  return relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative);
}

function resolveSpecPath(filePath, cwd) {
  const raw = String(filePath || "").replace(/\\/g, "/").replace(/^\.\//, "");

  if (!raw) return { ok: false, resolved: null, state: "refused", reason: "empty path" };
  if (path.isAbsolute(raw)) {
    return { ok: false, resolved: null, state: "refused", reason: "absolute paths are not accepted; use a workspace-relative path" };
  }

  // Canonicalise the ROOT too. Comparing against a non-canonical root lets a
  // symlinked workspace prefix produce false escapes, and — worse — lets a real
  // escape look contained.
  let root;
  try {
    root = fs.realpathSync(path.resolve(cwd || process.cwd()));
  } catch {
    root = path.resolve(cwd || process.cwd());
  }

  const resolved = path.resolve(root, raw);
  if (escapesRoot(path.relative(root, resolved))) {
    return { ok: false, resolved: null, state: "refused", reason: "path escapes the workspace" };
  }

  let stat;
  try {
    // lstat, not stat: a symlink must be refused rather than followed.
    stat = fs.lstatSync(resolved);
  } catch (err) {
    if (err.code === "ENOENT") return { ok: false, resolved, state: "missing", reason: "file does not exist" };
    return { ok: false, resolved, state: "unreadable", reason: `cannot stat: ${err.code || err.message}` };
  }

  if (stat.isSymbolicLink()) {
    return { ok: false, resolved, state: "refused", reason: "symlinks are not accepted as specification files" };
  }
  if (!stat.isFile()) {
    return { ok: false, resolved, state: "refused", reason: "not a regular file (a FIFO or device would block the gate)" };
  }
  if (stat.size > MAX_SPEC_BYTES) {
    return {
      ok: false,
      resolved,
      state: "refused",
      reason: `file is ${stat.size} bytes, over the ${MAX_SPEC_BYTES}-byte specification cap`,
    };
  }

  // lstat only guards the LEAF. A symlinked parent directory — `tests -> /etc` —
  // holds a perfectly ordinary regular file underneath and would pass every check
  // above. Canonicalising the whole path is what closes that.
  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch (err) {
    return { ok: false, resolved, state: "unreadable", reason: `cannot canonicalise: ${err.code || err.message}` };
  }
  if (escapesRoot(path.relative(root, real))) {
    return { ok: false, resolved, state: "refused", reason: "a parent directory is a symlink leading outside the workspace" };
  }

  return { ok: true, resolved, state: "ok", reason: "" };
}

/**
 * Read a specification file through a descriptor that cannot be swapped.
 *
 * The checks in resolveSpecPath describe the file as it was a moment ago. Between
 * that and a plain readFileSync, a hostile repository can replace the leaf with a
 * symlink, a FIFO, or a huge file. Opening with O_NOFOLLOW and then fstat-ing and
 * reading THAT descriptor means every check applies to the bytes actually
 * returned.
 *
 * @returns {{state: string, text: string|null, reason: string}}
 */
function readSpecFile(filePath, cwd) {
  const resolution = resolveSpecPath(filePath, cwd);
  if (!resolution.ok) return { state: resolution.state, text: null, reason: resolution.reason };

  const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
  let fd;
  try {
    fd = fs.openSync(resolution.resolved, fs.constants.O_RDONLY | NOFOLLOW);
  } catch (err) {
    if (err.code === "ENOENT") return { state: "missing", text: null, reason: "file does not exist" };
    if (err.code === "ELOOP" || err.code === "EMLINK") {
      return { state: "refused", text: null, reason: "the path became a symlink between the check and the read" };
    }
    return { state: "unreadable", text: null, reason: `cannot open: ${err.code || err.message}` };
  }

  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      return { state: "refused", text: null, reason: "not a regular file when opened (a FIFO or device would block the gate)" };
    }
    if (stat.size > MAX_SPEC_BYTES) {
      return { state: "refused", text: null, reason: `file is ${stat.size} bytes when opened, over the ${MAX_SPEC_BYTES}-byte cap` };
    }
    return { state: "ok", text: fs.readFileSync(fd, "utf8"), reason: "" };
  } catch (err) {
    return { state: "unreadable", text: null, reason: `cannot read: ${err.code || err.message}` };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* the descriptor may already be gone */
    }
  }
}

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Fingerprint one specification file.
 *
 * Records BOTH a whole-file digest and a per-line digest list. The line list is
 * what lets verification tell an addition from an edit: adding a case leaves every
 * recorded line present and in order, while relaxing an assertion does not. A
 * whole-file hash alone reports both as "changed", which contradicts the
 * documented policy that additions are healthy.
 *
 * Lines are trimmed and blanks dropped before hashing, so re-indenting or running
 * a formatter does not read as the specification moving.
 *
 * @returns {{state: string, sha: string|null, lines: string[]|null, reason: string}}
 */
function fingerprintFile(filePath, cwd) {
  const { state, text, reason } = readSpecFile(filePath, cwd);
  if (state !== "ok") return { state, sha: null, lines: null, reason };

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => sha256(line).slice(0, 16));

  return { state: "ok", sha: sha256(text), lines, reason: "" };
}

/** Fingerprint a list of paths into a {path: fingerprint} snapshot. */
function fingerprintFiles(files, cwd) {
  const snapshot = Object.create(null);
  for (const file of files || []) {
    const key = String(file).replace(/\\/g, "/");
    snapshot[key] = fingerprintFile(key, cwd);
  }
  return snapshot;
}

/**
 * Are all recorded lines still present, in order?
 *
 * Pure additions preserve the subsequence; editing or deleting a recorded line
 * breaks it. Linear in the current file's length.
 */
function isSubsequence(recorded, current) {
  let i = 0;
  for (const line of current) {
    if (i < recorded.length && recorded[i] === line) i++;
  }
  return i === recorded.length;
}

/**
 * Compare a recorded snapshot against a current one.
 *
 * `missing` and `unreadable` are kept apart on purpose. A file that vanished is a
 * deleted specification — a finding. A file that cannot be read right now (a
 * permission blip, a refused path) is an UNKNOWN, and reporting an unknown as
 * either "held" or "deleted" would be a fabricated verdict in opposite directions.
 *
 * @returns {{modified, removed, unknown, unchanged, extended}}
 */
function diffFingerprints(before, after) {
  const modified = [];
  const removed = [];
  const unknown = [];
  const unchanged = [];
  const extended = [];

  for (const file of Object.keys(before || {})) {
    const was = before[file];
    const now = (after || {})[file];

    if (!now || now.state === "unreadable" || now.state === "refused") {
      unknown.push({ file, reason: now ? now.reason : "not re-checked" });
      continue;
    }
    if (now.state === "missing") {
      if (was.state === "ok") removed.push({ file, reason: "recorded at red, gone at green" });
      else unchanged.push({ file, reason: "absent at both ends" });
      continue;
    }
    if (was.state !== "ok") {
      unknown.push({ file, reason: `unusable when recorded (${was.reason || was.state})` });
      continue;
    }
    if (was.sha === now.sha) {
      unchanged.push({ file, reason: "identical" });
      continue;
    }
    if (Array.isArray(was.lines) && Array.isArray(now.lines) && isSubsequence(was.lines, now.lines)) {
      extended.push({ file, reason: `${now.lines.length - was.lines.length} line(s) added; every recorded line intact` });
      continue;
    }
    modified.push({ file, reason: "a recorded line was changed or removed" });
  }

  return { modified, removed, unknown, unchanged, extended };
}

// ---------------------------------------------------------------------------
// Receipt store
// ---------------------------------------------------------------------------

function emptyReceipts() {
  return { schemaVersion: RECEIPTS_VERSION, receipts: [] };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Keep only structurally valid receipts, reporting the ones dropped. */
function validateReceipts(raw) {
  const receipts = [];
  const problems = [];

  (Array.isArray(raw?.receipts) ? raw.receipts : []).forEach((entry, index) => {
    if (!isPlainObject(entry) || typeof entry.id !== "string" || !entry.id) {
      problems.push(`receipts[${index}] is not a receipt object with an id — dropped.`);
      return;
    }
    if (!isPlainObject(entry.red) || typeof entry.red.kind !== "string") {
      problems.push(`receipts[${index}] ('${entry.id}') has no recorded red classification — dropped.`);
      return;
    }
    if (typeof entry.lane !== "string" || !entry.lane.trim()) {
      problems.push(`receipts[${index}] ('${entry.id}') has no lane, so it could never be matched against a green lane — dropped.`);
      return;
    }
    if (!isPlainObject(entry.test_files) || Object.keys(entry.test_files).length === 0) {
      problems.push(`receipts[${index}] ('${entry.id}') names no specification files, so it would settle HELD having checked nothing — dropped.`);
      return;
    }
    const badFingerprint = Object.entries(entry.test_files).find(
      ([, f]) => !isPlainObject(f) || typeof f.state !== "string" || (f.state === "ok" && !Array.isArray(f.lines))
    );
    if (badFingerprint) {
      problems.push(`receipts[${index}] ('${entry.id}') has a malformed fingerprint for '${badFingerprint[0]}' — dropped.`);
      return;
    }
    // A verdict is only meaningful if verification produced it. Any other truthy
    // value would otherwise settle the receipt and skip hashing entirely.
    // Only a decided verdict is carried forward. A persisted PENDING means "not
    // judged yet", so honouring it as settled would retire a receipt nothing ever
    // examined.
    const verdict = TERMINAL_VERDICTS.has(entry.verdict) ? entry.verdict : null;
    if (entry.verdict && !verdict) {
      problems.push(
        `receipts[${index}] ('${entry.id}') carries verdict '${entry.verdict}', which does not settle anything — treated as unverified.`
      );
    }
    receipts.push({ ...entry, verdict });
  });

  return { receipts, problems };
}

/**
 * Load the receipt store.
 *
 * Only ENOENT is an empty store. Corruption, a permission failure, or a truncated
 * write are reported — converting them to "no receipts" would silently erase the
 * evidence and let the hook do nothing while looking healthy.
 *
 * @returns {{store: object, error: string|null, problems: string[]}}
 */
function loadReceipts(cwd) {
  let text;
  try {
    text = fs.readFileSync(receiptsPath(cwd), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { store: emptyReceipts(), error: null, problems: [] };
    return { store: emptyReceipts(), error: `Could not read receipts.json: ${err.code || err.message}`, problems: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      store: emptyReceipts(),
      error: `receipts.json is not valid JSON (${err.message}). It was not treated as empty — delete it to start over, or repair it.`,
      problems: [],
    };
  }

  if (!isPlainObject(parsed)) {
    return { store: emptyReceipts(), error: "receipts.json does not contain an object.", problems: [] };
  }
  if (parsed.schemaVersion !== RECEIPTS_VERSION) {
    return {
      store: emptyReceipts(),
      error:
        `receipts.json declares schema v${parsed.schemaVersion === undefined ? "(absent)" : parsed.schemaVersion}; ` +
        `this plugin writes v${RECEIPTS_VERSION}. Delete the file to re-record.`,
      problems: [],
    };
  }
  if (!Array.isArray(parsed.receipts)) {
    return { store: emptyReceipts(), error: "receipts.json has no receipts array.", problems: [] };
  }

  const { receipts, problems } = validateReceipts(parsed);
  return { store: { schemaVersion: RECEIPTS_VERSION, receipts }, error: null, problems };
}

/**
 * Persist the receipt store atomically.
 *
 * Temp file in the same directory, then rename. A partial `writeFileSync` would
 * leave truncated JSON, and the loader now reports that as corruption rather than
 * hiding it — but not writing the corruption in the first place is better.
 */
function saveReceipts(cwd, receipts) {
  const file = receiptsPath(cwd);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  const temp = path.join(dir, `.receipts.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify(receipts, null, 2) + "\n");
    fs.renameSync(temp, file);
  } catch (err) {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* the temp file may never have been created */
    }
    throw err;
  }
}

const LOCK_WAIT_MS = 2000;
const STALE_LOCK_MS = 30000;

/**
 * Run a read-modify-write against the receipt store under a directory lock.
 *
 * `mkdir` is atomic on every filesystem the plugin runs on, which is all the
 * mutual exclusion this needs. Without it, the TaskCompleted hook and the CLI can
 * both load, both mutate, and both save — last writer wins, and the other's
 * receipt is gone with no error anywhere.
 *
 * A lock older than STALE_LOCK_MS is broken: the critical section is one small
 * file write, so a lock that old belongs to a process that died.
 *
 * @param {string} cwd
 * @param {(loaded: {store, error, problems}) => object|null} mutate — returns the
 *        store to persist, or null to persist nothing.
 * @returns {{store, error, problems, wrote: boolean}}
 */
function updateReceipts(cwd, mutate) {
  const dir = path.dirname(receiptsPath(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, ".receipts.lock");

  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;

      let age = Infinity;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue; // the lock vanished under us; try to take it again
      }
      if (age > STALE_LOCK_MS) {
        try {
          fs.rmdirSync(lock);
        } catch {
          /* another process broke it first */
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Could not lock receipts.json within ${LOCK_WAIT_MS}ms — another tdd-guardian process is holding it.`);
      }
      const until = Date.now() + 20;
      while (Date.now() < until) {
        /* brief spin; the critical section is a single small write */
      }
    }
  }

  try {
    const loaded = loadReceipts(cwd);
    const next = mutate(loaded);
    if (next) saveReceipts(cwd, next);
    return { ...loaded, wrote: Boolean(next) };
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch {
      /* already released */
    }
  }
}

/**
 * Build a red receipt from an observed run.
 *
 * @param {{id, lane, result, testFiles, cwd, sha?, dirtySource?, now?}} input
 */
function buildReceipt({ id, lane, result, testFiles, cwd, sha, dirtySource, now }) {
  const red = classifyRedRun(result);
  return {
    id: String(id || "").trim() || "unnamed",
    lane: String(lane || "").trim() || "unknown",
    recorded_at: now || new Date().toISOString(),
    head_sha: String(sha || ""),
    // Non-test files already modified when the red was recorded. Not proof the
    // implementation existed, but it is the visible half of that question.
    dirty_source: Array.isArray(dirtySource) ? dirtySource.slice(0, 50) : [],
    red,
    test_files: fingerprintFiles(testFiles, cwd),
    verified_at: null,
    verdict: null,
    findings: [],
  };
}

/** Replace any existing receipt with the same id, else append. Newest wins. */
function upsertReceipt(store, receipt) {
  const receipts = (store?.receipts || []).filter((r) => r.id !== receipt.id);
  receipts.push(receipt);
  return { schemaVersion: RECEIPTS_VERSION, receipts };
}

function findReceipt(store, id) {
  return (store?.receipts || []).find((r) => r.id === id) || null;
}

/** Every fingerprint in the receipt is usable evidence. */
function receiptIsUsable(receipt) {
  const files = Object.values(receipt?.test_files || {});
  return files.length > 0 && files.every((f) => f && f.state === "ok");
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Check a red receipt against the current state of its specification files.
 *
 * Called once the receipt's lane is GREEN. Reports what moved between red and
 * green:
 *
 *   * A receipt whose red proved nothing (no-tests, environment, or green) is a
 *     false red — HIGH. It certifies a specification that was never executed.
 *   * A recorded line changed or removed — HIGH. This is the check the module
 *     exists for.
 *   * A specification file deleted — HIGH, the strongest form of the same defect.
 *   * A file that cannot be read now — MEDIUM, reported as unknown. Not held, not
 *     broken; a verdict nobody can support is worse than an admitted gap.
 *   * Lines added with every recorded line intact — INFO. Additions are healthy.
 *   * An opaque red — MEDIUM. The receipt stands, but on weaker evidence.
 *
 * @returns {{ok, verdict, findings: Array<{severity, code, message}>}}
 */
function verifyReceipt(receipt, currentSnapshot) {
  const findings = [];

  if (!receipt) {
    return {
      ok: true,
      verdict: "NOT-RECORDED",
      findings: [
        {
          severity: "info",
          code: "no-receipt",
          message:
            "No red receipt was recorded for this work item, so specification–implementation separation is unverified. " +
            "This is not a violation: record one with `receipt.js record` before the implementation to make it checkable.",
        },
      ],
    };
  }

  if (!GENUINE_RED.has(receipt.red?.kind)) {
    findings.push({
      severity: "high",
      code: "false-red",
      message:
        `The recorded red for '${receipt.id}' proves nothing: ${receipt.red?.reason || "no reason recorded"} ` +
        `Kind: ${receipt.red?.kind || "unknown"}. A receipt is only evidence when the suite actually ran and failed.`,
    });
  } else if (receipt.red.kind === "opaque-failure") {
    findings.push({
      severity: "medium",
      code: "weak-red",
      message:
        `The red for '${receipt.id}' was recorded without parseable test counts, so it is not established that assertions ran ` +
        "rather than the runner failing in an unrecognised way. The receipt stands on weaker evidence than a counted failure.",
    });
  }

  if (Array.isArray(receipt.dirty_source) && receipt.dirty_source.length) {
    findings.push({
      severity: "medium",
      code: "implementation-already-present",
      message:
        `${receipt.dirty_source.length} non-test file(s) were already modified when the red was recorded ` +
        `(${receipt.dirty_source.slice(0, 5).join(", ")}${receipt.dirty_source.length > 5 ? ", …" : ""}). ` +
        "The tests may have been written against an implementation that already existed, which is the contamination the receipt exists to detect.",
    });
  }

  const diff = diffFingerprints(receipt.test_files || {}, currentSnapshot || {});

  if (diff.modified.length) {
    findings.push({
      severity: "high",
      code: "spec-changed-under-green",
      message:
        `${diff.modified.length} specification file(s) had a recorded line changed or removed between red and green: ` +
        `${diff.modified.map((d) => d.file).join(", ")}. The implementation edited its own acceptance criteria. ` +
        "Either restore the assertions, or state explicitly why the original specification was wrong.",
    });
  }

  if (diff.removed.length) {
    findings.push({
      severity: "high",
      code: "spec-deleted-under-green",
      message:
        `${diff.removed.length} specification file(s) recorded at red are gone at green: ${diff.removed.map((d) => d.file).join(", ")}. ` +
        "Deleting the specification is the strongest form of editing it.",
    });
  }

  if (diff.unknown.length) {
    findings.push({
      severity: "medium",
      code: "spec-unverifiable",
      message:
        `${diff.unknown.length} specification file(s) could not be checked: ` +
        `${diff.unknown.map((d) => `${d.file} (${d.reason})`).join(", ")}. ` +
        "Reported as unknown rather than held — a verdict nobody can support is worse than an admitted gap.",
    });
  }

  if (diff.extended.length) {
    findings.push({
      severity: "info",
      code: "spec-extended",
      message:
        `${diff.extended.length} specification file(s) gained lines with every recorded line intact: ` +
        `${diff.extended.map((d) => d.file).join(", ")}. Additions are healthy; only edits to recorded lines are a finding.`,
    });
  }

  const blocking = findings.filter((f) => f.severity === "high");
  if (blocking.length) return { ok: false, verdict: "SEPARATION-BROKEN", findings };

  // A file that could not be re-read leaves the question open. Returning HELD and
  // settling would retire the receipt on a verdict its own finding says nobody can
  // support — the contradiction this module exists to prevent, in its own code.
  if (diff.unknown.length) return { ok: true, verdict: "PENDING", findings };

  return { ok: true, verdict: "SEPARATION-HELD", findings };
}

/**
 * Verify every unsettled receipt whose lane is currently green.
 *
 * The green requirement is load-bearing. Without it, running `verify` while the
 * suite is still red records SEPARATION-HELD and settles the receipt — after which
 * the real red-to-green transition is never examined. A receipt whose lane is not
 * known green stays PENDING and unsettled.
 *
 * @param {object} store
 * @param {string} cwd
 * @param {{greenLanes?: Iterable<string>, now?: string}} opts
 * @returns {{store, reports: Array<{id, lane, verdict, findings, settled, pending}>}}
 */
function verifyAll(store, cwd, opts = {}) {
  // greenLanes is required in practice. Omitting it means "nothing is known to be
  // green", so nothing settles — a caller that forgets it gets PENDING, not a
  // silent reversion to settling every receipt regardless of lane state.
  const green = new Set(opts.greenLanes || []);
  const now = opts.now || new Date().toISOString();
  const reports = [];

  const receipts = (store?.receipts || []).map((receipt) => {
    // Guard here as well as in validateReceipts: verifyAll is exported and can be
    // handed a store the loader never saw.
    if (TERMINAL_VERDICTS.has(receipt.verdict)) {
      reports.push({
        id: receipt.id,
        lane: receipt.lane,
        verdict: receipt.verdict,
        findings: receipt.findings || [],
        settled: true,
        pending: false,
      });
      return receipt;
    }

    if (!green.has(receipt.lane)) {
      reports.push({
        id: receipt.id,
        lane: receipt.lane,
        verdict: "PENDING",
        findings: [
          {
            severity: "info",
            code: "lane-not-green",
            message:
              `Lane '${receipt.lane}' is not currently passing, so there is no red-to-green transition to judge yet. ` +
              "The receipt stays open rather than settling on a verdict it cannot support.",
          },
        ],
        settled: false,
        pending: true,
      });
      return receipt;
    }

    const snapshot = fingerprintFiles(Object.keys(receipt.test_files || {}), cwd);
    const result = verifyReceipt(receipt, snapshot);
    reports.push({ id: receipt.id, lane: receipt.lane, verdict: result.verdict, findings: result.findings, settled: false, pending: false });
    return { ...receipt, verified_at: now, verdict: result.verdict, findings: result.findings };
  });

  return { store: { schemaVersion: RECEIPTS_VERSION, receipts }, reports };
}

/**
 * One line per finding, for hook stderr and command output.
 *
 * Skips three things: info findings, receipts settled on an earlier run (a
 * finding repeated on every run afterwards stops being read), and pending
 * receipts (nothing has been judged yet, so there is no finding to report).
 */
function describeReports(reports) {
  const lines = [];
  for (const report of reports || []) {
    if (report.settled || report.pending) continue;
    for (const finding of report.findings || []) {
      if (finding.severity === "info") continue;
      lines.push(`[${finding.severity.toUpperCase()}] ${report.id} (${report.lane}): ${finding.message}`);
    }
  }
  return lines;
}

module.exports = {
  classifyRedRun,
  isTestFile,
  resolveSpecPath,
  fingerprintFile,
  fingerprintFiles,
  isSubsequence,
  diffFingerprints,
  buildReceipt,
  upsertReceipt,
  findReceipt,
  receiptIsUsable,
  loadReceipts,
  saveReceipts,
  updateReceipts,
  emptyReceipts,
  readSpecFile,
  escapesRoot,
  TERMINAL_VERDICTS,
  validateReceipts,
  verifyReceipt,
  verifyAll,
  describeReports,
  receiptsPath,
  RECEIPTS_VERSION,
  GENUINE_RED,
  VERDICTS,
  MAX_SPEC_BYTES,
};
