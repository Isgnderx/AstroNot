// Run with:  node --test tests/cross-match.test.mjs
//
// Covers tools/xmatch.js, the model behind the Catalog Cross-Match workspace: coordinate parsing, great-circle separation,
// the spatial index, matching rules (inclusive radius, ordering, ties), proper-motion epoch propagation, CSV column
// detection, 64-bit IDs, export, and speed on 100,000 x 100,000 rows.
//
// DATA KINDS, kept apart on purpose:
//   - Synthetic fixtures built in this file test the arithmetic and the rules. They are not archive data.
//   - Constants labelled "Astropy" were computed with Astropy 8.0.2 by tests/cross-match-reference.py.
//   - The "real archive extract" section uses assets/tools/xmatch-example.js: 40 AllWISE Source Catalog rows and 72 Gaia
//     DR3 rows that IRSA TAP returned on 2026-11-13 for a 90 arcsec cone around the SPHEREx example position. Its expected
//     values come from two independent sources: Astropy search_around_sky / apply_space_motion on the same rows (candidate
//     lists identical, separations within 1e-10 arcsec), and the archive's own gaia_dr3_allwise_best_neighbour table
//     (the 18 pairs listed below, angular_distance in arcsec).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const X = require("../tools/xmatch.js");
const vmParse = vm.runInContext(readFileSync(join(root, "tools/observation-csv.js"), "utf8") + "\n({ parseCsv });", vm.createContext({})).parseCsv;
// The reader runs in its own vm realm; copy its arrays into this realm so deepEqual sees ordinary Arrays.
const parseCsv = (text) => Array.from(vmParse(text), (row) => Array.from(row));
X.setCsvParser(parseCsv);

const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, (message ?? "") + " expected " + expected + " got " + actual);

// A position list without a CSV file: ids, then [ra, dec] pairs (NaN for an invalid row).
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
const run = (sources, catalog, radiusArcsec, extra = {}) => {
  const result = X.crossMatch(sources, catalog, { radiusArcsec, ...extra });
  assert.ok(result.ok, result.message);
  return result;
};
const names = (result, i, catalog) => (result.candidates[i] ?? []).map((c) => catalog.ids[c.index]);

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// ---- Coordinates --------------------------------------------------------------------------------------------------------
test("decimal and sexagesimal coordinates parse; invalid ones are refused with a reason", () => {
  assert.equal(X.parseAngle("156.09328159", "ra").value, 156.09328159);
  assert.equal(X.parseAngle("-41.64466331", "dec").value, -41.64466331);
  assert.equal(X.parseAngle("360", "ra").value, 0);
  near(X.parseAngle("10:24:22.4", "ra", "sexagesimal").value, 156.09333333, 1e-7);
  near(X.parseAngle("10h24m22.4s", "ra", "sexagesimal").value, 156.09333333, 1e-7);
  near(X.parseAngle("-41:38:40.8", "dec", "sexagesimal").value, -41.64466667, 1e-7);
  near(X.parseAngle("-00:30:00", "dec", "sexagesimal").value, -0.5, 1e-12);
  near(X.parseAngle("41 38 40.8", "dec", "sexagesimal").value, 41.64466667, 1e-7);
  near(X.parseAngle("−41:38:40.8", "dec", "sexagesimal").value, -41.64466667, 1e-7);
  for (const [text, axis, unit] of [
    ["", "ra"], ["  ", "dec"], ["NaN", "ra"], ["null", "dec"], ["abc", "ra"], ["1,5", "ra"], ["0x10", "dec"], ["Infinity", "ra"],
    ["361", "ra"], ["-0.1", "ra"], ["90.0001", "dec"], ["-91", "dec"], ["1e999", "dec"],
    ["25:00:00", "ra", "sexagesimal"], ["10:61:00", "ra", "sexagesimal"], ["10:24:60", "ra", "sexagesimal"], ["156.09", "ra", "sexagesimal"],
    ["10.5:24:00", "ra", "sexagesimal"], ["91:00:00", "dec", "sexagesimal"],
  ]) {
    const parsed = X.parseAngle(text, axis, unit);
    assert.ok(parsed.error && parsed.value === undefined, JSON.stringify([text, axis, unit]));
  }
  assert.equal(X.parseAngle("", "ra").missing, true);
});

// ---- Separation ---------------------------------------------------------------------------------------------------------
test("separation across RA 0/360 on the equator is 0.72 arcsec", () => {
  const separation = X.separationArcsec(359.9999, 0, 0.0001, 0);
  near(separation, 0.72, 1e-6);
  near(separation, 0.7199999997830036, 1e-9, "Astropy SkyCoord.separation");
  near(X.separationArcsec(0.0001, 0, 359.9999, 0), separation, 0, "symmetric");
});

test("separation matches Astropy near the pole, at tiny and at antipodal distances", () => {
  near(X.separationArcsec(10, 89.9999, 190, 89.9999), 0.7200000000325434, 1e-9, "across the pole");
  near(X.separationArcsec(10, 89.9999, 100, 89.9999), 0.5091168824771966, 1e-9, "90 degrees apart in RA near the pole");
  near(X.separationArcsec(156.09328159, -41.64466331, 156.09328259, -41.64466331), 0.0026902091393893285, 1e-10, "0.0027 arcsec");
  near(X.separationArcsec(0, 0, 180, 0), 648000, 1e-6, "antipodal");
  near(X.separationArcsec(5, 5, 5, 5), 0, 0);
  near(X.separationArcsec(10, 90, 250, 90), 0, 1e-9, "RA is meaningless at the pole");
});

