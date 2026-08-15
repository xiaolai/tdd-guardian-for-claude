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
function mergeReports(reports, cwd) {
  const valid = reports.filter(Boolean);
  const NO_APPROX = { lines: false, functions: false, branches: false, statements: false };
  if (valid.length === 0) {
    return { totals: emptyTotals(), method: "single", formats: [], approximate: false, approximateMetrics: { ...NO_APPROX }, files: [] };
  }
  if (valid.length === 1) {
    return {
      totals: valid[0].totals,
      method: "single",
      formats: [valid[0].format],
      approximate: false,
      approximateMetrics: { ...NO_APPROX },
      files: valid[0].files,
    };
  }

  const formats = valid.map((r) => r.format);
  const canUnion = valid.every((r) => r.hasLineDetail);

  if (canUnion) {
    // Union per file path, then recompute totals from the merged line hits.
    const byPath = new Map();
    for (const report of valid) {
      for (const file of report.files) {
        if (!file.lineHits) continue;
        const key = normalizePath(file.path, cwd);
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

    return {
      totals: totalsFromFiles(files),
      method: "union",
      formats,
      approximate: false,
      // Lines and statements are a true union. Functions and branches are the
      // strongest single lane (see maxMetric) because those items have no
      // identity across formats — exact for line coverage, a maximum for the
      // other two, and callers must be able to tell which is which.
      approximateMetrics: { lines: false, statements: false, functions: true, branches: true },
      files,
    };
  }

  let totals = emptyTotals();
  for (const report of valid) {
    for (const key of ["lines", "functions", "branches", "statements"]) {
      totals[key] = sumMetrics(totals[key], report.totals[key]);
    }
  }
  return {
    totals,
    method: "weighted",
    formats,
    approximate: true,
    approximateMetrics: { lines: true, functions: true, branches: true, statements: true },
    files: valid.flatMap((r) => r.files),
  };
}

function maxMetric(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  return a.pct >= b.pct ? { ...a } : { ...b };
}

/**
 * Key a file path for cross-lane identity.
 *
 * Reports disagree about roots: istanbul-final emits absolute paths, coverage.py
 * relative ones. Without stripping the workspace prefix, `/repo/src/a.js` and
 * `src/a.js` key differently, so the same file is counted twice in a merge that
 * still reports itself as an exact union — complementary 50% lanes that should
 * union to 100% come out as 50%.
 *
 * Case is folded because the merge asks "are these the same file on disk", and on
 * macOS and Windows they are. Glob matching deliberately does NOT fold case; that
 * asks a different question. See compileGlob.
 */
function normalizePath(p, cwd) {
  let clean = String(p || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const root = String(cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (root && clean.toLowerCase().startsWith(root.toLowerCase() + "/")) {
    clean = clean.slice(root.length + 1);
  }
  return clean.toLowerCase();
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

// ---------------------------------------------------------------------------
// Critical paths
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Glob matching
//
// Deliberately NOT regex-based. Compiling `**` to `.*` produces chained
// quantifiers, and a pattern like `**a**a**a**b` then backtracks
// catastrophically: measured at 1.27s for twelve fragments and over 11s at a
// 50-character subject. This matcher runs inside the TaskCompleted hook on every
// file in the coverage report, so a stall there freezes the editor. The
// segment-DP below is O(pattern x path) with no backtracking at all, which
// removes the class rather than capping it.
// ---------------------------------------------------------------------------

function splitPathSegments(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
}

/**
 * Match one path segment against a segment pattern containing `*` and `?`.
 *
 * Two-pointer wildcard matching with a single star rollback: O(pattern x text)
 * worst case, linear in practice, and — unlike a regex — it cannot blow up.
 */
function matchSegment(pattern, text) {
  let p = 0;
  let s = 0;
  let star = -1;
  let mark = 0;

  while (s < text.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === text[s])) {
      p++;
      s++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = s;
    } else if (star >= 0) {
      p = star + 1;
      s = ++mark;
    } else {
      return false;
    }
  }

  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

/**
 * Compile a glob into the segment list the matcher walks.
 *
 * A leading `**` is implicit: the pattern is anchored at the END and may start at
 * any segment boundary, so `src/payments/**` matches both `src/payments/charge.ts`
 * and the absolute `/home/u/proj/src/payments/charge.ts` that several report
 * formats emit. The cost is that a nested `vendor/src/payments/...` also matches;
 * that is the documented trade for working across nine formats' path conventions.
 *
 * Matching is case-SENSITIVE. Folding case would make `src/Auth/**` silently also
 * cover `src/auth/**` on a case-sensitive filesystem, quietly averaging an
 * unrelated well-covered directory into a critical path's score. A glob whose case
 * is wrong now reports "matched nothing", which is loud and true.
 */
function compileGlob(glob) {
  const segments = splitPathSegments(String(glob || "").replace(/^\.\//, ""));
  // An empty glob matches NOTHING, not everything. Config validation already
  // rejects one, but this function is exported: failing open here would silently
  // apply a critical path's strict threshold to every file in the report.
  if (segments.length === 0) return null;
  return ["**", ...segments];
}

/** Match a path's segments against a compiled glob. O(pattern x path), no backtracking. */
function matchCompiledGlob(compiled, filePath) {
  if (!compiled) return false;
  const segments = splitPathSegments(String(filePath || "").replace(/^\.\//, ""));
  const width = segments.length;

  let reachable = new Array(width + 1).fill(false);
  reachable[0] = true;

  for (const patternSegment of compiled) {
    const next = new Array(width + 1).fill(false);
    if (patternSegment === "**") {
      // Consumes any number of segments, including none.
      let carry = false;
      for (let j = 0; j <= width; j++) {
        carry = carry || reachable[j];
        next[j] = carry;
      }
    } else {
      for (let j = 1; j <= width; j++) {
        if (reachable[j - 1] && matchSegment(patternSegment, segments[j - 1])) next[j] = true;
      }
    }
    reachable = next;
  }

  return reachable[width];
}

function matchesGlob(filePath, glob) {
  return matchCompiledGlob(compileGlob(glob), filePath);
}

/**
 * Evaluate per-path coverage requirements against a merged report.
 *
 * Fails closed in two directions that would otherwise pass silently:
 *
 *   * No per-file data at all → FAILURE. A configured strict rule that cannot be
 *     evaluated must not report success; that is a "green means nothing happened"
 *     defect of exactly the kind this plugin exists to catch.
 *   * A glob matching zero files → WARNING naming the glob, because a typo'd path
 *     applies its strict threshold to nothing while looking enforced.
 *
 * A null metric stays a warning, never a failure — the format does not measure
 * that dimension, which is not the same as measuring zero.
 *
 * @returns {{ok: boolean, failures: string[], warnings: string[], results: object[]}}
 */
function evaluateCriticalPaths(merged, criticalPaths, globalThresholds) {
  const paths = Array.isArray(criticalPaths) ? criticalPaths : [];
  if (paths.length === 0) return { ok: true, failures: [], warnings: [], results: [] };

  const files = Array.isArray(merged?.files) ? merged.files : [];
  if (files.length === 0) {
    return {
      ok: false,
      failures: [
        `criticalPaths are configured but the merged coverage report carries no per-file data ` +
          `(formats: ${(merged?.formats || []).join(", ") || "none"}), so no per-path threshold could be evaluated. ` +
          `Emit a format with per-file entries — LCOV, Cobertura, JaCoCo, coverage.py JSON, or coverage-final.json — or remove criticalPaths.`,
      ],
      warnings: [],
      results: [],
    };
  }

  const failures = [];
  const warnings = [];
  const results = [];

  // Under a weighted merge the per-file list holds one entry per lane per file,
  // so a path exercised by two lanes is counted twice here exactly as it is in
  // the project total. The number is usable but approximate, and every invariant
  // in this file says an approximate number must say so rather than be quoted
  // like an exact one.
  const approximate = merged?.approximate === true;
  if (approximate) {
    warnings.push(
      `Critical-path percentages are APPROXIMATE: the merge was a weighted average (${(merged.formats || []).join(", ")}), ` +
        `so a file covered by more than one lane is counted once per lane. Emit LCOV or Cobertura from every contributing lane for exact per-path numbers.`
    );
  }

  // Even a union merge is exact only for lines and statements. Functions and
  // branches have no per-item identity across formats, so mergeReports keeps the
  // strongest single lane for them — a maximum, not a union. Enforcing a critical
  // threshold on that number while calling it exact is the same defect as quoting
  // a weighted average as a union.
  const approximateMetrics = merged?.approximateMetrics || {};
  const inexact = ["lines", "functions", "branches", "statements"].filter((key) => approximateMetrics[key]);
  if (inexact.length && !approximate) {
    warnings.push(
      `Critical-path ${inexact.join(" and ")} coverage is APPROXIMATE: more than one lane contributed and these dimensions ` +
        `carry no per-item identity across reports, so the strongest single lane is used rather than a union. ` +
        `Threshold a single authoritative report for exact ${inexact.join("/")} numbers.`
    );
  }

  for (const entry of paths) {
    // Compiled once per entry, not once per file — matching is O(pattern x path)
    // and the report can hold thousands of files.
    const compiled = compileGlob(entry.glob);
    const matched = files.filter((file) => matchCompiledGlob(compiled, file.path));
    const thresholds = { ...(globalThresholds || {}), ...(entry.thresholds || {}) };

    if (matched.length === 0) {
      // Unlike a lane in bootstrap, there is no legitimate steady state where a
      // critical path matches nothing: either the glob is wrong, or the code it
      // names has no measured coverage at all. Both are exactly what this feature
      // was configured to catch, so both fail rather than warn.
      failures.push(
        `${entry.glob}: matched no file in the coverage report, so its thresholds enforced nothing. ` +
          `Fix the glob to match the paths your reporter emits, or remove the entry — a rule that enforces nothing must not read as enforced.`
      );
      results.push({ glob: entry.glob, matchedFiles: 0, totals: null, ok: false, thresholds, approximate });
      continue;
    }

    const totals = totalsFromFiles(matched);

    // Refuse to enforce a bar on a dimension the merge could not compute exactly.
    // With lanes instrumenting different function sets, maxMetric can report
    // 1/1 = 100% for a file with 100 functions — a pass the true union would fail,
    // on the code the user marked as most expensive to get wrong.
    const enforceable = {};
    for (const [key, value] of Object.entries(thresholds)) {
      if (Number(value) > 0 && approximateMetrics[key]) {
        failures.push(
          `${entry.glob}: ${key} cannot be enforced exactly — ${(merged.formats || []).join(" + ")} were combined, and ${key} has no ` +
            `per-item identity across reports, so the reported figure can exceed the true union. ` +
            `Emit one authoritative report for these files, or set the ${key} threshold to 0 on this entry.`
        );
        continue;
      }
      enforceable[key] = value;
    }

    const cmp = compareToThresholds(totals, enforceable);

    for (const failure of cmp.failures) {
      failures.push(`${entry.glob} (${matched.length} file(s)): ${failure}`);
    }
    for (const warning of cmp.warnings) {
      warnings.push(`${entry.glob}: ${warning}`);
    }

    results.push({
      glob: entry.glob,
      description: entry.description || "",
      matchedFiles: matched.length,
      totals: totalsToPercentages(totals),
      thresholds,
      ok: cmp.ok && !Object.keys(thresholds).some((k) => Number(thresholds[k]) > 0 && approximateMetrics[k]),
      summary: cmp.summary,
      approximate,
      approximateMetrics: { ...approximateMetrics },
    });
  }

  return { ok: failures.length === 0, failures, warnings, results };
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
  evaluateCriticalPaths,
  matchesGlob,
  compileGlob,
  matchCompiledGlob,
  totalsToPercentages,
  totalsFromFiles,
  isEmpty,
  metric,
  KNOWN_FORMATS,
};
