"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const coverage = require("../scripts/tdd-guardian/lib/coverage.js");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ISTANBUL_SUMMARY = JSON.stringify({
  total: {
    lines: { total: 100, covered: 90, skipped: 0, pct: 90 },
    statements: { total: 110, covered: 99, skipped: 0, pct: 90 },
    functions: { total: 20, covered: 18, skipped: 0, pct: 90 },
    branches: { total: 40, covered: 30, skipped: 0, pct: 75 },
  },
  "/repo/src/a.ts": {
    lines: { total: 60, covered: 60, skipped: 0, pct: 100 },
    statements: { total: 66, covered: 66, skipped: 0, pct: 100 },
    functions: { total: 12, covered: 12, skipped: 0, pct: 100 },
    branches: { total: 20, covered: 20, skipped: 0, pct: 100 },
  },
  "/repo/src/b.ts": {
    lines: { total: 40, covered: 30, skipped: 0, pct: 75 },
    statements: { total: 44, covered: 33, skipped: 0, pct: 75 },
    functions: { total: 8, covered: 6, skipped: 0, pct: 75 },
    branches: { total: 20, covered: 10, skipped: 0, pct: 50 },
  },
});

const ISTANBUL_FINAL = JSON.stringify({
  "/repo/src/a.ts": {
    path: "/repo/src/a.ts",
    statementMap: {
      0: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
      1: { start: { line: 2, column: 0 }, end: { line: 3, column: 5 } },
      2: { start: { line: 5, column: 0 }, end: { line: 5, column: 8 } },
    },
    fnMap: { 0: { name: "f", decl: {}, loc: {} } },
    branchMap: { 0: { type: "if", locations: [{}, {}] } },
    s: { 0: 3, 1: 1, 2: 0 },
    f: { 0: 3 },
    b: { 0: [3, 0] },
  },
});

const COVERAGE_PY = JSON.stringify({
  meta: { version: "7.4.0", branch_coverage: true },
  files: {
    "app/core.py": {
      executed_lines: [1, 2, 3, 5],
      missing_lines: [4, 6],
      excluded_lines: [],
      summary: {
        covered_lines: 4,
        num_statements: 6,
        percent_covered: 66.66666666666667,
        missing_lines: 2,
        excluded_lines: 0,
        num_branches: 4,
        covered_branches: 3,
        missing_branches: 1,
      },
    },
  },
  totals: {
    covered_lines: 4,
    num_statements: 6,
    percent_covered: 66.66666666666667,
    num_branches: 4,
    covered_branches: 3,
  },
});

const LCOV = `TN:
SF:/repo/src/a.js
FN:3,alpha
FNDA:2,alpha
FNF:4
FNH:3
BRDA:5,0,0,1
BRDA:5,0,1,0
BRF:8
BRH:6
DA:1,3
DA:2,1
DA:3,0
DA:4,7
LF:4
LH:3
end_of_record
TN:
SF:/repo/src/b.js
FNF:2
FNH:2
BRF:0
BRH:0
DA:1,1
DA:2,0
LF:2
LH:1
end_of_record
`;

const COBERTURA = `<?xml version="1.0" ?>
<coverage line-rate="0.75" branch-rate="0.5" lines-valid="8" lines-covered="6" branches-valid="4" branches-covered="2" version="1.9">
  <packages>
    <package name="app">
      <classes>
        <class name="core" filename="app/core.py" line-rate="0.75">
          <methods>
            <method name="run" signature="()">
              <lines><line number="2" hits="4"/></lines>
            </method>
            <method name="idle" signature="()">
              <lines><line number="6" hits="0"/></lines>
            </method>
          </methods>
          <lines>
            <line number="1" hits="4"/>
            <line number="2" hits="4"/>
            <line number="3" hits="0" branch="true" condition-coverage="50% (1/2)"/>
            <line number="6" hits="0"/>
          </lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>
`;

const JACOCO = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd">
<report name="demo">
  <package name="com/example">
    <sourcefile name="Calculator.java">
      <line nr="5" mi="0" ci="4" mb="0" cb="2"/>
      <line nr="6" mi="3" ci="0" mb="2" cb="0"/>
      <counter type="INSTRUCTION" missed="3" covered="4"/>
      <counter type="BRANCH" missed="2" covered="2"/>
      <counter type="LINE" missed="1" covered="1"/>
      <counter type="METHOD" missed="1" covered="3"/>
    </sourcefile>
  </package>