// ---- Radius boundary ----------------------------------------------------------------------------------------------------
test("the radius is inclusive: a candidate exactly one arcsec away is found with radius 1 but not 0.999999", () => {
  const sources = list(["s"], [[10, 20]]);
  const catalog = list(["a"], [[10, 20 + 1 / 3600]]);
  assert.deepEqual(names(run(sources, catalog, 1), 0, catalog), ["a"]);
  assert.equal(run(sources, catalog, 0.999999).status[0], X.status.none);
  // Along RA at dec 60, one arcsec of arc is 2 arcsec of RA.
  const east = list(["e"], [[10 + (1 / 3600) / Math.cos(60 * Math.PI / 180), 60]]);
  const north = list(["s"], [[10, 60]]);
  near(X.separationArcsec(10, 60, east.ra[0], 60), 1, 1e-4);
  assert.equal(run(north, east, 1.0001).status[0], X.status.single);
  assert.equal(run(north, east, 0.99).status[0], X.status.none);
});

test("the radius limits are enforced", () => {
  const s = list(["s"], [[1, 1]]);
  for (const bad of [0, -1, NaN, 0.001, 3601, Infinity]) assert.equal(X.crossMatch(s, s, { radiusArcsec: bad }).ok, false, String(bad));
  assert.equal(X.crossMatch(s, s, { radiusArcsec: X.limits.defaultRadiusArcsec }).ok, true);
});

// ---- RA wrap and poles --------------------------------------------------------------------------------------------------
test("matches are found across RA 0/360 in both directions", () => {
  const catalog = list(["east", "west", "far"], [[0.0001, 0], [359.9999, 0], [180, 0]]);
  for (const [ra, expected] of [[359.9999, ["west", "east"]], [0.0001, ["east", "west"]], [0, ["east", "west"]], [359.99999, ["west", "east"]]]) {
    const result = run(list(["s"], [[ra, 0]]), catalog, 2);
    assert.deepEqual(names(result, 0, catalog), expected, "source at RA " + ra);
  }
  near(run(list(["s"], [[359.9999, 0]]), catalog, 2).candidates[0][1].separationArcsec, 0.72, 1e-6);
});

test("near the poles every RA is reachable", () => {
  const catalog = list(["a", "b", "c", "d", "e"], [[190, 89.9999], [100, 89.9999], [10, 89.9998], [300, 89.99], [45, -89.99995]]);
  const result = run(list(["n", "p", "s"], [[10, 89.9999], [123, 90], [77, -90]]), catalog, 1);
  // (10, 89.9999): c is 0.36 arcsec away (0.0001 deg of Dec), b 0.509, a 0.72; d is 35.6 arcsec away.
  assert.deepEqual(names(result, 0, catalog), ["c", "b", "a"]);
  // The pole itself: a and b are 0.36 arcsec away whatever their RA (a tie, ordered by ID), c is 0.72.
  assert.deepEqual(names(result, 1, catalog), ["a", "b", "c"]);
  assert.equal(result.ties[1], 1);
  assert.deepEqual(names(result, 2, catalog), ["e"]);
  near(result.candidates[2][0].separationArcsec, 0.18, 1e-6, "Dec -90 and -89.99995");
});

test("the index agrees with brute force near both poles, across RA 0/360 and over the whole sky", () => {
  const random = lcg(7);
  const radius = 50;
  const sample = (n, prefix) => {
    const ids = [];
    const positions = [];
    for (let i = 0; i < n; i++) {
      ids.push(prefix + i);
      const kind = i % 4;
      if (kind === 0) positions.push([random() * 360, 90 - 0.05 * Math.sqrt(random())]);
      else if (kind === 1) positions.push([random() * 360, -90 + 0.05 * Math.sqrt(random())]);
      else if (kind === 2) positions.push([(360 + (random() - 0.5) * 0.1) % 360, (random() - 0.5) * 0.1]);
      else positions.push([random() * 360, Math.asin(2 * random() - 1) * 180 / Math.PI]);
    }
    return list(ids, positions);
  };
  const sources = sample(400, "s");
  const catalog = sample(4000, "c");
  const result = run(sources, catalog, radius);
  let matched = 0;
  for (let i = 0; i < sources.count; i++) {
    const expected = [];
    for (let j = 0; j < catalog.count; j++) {
      if (X.separationArcsec(sources.ra[i], sources.dec[i], catalog.ra[j], catalog.dec[j]) <= radius + 1e-9) expected.push(j);
    }
    assert.deepEqual([...(result.candidates[i] ?? []).map((c) => c.index)].sort((a, b) => a - b), expected, "source " + i);
    matched += expected.length;
  }
  assert.ok(matched > 100, "the fixture should produce matches (" + matched + ")");
});

