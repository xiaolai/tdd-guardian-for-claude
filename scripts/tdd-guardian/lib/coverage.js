"use strict";
// Multi-format coverage parsing and merging.
//
// Every parser normalises to the same shape so the gate can compare against
// thresholds without knowing which tool produced the report:
//
//   { format, path, hasLineDetail, totals: {lines, functions, branches, statements}, files: [...] }
//
// A metric is either {covered, total, pct} or null. null means "this tool does not
// measure this dimension" — NOT zero. Treating null as zero would fail the gate on
// e.g. functions for any LCOV-only project, which is a false failure.
//
// hasLineDetail records whether the report carries per-line hit data. It decides
// whether multi-lane coverage can be merged as a true union or only as a weighted
// average (see mergeReports).

const fs = require("fs");
const path = require("path");

const KNOWN_FORMATS = [
  "istanbul-summary",
  "istanbul-final",
  "coverage-py",
  "lcov",
  "cobertura",
  "jacoco",
  "go-cover",
  "clover",
  "simplecov",
];

// ---------------------------------------------------------------------------
// Metric helpers
// ---------------------------------------------------------------------------

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Convention: 0 measurable units counts as 100%. Callers must separately check
// for total === 0, which means the report measured nothing at all — a silent
// no-op run looks identical to a perfect one if you only read the percentage.
function metric(covered, total) {
  const c = Number(covered) || 0;
  const t = Number(total) || 0;
  return { covered: c, total: t, pct: t === 0 ? 100 : round2((c / t) * 100) };
}

function emptyTotals() {
  return { lines: null, functions: null, branches: null, statements: null };
}

function sumMetrics(a, b) {
  if (a === null && b === null) return null;
  if (a === null) return { ...b };
  if (b === null) return { ...a };
  return metric(a.covered + b.covered, a.total + b.total);
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

function detectFormat(text, filePath) {
  const head = text.slice(0, 4096);
  const trimmed = head.trimStart();
  const ext = path.extname(filePath || "").toLowerCase();

  if (/^mode:\s*(set|count|atomic)/m.test(head)) return "go-cover";
  if (/^(TN:|SF:)/m.test(head)) return "lcov";

  if (trimmed.startsWith("<")) {
    if (/<report[\s>]/.test(head) && /jacoco/i.test(head.slice(0, 1024) + text.slice(0, 2048))) return "jacoco";
    if (/<coverage[\s>][^>]*(?:line-rate|lines-valid)/.test(head)) return "cobertura";
    if (/<coverage[\s>]/.test(head) && /<project[\s>]/.test(head)) return "clover";
    if (/<report[\s>]/.test(head)) return "jacoco";
    if (/<coverage[\s>]/.test(head)) return "cobertura";
    return null;
  }

  if (trimmed.startsWith("{")) {
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return null;
    }
    return detectJsonFormat(json);
  }

  // Extension is a last resort, never the primary signal.
  if (ext === ".info") return "lcov";
  if (ext === ".out") return "go-cover";
  return null;
}

