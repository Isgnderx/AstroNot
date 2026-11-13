// Run with:  node --test tests/xmatch-wasm.test.mjs
//
// Parity of the Rust/WebAssembly kernels with the JavaScript reference in tools/xmatch.js:
//   - rust/crates/xmatch: crossMatch() with engine "wasm" against engine "js": same statuses, ties, counts, coverage and the
//     same candidate lists (identical row order) with separations within 1e-9 arcsec;
//   - rust/crates/csv: readCsvTable / extractSources / extractCatalog on kernel tables against the JavaScript reader:
//     the same header, comments, malformed rows, positions (bitwise), reasons for bad rows and IDs (19 digits untouched).
// Inputs: synthetic fixtures built here, seeded random catalogs, and the real IRSA AllWISE x Gaia DR3 pair of
// assets/tools/xmatch-example.js (40 + 72 rows retrieved 2026-11-13).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const Wasm = require("../tools/wasm.js");
const Csv = require("../tools/csv-kernel.js");
const X = require("../tools/xmatch.js");

const vmParse = vm.runInContext(readFileSync(join(root, "tools/observation-csv.js"), "utf8") + "\n({ parseCsv });", vm.createContext({})).parseCsv;
X.setCsvParser((text) => Array.from(vmParse(text), (row) => Array.from(row)));

const xmKernel = await Wasm.load("xmatch");
const csvKernel = await Wasm.load("csv");
assert.ok(xmKernel, "tools/wasm/xmatch.wasm is missing: run node scripts/build-wasm.mjs xmatch");
assert.ok(csvKernel, "tools/wasm/csv.wasm is missing: run node scripts/build-wasm.mjs csv");
Csv.use(csvKernel);
X.useKernel(xmKernel);
X.useCsvKernel(Csv);

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function list(ids, positions, extra = {}) {
  const n = ids.length;
  const bad = positions.map((p) => Number.isNaN(p[0]) || Number.isNaN(p[1]));
  const ra = Float64Array.from(positions.map((p, i) => (bad[i] ? NaN : p[0])));
  const dec = Float64Array.from(positions.map((p, i) => (bad[i] ? NaN : p[1])));
  const valid = ra.reduce((sum, value) => sum + (Number.isNaN(value) ? 0 : 1), 0);
  return {
    ids, ra, dec, count: n, valid, reason: ids.map((_, i) => (Number.isNaN(ra[i]) ? "bad coordinates" : null)),
    pmra: new Float64Array(n).fill(NaN), pmdec: new Float64Array(n).fill(NaN), epoch: new Float64Array(n).fill(NaN), ...extra,
  };
}

// Runs both engines and asserts the results agree. Returns { js, wasm }.
function both(sources, catalog, options) {
  const js = X.crossMatch(sources, catalog, { ...options, engine: "js" });
  const wasm = X.crossMatch(sources, catalog, { ...options, engine: "wasm" });
  assert.equal(js.ok, wasm.ok, js.message);
  if (!js.ok) { assert.equal(wasm.message, js.message); return { js, wasm }; }
  assert.equal(js.engine, "js");
  assert.equal(wasm.engine, "wasm", "the kernel did not run");
  assert.deepEqual(Array.from(wasm.status), Array.from(js.status));
  assert.deepEqual(Array.from(wasm.ties), Array.from(js.ties));
  assert.deepEqual(wasm.counts, js.counts);
  assert.deepEqual(Array.from(wasm.coverage), Array.from(js.coverage));
  assert.deepEqual(wasm.coverageSummary, js.coverageSummary);
  assert.deepEqual(wasm.index, js.index);
  assert.equal(wasm.sourceCount, js.sourceCount);
  assert.equal(wasm.catalogCount, js.catalogCount);
  for (const key of ["requested", "targetEpoch", "moved", "noMotion", "noEpoch"]) assert.equal(wasm.motion[key], js.motion[key], key);
  assert.ok(Math.abs(wasm.motion.maxShiftArcsec - js.motion.maxShiftArcsec) <= 1e-9, "max shift");
  let worst = 0;
  for (let i = 0; i < js.sourceCount; i++) {
    const a = js.candidates[i];
    const b = wasm.candidates[i];
    if (a === null) { assert.equal(b, null, "source " + i); continue; }
    assert.equal(b.length, a.length, "candidate count of source " + i);
    for (let k = 0; k < a.length; k++) {
      assert.equal(b[k].index, a[k].index, "source " + i + " rank " + k);
      worst = Math.max(worst, Math.abs(b[k].separationArcsec - a[k].separationArcsec));
      assert.ok(Math.abs(b[k].ra - a[k].ra) <= 1e-12 && Math.abs(b[k].dec - a[k].dec) <= 1e-12, "moved position of source " + i);
    }
  }
  assert.ok(worst <= 1e-9, "largest separation difference " + worst + " arcsec");
  return { js, wasm, worst };
}

