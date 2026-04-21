"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const pluginRoot = path.resolve(__dirname, "..");

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(pluginRoot, relPath), "utf8"));
}

function listSkillFiles() {
  const skillsRoot = path.join(pluginRoot, "skills");
  return fs
    .readdirSync(skillsRoot)
    .map((name) => path.join(skillsRoot, name, "SKILL.md"))
    .filter((filePath) => fs.existsSync(filePath));
}

function parseFrontmatter(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  assert.ok(text.startsWith("---\n"), `${filePath} must start with YAML frontmatter`);
  const end = text.indexOf("\n---", 4);
  assert.ok(end > 0, `${filePath} must close YAML frontmatter`);
  const frontmatter = text.slice(4, end).trim();
  const fields = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (match) fields[match[1]] = match[2].replace(/^"|"$/g, "");
  }
  return fields;
}

const manifest = readJson(".codex-plugin/plugin.json");
assert.strictEqual(manifest.name, "tdd-guardian");
assert.strictEqual(manifest.skills, "./skills/");
assert.ok(!manifest.apps, "manifest should not declare unused apps");
assert.ok(!manifest.mcpServers, "manifest should not declare unused MCP servers");

const marketplacePaths = [
  path.resolve(pluginRoot, ".agents", "plugins", "marketplace.json"),
  path.resolve(pluginRoot, "..", "..", ".agents", "plugins", "marketplace.json"),
];
const marketplacePath = marketplacePaths.find((candidate) => fs.existsSync(candidate));
if (marketplacePath) {
  const marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
  assert.ok(
    marketplace.plugins.some((plugin) => plugin.name === "tdd-guardian"),
    "available marketplace should expose the plugin"
  );
}

const hooks = readJson("templates/hooks.json");
assert.ok(Array.isArray(hooks.hooks.PreToolUse), "PreToolUse hook is required");
assert.ok(Array.isArray(hooks.hooks.Stop), "Stop hook is required");
assert.match(
  hooks.hooks.Stop[0].hooks[0].command,
  /\.codex\/tdd-guardian\/scripts\/codechange_gate\.js/,
  "Stop hook must call the installed code-change gate"
);

for (const relPath of [
  "templates/config.default.json",
  "templates/scripts/shared.js",
  "templates/scripts/pretool_guard.js",
  "templates/scripts/codechange_gate.js",
  "scripts/tdd-guardian/install.js",
]) {
  assert.ok(fs.existsSync(path.join(pluginRoot, relPath)), `${relPath} must exist`);
}

const names = new Set();
for (const skillFile of listSkillFiles()) {
  const fields = parseFrontmatter(skillFile);
  assert.ok(fields.name, `${skillFile} must declare name`);
  assert.ok(fields.description, `${skillFile} must declare description`);
  assert.ok(fields.name.startsWith("tdd-guardian-"), `${skillFile} skill name should be namespaced`);
  assert.ok(!names.has(fields.name), `duplicate skill name: ${fields.name}`);
  names.add(fields.name);
}

for (const required of [
  "tdd-guardian-init",
  "tdd-guardian-workflow",
  "tdd-guardian-policy-core",
  "tdd-guardian-coverage-gate",
  "tdd-guardian-review",
]) {
  assert.ok(names.has(required), `missing skill: ${required}`);
}