// ---- Ordering -----------------------------------------------------------------------------------------------------------
test("two equidistant candidates are both kept and ordered by ID, whatever the file order", () => {
  const positions = [[100.0001, 0], [99.9999, 0]];
  for (const ids of [["10", "2"], ["2", "10"]]) {
    const catalog = list(ids, positions);
    const result = run(list(["s"], [[100, 0]]), catalog, 1);
    assert.equal(result.status[0], X.status.multiple);
    assert.deepEqual(names(result, 0, catalog), ["2", "10"], "digit-only IDs order numerically: 2 before 10");
    assert.equal(result.ties[0], 1);
    assert.equal(result.candidates[0][0].separationArcsec, result.candidates[0][1].separationArcsec);
  }
  // Text IDs tie-break by code point, then by catalog row for duplicate IDs.
  const twin = list(["B", "A", "A"], [[100.0001, 0], [99.9999, 0], [100, 0.0001]]);
  assert.deepEqual(names(run(list(["s"], [[100, 0]]), twin, 1), 0, twin), ["A", "A", "B"]);
  assert.deepEqual(run(list(["s"], [[100, 0]]), twin, 1).candidates[0].map((c) => c.index), [1, 2, 0]);
});

test("candidates are sorted by separation and statuses are single, multiple or none", () => {
  const catalog = list(["far", "near", "mid", "out"], [[50.0004, 10], [50.00005, 10], [50.0002, 10], [50.01, 10]]);
  const sources = list(["s1", "s2", "s3"], [[50, 10], [50.0002, 10.00001], [51, 11]]);
  const result = run(sources, catalog, 1);
  assert.deepEqual(names(result, 0, catalog), ["near", "mid"]);
  assert.equal(result.status[0], X.status.multiple);
  assert.equal(result.status[1], X.status.multiple);
  assert.equal(names(result, 1, catalog)[0], "mid");
  assert.equal(result.status[2], X.status.none);
  assert.equal(result.candidates[2], null);
  assert.equal(result.ties[0], 0);
  assert.deepEqual(result.counts, { [X.status.none]: 1, [X.status.single]: 0, [X.status.multiple]: 2, [X.status.invalid]: 0 });
  assert.equal(run(list(["s"], [[50.0002, 10]]), catalog, 0.1).status[0], X.status.single);
});

test("rows with invalid coordinates are reported, never matched, and do not stop the run", () => {
  const catalog = list(["a", "b"], [[10, 10], [NaN, 10]]);
  const sources = list(["good", "bad", "alsobad"], [[10, 10], [NaN, NaN], [10, NaN]]);
  const result = run(sources, catalog, 5);
  assert.deepEqual([...result.status], [X.status.single, X.status.invalid, X.status.invalid]);
  assert.equal(result.counts[X.status.invalid], 2);
  assert.deepEqual(names(result, 0, catalog), ["a"]);
  assert.equal(X.crossMatch(list(["x"], [[NaN, NaN]]), catalog, { radiusArcsec: 3 }).ok, false);
  assert.equal(X.crossMatch(sources, list(["x"], [[NaN, NaN]]), { radiusArcsec: 3 }).ok, false);
});

// ---- Proper motion and epochs -------------------------------------------------------------------------------------------
test("propagation agrees with Astropy apply_space_motion", () => {
  const cases = {
    gaia_like_back_5p26yr: [156.11948822347, -41.65045654674, -2.917, 2.214, 2016.0, 2010.744, 156.11949392307577, -41.650459779179855],
    fast_mid_dec: [10, -30, -500, 300, 2016, 2000, 10.002566035670784, -30.001333308451105],
    high_dec: [200, 85, 120, -80, 2016, 2026, 200.00382440153442, 84.99977776669539],
    near_pole: [40, 89.99, 300, 200, 2016, 2056, 63.19859055877657, 89.99153802988785],
    ra_wrap: [359.99999, 0, 5000, 0, 2016, 2046, 0.041656659321549556, 0],
  };
  for (const [name, [ra, dec, pmra, pmdec, from, to, expectedRa, expectedDec]] of Object.entries(cases)) {
    const [newRa, newDec] = X.propagatePosition(ra, dec, pmra, pmdec, to - from, true);
    near(X.separationArcsec(newRa, newDec, expectedRa, expectedDec), 0, 1e-4, name + " difference from Astropy in arcsec (0.1 mas)");
  }
});

test("pmra with or without cos(dec) gives the same motion when converted, and the convention matters", () => {
  const dec = 60;
  const withCos = X.propagatePosition(100, dec, -40, 25, 10, true);
  const without = X.propagatePosition(100, dec, -40 / Math.cos(dec * Math.PI / 180), 25, 10, false);
  near(X.separationArcsec(withCos[0], withCos[1], without[0], without[1]), 0, 1e-9);
  const wrong = X.propagatePosition(100, dec, -40, 25, 10, false);
  assert.ok(X.separationArcsec(withCos[0], withCos[1], wrong[0], wrong[1]) > 0.1, "ignoring the convention shifts the position visibly");
  // Gaia: 100 mas/yr in pmra* is 100 mas of arc per year at any declination.
  near(X.separationArcsec(10, 80, ...X.propagatePosition(10, 80, 100, 0, 1, true)), 0.1, 1e-7);
  assert.deepEqual(X.propagatePosition(33, 44, 0, 0, 50, true), [33, 44]);
  assert.equal(X.propagatePosition(1, 2, 7, 8, 0, true)[0], 1);
});