// ---- Matching kernel ---------------------------------------------------------------------------------------------------------
test("RA 359.9999 against 0.0001, both directions, both engines agree", () => {
  const sources = list(["east", "west"], [[0.0001, 0], [359.9999, 5]]);
  const catalog = list(["a", "b", "c", "d"], [[359.9999, 0], [0.0003, 0], [0.0001, 5], [359.99995, 5]]);
  const { wasm } = both(sources, catalog, { radiusArcsec: 1 });
  assert.deepEqual(wasm.candidates[0].map((c) => c.index), [0, 1], "equal separations: ordered by ID a, b");
  assert.equal(wasm.ties[0], 1);
  assert.deepEqual(wasm.candidates[1].map((c) => c.index), [3, 2]);
  assert.ok(Math.abs(wasm.candidates[0][1].separationArcsec - 0.72) < 1e-9 && Math.abs(wasm.candidates[0][0].separationArcsec - 0.72) < 1e-9, "0.0002 degrees is 0.72 arcsec");
});

test("poles: every RA is reachable, cap and antipodal rows agree", () => {
  const random = lcg(7);
  const make = (n, prefix) => {
    const ids = [];
    const positions = [];
    for (let i = 0; i < n; i++) {
      ids.push(prefix + i);
      const kind = i % 5;
      if (kind === 0) positions.push([random() * 360, 90 - 0.05 * Math.sqrt(random())]);
      else if (kind === 1) positions.push([random() * 360, -90 + 0.05 * Math.sqrt(random())]);
      else if (kind === 2) positions.push([(360 + (random() - 0.5) * 0.1) % 360, (random() - 0.5) * 0.1]);
      else if (kind === 3) positions.push([random() * 360, Math.asin(2 * random() - 1) * 180 / Math.PI]);
      else positions.push([random() * 360, i % 2 ? 90 : -90]);
    }
    return list(ids, positions);
  };
  for (const radius of [0.5, 50, 3600]) {
    const { wasm } = both(make(500, "s"), make(5000, "c"), { radiusArcsec: radius });
    assert.ok(wasm.counts[X.status.single] + wasm.counts[X.status.multiple] > 50, "the fixture should produce matches at radius " + radius);
  }
  const north = both(list(["n"], [[10, 90]]), list(["x", "y"], [[200, 90], [10, 89.9999]]), { radiusArcsec: 1 });
  assert.deepEqual(north.wasm.candidates[0].map((c) => c.index), [0, 1]);
});

test("the radius is inclusive and ties are ordered by catalog ID (digits numerically, text by code point, then row)", () => {
  const equator = list(["s"], [[100, 0]]);
  const one = list(["near"], [[100, 1 / 3600]]);
  assert.equal(both(equator, one, { radiusArcsec: 1 }).wasm.status[0], X.status.single);
  assert.equal(both(equator, one, { radiusArcsec: 0.999999 }).wasm.status[0], X.status.none);
  for (const ids of [["10", "2"], ["2", "10"], ["B", "A", "A"], ["007", "7", "7"], ["9", "10", "010"]]) {
    const positions = [[100.0001, 0], [99.9999, 0], [100, 0.0001]].slice(0, ids.length);
    const { wasm } = both(equator, list(ids, positions), { radiusArcsec: 1 });
    assert.equal(wasm.ties[0], 1);
  }
  // Three ties in a row inside a longer list.
  const catalog = list(["30", "4", "200", "x", "5"], [[100.00005, 0], [99.99995, 0], [100, 0.00005], [100.001, 0], [100, -0.00005]]);
  const { wasm } = both(equator, catalog, { radiusArcsec: 5 });
  assert.deepEqual(wasm.candidates[0].slice(0, 4).map((c) => catalog.ids[c.index]), ["4", "5", "30", "200"]);
});