function detectJsonFormat(json) {
  if (!json || typeof json !== "object") return null;

  if (json.totals && typeof json.totals === "object" && "num_statements" in json.totals) return "coverage-py";
  if (Array.isArray(json.data) && json.data[0] && json.data[0].totals) return "coverage-py";
  if (json.files && typeof json.files === "object" && !json.total) {
    const first = Object.values(json.files)[0];
    if (first && (first.summary || first.executed_lines)) return "coverage-py";
  }

  if (json.total && typeof json.total === "object") {
    const t = json.total;
    if (t.lines && typeof t.lines === "object" && "pct" in t.lines) return "istanbul-summary";
  }

  const values = Object.values(json);
  if (values.length && values.every((v) => v && typeof v === "object")) {
    if (values.some((v) => v.statementMap && v.s)) return "istanbul-final";
    // SimpleCov .resultset.json: { "<suite>": { coverage: {...}, timestamp: n } }
    if (values.some((v) => v.coverage && typeof v.coverage === "object")) return "simplecov";
  }

  return null;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parseIstanbulSummary(text) {
  const json = JSON.parse(text);
  const pick = (obj, key) => {
    const m = obj && obj[key];
    if (!m || typeof m.total !== "number") return null;
    return metric(m.covered, m.total);
  };

  const files = [];
  for (const [key, value] of Object.entries(json)) {
    if (key === "total") continue;
    files.push({
      path: key,
      lines: pick(value, "lines"),
      functions: pick(value, "functions"),
      branches: pick(value, "branches"),
      statements: pick(value, "statements"),
      lineHits: null,
      uncoveredLines: [],
    });
  }

  return {
    format: "istanbul-summary",
    hasLineDetail: false,
    totals: {
      lines: pick(json.total, "lines"),
      functions: pick(json.total, "functions"),
      branches: pick(json.total, "branches"),
      statements: pick(json.total, "statements"),
    },
    files,
  };
}

function parseIstanbulFinal(text) {
  const json = JSON.parse(text);
  const files = [];

  for (const [key, entry] of Object.entries(json)) {
    if (!entry || !entry.statementMap) continue;

    const lineHits = {};
    for (const [id, loc] of Object.entries(entry.statementMap)) {
      const count = Number(entry.s?.[id]) || 0;
      const from = loc?.start?.line;
      const to = loc?.end?.line ?? from;
      if (!Number.isFinite(from)) continue;
      for (let line = from; line <= to; line++) {
        lineHits[line] = Math.max(lineHits[line] || 0, count);
      }
    }

    const lineValues = Object.values(lineHits);
    const stmtValues = Object.values(entry.s || {}).map(Number);
    const fnValues = Object.values(entry.f || {}).map(Number);

    let branchCovered = 0;
    let branchTotal = 0;
    for (const paths of Object.values(entry.b || {})) {
      for (const hit of paths || []) {
        branchTotal++;
        if (Number(hit) > 0) branchCovered++;
      }
    }

    files.push({
      path: entry.path || key,
      lines: metric(lineValues.filter((v) => v > 0).length, lineValues.length),
      functions: fnValues.length ? metric(fnValues.filter((v) => v > 0).length, fnValues.length) : null,
      branches: branchTotal ? metric(branchCovered, branchTotal) : null,
      statements: stmtValues.length ? metric(stmtValues.filter((v) => v > 0).length, stmtValues.length) : null,
      lineHits,
      uncoveredLines: Object.entries(lineHits).filter(([, h]) => h === 0).map(([l]) => Number(l)).sort((a, b) => a - b),
    });
  }

  return { format: "istanbul-final", hasLineDetail: true, totals: totalsFromFiles(files), files };
}

function parseCoveragePy(text) {
  const json = JSON.parse(text);
  const root = Array.isArray(json.data) && json.data[0] ? json.data[0] : json;
  const files = [];

  for (const [name, entry] of Object.entries(root.files || {})) {
    const summary = entry.summary || {};
    const executed = Array.isArray(entry.executed_lines) ? entry.executed_lines : [];
    const missing = Array.isArray(entry.missing_lines) ? entry.missing_lines : [];

    const lineHits = {};
    for (const line of executed) lineHits[line] = 1;
    for (const line of missing) if (!(line in lineHits)) lineHits[line] = 0;

    const covered = Number(summary.covered_lines);
    const total = Number(summary.num_statements);
    const stmt = Number.isFinite(covered) && Number.isFinite(total) ? metric(covered, total) : metric(executed.length, executed.length + missing.length);

    const numBranches = Number(summary.num_branches);
    const coveredBranches = Number(summary.covered_branches);

    files.push({
      path: name,
      // coverage.py measures statements; lines and statements are the same axis.
      lines: stmt,
      functions: null,
      branches: Number.isFinite(numBranches) && numBranches > 0 ? metric(coveredBranches || 0, numBranches) : null,
      statements: stmt,
      lineHits: Object.keys(lineHits).length ? lineHits : null,
      uncoveredLines: missing.slice().sort((a, b) => a - b),
    });
  }

  const totals = root.totals || {};
  const hasTotals = Number.isFinite(Number(totals.num_statements));
  const stmtTotal = hasTotals
    ? metric(Number(totals.covered_lines) || 0, Number(totals.num_statements))
    : totalsFromFiles(files).statements;
  const branchTotal =
    Number(totals.num_branches) > 0 ? metric(Number(totals.covered_branches) || 0, Number(totals.num_branches)) : totalsFromFiles(files).branches;

  return {
    format: "coverage-py",
    hasLineDetail: files.some((f) => f.lineHits),
    totals: { lines: stmtTotal, functions: null, branches: branchTotal, statements: stmtTotal },
    files,
  };
}

function parseLcov(text) {
  const files = [];
  let current = null;

  const reset = () => ({
    path: "",
    lineHits: {},
    fnFound: 0,
    fnHit: 0,
    brFound: 0,
    brHit: 0,
    lfFound: null,
    lhHit: null,
  });

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("SF:")) {
      current = reset();
      current.path = line.slice(3);
      continue;
    }
    if (!current) continue;

    if (line.startsWith("DA:")) {
      const [num, hits] = line.slice(3).split(",");
      const n = Number(num);
      if (Number.isFinite(n)) current.lineHits[n] = Math.max(current.lineHits[n] || 0, Number(hits) || 0);
    } else if (line.startsWith("FNF:")) current.fnFound = Number(line.slice(4)) || 0;
    else if (line.startsWith("FNH:")) current.fnHit = Number(line.slice(4)) || 0;
    else if (line.startsWith("BRF:")) current.brFound = Number(line.slice(4)) || 0;
    else if (line.startsWith("BRH:")) current.brHit = Number(line.slice(4)) || 0;
    else if (line.startsWith("LF:")) current.lfFound = Number(line.slice(3)) || 0;
    else if (line.startsWith("LH:")) current.lhHit = Number(line.slice(3)) || 0;
    else if (line === "end_of_record") {
      const hitValues = Object.values(current.lineHits);
      const lines =
        current.lfFound !== null
          ? metric(current.lhHit || 0, current.lfFound)
          : metric(hitValues.filter((v) => v > 0).length, hitValues.length);

      files.push({
        path: current.path,
        lines,
        functions: current.fnFound > 0 ? metric(current.fnHit, current.fnFound) : null,
        branches: current.brFound > 0 ? metric(current.brHit, current.brFound) : null,
        // LCOV has no separate statement axis; mirroring lines is the standard reading.
        statements: lines,
        lineHits: Object.keys(current.lineHits).length ? current.lineHits : null,
        uncoveredLines: Object.entries(current.lineHits).filter(([, h]) => h === 0).map(([l]) => Number(l)).sort((a, b) => a - b),
      });
      current = null;
    }
  }

  return { format: "lcov", hasLineDetail: files.some((f) => f.lineHits), totals: totalsFromFiles(files), files };
}

