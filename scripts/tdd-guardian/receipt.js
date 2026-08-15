#!/usr/bin/env node
"use strict";
// Red-receipt CLI.
//
//   record --id WI-1 [--lane unit] [--files a,b]   run the lane, record the red
//   verify [--id WI-1]                             re-run the lane; if green, judge
//   show                                           list recorded receipts
//
// Options: --id <work-item>  --lane <name>  --files <a,b>  --cwd <dir>  --json
//
// `--cwd` sets the workspace root that every path is resolved and contained
// against. It exists for tests and for agents invoked from a different directory;
// it does not widen what may be read, because resolveSpecPath still refuses
// anything outside whatever root it is given.
//
// WHAT THIS PROVES is documented in lib/verification.js — read it before relying
// on a receipt. In short: it shows the lane failed and the named files had the
// recorded contents, not that those files caused the failure or that no
// implementation existed.
//
// Exit codes: 0 = recorded / held / pending, 1 = refused or separation broken.

const configLib = require("./lib/config");
const lanesLib = require("./lib/lanes");
const exec = require("./lib/exec");
const verification = require("./lib/verification");

// Work-item ids reach the terminal and an agent's transcript. Restricting the
// charset is what stops a crafted id from emitting ANSI/OSC sequences that forge
// output an agent then reads back as fact.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// The plugin's own state, config, and receipts — never project source.
const BOOKKEEPING_RE = /(^|\/)\.claude\/tdd-guardian\//;

const FLAGS = {
  id: { value: true },
  lane: { value: true },
  files: { value: true },
  cwd: { value: true },
  json: { value: false },
};

/**
 * Replace control characters in anything echoed to a terminal.
 *
 * Receipt ids, lane names, and file paths all reach an agent's Bash transcript.
 * An embedded ESC sequence there can repaint the terminal or forge output that
 * the agent then reads back as fact, so the bytes never make it out intact.
 */
function clean(value) {
  return String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

/**
 * Strict argument parsing.
 *
 * A permissive parser turned `--id` with no value into the boolean `true`, which
 * became the literal work-item id "true", and silently ignored misspelled flags.
 * Both produce a receipt that looks valid and records the wrong thing.
 */
function parseArgs(argv) {
  const args = { _: [] };
  const errors = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }

    const body = token.slice(2);
    const eq = body.indexOf("=");
    const key = eq === -1 ? body : body.slice(0, eq);
    const inline = eq === -1 ? null : body.slice(eq + 1);

    const spec = FLAGS[key];
    if (!spec) {
      errors.push(`Unknown option '--${key}'. Valid: ${Object.keys(FLAGS).map((k) => "--" + k).join(", ")}.`);
      continue;
    }
    if (key in args) {
      errors.push(`Option '--${key}' was given more than once.`);
      continue;
    }

    if (!spec.value) {
      if (inline !== null) errors.push(`Option '--${key}' takes no value.`);
      args[key] = true;
      continue;
    }

    if (inline !== null) {
      if (!inline) errors.push(`Option '--${key}' needs a value.`);
      args[key] = inline;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      errors.push(`Option '--${key}' needs a value.`);
      continue;
    }
    args[key] = argv[++i];
  }

  return { args, errors };
}

function die(message, code = 1) {
  console.error(clean(message));
  process.exit(code);
}

function loadConfigOrDie(cwd) {
  const loaded = configLib.load(cwd);
  if (!loaded.exists) die("No TDD Guardian config. Run /tdd-guardian:init first.");
  if (loaded.errors.length) die(`TDD Guardian config is invalid:\n${loaded.errors.join("\n")}`);
  // Running the repository's test command is the single most consequential thing
  // this CLI does. A project that switched the plugin off has withdrawn consent
  // for that, and a new entry point must not route around it.
  if (loaded.config.enabled === false) {
    die('TDD Guardian is disabled for this project ("enabled": false). Re-enable it in .claude/tdd-guardian/config.json to record receipts.');
  }
  return loaded.config;
}

/**
 * Working-tree changes, split into test files and other source.
 *
 * Uses `--porcelain=v1 -z`. The human-readable form C-quotes unusual filenames
 * and renders renames as `old -> new`, so a filename containing that sequence, a
 * newline, or a non-ASCII byte parses to the wrong path — which then fingerprints
 * as unreadable and silently drops out of the evidence.
 */
