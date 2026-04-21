"use strict";

const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const pluginRoot = path.resolve(__dirname, "..");
const installer = path.join(pluginRoot, "scripts", "tdd-guardian", "install.js");

test("installer writes repo-local Codex config, hooks, scripts, gitignore, and agents", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tdd-guardian-install-"));
  fs.writeFileSync(
    path.join(workspace, "package.json"),
    JSON.stringify({ scripts: { test: "node --test", coverage: "node coverage.js" } }, null, 2)
  );

  const result = spawnSync(process.execPath, [installer, "--workspace", workspace, "--strict", "--install-agents"], {
    cwd: pluginRoot,
    encoding: "utf8",
  });

  assert.strictEqual(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.strictEqual(summary.workspace, workspace);
  assert.strictEqual(summary.codexHooksFeatureRequired, true);

  for (const relPath of [
    ".codex/hooks.json",
    ".codex/tdd-guardian/config.json",
    ".codex/tdd-guardian/scripts/shared.js",
    ".codex/tdd-guardian/scripts/pretool_guard.js",
    ".codex/tdd-guardian/scripts/codechange_gate.js",
    ".codex/agents/tdd-planner.toml",
  ]) {
    assert.ok(fs.existsSync(path.join(workspace, relPath)), `${relPath} should be installed`);
  }

  const hooks = JSON.parse(fs.readFileSync(path.join(workspace, ".codex", "hooks.json"), "utf8"));
  assert.ok(hooks.hooks.PreToolUse);
  assert.ok(hooks.hooks.Stop);

  const config = JSON.parse(
    fs.readFileSync(path.join(workspace, ".codex", "tdd-guardian", "config.json"), "utf8")
  );
  assert.strictEqual(config.enforceOnCodeChange, true);
  assert.strictEqual(config.blockCommitWithoutFreshGate, true);
  assert.strictEqual(config.testCommand, "npm test");
  assert.strictEqual(config.coverageCommand, "npm run coverage");

  const gitignore = fs.readFileSync(path.join(workspace, ".gitignore"), "utf8");
  assert.match(gitignore, /\.codex\/tdd-guardian\/state\.json/);
  assert.match(gitignore, /\.codex\/tdd-guardian\/logs\//);
});