</report>
`;

const CLOVER = `<?xml version="1.0" encoding="UTF-8"?>
<coverage generated="1700000000">
  <project timestamp="1700000000">
    <metrics files="1" loc="20" ncloc="18" classes="1" methods="4" coveredmethods="3" conditionals="6" coveredconditionals="4" statements="10" coveredstatements="8"/>
    <file name="/repo/src/Service.php">
      <line num="4" type="method" name="handle" visibility="public" complexity="2" crap="2" count="5"/>
      <line num="5" type="stmt" count="5"/>
      <line num="6" type="cond" truecount="1" falsecount="0"/>
      <line num="7" type="stmt" count="0"/>
    </file>
  </project>
</coverage>
`;

const GO_COVER = `mode: set
github.com/x/y/a.go:3.20,6.2 3 1
github.com/x/y/a.go:8.14,10.3 2 0
github.com/x/y/b.go:4.10,5.5 1 1
`;

const SIMPLECOV_NESTED = JSON.stringify({
  RSpec: {
    coverage: { "/repo/lib/thing.rb": { lines: [1, 0, null, 4] } },
    timestamp: 1700000000,
  },
});

const SIMPLECOV_FLAT = JSON.stringify({
  Minitest: { coverage: { "/repo/lib/thing.rb": [1, 0, null, 4] }, timestamp: 1700000000 },
});

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

test("detectFormat identifies every supported format", () => {
  assert.equal(coverage.detectFormat(ISTANBUL_SUMMARY, "coverage-summary.json"), "istanbul-summary");
  assert.equal(coverage.detectFormat(ISTANBUL_FINAL, "coverage-final.json"), "istanbul-final");
  assert.equal(coverage.detectFormat(COVERAGE_PY, "coverage.json"), "coverage-py");
  assert.equal(coverage.detectFormat(LCOV, "lcov.info"), "lcov");
  assert.equal(coverage.detectFormat(COBERTURA, "cobertura.xml"), "cobertura");
  assert.equal(coverage.detectFormat(JACOCO, "jacoco.xml"), "jacoco");
  assert.equal(coverage.detectFormat(CLOVER, "clover.xml"), "clover");
  assert.equal(coverage.detectFormat(GO_COVER, "coverage.out"), "go-cover");
  assert.equal(coverage.detectFormat(SIMPLECOV_NESTED, ".resultset.json"), "simplecov");
});

test("detectFormat returns null for unknown content", () => {
  assert.equal(coverage.detectFormat("hello world", "x.txt"), null);
  assert.equal(coverage.detectFormat("{ not json", "x.json"), null);
});

// ---------------------------------------------------------------------------
// Per-format parsing
// ---------------------------------------------------------------------------

test("istanbul-summary parses totals and per-file entries", () => {
  const { report, error } = coverage.parseText(ISTANBUL_SUMMARY, "coverage-summary.json");
  assert.equal(error, null);
  assert.equal(report.format, "istanbul-summary");
  assert.equal(report.hasLineDetail, false);
  assert.deepEqual(report.totals.lines, { covered: 90, total: 100, pct: 90 });
  assert.deepEqual(report.totals.branches, { covered: 30, total: 40, pct: 75 });
  assert.equal(report.files.length, 2);
  assert.equal(report.files.find((f) => f.path.endsWith("b.ts")).branches.pct, 50);
});

test("istanbul-final derives line hits from the statement map", () => {
  const { report } = coverage.parseText(ISTANBUL_FINAL, "coverage-final.json");
  assert.equal(report.hasLineDetail, true);
  const file = report.files[0];
  // Statement 1 spans lines 2-3, so both lines inherit its hit count.
  assert.deepEqual(file.lineHits, { 1: 3, 2: 1, 3: 1, 5: 0 });
  assert.deepEqual(file.lines, { covered: 3, total: 4, pct: 75 });
  assert.deepEqual(file.uncoveredLines, [5]);
  // Branch b[0] = [3, 0]: one of two paths taken.
  assert.deepEqual(file.branches, { covered: 1, total: 2, pct: 50 });
  assert.deepEqual(file.functions, { covered: 1, total: 1, pct: 100 });
});

test("coverage-py maps statements onto lines and reports no function data", () => {
  const { report } = coverage.parseText(COVERAGE_PY, "coverage.json");
  assert.equal(report.format, "coverage-py");
  assert.deepEqual(report.totals.lines, { covered: 4, total: 6, pct: 66.67 });
  assert.deepEqual(report.totals.statements, { covered: 4, total: 6, pct: 66.67 });
  assert.deepEqual(report.totals.branches, { covered: 3, total: 4, pct: 75 });
  assert.equal(report.totals.functions, null, "coverage.py does not measure functions");
  assert.deepEqual(report.files[0].uncoveredLines, [4, 6]);
});

test("lcov aggregates LF/LH, FNF/FNH and BRF/BRH across records", () => {
  const { report } = coverage.parseText(LCOV, "lcov.info");
  assert.equal(report.format, "lcov");
  assert.equal(report.hasLineDetail, true);
  assert.deepEqual(report.totals.lines, { covered: 4, total: 6, pct: 66.67 });
  assert.deepEqual(report.totals.functions, { covered: 5, total: 6, pct: 83.33 });
  assert.deepEqual(report.totals.branches, { covered: 6, total: 8, pct: 75 });
  // LCOV has no separate statement axis; lines is mirrored into it.
  assert.deepEqual(report.totals.statements, report.totals.lines);
  assert.deepEqual(report.files[0].uncoveredLines, [3]);
});

test("cobertura prefers the root element counters over the per-class scan", () => {
  const { report } = coverage.parseText(COBERTURA, "cobertura.xml");
  assert.equal(report.format, "cobertura");
  // Root says 6/8 lines; the class scan alone would have found 2/4.
  assert.deepEqual(report.totals.lines, { covered: 6, total: 8, pct: 75 });
  assert.deepEqual(report.totals.branches, { covered: 2, total: 4, pct: 50 });
  const file = report.files[0];
  assert.equal(file.path, "app/core.py");
  assert.deepEqual(file.uncoveredLines, [3, 6]);
  assert.deepEqual(file.functions, { covered: 1, total: 2, pct: 50 });
});

test("jacoco reads counters and treats covered instructions as line hits", () => {
  const { report } = coverage.parseText(JACOCO, "jacoco.xml");
  assert.equal(report.format, "jacoco");
  assert.deepEqual(report.totals.lines, { covered: 1, total: 2, pct: 50 });
  assert.deepEqual(report.totals.branches, { covered: 2, total: 4, pct: 50 });
  assert.deepEqual(report.totals.functions, { covered: 3, total: 4, pct: 75 });
  // INSTRUCTION is bytecode-level, so statements mirrors lines instead.
  assert.deepEqual(report.totals.statements, report.totals.lines);
  assert.equal(report.files[0].path, "com/example/Calculator.java");
  assert.deepEqual(report.files[0].uncoveredLines, [6]);
});

test("clover reads project metrics and classifies method/cond/stmt lines", () => {
  const { report } = coverage.parseText(CLOVER, "clover.xml");
  assert.equal(report.format, "clover");
  assert.deepEqual(report.totals.lines, { covered: 8, total: 10, pct: 80 });
  assert.deepEqual(report.totals.functions, { covered: 3, total: 4, pct: 75 });
  assert.deepEqual(report.totals.branches, { covered: 4, total: 6, pct: 66.67 });
  // A type="method" line is a function, not a statement line.
  assert.deepEqual(report.files[0].uncoveredLines, [7]);
});

test("go-cover weights by statement count and reports no function or branch data", () => {
  const { report } = coverage.parseText(GO_COVER, "coverage.out");
  assert.equal(report.format, "go-cover");
  // Statements: a.go 3 covered of 5, b.go 1 of 1 => 4/6.
  assert.deepEqual(report.totals.statements, { covered: 4, total: 6, pct: 66.67 });
  assert.equal(report.totals.functions, null);
  assert.equal(report.totals.branches, null);
  const a = report.files.find((f) => f.path.endsWith("a.go"));
  // Block 3.20,6.2 marks lines 3-6 hit; block 8.14,10.3 marks 8-10 missed.
  assert.deepEqual(a.uncoveredLines, [8, 9, 10]);
});

test("simplecov parses both the nested and the flat resultset shapes", () => {
  for (const fixture of [SIMPLECOV_NESTED, SIMPLECOV_FLAT]) {
    const { report } = coverage.parseText(fixture, ".resultset.json");
    assert.equal(report.format, "simplecov");
    // Index 2 is null (not relevant) and must not count toward the total.
    assert.deepEqual(report.totals.lines, { covered: 2, total: 3, pct: 66.67 });
    assert.deepEqual(report.files[0].uncoveredLines, [2]);
  }
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

test("parseText reports an unrecognized format with a sample of the content", () => {
  const { report, error } = coverage.parseText("total garbage", "weird.dat");
  assert.equal(report, null);
  assert.match(error, /Unrecognized coverage format/);
  assert.match(error, /total garbage/);
});

test("parseText reports an empty report rather than returning zero coverage", () => {
  const { report, error } = coverage.parseText("   ", "empty.json");
  assert.equal(report, null);
  assert.match(error, /is empty/);
});

test("parseFile explains a missing report with the likely causes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tddg-"));
  const { report, error } = coverage.parseFile("coverage/nope.json", dir);
  assert.equal(report, null);
  assert.match(error, /Coverage summary not found/);
  assert.match(error, /coverageSummaryPath/);
});

// ---------------------------------------------------------------------------
// Threshold comparison
// ---------------------------------------------------------------------------

test("compareToThresholds fails a measured metric that is below threshold", () => {
  const { report } = coverage.parseText(ISTANBUL_SUMMARY, "s.json");
  const result = coverage.compareToThresholds(report.totals, { lines: 95, branches: 50 });
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /lines: 90\.00% < 95\.00% \(90\/100\)/);
});

test("compareToThresholds warns rather than fails when a metric is not measured", () => {
  const { report } = coverage.parseText(GO_COVER, "coverage.out");
  const result = coverage.compareToThresholds(report.totals, { statements: 50, functions: 100, branches: 100 });
  assert.equal(result.ok, true, "an unmeasured metric must not fail the gate");
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0], /not measured/);
  assert.match(result.summary, /functions=n\/a/);
});

test("compareToThresholds ignores a zero threshold on an unmeasured metric", () => {
  const { report } = coverage.parseText(GO_COVER, "coverage.out");
  const result = coverage.compareToThresholds(report.totals, { statements: 50, functions: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 0);
});

test("compareToBaseline blocks a decrease and allows an improvement", () => {
  const { report } = coverage.parseText(ISTANBUL_SUMMARY, "s.json");
  const dropped = coverage.compareToBaseline(report.totals, { lines: 95 });
  assert.equal(dropped.ok, false);
  assert.match(dropped.failures[0], /Δ -5\.00%/);

  const improved = coverage.compareToBaseline(report.totals, { lines: 80 });
  assert.equal(improved.ok, true);
});

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

test("mergeReports passes a single report through untouched", () => {
  const { report } = coverage.parseText(LCOV, "lcov.info");
  const merged = coverage.mergeReports([report]);
  assert.equal(merged.method, "single");
  assert.equal(merged.approximate, false);
  assert.deepEqual(merged.totals, report.totals);
});

test("mergeReports unions per-line detail so overlapping lines count once", () => {
  const laneA = `SF:/repo/src/a.js