test("different epochs: a moving source matches only after the catalog is moved to the source epoch", () => {
  // A catalog star at (150, 20) in 2016.0 with 1000 mas/yr in RA* and -500 in Dec. In 2000.0 it stood 17.9 arcsec away.
  const catalog = list(["star", "still"], [[150, 20], [150.01, 20]], {
    pmra: Float64Array.from([1000, 0]), pmdec: Float64Array.from([-500, 0]), epoch: Float64Array.from([2016, 2016]),
  });
  const [oldRa, oldDec] = X.propagatePosition(150, 20, 1000, -500, -16, true);
  const sources = list(["s"], [[oldRa, oldDec]]);
  const asPublished = run(sources, catalog, 2);
  assert.equal(asPublished.status[0], X.status.none, "17.9 arcsec apart at the published epoch");
  assert.equal(asPublished.motion.requested, false);
  const moved = run(sources, catalog, 2, { targetEpoch: 2000, pmraIncludesCosDec: true });
  assert.equal(moved.status[0], X.status.single);
  assert.deepEqual(names(moved, 0, catalog), ["star"]);
  near(moved.candidates[0][0].separationArcsec, 0, 1e-6);
  assert.equal(moved.motion.moved, 2);
  near(moved.motion.maxShiftArcsec, Math.hypot(16, 8), 0.01);
  assert.equal(catalog.ra[0], 150, "the caller's catalog is not modified");
});

test("proper motion needs the cos(dec) convention, an epoch and both components; missing ones are counted", () => {
  const catalog = list(["a", "b", "c"], [[10, 10], [10.001, 10], [10.002, 10]], {
    pmra: Float64Array.from([100, NaN, 100]), pmdec: Float64Array.from([0, 0, 0]), epoch: Float64Array.from([2016, 2016, NaN]),
  });
  const sources = list(["s"], [[10, 10]]);
  assert.equal(X.crossMatch(sources, catalog, { radiusArcsec: 3, targetEpoch: 2000 }).ok, false, "convention missing");
  assert.equal(X.crossMatch(sources, catalog, { radiusArcsec: 3, targetEpoch: NaN, pmraIncludesCosDec: true }).ok, false);
  const result = run(sources, catalog, 3, { targetEpoch: 2000, pmraIncludesCosDec: true });
  assert.deepEqual([result.motion.moved, result.motion.noMotion, result.motion.noEpoch], [1, 1, 1]);
  assert.equal(X.parseEpoch("2016.000", "jyear"), 2016);
  near(X.parseEpoch("55400.0", "mjd"), 2010.5558, 1e-4, "MJD 55400.0 as a Julian year (the AllWISE documentation quotes 2010.5589)");
  near(X.julianYearToMjd(X.mjdToJulianYear(60000)), 60000, 1e-9);
  assert.ok(Number.isNaN(X.parseEpoch("5", "jyear")) && Number.isNaN(X.parseEpoch("2016", "mjd")) && Number.isNaN(X.parseEpoch("", "jyear")));
});

// ---- Large IDs ---------------------------------------------------------------------------------------------------------
test("19-digit Gaia IDs stay text from the CSV cell to the exported CSV", () => {
  const a = "5416565604120469376";
  const b = "5416565604120469377"; // differs by 1: Number() cannot tell them apart
  assert.equal(Number(a), Number(b), "the premise: doubles collapse these IDs");
  const catalogText = "source_id,ra,dec,pmra,pmdec,ref_epoch,parallax\n" + a + ",156.1,-41.6,,,2016.000,\n" + b + ",156.1000001,-41.6,,,2016.000,\n";
  const sourceText = "source_id,x_pixel,y_pixel,ra,dec\n9223372036854775807,1,2,156.1,-41.6\n";
  const st = X.readCsvTable(sourceText);
  const ct = X.readCsvTable(catalogText);
  const sources = X.extractSources(st, { ...X.detectSourceColumns(st.header), unit: "deg" });
  const detected = X.detectCatalogColumns(ct.header, ct.rows);
  const catalog = X.extractCatalog(ct, { ...detected.columns, unit: "deg", epochUnit: "jyear", fixedEpoch: NaN });
  assert.equal(sources.ids[0], "9223372036854775807");
  assert.deepEqual(catalog.ids, [a, b]);
  const result = run(sources, catalog, 1);
  assert.deepEqual(names(result, 0, catalog), [a, b]);
  const csv = X.buildExportCsv(sources, catalog, result, { catalogName: "Gaia", catalogRelease: "DR3" });
  assert.ok(csv.includes("," + a + ",") && csv.includes("," + b + ",") && csv.startsWith("source_id,"));
  assert.ok(csv.includes("9223372036854775807,1,"));
  const safe = parseCsv(X.buildExportCsv(sources, catalog, result, { spreadsheetIds: true }));
  assert.equal(safe[1][0], '="9223372036854775807"');
  assert.deepEqual(safe.slice(1).map((row) => row[X.exportHeader.indexOf("catalog_id")]), ['="' + a + '"', '="' + b + '"']);
  assert.equal(X.compareIds(a, b), -1);
  assert.equal(X.compareIds("9", "10"), -1);
  assert.equal(X.compareIds("007", "7"), 0);
});