// Narrow attribute scraper. These reports are machine-generated and well-formed;
// a full XML parser would be a dependency for no added correctness here.
function xmlAttrs(tag) {
  const out = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(tag))) out[m[1]] = m[2];
  return out;
}

function parseCobertura(text) {
  const files = [];
  const classRe = /<class\b([^>]*)>([\s\S]*?)<\/class>/g;
  let match;

  while ((match = classRe.exec(text))) {
    const attrs = xmlAttrs(match[1]);
    const body = match[2];
    const filename = attrs.filename || attrs.name || "";

    const lineHits = {};
    let brCovered = 0;
    let brTotal = 0;

    const lineRe = /<line\b([^>]*)\/?>/g;
    let lineMatch;
    while ((lineMatch = lineRe.exec(body))) {
      const la = xmlAttrs(lineMatch[1]);
      const num = Number(la.number);
      if (!Number.isFinite(num)) continue;
      lineHits[num] = Math.max(lineHits[num] || 0, Number(la.hits) || 0);

      if (la.branch === "true" && la["condition-coverage"]) {
        const cc = /\((\d+)\/(\d+)\)/.exec(la["condition-coverage"]);
        if (cc) {
          brCovered += Number(cc[1]);
          brTotal += Number(cc[2]);
        }
      }
    }

    const methodCount = (body.match(/<method\b/g) || []).length;
    let fnCovered = 0;
    if (methodCount) {
      const methodRe = /<method\b([^>]*)>([\s\S]*?)<\/method>/g;
      let mm;
      while ((mm = methodRe.exec(body))) {
        const hits = [...mm[2].matchAll(/<line\b([^>]*)\/?>/g)].map((x) => Number(xmlAttrs(x[1]).hits) || 0);
        if (hits.some((h) => h > 0)) fnCovered++;
      }
    }

    const hitValues = Object.values(lineHits);
    const lines = metric(hitValues.filter((v) => v > 0).length, hitValues.length);

    files.push({
      path: filename,
      lines,
      functions: methodCount ? metric(fnCovered, methodCount) : null,
      branches: brTotal ? metric(brCovered, brTotal) : null,
      statements: lines,
      lineHits: hitValues.length ? lineHits : null,
      uncoveredLines: Object.entries(lineHits).filter(([, h]) => h === 0).map(([l]) => Number(l)).sort((a, b) => a - b),
    });
  }

  let totals = totalsFromFiles(files);

  // Prefer the root element's own counters when present — they are authoritative
  // and cover files the class scan may have missed.
  const rootMatch = /<coverage\b([^>]*)>/.exec(text);
  if (rootMatch) {
    const ra = xmlAttrs(rootMatch[1]);
    const linesValid = Number(ra["lines-valid"]);
    const linesCovered = Number(ra["lines-covered"]);
    const branchesValid = Number(ra["branches-valid"]);
    const branchesCovered = Number(ra["branches-covered"]);
    if (Number.isFinite(linesValid) && linesValid > 0) {
      const lineTotal = metric(linesCovered || 0, linesValid);
      totals = { ...totals, lines: lineTotal, statements: lineTotal };
    }
    if (Number.isFinite(branchesValid) && branchesValid > 0) {
      totals = { ...totals, branches: metric(branchesCovered || 0, branchesValid) };
    }
  }

  return { format: "cobertura", hasLineDetail: files.some((f) => f.lineHits), totals, files };
}

