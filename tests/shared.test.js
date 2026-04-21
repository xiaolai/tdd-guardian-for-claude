"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const {
  checkCoverage,
  computeSourceFingerprint,
  mergeConfig,
  writeJson,
} = require("../templates/scripts/shared");

function tempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tdd-guardian-"));
}

test("source fingerprint tracks code files and ignores markdown by default", () => {
  const cwd = tempWorkspace();
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "index.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(cwd, "README.md"), "Initial docs\n");

  const config = mergeConfig({});
  const first = computeSourceFingerprint(cwd, config);

  fs.writeFileSync(path.join(cwd, "README.md"), "Changed docs\n");
  const docsChanged = computeSourceFingerprint(cwd, config);
  assert.strictEqual(docsChanged.fingerprint, first.fingerprint);

  fs.writeFileSync(path.join(cwd, "src", "index.js"), "module.exports = 2;\n");
  const codeChanged = computeSourceFingerprint(cwd, config);
  assert.notStrictEqual(codeChanged.fingerprint, first.fingerprint);
});

test("coverage gate supports absolute and no-decrease modes", () => {
  const cwd = tempWorkspace();
  fs.mkdirSync(path.join(cwd, "coverage"), { recursive: true });
  writeJson(path.join(cwd, "coverage", "coverage-summary.json"), {
    total: {
      lines: { pct: 90 },
      functions: { pct: 95 },
      branches: { pct: 80 },
      statements: { pct: 90 },
    },
  });

  const absolute = mergeConfig({
    coverageThresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
  });
  const [absoluteOk, absoluteMessage] = checkCoverage(absolute, cwd, {});
  assert.strictEqual(absoluteOk, false);
  assert.match(absoluteMessage, /Coverage gate failed/);

  const noDecrease = mergeConfig({
    coverageMode: "no-decrease",
    coverageThresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
  });
  const [baselineOk, , baseline] = checkCoverage(noDecrease, cwd, {});
  assert.strictEqual(baselineOk, true);
  assert.ok(baseline.coverage);

  writeJson(path.join(cwd, "coverage", "coverage-summary.json"), {
    total: {
      lines: { pct: 89 },
      functions: { pct: 95 },
      branches: { pct: 80 },
      statements: { pct: 90 },
    },
  });
  const [dropOk, dropMessage] = checkCoverage(noDecrease, cwd, { baseline });
  assert.strictEqual(dropOk, false);
  assert.match(dropMessage, /Coverage decreased/);
});