// ---- CSV and columns ---------------------------------------------------------------------------------------------------
test("the Source Detection export layout and the other column names are detected", () => {
  const detection = X.readCsvTable("source_id,x_pixel,y_pixel,ra,dec,peak,area_pixels\nS0001,10.5,20.25,156.1,-41.6,12.5,9\nS0002,11,22,,,3,4\n");
  assert.deepEqual(X.detectSourceColumns(detection.header), { id: 0, ra: 3, dec: 4 });
  const sources = X.extractSources(detection, { ...X.detectSourceColumns(detection.header), unit: "deg" });
  assert.equal(sources.valid, 1);
  assert.match(sources.reason[1], /RA cell is empty/);
  assert.deepEqual(X.detectSourceColumns(["name", "RAJ2000", "DEJ2000"]), { id: 0, ra: 1, dec: 2 });
  assert.deepEqual(X.detectSourceColumns(["id", "x", "y"]), { id: 0, ra: -1, dec: -1 });
  assert.equal(X.detectSourceColumns(["a", "b", "c"]).id, -1);
});

test("Gaia and AllWISE tables are recognised by their real IRSA column names", () => {
  const gaia = X.detectCatalogColumns(["source_id", "ra", "dec", "pmra", "pmdec", "ref_epoch", "parallax", "phot_g_mean_mag"]);
  assert.equal(gaia.info.kind, "gaia");
  assert.deepEqual(gaia.columns, { id: 0, ra: 1, dec: 2, pmra: 3, pmdec: 4, epoch: 5 });
  assert.equal(gaia.info.pmraIncludesCosDec, true);
  const header = ["designation", "ra", "dec", "sigra", "sigdec", "ra_pm", "dec_pm", "pmra", "pmdec", "w1mpro", "w1mjdmean", "cntr"];
  const wise = X.detectCatalogColumns(header, [["J102428.66-413922.9", "156.1", "-41.6"]]);
  assert.equal(wise.info.kind, "allwise");
  assert.equal(wise.columns.id, 0);
  assert.equal(wise.columns.ra, 1, "ra, not ra_pm");
  assert.equal(wise.columns.epoch, 10);
  assert.equal(wise.info.epochUnit, "mjd");
  assert.equal(wise.info.pmraIncludesCosDec, null, "the AllWISE documentation does not say");
  assert.equal(X.detectCatalogColumns(header, [["not-a-designation", "1", "2"]]).info.kind, null);
});

test("CSV problems are explained", () => {
  assert.match(X.readCsvTable("").message, /empty/);
  assert.match(X.readCsvTable("a;b;c\n1;2;3\n").message, /not comma-separated/);
  assert.match(X.readCsvTable("<html><body>x</body></html>").message, /XML or HTML/);
  assert.match(X.readCsvTable("id,ra\n1,2\n").message, /only 2 column/);
  const ragged = X.readCsvTable("id,ra,dec\n1,10,20\n2,10\n3,10,20,30\n");
  assert.deepEqual(ragged.malformed, [{ row: 2, fields: 2 }, { row: 3, fields: 4 }]);
  const sources = X.extractSources(ragged, { id: 0, ra: 1, dec: 2, unit: "deg" });
  assert.equal(sources.valid, 1);
  assert.match(sources.reason[1], /2 fields, the header has 3/);
  const empty = X.extractSources(X.readCsvTable("id,ra,dec\n,10,20\n,11,20\n"), { id: 0, ra: 1, dec: 2, unit: "deg" });
  assert.deepEqual(empty.ids, ["row 1", "row 2"]);
  assert.equal(empty.emptyIds, 2);
  const duplicates = X.extractSources(X.readCsvTable("id,ra,dec\nA,10,20\nA,11,20\nB,1,1\n"), { id: 0, ra: 1, dec: 2, unit: "deg" });
  assert.equal(duplicates.duplicateIds, 2);
});

test("leading # comment lines carry catalog metadata and are not data", () => {
  const table = X.readCsvTable("# catalog: Gaia\n# release = DR3\n# center_ra: 156.1\n# Radius arcsec: 90\n# just a remark\nsource_id,ra,dec\n1,2,3\n");
  assert.deepEqual(table.meta, { catalog: "Gaia", release: "DR3", center_ra: "156.1", radius_arcsec: "90" });
  assert.deepEqual(table.header, ["source_id", "ra", "dec"]);
  assert.equal(table.rows.length, 1);
  assert.equal(table.comments.length, 5);
});

test("sexagesimal tables convert RA from hours", () => {
  const table = X.readCsvTable("id,ra,dec\nA,10:24:22.4,-41:38:40.8\nB,10:24,bad\n");
  const sources = X.extractSources(table, { id: 0, ra: 1, dec: 2, unit: "sexagesimal" });
  near(sources.ra[0], 156.09333333, 1e-7);
  near(sources.dec[0], -41.64466667, 1e-7);
  assert.equal(sources.valid, 1);
  assert.match(sources.reason[1], /not sexagesimal|numeric fields/);
});