function parseJacoco(text) {
  const files = [];
  const packageRe = /<package\b([^>]*)>([\s\S]*?)<\/package>/g;
  let pkgMatch;

  const counterOf = (body, type) => {
    const re = new RegExp(`<counter\\b[^>]*type="${type}"[^>]*/?>`, "g");
    let missed = 0;
    let covered = 0;
    let found = false;
    let m;
    while ((m = re.exec(body))) {
      const a = xmlAttrs(m[0]);
      missed += Number(a.missed) || 0;
      covered += Number(a.covered) || 0;
      found = true;
    }
    return found ? metric(covered, covered + missed) : null;
  };

  while ((pkgMatch = packageRe.exec(text))) {
    const pkgName = xmlAttrs(pkgMatch[1]).name || "";
    const pkgBody = pkgMatch[2];

    const sourceRe = /<sourcefile\b([^>]*)>([\s\S]*?)<\/sourcefile>/g;
    let srcMatch;
    while ((srcMatch = sourceRe.exec(pkgBody))) {
      const name = xmlAttrs(srcMatch[1]).name || "";
      const body = srcMatch[2];

      const lineHits = {};
      const lineRe = /<line\b([^>]*)\/?>/g;
      let lm;
      while ((lm = lineRe.exec(body))) {
        const a = xmlAttrs(lm[1]);
        const nr = Number(a.nr);
        if (!Number.isFinite(nr)) continue;
        // ci = covered instructions on this line; > 0 means the line executed.
        lineHits[nr] = Number(a.ci) > 0 ? 1 : 0;
      }

      const lineCounter = counterOf(body, "LINE");
      const hitValues = Object.values(lineHits);
      const lines = lineCounter || metric(hitValues.filter((v) => v > 0).length, hitValues.length);

      files.push({
        path: pkgName ? `${pkgName}/${name}` : name,
        lines,
        functions: counterOf(body, "METHOD"),
        branches: counterOf(body, "BRANCH"),
        // JaCoCo's INSTRUCTION counter is bytecode-level and not comparable to
        // "statements" in other tools, so lines is mirrored instead.
        statements: lines,
        lineHits: hitValues.length ? lineHits : null,
        uncoveredLines: Object.entries(lineHits).filter(([, h]) => h === 0).map(([l]) => Number(l)).sort((a, b) => a - b),
      });
    }
  }

  return { format: "jacoco", hasLineDetail: files.some((f) => f.lineHits), totals: totalsFromFiles(files), files };
}