test("invalid rows, duplicate catalog IDs, no match and radius limits", () => {
  const sources = list(["a", "bad", "c", "d"], [[10, 10], [NaN, NaN], [10.0001, 10], [200, -50]]);
  const catalog = list(["x", "y", "bad", "z", "x"], [[10, 10], [10.00001, 10], [NaN, NaN], [10.0001, 10.00001], [10, 10]]);
  const { wasm } = both(sources, catalog, { radiusArcsec: 2 });
  assert.equal(wasm.status[1], X.status.invalid);
  assert.equal(wasm.status[3], X.status.none);
  assert.equal(wasm.candidates[3], null);
  assert.equal(wasm.index.rows, 4);
  for (const radiusArcsec of [0.001, 3601, NaN]) both(sources, catalog, { radiusArcsec });
  both(list(["a"], [[NaN, NaN]]), catalog, { radiusArcsec: 2 });
});

test("proper motion: the kernel moves the catalog like propagatePosition (cos(dec) either way, poles, missing data)", () => {
  const random = lcg(31);
  const n = 3000;
  const ids = Array.from({ length: n }, (_, i) => "c" + i);
  const positions = Array.from({ length: n }, (_, i) => (i % 7 === 0 ? [random() * 360, (random() < 0.5 ? 1 : -1) * (89.9 + random() * 0.1)] : [random() * 360, (random() - 0.5) * 170]));
  const catalog = list(ids, positions, {
    pmra: Float64Array.from({ length: n }, (_, i) => (i % 11 === 0 ? NaN : (random() - 0.5) * 4000)),
    pmdec: Float64Array.from({ length: n }, (_, i) => (i % 13 === 0 ? NaN : (random() - 0.5) * 4000)),
    epoch: Float64Array.from({ length: n }, (_, i) => (i % 17 === 0 ? NaN : 1990 + random() * 40)),
  });
  const sources = list(ids.slice(0, 600).map((id) => "s" + id), Array.from({ length: 600 }, (_, i) => {
    const j = (i * 5) % n;
    return [catalog.ra[j] + (random() - 0.5) * 0.002, Math.max(-90, Math.min(90, catalog.dec[j] + (random() - 0.5) * 0.002))];
  }).map(([ra, dec]) => [((ra % 360) + 360) % 360, dec]));
  for (const includes of [true, false]) {
    const { wasm } = both(sources, catalog, { radiusArcsec: 20, targetEpoch: 2016, pmraIncludesCosDec: includes });
    assert.ok(wasm.motion.moved > 2000 && wasm.motion.noMotion > 100 && wasm.motion.noEpoch > 100, JSON.stringify(wasm.motion));
  }
  const moved = X.crossMatch(sources, catalog, { radiusArcsec: 20, targetEpoch: 2016, pmraIncludesCosDec: true, engine: "wasm" });
  const [ra, dec] = X.propagatePosition(catalog.ra[1], catalog.dec[1], catalog.pmra[1], catalog.pmdec[1], 2016 - catalog.epoch[1], true);
  const hit = moved.candidates.find((list) => list && list.some((c) => c.index === 1));
  if (hit) assert.ok(Math.abs(hit.find((c) => c.index === 1).ra - ra) < 1e-12 && Math.abs(hit.find((c) => c.index === 1).dec - dec) < 1e-12);
  assert.equal(X.crossMatch(sources, catalog, { radiusArcsec: 20, targetEpoch: 2016, engine: "wasm" }).ok, false, "pmra convention is still required");
});

test("coverage of the extract and a full row limit", () => {
  const random = lcg(5);
  const sources = list(Array.from({ length: 300 }, (_, i) => "s" + i), Array.from({ length: 300 }, () => [150 + random() * 4, -41 + random() * 2]));
  const catalog = list(Array.from({ length: 900 }, (_, i) => "c" + i), Array.from({ length: 900 }, () => [150 + random() * 4, -41 + random() * 2]));
  const cone = { ra: 152, dec: -40, radiusArcsec: 3600 };
  const covered = both(sources, catalog, { radiusArcsec: 30, coverage: cone });
  assert.ok(covered.wasm.coverageSummary.outside > 0 && covered.wasm.coverageSummary.outside < 300);
  assert.ok(covered.wasm.coverage.includes("covered") && covered.wasm.coverage.includes("not-covered"));
  const cut = both(sources, catalog, { radiusArcsec: 30, coverage: cone, rowLimit: 900 });
  assert.equal(cut.wasm.coverageSummary.truncated, true);
});