// ---- Coverage -----------------------------------------------------------------------------------------------------------
test("coverage of the extract is reported per source, and a full row limit makes it unknown", () => {
  const catalog = list(["a", "b"], [[10, 10], [10.001, 10]]);
  const sources = list(["inside", "edge", "outside"], [[10, 10], [10, 10 + 88 / 3600], [10, 11]]);
  const cone = { ra: 10, dec: 10, radiusArcsec: 90 };
  const result = run(sources, catalog, 3, { coverage: cone });
  assert.deepEqual(result.coverage, ["covered", "not-covered", "not-covered"], "the whole 3 arcsec circle must lie inside the 90 arcsec cone");
  assert.equal(result.coverageSummary.outside, 2);
  const truncated = run(sources, catalog, 3, { coverage: cone, rowLimit: 2 });
  assert.deepEqual(truncated.coverage, ["unknown", "unknown", "unknown"]);
  assert.equal(truncated.coverageSummary.truncated, true);
  assert.deepEqual(run(sources, catalog, 3).coverage, ["unknown", "unknown", "unknown"]);
});

// ---- Export -------------------------------------------------------------------------------------------------------------
test("export keeps IDs, units, radius, epoch, every candidate and the unmatched rows", () => {
  const catalog = list(["c1", "c2", "c3"], [[100.0001, 0], [99.9999, 0], [200, 0]], {
    pmra: Float64Array.from([10, 10, 0]), pmdec: Float64Array.from([0, 0, 0]), epoch: Float64Array.from([2016, 2016, 2016]),
  });
  const sources = list(["multi", "none", "=SUM(A1)", "bad"], [[100, 0], [50, 50], [300, 0], [NaN, 0]]);
  const result = run(sources, catalog, 1, { targetEpoch: 2010, pmraIncludesCosDec: true });
  const csv = X.buildExportCsv(sources, catalog, result, { catalogName: "Test, catalog", catalogRelease: "r1", sourceEpoch: "2010.0" });
  const rows = parseCsv(csv);
  assert.equal(rows.length, 1 + 2 + 3, "header, two candidates of 'multi', and one row each for the three others");
  assert.ok(rows.every((row) => row.length === X.exportHeader.length));
  const col = (name) => X.exportHeader.indexOf(name);
  const body = rows.slice(1);
  assert.deepEqual(body.map((row) => row[col("match_status")]), ["multiple-candidates", "multiple-candidates", "no-match", "no-match", "invalid-coordinates"]);
  assert.deepEqual(body.slice(0, 2).map((row) => row[col("candidate_rank")]), ["1", "2"]);
  assert.deepEqual(body.slice(0, 2).map((row) => row[col("nearest_candidate")]), ["yes", "no"]);
  assert.deepEqual(body.slice(0, 2).map((row) => row[col("candidate_count")]), ["2", "2"]);
  assert.deepEqual(body.slice(0, 2).map((row) => row[col("catalog_id")]), ["c1", "c2"], "c1 moves toward the source and c2 away from it");
  assert.equal(body[0][col("radius_arcsec")], "1");
  assert.equal(body[0][col("comparison_epoch_jyear")], "2010.0000");
  assert.equal(body[0][col("catalog_epoch_published_jyear")], "2016.0000");
  assert.equal(body[0][col("catalog_position_moved")], "yes");
  assert.equal(body[0][col("catalog_name")], "Test, catalog");
  assert.equal(body[0][col("source_epoch")], "2010.0");
  assert.match(body[0][col("note")], /position match only/);
  assert.equal(body[0][col("tie_with_next")], "no");
  assert.match(body[4][col("note")], /Not matched: bad coordinates/);
  assert.equal(body[4][col("source_ra_deg")], "");
  assert.equal(body[3][col("source_id")], "'=SUM(A1)", "a text value that starts a formula is neutralised");
  assert.equal(body[2][col("candidate_rank")], "");
  assert.match(csv, /\r\n$/);
});

// ---- IRSA query link ----------------------------------------------------------------------------------------------------
test("the IRSA TAP link carries the cone, the table columns and the row limit; bad input is refused", () => {
  const q = X.irsaExtractQuery({ table: "gaia", ra: 156.09328159, dec: -41.64466331, radiusArcsec: 90, rowLimit: 20000 });
  assert.equal(q.adql, "SELECT TOP 20000 source_id,ra,dec,pmra,pmdec,ref_epoch,parallax,phot_g_mean_mag FROM gaia_dr3_source WHERE CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',156.09328159,-41.64466331,0.025))=1");
  const url = new URL(q.url);
  assert.equal(url.origin + url.pathname, "https://irsa.ipac.caltech.edu/TAP/sync");
  assert.equal(url.searchParams.get("QUERY"), q.adql);
  assert.equal(url.searchParams.get("FORMAT"), "csv");
  assert.match(X.irsaExtractQuery({ table: "allwise", ra: 1, dec: 2, radiusArcsec: 5, rowLimit: 10 }).adql, /FROM allwise_p3as_psd/);
  for (const bad of [{ table: "x" }, { table: "gaia", ra: 361, dec: 0, radiusArcsec: 5, rowLimit: 10 }, { table: "gaia", ra: 1, dec: 0, radiusArcsec: 4000, rowLimit: 10 },
    { table: "gaia", ra: 1, dec: 0, radiusArcsec: 5, rowLimit: 0 }, { table: "gaia", ra: NaN, dec: 0, radiusArcsec: 5, rowLimit: 10 }]) {
    assert.ok(X.irsaExtractQuery(bad).error, JSON.stringify(bad));
  }
  const circle = X.enclosingCircle(list(["a", "b", "bad"], [[359.999, 10], [0.001, 10], [NaN, NaN]]), 3);
  near(circle.dec, 10, 1e-6);
  assert.ok(circle.ra > 359.99 || circle.ra < 0.01);
  near(circle.radiusArcsec, X.separationArcsec(0, 10, 0.001, 10) + 3, 1e-6);
  assert.equal(X.enclosingCircle(list(["x"], [[NaN, NaN]])), null);
});