function parseClover(text) {
  const files = [];
  const fileRe = /<file\b([^>]*)>([\s\S]*?)<\/file>/g;
  let match;

  while ((match = fileRe.exec(text))) {
    const attrs = xmlAttrs(match[1]);
    const body = match[2];

    const lineHits = {};
    let methodTotal = 0;
    let methodCovered = 0;
    let condTotal = 0;
    let condCovered = 0;

    const lineRe = /<line\b([^>]*)\/?>/g;
    let lm;
    while ((lm = lineRe.exec(body))) {
      const a = xmlAttrs(lm[1]);
      const num = Number(a.num);
      const count = Number(a.count) || 0;
      if (!Number.isFinite(num)) continue;

      if (a.type === "method") {
        methodTotal++;
        if (count > 0) methodCovered++;
        continue;
      }
      if (a.type === "cond") {
        const trueCount = Number(a.truecount) || 0;
        const falseCount = Number(a.falsecount) || 0;
        condTotal += 2;
        condCovered += (trueCount > 0 ? 1 : 0) + (falseCount > 0 ? 1 : 0);
        // A cond line carries no `count` attribute; it executed if either branch did.
        lineHits[num] = Math.max(lineHits[num] || 0, trueCount + falseCount);
        continue;
      }
      lineHits[num] = Math.max(lineHits[num] || 0, count);
    }

    const hitValues = Object.values(lineHits);
    const lines = metric(hitValues.filter((v) => v > 0).length, hitValues.length);

    files.push({
      path: attrs.name || attrs.path || "",
      lines,
      functions: methodTotal ? metric(methodCovered, methodTotal) : null,
      branches: condTotal ? metric(condCovered, condTotal) : null,
      statements: lines,
      lineHits: hitValues.length ? lineHits : null,
      uncoveredLines: Object.entries(lineHits).filter(([, h]) => h === 0).map(([l]) => Number(l)).sort((a, b) => a - b),
    });
  }

  let totals = totalsFromFiles(files);

  const projectMetrics = /<project\b[^>]*>\s*<metrics\b([^>]*)\/?>/.exec(text);
  if (projectMetrics) {
    const a = xmlAttrs(projectMetrics[1]);
    const stmts = Number(a.statements);
    const coveredStmts = Number(a.coveredstatements);
    const methods = Number(a.methods);
    const coveredMethods = Number(a.coveredmethods);
    const conds = Number(a.conditionals);
    const coveredConds = Number(a.coveredconditionals);
    if (Number.isFinite(stmts) && stmts > 0) {
      const s = metric(coveredStmts || 0, stmts);
      totals = { ...totals, lines: s, statements: s };
    }
    if (Number.isFinite(methods) && methods > 0) totals = { ...totals, functions: metric(coveredMethods || 0, methods) };
    if (Number.isFinite(conds) && conds > 0) totals = { ...totals, branches: metric(coveredConds || 0, conds) };
  }

  return { format: "clover", hasLineDetail: files.some((f) => f.lineHits), totals, files };
}

function parseGoCover(text) {
  // Each line: path/file.go:startLine.startCol,endLine.endCol NumStmt Count
  const perFile = new Map();
  const lineRe = /^(.+):(\d+)\.(\d+),(\d+)\.(\d+)\s+(\d+)\s+(\d+)$/;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("mode:")) continue;
    const m = lineRe.exec(line);
    if (!m) continue;

    const [, file, startLine, , endLine, , numStmt, count] = m;
    if (!perFile.has(file)) perFile.set(file, { stmtCovered: 0, stmtTotal: 0, lineHits: {} });
    const entry = perFile.get(file);

    const stmts = Number(numStmt);
    const hits = Number(count);
    entry.stmtTotal += stmts;
    if (hits > 0) entry.stmtCovered += stmts;

    for (let n = Number(startLine); n <= Number(endLine); n++) {
      entry.lineHits[n] = Math.max(entry.lineHits[n] || 0, hits);
    }
  }

  const files = [];
  for (const [file, entry] of perFile) {
    const hitValues = Object.values(entry.lineHits);
    files.push({
      path: file,
      lines: metric(hitValues.filter((v) => v > 0).length, hitValues.length),
      functions: null,
      branches: null,
      statements: metric(entry.stmtCovered, entry.stmtTotal),
      lineHits: entry.lineHits,
      uncoveredLines: Object.entries(entry.lineHits).filter(([, h]) => h === 0).map(([l]) => Number(l)).sort((a, b) => a - b),
    });
  }

  const totals = totalsFromFiles(files);
  return { format: "go-cover", hasLineDetail: true, totals: { ...totals, functions: null, branches: null }, files };
}

