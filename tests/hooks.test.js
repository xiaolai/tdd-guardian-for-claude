"use strict";

const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const {
  computeSourceFingerprint,
  guardPaths,
  mergeConfig,
  writeJson,
} = require("../templates/scripts/shared");

const pluginRoot = path.resolve(__dirname, "..");
const pretool = path.join(pluginRoot, "templates", "scripts", "pretool_guard.js");
const codechange = path.join(pluginRoot, "templates", "scripts", "codechange_gate.js");

function tempWorkspace() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tdd-guardian-hooks-"));
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "index.js"), "module.exports = 1;\n");
  fs.mkdirSync(path.join(cwd, "coverage"), { recursive: true });
  writeJson(path.join(cwd, "coverage", "coverage-summary.json"), {
    total: {
      lines: { pct: 100 },
      functions: { pct: 100 },
      branches: { pct: 100 },
      statements: { pct: 100 },
    },
  });

  const paths = guardPaths(cwd);
  writeJson(paths.config, mergeConfig({
    testCommand: "node -e \"process.exit(0)\"",
    coverageCommand: "node -e \"process.exit(0)\"",
  }));
  return cwd;
}

function runNode(script, cwd, payload) {
  return spawnSync(process.execPath, [script], {
    cwd,
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
}

test("pretool guard denies release commands until current source passed gates", () => {
  const cwd = tempWorkspace();
  const payload = {
    cwd,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git push" },
  };

  const denied = runNode(pretool, cwd, payload);
  assert.strictEqual(denied.status, 0);
  assert.match(denied.stdout, /permissionDecision/);
  assert.match(denied.stdout, /deny/);

  const current = computeSourceFingerprint(cwd, mergeConfig({}));
  writeJson(guardPaths(cwd).state, {
    last_result: "passed",
    last_gate_passed_at: "2000-01-01T00:00:00.000Z",
    last_passed_fingerprint: current.fingerprint,
  });

  const allowed = runNode(pretool, cwd, payload);
  assert.strictEqual(allowed.status, 0);
  assert.strictEqual(allowed.stdout.trim(), "");
});

test("code-change gate initializes then runs gates after source changes", () => {
  const cwd = tempWorkspace();
  const payload = { cwd, hook_event_name: "Stop" };

  const initialized = runNode(codechange, cwd, payload);
  assert.strictEqual(initialized.status, 0);
  assert.strictEqual(initialized.stdout.trim(), "");
  assert.strictEqual(JSON.parse(fs.readFileSync(guardPaths(cwd).state, "utf8")).last_result, "initialized");

  fs.writeFileSync(path.join(cwd, "src", "index.js"), "module.exports = 2;\n");

  const passed = runNode(codechange, cwd, payload);
  assert.strictEqual(passed.status, 0);
  assert.match(passed.stdout, /gates passed/);
  const state = JSON.parse(fs.readFileSync(guardPaths(cwd).state, "utf8"));
  assert.strictEqual(state.last_result, "passed");
  assert.ok(state.last_passed_fingerprint);

  const logs = fs.readdirSync(guardPaths(cwd).logs);
  assert.ok(logs.length >= 2, "every hook run should write a complete log");
});