function workingTreeChanges(cwd) {
  const res = exec.run("git status --porcelain=v1 -z --untracked-files=all", cwd, { timeoutMs: 15000 });
  if (res.exitCode !== 0) return null;

  const tokens = res.stdout.split("\0");
  const paths = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (!filePath) continue;
    paths.push(filePath);
    // A rename or copy entry is followed by its source path as a separate record.
    if (status[0] === "R" || status[0] === "C" || status[1] === "R" || status[1] === "C") i++;
  }

  // The gate's own bookkeeping is not project source. Counting config.json and
  // receipts.json as "implementation already present" would fire that finding on
  // every single record — a false positive on the happy path, which is the
  // fastest way to teach someone to ignore a finding.
  const relevant = paths.filter((p) => !BOOKKEEPING_RE.test(p.replace(/\\/g, "/")));

  return {
    tests: relevant.filter((p) => verification.isTestFile(p)).sort(),
    source: relevant.filter((p) => !verification.isTestFile(p)).sort(),
  };
}

/** Resolve which lane to run, refusing to guess when the choice is ambiguous. */
function resolveLane(config, laneName) {
  if (laneName) {
    const lane = config.lanes.find((l) => l.name === laneName);
    if (!lane) {
      die(`No lane named '${clean(laneName)}'. Configured lanes: ${config.lanes.map((l) => l.name).join(", ") || "none"}.`);
    }
    return lane;
  }

  const candidates = lanesLib.lanesForTrigger(config, "taskCompleted");
  if (candidates.length === 0) {
    die("No lane is bound to taskCompleted. Pass --lane <name> to choose one explicitly.");
  }
  if (candidates.length > 1) {
    // Silently taking lanes[0] made the receipt depend on config ordering, and the
    // lane the work item's tests actually live in might never run.
    die(
      `${candidates.length} lanes are bound to taskCompleted (${candidates.map((l) => l.name).join(", ")}). ` +
        "Pass --lane <name> — recording against the wrong lane produces evidence about tests that never ran."
    );
  }
  return candidates[0];
}