function parseSimpleCov(text) {
  const json = JSON.parse(text);
  const files = [];

  for (const suite of Object.values(json)) {
    const coverage = suite && suite.coverage;
    if (!coverage || typeof coverage !== "object") continue;

    for (const [file, data] of Object.entries(coverage)) {
      // Newer SimpleCov nests under `lines`; older emits the array directly.
      const lineArray = Array.isArray(data) ? data : Array.isArray(data.lines) ? data.lines : null;
      if (!lineArray) continue;

      const lineHits = {};
      let covered = 0;
      let total = 0;
      lineArray.forEach((hits, index) => {
        if (hits === null || hits === undefined) return; // non-relevant line
        const n = index + 1;
        lineHits[n] = Number(hits) || 0;
        total++;
        if (Number(hits) > 0) covered++;
      });

      const lines = metric(covered, total);
      files.push({
        path: file,
        lines,
        functions: null,
        branches: null,
        statements: lines,
        lineHits,
        uncoveredLines: Object.entries(lineHits).filter(([, h]) => h === 0).map(([l]) => Number(l)).sort((a, b) => a - b),
      });
    }
  }

  const totals = totalsFromFiles(files);
  return { format: "simplecov", hasLineDetail: true, totals: { ...totals, functions: null, branches: null }, files };
}

function totalsFromFiles(files) {
  const totals = emptyTotals();
  for (const file of files) {
    for (const key of ["lines", "functions", "branches", "statements"]) {
      totals[key] = sumMetrics(totals[key], file[key]);
    }
  }
  return totals;
}