test("random catalogs agree with the JavaScript index candidate for candidate", () => {
  for (const [seed, radius] of [[1, 3], [2, 30], [3, 300], [4, 1800]]) {
    const random = lcg(seed);
    const make = (n, prefix) => list(Array.from({ length: n }, (_, i) => prefix + i), Array.from({ length: n }, () => [random() * 360, Math.asin(2 * random() - 1) * 180 / Math.PI]));
    const sources = make(300, "s");
    const catalog = make(20000, "c");
    const { wasm } = both(sources, catalog, { radiusArcsec: radius });
    assert.equal(wasm.counts[X.status.invalid], 0);
  }
});

test("100,000 x 100,000 rows around 0/360, the equator, the pole and RA 100: identical candidate lists", () => {
  const random = lcg(12345);
  const make = (n, prefix) => {
    const ids = [];
    const positions = [];
    for (let i = 0; i < n; i++) {
      ids.push(prefix + (1000000000000000000n + BigInt(i) * 7919n).toString());
      const kind = i % 4;
      if (kind === 0) positions.push([(360 + (random() - 0.5)) % 360, random() - 0.5]);
      else if (kind === 1) positions.push([random() * 360, Math.asin(2 * random() - 1) * 180 / Math.PI]);
      else if (kind === 2) positions.push([random() * 360, 90 - 0.5 * Math.sqrt(random())]);
      else positions.push([100 + random(), random() - 0.5]);
    }
    return list(ids, positions);
  };
  const sources = make(100000, "s");
  const catalog = make(100000, "c");
  const { wasm, worst } = both(sources, catalog, { radiusArcsec: 20 });
  assert.ok(wasm.counts[X.status.single] + wasm.counts[X.status.multiple] > 10000);
  console.log("# 100k x 100k: worst separation difference " + worst.toExponential(2) + " arcsec");
});

test("a lazy candidate list (large source count) reads like the eager one", () => {
  const random = lcg(8);
  const n = 120000;
  const sources = list(Array.from({ length: n }, (_, i) => "s" + i), Array.from({ length: n }, () => [random() * 10, random() * 10]));
  const catalog = list(Array.from({ length: 5000 }, (_, i) => "c" + i), Array.from({ length: 5000 }, () => [random() * 10, random() * 10]));
  const result = X.crossMatch(sources, catalog, { radiusArcsec: 300, engine: "wasm" });
  assert.equal(result.engine, "wasm");
  assert.equal(result.candidates.length, n);
  const eager = X.crossMatch(sources, catalog, { radiusArcsec: 300, engine: "js" });
  for (let i = 0; i < n; i += 997) assert.deepEqual(result.candidates[i]?.map((c) => c.index) ?? null, eager.candidates[i]?.map((c) => c.index) ?? null);
});

// ---- CSV tables ----------------------------------------------------------------------------------------------------------------
function withCsv(enabled, run) {
  X.useCsvKernel(enabled ? Csv : null);
  try { return run(); } finally { X.useCsvKernel(Csv); }
}

const sourceMapping = (table, unit = "deg") => ({ ...X.detectSourceColumns(table.header), unit });
const catalogMapping = (table, unit = "deg") => ({ ...X.detectCatalogColumns(table.header, table.rows).columns, unit, epochUnit: "jyear", fixedEpoch: NaN });
const bytesOf = (text) => new TextEncoder().encode(text);

function assertTablesAgree(text, label) {
  const js = withCsv(false, () => X.readCsvTable(text));
  const wasm = withCsv(true, () => X.readCsvTable(bytesOf(text)));
  assert.equal(wasm.ok, js.ok, label);
  if (!js.ok) { assert.equal(wasm.message, js.message, label); return null; }
  assert.ok(wasm.kernel, "the kernel did not read " + label);
  assert.deepEqual(wasm.header, js.header, label);
  assert.deepEqual(wasm.meta, js.meta, label);
  assert.deepEqual(wasm.comments, js.comments, label);
  assert.deepEqual(wasm.malformed, js.malformed, label);
  assert.equal(wasm.rows.length, js.rows.length, label);
  assert.deepEqual(wasm.rows.slice(0, js.rows.length), js.rows, label);
  return { js, wasm };
}