// ---- Large lists --------------------------------------------------------------------------------------------------------
test("100,000 sources against 100,000 catalog rows finish quickly and agree with brute force", () => {
  const random = lcg(12345);
  // Four areas: a strip across RA 0/360 on the equator, the whole sky, a cap around the north pole, a patch at RA 100.
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
  const started = performance.now();
  const result = run(sources, catalog, 20);
  const seconds = (performance.now() - started) / 1000;
  assert.ok(seconds < 8, "matching 100k x 100k took " + seconds.toFixed(2) + " s");
  assert.equal(Object.values(result.counts).reduce((a, b) => a + b, 0), 100000);
  assert.ok(result.counts[X.status.single] + result.counts[X.status.multiple] > 10000, "the fixture should produce many matches");
  // Brute force on every 500th source over all catalog rows.
  for (let i = 0; i < sources.count; i += 500) {
    const expected = [];
    for (let j = 0; j < catalog.count; j++) {
      const separation = X.separationArcsec(sources.ra[i], sources.dec[i], catalog.ra[j], catalog.dec[j]);
      if (separation <= 20 + 1e-9) expected.push([j, separation]);
    }
    expected.sort((a, b) => Math.round(a[1] / 1e-6) - Math.round(b[1] / 1e-6) || X.compareIds(catalog.ids[a[0]], catalog.ids[b[0]]) || a[0] - b[0]);
    assert.deepEqual((result.candidates[i] ?? []).map((c) => c.index), expected.map((e) => e[0]), "source " + i);
  }
  assert.equal(catalog.ids[99999], "c" + (1000000000000000000n + 99999n * 7919n).toString(), "IDs above 2^53 survive");
  console.log("# 100k x 100k match: " + seconds.toFixed(2) + " s, " + result.index.zones + " zones of " + result.index.zoneHeightDeg + " deg");
});

test("100,000 CSV rows go from text to exported CSV in seconds", () => {
  const random = lcg(99);
  const lines = ["source_id,x_pixel,y_pixel,ra,dec"];
  const cat = ["source_id,ra,dec,pmra,pmdec,ref_epoch,parallax"];
  for (let i = 0; i < 100000; i++) {
    const ra = 150 + random() * 2;
    const dec = -41 + random() * 2;
    lines.push("S" + i + "," + (i % 70) + "," + (i % 71) + "," + ra.toFixed(8) + "," + dec.toFixed(8));
    cat.push((5416565604120469376n + BigInt(i)).toString() + "," + (ra + (random() - 0.5) * 0.0004).toFixed(8) + "," + (dec + (random() - 0.5) * 0.0004).toFixed(8) + ",1.5,-2.5,2016.000,0.3");
  }
  const started = performance.now();
  const st = X.readCsvTable(lines.join("\n"));
  const ct = X.readCsvTable(cat.join("\n"));
  const sources = X.extractSources(st, { ...X.detectSourceColumns(st.header), unit: "deg" });
  const detected = X.detectCatalogColumns(ct.header, ct.rows);
  const catalog = X.extractCatalog(ct, { ...detected.columns, unit: "deg", epochUnit: "jyear", fixedEpoch: NaN });
  const result = run(sources, catalog, 3, { targetEpoch: 2000, pmraIncludesCosDec: true });
  const csv = X.buildExportCsv(sources, catalog, result, {});
  const seconds = (performance.now() - started) / 1000;
  assert.ok(seconds < 20, "the CSV pipeline took " + seconds.toFixed(2) + " s");
  assert.equal(result.motion.moved, 100000);
  assert.ok(csv.split("\r\n").length > 100000);
  console.log("# 100k-row CSV pipeline: " + seconds.toFixed(2) + " s, " + csv.length.toLocaleString("en-US") + " bytes exported");
});

