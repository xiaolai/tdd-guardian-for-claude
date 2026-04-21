#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, 0o755);
}

function parseArgs(argv) {
  const args = {
    workspace: "",
    installAgents: false,
    set: {},
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--workspace") {
      args.workspace = argv[++i] || "";
    } else if (arg === "--install-agents") {
      args.installAgents = true;
    } else if (arg === "--no-install-agents") {
      args.installAgents = false;
    } else if (arg === "--test-command") {
      args.set.testCommand = argv[++i] || "";
    } else if (arg === "--coverage-command") {
      args.set.coverageCommand = argv[++i] || "";
    } else if (arg === "--coverage-summary-path") {
      args.set.coverageSummaryPath = argv[++i] || "";
    } else if (arg === "--coverage-mode") {
      args.set.coverageMode = argv[++i] || "";
    } else if (arg === "--require-mutation") {
      args.set.requireMutation = true;
    } else if (arg === "--mutation-command") {
      args.set.mutationCommand = argv[++i] || "";
    } else if (arg === "--advisory") {
      args.set.enforceOnCodeChange = false;
      args.set.blockCommitWithoutFreshGate = false;
    } else if (arg === "--strict") {
      args.set.enforceOnCodeChange = true;
      args.set.blockCommitWithoutFreshGate = true;
    }
  }

  return args;
}

function gitRoot(cwd) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status === 0) return result.stdout.trim();
  return cwd;
}

function detectCommands(workspace, config) {
  const pkgPath = path.join(workspace, "package.json");
  const pkg = loadJson(pkgPath);
  if (pkg && pkg.scripts) {
    const runner = fs.existsSync(path.join(workspace, "pnpm-lock.yaml"))
      ? "pnpm"
      : fs.existsSync(path.join(workspace, "yarn.lock"))
        ? "yarn"
        : "npm";

    if (!config.testCommand || config.testCommand === "pnpm test") {
      if (pkg.scripts.test) config.testCommand = `${runner} test`;
    }

    if (!config.coverageCommand || config.coverageCommand === "pnpm test -- --coverage") {
      if (pkg.scripts.coverage) {
        config.coverageCommand = `${runner} run coverage`;
      } else if (pkg.scripts.test) {
        config.coverageCommand = `${runner} test -- --coverage`;
      }
    }
  } else if (
    fs.existsSync(path.join(workspace, "pyproject.toml")) ||
    fs.existsSync(path.join(workspace, "pytest.ini")) ||
    fs.existsSync(path.join(workspace, "tests"))
  ) {
    config.testCommand = config.testCommand === "pnpm test" ? "pytest" : config.testCommand;
    config.coverageCommand =
      config.coverageCommand === "pnpm test -- --coverage"
        ? "pytest --cov --cov-report=json"
        : config.coverageCommand;
    config.coverageSummaryPath =
      config.coverageSummaryPath === "coverage/coverage-summary.json"
        ? "coverage.json"
        : config.coverageSummaryPath;
  }

  return config;
}

function mergeClaudeConfig(workspace, config) {
  const claudeConfig = loadJson(path.join(workspace, ".claude", "tdd-guardian", "config.json"));
  if (!claudeConfig) return config;

  const migrated = { ...config, ...claudeConfig };
  delete migrated.enforceOnTaskCompleted;
  if (Object.prototype.hasOwnProperty.call(claudeConfig, "enforceOnTaskCompleted")) {
    migrated.enforceOnCodeChange = Boolean(claudeConfig.enforceOnTaskCompleted);
  }
  return migrated;
}

function mergeHooks(existing, addition) {
  const merged = existing && typeof existing === "object" ? existing : {};
  merged.hooks = merged.hooks && typeof merged.hooks === "object" ? merged.hooks : {};

  for (const [event, groups] of Object.entries(addition.hooks || {})) {
    merged.hooks[event] = Array.isArray(merged.hooks[event]) ? merged.hooks[event] : [];
    for (const group of groups) {
      const commands = new Set((group.hooks || []).map((hook) => hook.command));
      const exists = merged.hooks[event].some((existingGroup) =>
        (existingGroup.hooks || []).some((hook) => commands.has(hook.command))
      );
      if (!exists) merged.hooks[event].push(group);
    }
  }

  return merged;
}

function appendGitignore(workspace, snippetPath) {
  const gitignorePath = path.join(workspace, ".gitignore");
  const snippet = fs.readFileSync(snippetPath, "utf8").trim().split(/\r?\n/);
  const current = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  const lines = current.split(/\r?\n/);
  const missing = snippet.filter((line) => line && !lines.includes(line));
  if (missing.length === 0) return false;
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(gitignorePath, `${prefix}${missing.join("\n")}\n`);
  return true;
}

function copyAgents(pluginRoot, workspace) {
  const srcDir = path.join(pluginRoot, "templates", "agents");
  const dstDir = path.join(workspace, ".codex", "agents");
  if (!fs.existsSync(srcDir)) return [];
  fs.mkdirSync(dstDir, { recursive: true });
  const copied = [];
  for (const name of fs.readdirSync(srcDir)) {
    if (!name.endsWith(".toml")) continue;
    copyFile(path.join(srcDir, name), path.join(dstDir, name));
    copied.push(path.join(".codex", "agents", name));
  }
  return copied;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const pluginRoot = path.resolve(__dirname, "..", "..");
  const workspace = gitRoot(path.resolve(args.workspace || process.cwd()));

  const defaultConfig = loadJson(path.join(pluginRoot, "templates", "config.default.json"));
  const configPath = path.join(workspace, ".codex", "tdd-guardian", "config.json");
  const existingConfig = loadJson(configPath);
  let config = existingConfig || mergeClaudeConfig(workspace, defaultConfig);
  config = detectCommands(workspace, { ...config, ...args.set });

  if (args.installAgents) config.installCustomAgents = true;

  writeJson(configPath, config);

  const scriptDst = path.join(workspace, ".codex", "tdd-guardian", "scripts");
  for (const scriptName of ["shared.js", "pretool_guard.js", "codechange_gate.js"]) {
    copyFile(
      path.join(pluginRoot, "templates", "scripts", scriptName),
      path.join(scriptDst, scriptName)
    );
  }

  const hooksTemplate = loadJson(path.join(pluginRoot, "templates", "hooks.json"));
  const hooksPath = path.join(workspace, ".codex", "hooks.json");
  const mergedHooks = mergeHooks(loadJson(hooksPath), hooksTemplate);
  writeJson(hooksPath, mergedHooks);

  const gitignoreUpdated = appendGitignore(
    workspace,
    path.join(pluginRoot, "templates", "gitignore.snippet")
  );

  const agents = config.installCustomAgents ? copyAgents(pluginRoot, workspace) : [];

  console.log(
    JSON.stringify(
      {
        workspace,
        config: path.relative(workspace, configPath),
        hooks: path.relative(workspace, hooksPath),
        scripts: path.relative(workspace, scriptDst),
        gitignoreUpdated,
        agents,
        codexHooksFeatureRequired: true,
      },
      null,
      2
    )
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  mergeHooks,
  parseArgs,
};