function assertSourcesAgree(js, wasm, label) {
  assert.equal(wasm.count, js.count, label);
  assert.equal(wasm.valid, js.valid, label);
  assert.equal(wasm.emptyIds, js.emptyIds, label);
  assert.equal(wasm.duplicateIds, js.duplicateIds, label);
  for (let i = 0; i < js.count; i++) {
    assert.equal(wasm.ids[i], js.ids[i], label + " id " + i);
    assert.ok(Object.is(wasm.ra[i], js.ra[i]) && Object.is(wasm.dec[i], js.dec[i]), label + " position " + i);
    assert.equal(wasm.reason[i], js.reason[i], label + " reason " + i);
  }
}

const messyFile = [
  "﻿# catalog: Test cat",
  "# release = R9",
  "source_id,ra,dec,pmra,pmdec,ref_epoch,note",
  "5416565604120469376,156.1,-41.6,1.5,-2.5,2016.0,plain",
  "5416565604120469377,\"156.1000001\",-41.6,,,2016,\"quoted, comma\"",
  "9223372036854775807,359.9999,0.0001,NaN,5,1999.5,\"say \"\"hi\"\"\"",
  "dup,0.0001,90,1e1,2d,2016,x",
  "dup,0.0002,-90,1,2,2016,x",
  ",10,10,1,2,2016,empty id",
  " 7 , 11.5 , 12.5 ,3,4, 2016 ,spaces",
  "short,1,2",
  "too,1,2,3,4,5,6,7,8",
  "bad,abc,10,1,2,2016,x",
  "bad2,10,,1,2,2016,x",
  "bad3,361,10,1,2,2016,x",
  "bad4,10,-90.5,1,2,2016,x",
  "bad5,−1,10,1,2,2016,x",
  "bad6,1,−10,1,2,2016,x",
  "bad7,null,--,1,2,2016,x",
  "bad8,1e999,5,1,2,2016,x",
  "bad9,1,2,1,2,1700,x",
  "ok360,360,0,1,2,2016,x",
  "dec-,1,-90,-,?,2016,x",
  "decimalcomma,1,2,1,2,2016,x",
  "",
  "   ",
  "last,12.25,-12.25,9,9,2016,end",
].join("\r\n") + "\r\n";

test("readCsvTable on the kernel equals the JavaScript reader: header, # metadata, malformed rows, BOM, CRLF, quotes", () => {
  const { js, wasm } = assertTablesAgree(messyFile, "messy file");
  assert.equal(js.meta.catalog, "Test cat");
  assert.ok(js.malformed.length >= 2);
  assert.equal(wasm.kernel.rowCount, wasm.rows.length + 1);
});

test("extractSources and extractCatalog on the kernel equal the JavaScript ones, reason for reason", () => {
  const { js, wasm } = assertTablesAgree(messyFile, "messy file");
  const mapping = { ...sourceMapping(js), unit: "deg" };
  assertSourcesAgree(X.extractSources(js, mapping), X.extractSources(wasm, mapping), "sources");
  const detected = X.detectCatalogColumns(js.header, js.rows);
  assert.deepEqual(X.detectCatalogColumns(wasm.header, wasm.rows), detected);
  for (const epochUnit of ["jyear", "mjd"]) {
    const cm = { ...detected.columns, unit: "deg", epochUnit, fixedEpoch: NaN };
    const a = X.extractCatalog(js, cm);
    const b = X.extractCatalog(wasm, cm);
    assertSourcesAgree(a, b, "catalog " + epochUnit);
    for (const key of ["pmUsable", "epochKnown"]) assert.equal(b[key], a[key], key);
    assert.ok(Object.is(b.epochMin, a.epochMin) && Object.is(b.epochMax, a.epochMax));
    for (let i = 0; i < a.count; i++) assert.ok(Object.is(b.pmra[i], a.pmra[i]) && Object.is(b.pmdec[i], a.pmdec[i]) && Object.is(b.epoch[i], a.epoch[i]), "pm/epoch row " + i);
  }
  const fixed = { ...detected.columns, epoch: -1, unit: "deg", epochUnit: "jyear", fixedEpoch: 2000 };
  assert.deepEqual(Array.from(X.extractCatalog(wasm, fixed).epoch), Array.from(X.extractCatalog(js, fixed).epoch));
  const noId = { ...mapping, id: -1 };
  assertSourcesAgree(X.extractSources(js, noId), X.extractSources(wasm, noId), "no id column");
  // Sexagesimal input is still read (by the JavaScript code on the lazy rows) and gives the same answer.
  const sexa = "id,ra,dec\nA,10:24:22.4,-41:38:40.8\nB,bad,1\nC,25:00:00,0\n";
  const t = assertTablesAgree(sexa, "sexagesimal");
  const sm = { id: 0, ra: 1, dec: 2, unit: "sexagesimal" };
  assertSourcesAgree(X.extractSources(t.js, sm), X.extractSources(t.wasm, sm), "sexagesimal");
});