// ---- Real archive extract (NASA/IPAC IRSA TAP, retrieved 2026-11-13) --------------------------------------------------------
// Official Gaia DR3 x AllWISE best-neighbour pairs (IRSA table gaia_dr3_allwise_best_neighbour, joined to the 90 arcsec
// cone): [Gaia source_id, AllWISE designation, angular_distance in arcsec].
const officialPairs = [
  ["5416565604120469376", "J102428.67-413901.6", 7.5479425490e-02], ["5416565569760721408", "J102424.98-413949.6", 4.4111806154e-01],
  ["5416565844638646144", "J102421.57-413821.3", 8.6244910955e-02], ["5416565672839933952", "J102420.89-413958.6", 3.1350588799e-01],
  ["5416565745856563200", "J102417.15-413819.3", 3.2260170579e-01], ["5416565711496627328", "J102416.45-413938.8", 2.7323386073e-01],
  ["5416568799576153600", "J102418.06-413735.6", 1.8641896546e-01], ["5416565844638646016", "J102420.61-413822.2", 2.8972083330e-01],
  ["5416565745856367616", "J102419.31-413858.2", 1.8620230258e-02], ["5416565741559425920", "J102418.91-413845.4", 5.5101376772e-01],
  ["5416565707199681664", "J102415.50-413912.3", 3.5440278053e-01], ["5416565741559427328", "J102415.30-413839.4", 4.4297222048e-02],
  ["5416565844638649600", "J102421.48-413758.6", 3.9299166203e-01], ["5416565608417416320", "J102427.29-413848.5", 5.4646674544e-02],
  ["5416565814575847168", "J102426.40-413830.5", 3.6584440619e-02], ["5416565608417415680", "J102426.77-413902.6", 5.3486142308e-02],
  ["5416567085886167936", "J102429.50-413802.5", 9.6719823778e-02], ["5416565604120475520", "J102427.82-413829.9", 5.9534132481e-01],
];

function loadExample() {
  const example = vm.runInContext(readFileSync(join(root, "assets/tools/xmatch-example.js"), "utf8") + "\ncatalogCrossMatchExample", vm.createContext({}));
  const st = X.readCsvTable(example.allwise.csv);
  const ct = X.readCsvTable(example.gaia.csv);
  const sources = X.extractSources(st, { ...X.detectSourceColumns(st.header), unit: "deg" });
  const detected = X.detectCatalogColumns(ct.header, ct.rows);
  const catalog = X.extractCatalog(ct, { ...detected.columns, unit: "deg", epochUnit: "jyear", fixedEpoch: NaN });
  return { example, st, ct, sources, catalog, detected };
}

test("real archive extract: file contents, detection and metadata", () => {
  const { example, st, ct, sources, catalog, detected } = loadExample();
  assert.equal(example.retrieved, "2026-11-13");
  assert.equal(sources.count, 40);
  assert.equal(catalog.count, 72);
  assert.equal(sources.valid, 40);
  assert.equal(catalog.valid, 72);
  assert.equal(detected.info.kind, "gaia");
  assert.equal(ct.meta.release, "DR3");
  assert.equal(ct.meta.radius_arcsec, "90");
  assert.equal(st.meta.catalog, "AllWISE Source Catalog");
  assert.ok(catalog.ids.every((id) => /^\d{19}$/.test(id)), "Gaia source_id values are 19-digit text");
  assert.equal(catalog.pmUsable, 65, "7 of the 72 Gaia rows have no proper motion");
  assert.equal(catalog.epochMin, 2016);
  assert.equal(catalog.epochMax, 2016);
  assert.equal(sources.ids[1], "J102428.67-413901.6");
});

test("real archive extract: all 18 official Gaia DR3 x AllWISE best-neighbour pairs are reproduced", () => {
  const { sources, catalog } = loadExample();
  const moved = run(sources, catalog, 3, { targetEpoch: 2010.744, pmraIncludesCosDec: true });
  const published = run(sources, catalog, 3);
  const counts = (r) => [r.counts[X.status.none], r.counts[X.status.single], r.counts[X.status.multiple]];
  assert.deepEqual(counts(moved), [13, 25, 2], "Astropy search_around_sky on the moved positions finds the same 40 lists");
  assert.deepEqual(counts(published), [13, 25, 2], "and on the published positions");
  assert.equal(moved.motion.moved, 65);
  assert.equal(moved.motion.noMotion, 7);
  near(moved.motion.maxShiftArcsec, 0.2437, 1e-3);
  let worst = 0;
  for (const [gaiaId, designation, official] of officialPairs) {
    const i = sources.ids.indexOf(designation);
    assert.ok(i >= 0, designation + " is in the source list");
    const hit = (moved.candidates[i] ?? []).find((c) => catalog.ids[c.index] === gaiaId);
    assert.ok(hit, designation + " has candidate " + gaiaId);
    worst = Math.max(worst, Math.abs(hit.separationArcsec - official));
  }
  assert.ok(worst < 1e-3, "worst difference from the archive's angular_distance: " + worst + " arcsec");
  // One of them, spelled out: AllWISE J102428.67-413901.6 and Gaia DR3 5416565604120469376.
  const i = sources.ids.indexOf("J102428.67-413901.6");
  assert.equal(catalog.ids[moved.candidates[i][0].index], "5416565604120469376");
  near(moved.candidates[i][0].separationArcsec, 0.075479, 5e-5);
  for (const k of [...moved.status].map((s, index) => (s === X.status.multiple ? index : -1)).filter((index) => index >= 0)) {
    const [first, second] = moved.candidates[k];
    assert.ok(first.separationArcsec <= second.separationArcsec);
  }
  console.log("# real extract: 18/18 official pairs found, worst |difference| " + (worst * 1000).toFixed(3) + " mas");
});