const PARSERS = {
  "istanbul-summary": parseIstanbulSummary,
  "istanbul-final": parseIstanbulFinal,
  "coverage-py": parseCoveragePy,
  lcov: parseLcov,
  cobertura: parseCobertura,
  jacoco: parseJacoco,
  clover: parseClover,
  "go-cover": parseGoCover,
  simplecov: parseSimpleCov,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a coverage report from text.
 * @returns {{report: object|null, error: string|null}}
 */
function parseText(text, filePath) {
  if (!text || !text.trim()) {
    return { report: null, error: `Coverage report at ${filePath || "<text>"} is empty.` };
  }

  const format = detectFormat(text, filePath);
  if (!format) {
    return {
      report: null,
      error:
        `Unrecognized coverage format at ${filePath || "<text>"}. First 80 chars: ${JSON.stringify(text.slice(0, 80))}. ` +
        `Supported: ${KNOWN_FORMATS.join(", ")}.`,
    };
  }

  try {
    const report = PARSERS[format](text);
    report.path = filePath || "";
    return { report, error: null };
  } catch (err) {
    return { report: null, error: `Failed to parse ${format} report at ${filePath}: ${err.message}` };
  }
}

/**
 * Read and parse a coverage report from disk.
 * @returns {{report: object|null, error: string|null}}
 */
function parseFile(filePath, cwd) {
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(cwd || process.cwd(), filePath);

  let text;
  try {
    text = fs.readFileSync(resolved, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return {
        report: null,
        error:
          `Coverage summary not found at ${filePath}.\n\n` +
          `Likely causes:\n` +
          `1. The coverage command has not run yet.\n` +
          `2. The coverage command ran but wrote elsewhere — check your reporter config.\n` +
          `3. coverageSummaryPath in config is wrong — re-run /tdd-guardian:init.`,
      };
    }
    return { report: null, error: `Could not read coverage report at ${filePath}: ${err.message}` };
  }

  return parseText(text, resolved);
}

/**
 * Merge coverage reports from several lanes.
 *
 * "union" is exact: it recomputes per-line coverage across reports, so a line hit
 * by any lane counts once. It requires every report to carry per-line detail.
 *
 * "weighted" sums covered/total across reports. It is an APPROXIMATION — where
 * lanes exercise the same line, that line is counted once per lane, so the result
 * is a weighted average rather than a true union. Callers must surface this.
 *
 * @returns {{totals, method: "single"|"union"|"weighted", formats: string[], approximate: boolean}}
 */
function mergeReports(reports) {
  const valid = reports.filter(Boolean);
  if (valid.length === 0) return { totals: emptyTotals(), method: "single", formats: [], approximate: false, files: [] };
  if (valid.length === 1) {
    return { totals: valid[0].totals, method: "single", formats: [valid[0].format], approximate: false, files: valid[0].files };
  }

  const formats = valid.map((r) => r.format);
  const canUnion = valid.every((r) => r.hasLineDetail);

  if (canUnion) {
    // Union per file path, then recompute totals from the merged line hits.
    const byPath = new Map();
    for (const report of valid) {
      for (const file of report.files) {
        if (!file.lineHits) continue;
        const key = normalizePath(file.path);
        if (!byPath.has(key)) byPath.set(key, { path: file.path, lineHits: {}, functions: null, branches: null });
        const entry = byPath.get(key);
        for (const [line, hits] of Object.entries(file.lineHits)) {
          entry.lineHits[line] = Math.max(entry.lineHits[line] || 0, Number(hits) || 0);
        }
        // Function and branch axes have no per-item identity across formats, so
        // the best available reading is the strongest single lane.
        entry.functions = maxMetric(entry.functions, file.functions);
        entry.branches = maxMetric(entry.branches, file.branches);
      }
    }

    const files = [];
    for (const entry of byPath.values()) {
      const hitValues = Object.values(entry.lineHits);
      const lines = metric(hitValues.filter((v) => v > 0).length, hitValues.length);
      files.push({
        path: entry.path,
        lines,
        functions: entry.functions,
        branches: entry.branches,
        statements: lines,
        lineHits: entry.lineHits,
        uncoveredLines: Object.entries(entry.lineHits).filter(([, h]) => h === 0).map(([l]) => Number(l)).sort((a, b) => a - b),
      });
    }

    return { totals: totalsFromFiles(files), method: "union", formats, approximate: false, files };
  }

  let totals = emptyTotals();
  for (const report of valid) {
    for (const key of ["lines", "functions", "branches", "statements"]) {
      totals[key] = sumMetrics(totals[key], report.totals[key]);
    }
  }
  return { totals, method: "weighted", formats, approximate: true, files: valid.flatMap((r) => r.files) };
}

function maxMetric(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  return a.pct >= b.pct ? { ...a } : { ...b };
}

function normalizePath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

/**
 * Compare merged totals against thresholds.
 *
 * A null metric with a non-zero threshold is a WARNING, not a failure — the tool
 * does not measure that dimension, which is different from measuring it as zero.
 *
 * @returns {{ok: boolean, failures: string[], warnings: string[], summary: string}}
 */
function compareToThresholds(totals, thresholds) {
  const failures = [];
  const warnings = [];
  const parts = [];

  for (const [key, rawThreshold] of Object.entries(thresholds || {})) {
    const threshold = Number(rawThreshold);
    if (!Number.isFinite(threshold)) continue;

    const m = totals[key];
    if (m === null || m === undefined) {
      if (threshold > 0) {
        warnings.push(
          `${key} coverage is not measured by this report format. Configure your coverage tool to emit it, or set the ${key} threshold to 0.`
        );
      }
      parts.push(`${key}=n/a`);
      continue;
    }

    parts.push(`${key}=${m.pct.toFixed(2)}%`);
    if (m.pct < threshold) {
      failures.push(`${key}: ${m.pct.toFixed(2)}% < ${threshold.toFixed(2)}% (${m.covered}/${m.total})`);
    }
  }

  return { ok: failures.length === 0, failures, warnings, summary: parts.join(", ") };
}

/**
 * Compare merged totals against a recorded baseline (no-decrease mode).
 * @returns {{ok: boolean, failures: string[], summary: string}}
 */
function compareToBaseline(totals, baselineCoverage) {
  const failures = [];
  const parts = [];

  for (const key of ["lines", "functions", "branches", "statements"]) {
    const m = totals[key];
    if (!m) continue;
    parts.push(`${key}=${m.pct.toFixed(2)}%`);

    const base = Number(baselineCoverage?.[key]);
    if (!Number.isFinite(base)) continue;
    if (m.pct < base) {
      failures.push(`${key}: ${m.pct.toFixed(2)}% < baseline ${base.toFixed(2)}% (Δ ${(m.pct - base).toFixed(2)}%)`);
    }
  }

  return { ok: failures.length === 0, failures, summary: parts.join(", ") };
}

// Flatten totals to a plain {metric: pct} map for storage in state.json.
function totalsToPercentages(totals) {
  const out = {};
  for (const key of ["lines", "functions", "branches", "statements"]) {
    out[key] = totals[key] ? totals[key].pct : null;
  }
  return out;
}

// True when the report measured nothing. A run that silently produced no data
// yields 100% under the 0/0 convention, which would otherwise pass the gate.
function isEmpty(totals) {
  const measured = ["lines", "statements"].map((k) => totals[k]).filter(Boolean);
  if (measured.length === 0) return true;
  return measured.every((m) => m.total === 0);
}

module.exports = {
  parseFile,
  parseText,
  detectFormat,
  mergeReports,
  compareToThresholds,
  compareToBaseline,
  totalsToPercentages,
  totalsFromFiles,
  isEmpty,
  metric,
  KNOWN_FORMATS,
};