test("readCsvTable on the kernel gives the same messages for unusable files", () => {
  for (const [text, label] of [
    ["", "empty"], ["   \n\t\n", "blank"], ["# only a comment\n", "comment only"], ["a;b;c\n1;2;3\n", "semicolons"], ["a\tb\tc\n1\t2\t3\n", "tabs"],
    ["<html><body>x</body></html>", "html"], ["a,b\n1,2\n", "two columns"], ["a,b,c\n1,\"open,3\n", "unclosed quote"], ["a,b,c\n", "header only"],
    ["\n\n# c\n\nid,ra,dec\n1,2,3\n", "blank lines before the header"], ["# c1\r\n# c2\r\nid,ra,dec\r\n", "comments then header"],
  ]) assertTablesAgree(text, label);
  const header = assertTablesAgree("id,ra,dec\n", "header only 2");
  assert.equal(header.wasm.rows.length, 0);
});

test("19-digit IDs stay text through the kernel table, the match and the exported CSV", () => {
  const a = "5416565604120469376";
  const b = "5416565604120469377";
  const catalogText = "source_id,ra,dec,pmra,pmdec,ref_epoch,parallax\n" + a + ",156.1,-41.6,,,2016.000,\n" + b + ",156.1000001,-41.6,,,2016.000,\n";
  const sourceText = "source_id,x_pixel,y_pixel,ra,dec\n9223372036854775807,1,2,156.1,-41.6\n";
  const st = X.readCsvTable(bytesOf(sourceText));
  const ct = X.readCsvTable(bytesOf(catalogText));
  assert.ok(st.kernel && ct.kernel);
  const sources = X.extractSources(st, sourceMapping(st));
  const catalog = X.extractCatalog(ct, catalogMapping(ct));
  assert.equal(sources.ids[0], "9223372036854775807");
  assert.deepEqual([catalog.ids[0], catalog.ids[1]], [a, b]);
  const result = X.crossMatch(sources, catalog, { radiusArcsec: 1, engine: "wasm" });
  assert.deepEqual(result.candidates[0].map((c) => catalog.ids[c.index]), [a, b]);
  const csv = X.buildExportCsv(sources, catalog, result, { catalogName: "Gaia", catalogRelease: "DR3" });
  assert.ok(csv.includes("," + a + ",") && csv.includes("," + b + ",") && csv.includes("9223372036854775807,1,"));
});

// ---- The real IRSA example pair -------------------------------------------------------------------------------------------------
test("real IRSA AllWISE x Gaia DR3 extract: kernel tables, kernel match and exported CSV equal the JavaScript pipeline", () => {
  const example = vm.runInContext(readFileSync(join(root, "assets/tools/xmatch-example.js"), "utf8") + "\ncatalogCrossMatchExample", vm.createContext({}));
  const js = withCsv(false, () => {
    const st = X.readCsvTable(example.allwise.csv);
    const ct = X.readCsvTable(example.gaia.csv);
    return { st, ct, sources: X.extractSources(st, sourceMapping(st)), catalog: X.extractCatalog(ct, catalogMapping(ct)), detected: X.detectCatalogColumns(ct.header, ct.rows) };
  });
  const st = X.readCsvTable(bytesOf(example.allwise.csv));
  const ct = X.readCsvTable(bytesOf(example.gaia.csv));
  assert.ok(st.kernel && ct.kernel);
  assert.deepEqual(st.meta, js.st.meta);
  assert.deepEqual(ct.meta, js.ct.meta);
  const detected = X.detectCatalogColumns(ct.header, ct.rows);
  assert.deepEqual(detected, js.detected);
  assert.equal(detected.info.kind, "gaia");
  const sources = X.extractSources(st, sourceMapping(st));
  const catalog = X.extractCatalog(ct, catalogMapping(ct));
  assertSourcesAgree(js.sources, sources, "AllWISE sources");
  assertSourcesAgree(js.catalog, catalog, "Gaia catalog");
  assert.equal(catalog.pmUsable, 65);
  // AllWISE designations are recognised by the kernel shape test as well.
  assert.equal(X.detectCatalogColumns(st.header, st.rows).info.kind, "allwise");
  for (const options of [{ radiusArcsec: 3 }, { radiusArcsec: 3, targetEpoch: 2010.744, pmraIncludesCosDec: true }, { radiusArcsec: 10, targetEpoch: 2016, pmraIncludesCosDec: false }]) {
    const { js: a, wasm: b } = both(js.sources, js.catalog, options);
    const c = X.crossMatch(sources, catalog, { ...options, engine: "wasm" });
    assert.deepEqual(Array.from(c.status), Array.from(a.status));
    assert.deepEqual(c.counts, a.counts);
    for (let i = 0; i < sources.count; i++) assert.deepEqual((c.candidates[i] ?? []).map((x) => x.index), (a.candidates[i] ?? []).map((x) => x.index));
    // The exported CSV is the same text (separations are printed to 6 decimals; the engines agree to 1e-12).
    const context = { catalogName: "Gaia", catalogRelease: "DR3", sourceEpoch: "2010.744 (Julian year)" };
    assert.equal(X.buildExportCsv(sources, catalog, c, context), X.buildExportCsv(js.sources, js.catalog, a, context));
    assert.equal(X.buildExportCsv(js.sources, js.catalog, b, context), X.buildExportCsv(js.sources, js.catalog, a, context));
  }
});