function cmdRecord(args, cwd) {
  const id = String(args.id || "").trim();
  if (!id) die("Missing --id. Name the work item this red belongs to, e.g. --id WI-1.");
  if (!ID_RE.test(id)) {
    die(`Invalid --id '${clean(id)}'. Use letters, digits, dot, dash, or underscore (max 64 characters).`);
  }

  const config = loadConfigOrDie(cwd);
  const lane = resolveLane(config, String(args.lane || "").trim());

  const changes = workingTreeChanges(cwd);
  let files;
  let dirtySource = [];

  if (args.files) {
    files = String(args.files)
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);
    if (changes) dirtySource = changes.source;
  } else {
    if (changes === null) {
      die("Could not list the working tree — git is unavailable or this is not a repository. Pass --files a,b to name the specification files explicitly.");
    }
    files = changes.tests;
    dirtySource = changes.source;
  }

  if (files.length === 0) {
    die(
      "Refusing to record: no new or modified test files found in the working tree.\n" +
        "A red receipt names the specification it is evidence for. Write the failing test first, or pass --files explicitly."
    );
  }

  // Every named file must be usable evidence BEFORE the lane runs. A path that is
  // missing, refused, or unreadable would otherwise fingerprint as null and later
  // compare as "unchanged", producing a held verdict backed by nothing.
  const before = verification.fingerprintFiles(files, cwd);
  const unusable = Object.entries(before).filter(([, f]) => f.state !== "ok");
  if (unusable.length) {
    die(
      "Refusing to record — these specification files are not usable evidence:\n" +
        unusable.map(([file, f]) => `  ${clean(file)}: ${clean(f.reason || f.state)}`).join("\n")
    );
  }

  console.error(`[tdd-guardian] Recording red for ${clean(id)} — running lane '${clean(lane.name)}': ${clean(lane.command)}`);
  const result = lanesLib.runLane(lane, cwd);

  // Fingerprint again after the run. A lane command, setup hook, formatter, or
  // code generator can rewrite a test while the suite executes; without this the
  // rewritten file becomes the baseline and the change is erased from the record.
  const after = verification.fingerprintFiles(files, cwd);
  const movedDuringRun = Object.keys(before).filter((file) => after[file]?.state !== "ok" || after[file].sha !== before[file].sha);
  if (movedDuringRun.length) {
    die(
      `Refusing to record: ${movedDuringRun.length} specification file(s) changed while the lane was running ` +
        `(${movedDuringRun.map(clean).join(", ")}).\n` +
        "A formatter, generator, or setup step is rewriting your tests. Whatever is doing that must run before the red is recorded, not during it."
    );
  }

  const receipt = verification.buildReceipt({
    id,
    lane: lane.name,
    result,
    testFiles: files,
    cwd,
    sha: lanesLib.headSha(cwd) || "",
    dirtySource,
  });

  // Load, check, and save under one lock: the TaskCompleted hook writes the same
  // file, and an interleaved read-modify-write silently drops one side's receipt.
  let refusal = null;
  try {
    verification.updateReceipts(cwd, (loaded) => {
      if (loaded.error) {
        refusal = `Cannot record: ${loaded.error}`;
        return null;
      }
      for (const problem of loaded.problems) console.error(`[tdd-guardian] ${clean(problem)}`);

      // Never let a failed attempt destroy good evidence. Re-running `record`
      // after a green or a broken runner would otherwise overwrite the valid
      // receipt for the same work item with one that proves nothing.
      const existing = verification.findReceipt(loaded.store, id);
      if (!receipt.red.red && existing && verification.GENUINE_RED.has(existing.red?.kind)) {
        refusal =
          `Refusing to overwrite the existing valid receipt for '${clean(id)}' with an invalid one ` +
          `(${clean(receipt.red.kind)}: ${clean(receipt.red.reason)}).\n` +
          "Fix the cause and record again, or use a different --id.";
        return null;
      }
      return verification.upsertReceipt(loaded.store, receipt);
    });
  } catch (err) {
    die(`Could not write receipts.json: ${err.code || err.message}`);
  }
  if (refusal) die(refusal);

  if (args.json) {
    console.log(JSON.stringify({ id: receipt.id, lane: receipt.lane, red: receipt.red, test_files: Object.keys(receipt.test_files) }, null, 2));
  }

  if (!receipt.red.red) {
    console.error(
      `[tdd-guardian] RECORDED, BUT NOT A VALID RED (${clean(receipt.red.kind)}): ${clean(receipt.red.reason)}\n` +
        "The receipt is stored so the problem is visible, and verification will flag it. Fix the cause and record again."
    );
    process.exit(1);
  }

  const notes = [`[tdd-guardian] Red recorded for ${clean(id)} (${clean(receipt.red.kind)}): ${clean(receipt.red.reason)}`];
  notes.push(`  Specification files: ${Object.keys(receipt.test_files).map(clean).join(", ")}`);
  notes.push("  Recorded lines in these files must not change on the way to green. Adding lines is fine.");
  if (dirtySource.length) {
    notes.push(
      `  NOTE: ${dirtySource.length} non-test file(s) were already modified (${dirtySource.slice(0, 3).map(clean).join(", ")}${dirtySource.length > 3 ? ", …" : ""}).`,
      "  If the implementation already existed, these tests were not written blind to it."
    );
  }
  console.error(notes.join("\n"));
  return 0;
}