DA:1,1
DA:2,0
DA:3,0
LF:3
LH:1
end_of_record
`;
  const laneB = `SF:/repo/src/a.js
DA:1,0
DA:2,5
DA:3,0
LF:3
LH:1
end_of_record
`;
  const a = coverage.parseText(laneA, "a.info").report;
  const b = coverage.parseText(laneB, "b.info").report;

  const merged = coverage.mergeReports([a, b]);
  assert.equal(merged.method, "union");
  assert.equal(merged.approximate, false);
  // Union: lines 1 and 2 are covered by some lane, line 3 by neither => 2/3.
  assert.deepEqual(merged.totals.lines, { covered: 2, total: 3, pct: 66.67 });
});

test("mergeReports falls back to a flagged weighted average without line detail", () => {
  const summary = coverage.parseText(ISTANBUL_SUMMARY, "s.json").report;
  const lcov = coverage.parseText(LCOV, "l.info").report;

  const merged = coverage.mergeReports([summary, lcov]);
  assert.equal(merged.method, "weighted");
  assert.equal(merged.approximate, true, "callers must be told the merge is approximate");
  // 90/100 + 4/6 summed => 94/106.
  assert.deepEqual(merged.totals.lines, { covered: 94, total: 106, pct: 88.68 });
});

test("mergeReports handles an empty input list", () => {
  const merged = coverage.mergeReports([]);
  assert.equal(merged.method, "single");
  assert.deepEqual(merged.totals, { lines: null, functions: null, branches: null, statements: null });
});

// ---------------------------------------------------------------------------
// Empty-report detection
// ---------------------------------------------------------------------------

test("isEmpty flags a report that measured nothing", () => {
  // 0/0 scores 100% by convention, which would otherwise pass every threshold.
  const empty = coverage.parseText(JSON.stringify({ total: { lines: { total: 0, covered: 0, pct: 100 } } }), "s.json").report;
  assert.equal(empty.totals.lines.pct, 100);
  assert.equal(coverage.isEmpty(empty.totals), true);
});

test("isEmpty is false for a report with real measurements", () => {
  const { report } = coverage.parseText(ISTANBUL_SUMMARY, "s.json");
  assert.equal(coverage.isEmpty(report.totals), false);
});

test("totalsToPercentages flattens metrics and preserves nulls", () => {
  const { report } = coverage.parseText(GO_COVER, "coverage.out");
  assert.deepEqual(coverage.totalsToPercentages(report.totals), {
    lines: 66.67,
    functions: null,
    branches: null,
    statements: 66.67,
  });
});