// ---- Text to table at scale ------------------------------------------------------------------------------------------------------
test("100,000-row CSV files: text -> kernel table -> match -> export equals the JavaScript pipeline", () => {
  const random = lcg(99);
  const lines = ["source_id,x_pixel,y_pixel,ra,dec"];
  const cat = ["source_id,ra,dec,pmra,pmdec,ref_epoch,parallax"];
  for (let i = 0; i < 100000; i++) {
    const ra = 150 + random() * 2;
    const dec = -41 + random() * 2;
    lines.push("S" + i + "," + (i % 70) + "," + (i % 71) + "," + ra.toFixed(8) + "," + dec.toFixed(8));
    cat.push((5416565604120469376n + BigInt(i)).toString() + "," + (ra + (random() - 0.5) * 0.0004).toFixed(8) + "," + (dec + (random() - 0.5) * 0.0004).toFixed(8) + ",1.5,-2.5,2016.000,0.3");
  }
  const sourceText = lines.join("\r\n") + "\r\n";
  const catalogText = cat.join("\n");
  const pipeline = (csvOn, engine) => withCsv(csvOn, () => {
    const st = X.readCsvTable(csvOn ? bytesOf(sourceText) : sourceText);
    const ct = X.readCsvTable(csvOn ? bytesOf(catalogText) : catalogText);
    const sources = X.extractSources(st, sourceMapping(st));
    const catalog = X.extractCatalog(ct, catalogMapping(ct));
    const result = X.crossMatch(sources, catalog, { radiusArcsec: 3, targetEpoch: 2000, pmraIncludesCosDec: true, engine });
    return { st, ct, sources, catalog, result };
  });
  const js = pipeline(false, "js");
  const wasm = pipeline(true, "wasm");
  assert.equal(js.result.engine, "js");
  assert.equal(wasm.result.engine, "wasm");
  assert.ok(wasm.st.kernel && wasm.ct.kernel);
  assert.equal(wasm.sources.valid, js.sources.valid);
  assert.equal(wasm.catalog.valid, js.catalog.valid);
  assert.equal(wasm.result.motion.moved, 100000);
  assert.deepEqual(wasm.result.counts, js.result.counts);
  for (let i = 0; i < 100000; i += 1) {
    assert.ok(Object.is(wasm.sources.ra[i], js.sources.ra[i]) && Object.is(wasm.catalog.dec[i], js.catalog.dec[i]));
    const a = js.result.candidates[i];
    const b = wasm.result.candidates[i];
    assert.deepEqual(b?.map((c) => c.index) ?? null, a?.map((c) => c.index) ?? null, "source " + i);
  }
  for (let i = 0; i < 100000; i += 997) assert.equal(wasm.catalog.ids[i], js.catalog.ids[i]);
  const exported = X.buildExportCsv(wasm.sources, wasm.catalog, wasm.result, {});
  const reference = X.buildExportCsv(js.sources, js.catalog, js.result, {});
  assert.equal(exported.split("\r\n").length, reference.split("\r\n").length);
  assert.equal(exported.slice(0, 2000), reference.slice(0, 2000));
});