function cmdVerify(args, cwd) {
  const loaded = verification.loadReceipts(cwd);
  if (loaded.error) die(`Cannot verify: ${loaded.error}`);
  for (const problem of loaded.problems) console.error(`[tdd-guardian] ${clean(problem)}`);

  const store = loaded.store;
  if (store.receipts.length === 0) {
    console.error("[tdd-guardian] No red receipts recorded. Specification–implementation separation is unverified, not violated.");
    if (args.json) console.log(JSON.stringify({ reports: [] }, null, 2));
    return 0;
  }

  const id = String(args.id || "").trim();
  if (id && !ID_RE.test(id)) die(`Invalid --id '${clean(id)}'.`);
  const scoped = id ? { schemaVersion: store.schemaVersion, receipts: store.receipts.filter((r) => r.id === id) } : store;
  if (id && scoped.receipts.length === 0) {
    die(`No receipt with id '${clean(id)}'. Recorded: ${store.receipts.map((r) => clean(r.id)).join(", ")}.`);
  }

  // Establish which lanes are actually green right now. Without this, verifying
  // while the suite is still red settles the receipt on a verdict about a
  // transition that has not happened, and the real one is never examined.
  const config = loadConfigOrDie(cwd);
  const greenLanes = new Set();
  const pendingLanes = new Set();
  const unsettled = scoped.receipts.filter((r) => !r.verdict);

  for (const laneName of new Set(unsettled.map((r) => r.lane))) {
    const lane = config.lanes.find((l) => l.name === laneName);
    if (!lane) {
      console.error(`[tdd-guardian] Receipt lane '${clean(laneName)}' is no longer configured — cannot establish green.`);
      pendingLanes.add(laneName);
      continue;
    }
    console.error(`[tdd-guardian] Checking lane '${clean(lane.name)}' is green before judging its receipts…`);
    const result = lanesLib.runLane(lane, cwd);
    if (result.ok) greenLanes.add(laneName);
    else {
      pendingLanes.add(laneName);
      console.error(`[tdd-guardian] Lane '${clean(laneName)}' is ${clean(result.status)} — its receipts stay open.`);
    }
  }

  const { store: verified, reports } = verification.verifyAll(scoped, cwd, { greenLanes });
  try {
    verification.updateReceipts(cwd, (fresh) =>
      verified.receipts.reduce((acc, receipt) => verification.upsertReceipt(acc, receipt), fresh.store)
    );
  } catch (err) {
    console.error(`[tdd-guardian] Could not persist verdicts: ${err.code || err.message}`);
  }

  if (args.json) console.log(JSON.stringify({ reports }, null, 2));

  const lines = verification.describeReports(reports);
  const broken = reports.filter((r) => r.verdict === "SEPARATION-BROKEN");
  const pending = reports.filter((r) => r.pending);

  for (const report of broken.filter((r) => r.settled)) {
    console.error(`[tdd-guardian] ${clean(report.id)} (${clean(report.lane)}): SEPARATION-BROKEN, recorded on an earlier run.`);
  }
  for (const report of pending) {
    console.error(`[tdd-guardian] ${clean(report.id)} (${clean(report.lane)}): PENDING — lane not green, nothing to judge yet.`);
  }

  // Exit status follows the VERDICT. A medium finding — a weak red, dirty source
  // at record time — is context worth printing, not a failed verification.
  if (broken.length === 0) {
    if (lines.length) console.error(["[tdd-guardian] Notes on the recorded evidence:", ...lines.map(clean)].join("\n"));
    const held = reports.filter((r) => !r.settled && !r.pending).map((r) => clean(r.id));
    console.error(
      held.length
        ? `[tdd-guardian] Specification held for ${held.join(", ")} — no recorded line changed between red and green.`
        : pending.length
          ? "[tdd-guardian] Nothing judged: every open receipt is waiting on a green lane."
          : "[tdd-guardian] Nothing new to verify; every receipt was settled on an earlier run."
    );
    return 0;
  }

  console.error(["[tdd-guardian] Specification–implementation separation broken:", ...lines.map(clean)].join("\n"));
  process.exit(1);
}

function cmdShow(args, cwd) {
  const loaded = verification.loadReceipts(cwd);
  if (loaded.error) die(`Cannot read receipts: ${loaded.error}`);
  for (const problem of loaded.problems) console.error(`[tdd-guardian] ${clean(problem)}`);

  if (args.json) {
    console.log(JSON.stringify(loaded.store, null, 2));
    return 0;
  }
  if (loaded.store.receipts.length === 0) {
    console.log("No red receipts recorded.");
    return 0;
  }
  for (const receipt of loaded.store.receipts) {
    console.log(
      `${clean(receipt.id)} [${clean(receipt.lane)}] ${clean(receipt.red?.kind || "?")} — ` +
        `${Object.keys(receipt.test_files || {}).length} spec file(s), verdict: ${clean(receipt.verdict || "unverified")}`
    );
  }
  return 0;
}

const USAGE =
  "Usage:\n" +
  "  receipt.js record --id <work-item> [--lane <name>] [--files a,b] [--cwd <dir>] [--json]\n" +
  "  receipt.js verify [--id <work-item>] [--cwd <dir>] [--json]\n" +
  "  receipt.js show [--cwd <dir>] [--json]";

function main() {
  const { args, errors } = parseArgs(process.argv.slice(2));
  if (errors.length) die([...errors, "", USAGE].join("\n"));

  const cwd = String(args.cwd || process.cwd());
  switch (args._[0]) {
    case "record":
      return cmdRecord(args, cwd);
    case "verify":
      return cmdVerify(args, cwd);
    case "show":
      return cmdShow(args, cwd);
    default:
      die(USAGE);
  }
}

if (require.main === module) main();

module.exports = { parseArgs, workingTreeChanges, clean, ID_RE };
