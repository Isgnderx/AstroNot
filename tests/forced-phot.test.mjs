// Run with:  node --test tests/        (or: node tests/forced-phot.test.mjs)
//
// Covers tools/forced-phot.js, the forced-photometry measurement module (a port of spxphot, the Rust reimplementation of the
// IRSA SPHEREx Spectrophotometry Tool).
//   - Coordinate layer (port of spxphot src/wcs.rs): TAN-SIP, pixel solid angle and the WCS-WAVE lookup, checked against
//     tests/data/spxphot/wcs_vectors.json (astropy values for a real SPHEREx IMAGE header) and against tools/wcs.js.
//   - Forced photometry on one frame (port of phot.rs): the Rust unit tests and the background statistics.
//   - Frames, calibration cache and the run (port of archive.rs / main.rs): parity of the fixture cutout with spxphot's own row,
//     the run's report, target parsing, frame selection and the two CSV writers. The LIVE tests (ASTRONOT_LIVE=1,
//     ASTRONOT_LIVE_FULL=1) read real frames from IRSA's S3 bucket.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const Wcs = require("../tools/wcs.js");
const ForcedPhot = require("../tools/forced-phot.js");
const Range = require("../tools/fits-range.js");
const Spectrum = require("../tools/spectrum-csv.js");

const V = JSON.parse(readFileSync(fileURLToPath(new URL("./data/spxphot/wcs_vectors.json", import.meta.url)), "utf8"));
const fields = V.header;
const flat = (x) => (Array.isArray(x) ? x.flatMap(flat) : [x]);

// ---- Celestial and spectral WCS (port of wcs.rs) --------------------------------------------------------------------------

test("TanSip matches astropy: sky to 1e-6 arcsec, roundtrip to 1e-8 px", () => {
  const w = ForcedPhot.createTanSip(fields);
  assert.equal(V.pix.length, V.sky.length);
  V.pix.forEach(([x, y], i) => {
    const [ra, dec] = w.pixToWorld(x, y);
    assert.ok(Math.abs(ra - V.sky[i][0]) * 3600 < 1e-6, "ra at pixel " + i);
    assert.ok(Math.abs(dec - V.sky[i][1]) * 3600 < 1e-6, "dec at pixel " + i);
    const [bx, by] = w.worldToPix(ra, dec);
    assert.ok(Math.abs(bx - x) < 1e-8 && Math.abs(by - y) < 1e-8, "roundtrip at pixel " + i + ": " + bx + ", " + by);
  });
});

test("pixelSolidAngle matches the finite-difference reference to 2e-4", () => {
  const w = ForcedPhot.createTanSip(fields);
  V.pix.forEach(([x, y], i) => {
    const om = w.pixelSolidAngle(x, y) * 206264.80624709636 ** 2;
    assert.ok(Math.abs(om / V.omega_arcsec2[i] - 1) < 2e-4, "omega " + om + " vs " + V.omega_arcsec2[i]);
  });
});

test("WaveTable with SIP matches astropy wavelength and bandwidth to 1e-6", () => {
  const t = ForcedPhot.createWaveTable(flat(V.wave_x), flat(V.wave_y), flat(V.wave_values)).withSipFrom(fields);
  const wv = flat(V.wave);
  const bw = flat(V.band);
  V.pix.forEach(([x, y], i) => {
    const [w, b] = t.eval(x, y, [1, 1]);
    assert.ok(Math.abs(w - wv[i]) < 1e-6, "wave " + w + " vs " + wv[i]);
    assert.ok(Math.abs(b - bw[i]) < 1e-6, "band " + b + " vs " + bw[i]);
  });
});

test("worldToPix agrees with tools/wcs.js skyToPixel to 1e-8 px (after the 1-based shift)", () => {
  const created = Wcs.createWcs(fields);
  assert.ok(created.wcs, "tools/wcs.js accepts the header: " + created.reason);
  const { wcs } = created;
  const w = ForcedPhot.createTanSip(fields);
  V.pix.forEach(([x, y], i) => {
    const [ra, dec] = V.sky[i];
    const site = wcs.skyToPixel(ra, dec);
    const [bx, by] = w.worldToPix(ra, dec);
    assert.ok(Math.abs(bx - (site.x - 1)) < 1e-8 && Math.abs(by - (site.y - 1)) < 1e-8, "pixel " + i + ": " + bx + ", " + by + " vs " + (site.x - 1) + ", " + (site.y - 1));
    const sky = wcs.pixelToSky(x + 1, y + 1);
    const [r, d] = w.pixToWorld(x, y);
    let dra = r - sky.ra;
    if (dra > 180) dra -= 360;
    if (dra < -180) dra += 360;
    assert.ok(Math.abs(dra) * 3600 < 1e-6 && Math.abs(d - sky.dec) * 3600 < 1e-6, "sky at pixel " + i);
  });
});

test("createTanSip rejects non-TAN projections and LONPOLE other than 180", () => {
  assert.throws(() => ForcedPhot.createTanSip({ ...fields, CTYPE1: "RA---SIN" }), /unsupported projection RA---SIN/);
  assert.throws(() => ForcedPhot.createTanSip({ ...fields, LONPOLE: "0" }), /LONPOLE != 180 is not supported/);
});

test("pixToWorld wraps RA like Rust rem_euclid: exact for small positive RA, just under 360 for small negative RA", () => {
  // CRVAL1 = CRVAL2 = 0 on the vector header's other cards: on the equator at the reference point xi = cd * t * D2R, eta = 0.
  const f = { ...fields, CRVAL1: 0, CRVAL2: 0, CRPIX1: 1, CRPIX2: 1, CD1_1: 1, CD1_2: 0, CD2_1: 0, CD2_2: 1 };
  for (const key of Object.keys(f)) if (/^(A|B|AP|BP)_/.test(key)) delete f[key];
  const w = ForcedPhot.createTanSip(f);
  const D2R = Math.PI / 180;
  const rawRa = (t) => Math.atan2((t + 1 - 1) * D2R, 1) / D2R; // unwrapped RA in degrees for a pixel at x = t (y = 0), u = x + 1 - CRPIX1
  for (const t of [1e-6, 0.123456789, 5e-13]) {
    const [ra] = w.pixToWorld(t, 0);
    assert.equal(ra, rawRa(t) % 360, "positive RA is returned unchanged for t = " + t);
    assert.ok(ra > 0 && ra < 1);
  }
  const [negative] = w.pixToWorld(-1e-12, 0);
  assert.equal(negative, rawRa(-1e-12) + 360);
  assert.ok(negative > 359.99999999 && negative < 360, "tiny negative RA maps to just under 360: " + negative);
  // x = -1 makes x + 1 exact, so with CRPIX1 = +/-1e-17 the plane offset is exactly -/+1e-17 pixel.
  const wTiny = ForcedPhot.createTanSip({ ...f, CRPIX1: 1e-17 });
  assert.equal(wTiny.pixToWorld(-1, 0)[0], 360, "-1e-17 deg maps to 360 (-1e-17 + 360 rounds to 360), as in Rust");
  const wTinyPositive = ForcedPhot.createTanSip({ ...f, CRPIX1: -1e-17 });
  assert.ok(wTinyPositive.pixToWorld(-1, 0)[0] > 0 && wTinyPositive.pixToWorld(-1, 0)[0] < 1e-16, "+1e-17 deg stays 1e-17");
  assert.equal(w.pixToWorld(0, 0)[0], 0);
});

// ---- Forced photometry on one frame (port of spxphot src/phot.rs) -----------------------------------------------------------------
// The first two tests are the Rust unit tests, with their numbers and tolerances. fitFrame takes the readRows-shaped blocks
// { y0, width, data, at(x, y) }; params already carry fitHalf (the Rust Params::default() has fit_half 5, so these tests set 5).

const { bits, flagNames, defaultParams, withFitHalf, fitFrame } = ForcedPhot;

function block(width, data) {
  return {
    y0: 0,
    width,
    data,
    at(x, y) {
      return this.data[(y - this.y0) * this.width + x];
    },
  };
}

// The Rust `gauss` helper: unit-sum circular Gaussian (sigma 1) on an n x n box with lower-left pixel (bx, by).
function gauss(x0, y0, bx, by, n) {
  const m = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const dx = bx + i - x0;
      const dy = by + j - y0;
      m[j * n + i] = Math.exp(-(dx * dx + dy * dy) / 2);
    }
  }
  let s = 0;
  for (const v of m) s += v;
  for (let i = 0; i < m.length; i++) m[i] /= s;
  return m;
}

const rustParams = { ...defaultParams, fitHalf: 5 }; // Params::default() of phot.rs

// A noise-free frame: background 3, one Gaussian of flux 500 at (x0, y0) rendered over the whole image, variance 1.
function cleanFrame(w, h, x0, y0, fl) {
  const full = gauss(x0, y0, 0, 0, w); // w x w; the image is w x h with h <= w
  const img = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) img[i] = 3.0 + 500.0 * full[i];
  return { image: block(w, img), flags: block(w, fl || new Float64Array(w * h)), variance: block(w, new Float64Array(w * h).fill(1)), height: h };
}

test("bits: values from phot.rs, FIT_IGNORE and BAD composed as in the Rust, flagNames in bit order", () => {
  assert.equal(bits.TRANSIENT, 1n);
  assert.equal(bits.SUR_ERROR, 4n);
  assert.equal(bits.HOT, 1n << 10n);
  assert.equal(bits.CONTAINS_BAD_PIXEL, 1n << 32n);
  assert.equal(bits.FIT_ERROR, 1n << 33n);
  assert.equal(bits.OUTLIER, 1n << 19n);
  assert.equal(bits.SOURCE, 1n << 21n);
  assert.equal(
    bits.FIT_IGNORE,
    bits.SUR_ERROR | bits.NONFUNC | bits.MISSING_DATA | bits.HOT | bits.COLD | bits.NONLINEAR | bits.PERSIST | bits.BLOOM | bits.SNOWBALL | bits.HALO | bits.SATELLITE_HALO
  );
  assert.equal(bits.BAD, ((1n << 30n) - 1n) & ~(1n << 21n) & ~(1n << 19n));
  assert.equal(bits.BAD & bits.SOURCE, 0n);
  assert.equal(bits.BAD & bits.OUTLIER, 0n);
  assert.deepEqual(flagNames(0), []);
  assert.deepEqual(flagNames((1 << 10) | (1 << 2) | 1), ["TRANSIENT", "SUR_ERROR", "HOT"]);
  assert.deepEqual(flagNames(bits.FIT_ERROR | bits.CONTAINS_BAD_PIXEL | bits.SOURCE), ["SOURCE", "CONTAINS_BAD_PIXEL", "FIT_ERROR"]);
});

test("defaultParams and withFitHalf", () => {
  assert.deepEqual(defaultParams, { fitSize: 13, fitShape: "circle", bkgHalf: 10, bkgExcludeR: 3, bkgStat: "median", skyFit: true, qlRadius: 2.5, flagRadius: 2.5, astropyWave: false });
  assert.equal(withFitHalf(defaultParams).fitHalf, 8); // ceil(13 / 2) + 1, as main.rs:574
  assert.equal(withFitHalf({ ...defaultParams, fitSize: 12 }).fitHalf, 7);
  assert.equal(withFitHalf({ ...defaultParams, fitSize: 5 }).fitSize, 5);
});

test("recovers flux and background exactly without noise", () => {
  const [w, h] = [40, 40];
  const p = rustParams;
  const [x0, y0] = [20.3, 19.6];
  const n = 2 * p.fitHalf + 1;
  const [bx, by] = [20 - p.fitHalf, 20 - p.fitHalf];
  const px = cleanFrame(w, h, x0, y0);
  const m = gauss(x0, y0, bx, by, n);
  const fit = fitFrame(px, p, [[x0, y0]], 0, [m], bx, by);
  // the fit box truncates the Gaussian slightly; renormalised model absorbs that
  const full = gauss(x0, y0, 0, 0, w);
  let inBox = 0;
  for (let i = 0; i < full.length; i++) {
    const x = i % w;
    const y = Math.floor(i / w);
    if (x >= bx && x < bx + n && y >= by && y < by + n) inBox += full[i];
  }
  assert.ok(Math.abs(fit.flux[0] - 500 * inBox) < 1e-6, String(fit.flux[0]));
  assert.ok(Math.abs(fit.bkgPre + fit.bkgFit - 3.0) < 1e-9);
  assert.ok(fit.fitQl < 1e-9);
  assert.equal(fit.flags, 0n);
});

test("bad pixels are masked and flagged (a hot pixel next to the source)", () => {
  const [w, h] = [30, 30];
  const p = rustParams;
  const [x0, y0] = [15.0, 15.0];
  const n = 2 * p.fitHalf + 1;
  const [bx, by] = [10, 10];
  const m = gauss(x0, y0, bx, by, n);
  const img = new Float64Array(w * h).fill(1.0);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) img[(by + j) * w + bx + i] += 100.0 * m[j * n + i];
  const fl = new Float64Array(w * h);
  img[15 * w + 16] = 1e6; // hot pixel next to the source
  fl[15 * w + 16] = Number(bits.HOT);
  const px = { image: block(w, img), flags: block(w, fl), variance: block(w, new Float64Array(w * h).fill(1)), height: h };
  const fit = fitFrame(px, p, [[x0, y0]], 0, [m], bx, by);
  assert.ok(Math.abs(fit.flux[0] - 100.0) < 1e-6, String(fit.flux[0]));
  assert.notEqual(fit.flags & bits.HOT, 0n);
  assert.notEqual(fit.flags & bits.CONTAINS_BAD_PIXEL, 0n);
  assert.equal(typeof fit.flags, "bigint");
});

test("edge: a source 2 px from the top row fits with fewer pixels and no exception", () => {
  const [w, h] = [40, 40];
  const p = rustParams;
  const n = 2 * p.fitHalf + 1;
  const run = (x0, y0) => {
    const px = cleanFrame(w, h, x0, y0);
    const bx = Math.round(x0) - p.fitHalf;
    const by = Math.round(y0) - p.fitHalf;
    return fitFrame(px, p, [[x0, y0]], 0, [gauss(x0, y0, bx, by, n)], bx, by);
  };
  const centred = run(20.3, 19.6);
  const edge = run(20.3, h - 3); // pixel rows above h - 1 do not exist
  assert.ok(edge.nPix > 0 && edge.nPix < centred.nPix, `${edge.nPix} vs ${centred.nPix}`);
  assert.ok(Number.isFinite(edge.flux[0]));
  assert.ok(Number.isFinite(edge.fluxErr[0]));
  assert.equal(edge.flags & bits.FIT_ERROR, 0n);
});

test("degenerate: two sources at one position give FIT_ERROR and NaN", () => {
  const [w, h] = [40, 40];
  const p = rustParams;
  const [x0, y0] = [20.3, 19.6];
  const [bx, by] = [20 - p.fitHalf, 20 - p.fitHalf];
  const px = cleanFrame(w, h, x0, y0);
  const m = gauss(x0, y0, bx, by, 2 * p.fitHalf + 1);
  const fit = fitFrame(px, p, [[x0, y0], [x0, y0]], 0, [m, Float64Array.from(m)], bx, by);
  assert.notEqual(fit.flags & bits.FIT_ERROR, 0n);
  assert.ok(Number.isNaN(fit.flux[0]));
  assert.ok(Number.isNaN(fit.flux[1]));
  assert.ok(Number.isNaN(fit.fluxErr[0]));
  assert.ok(Number.isNaN(fit.fitQl));
});

test("degenerate: zero variance everywhere gives nPix 0 and FIT_ERROR", () => {
  const [w, h] = [40, 40];
  const p = rustParams;
  const [x0, y0] = [20.3, 19.6];
  const [bx, by] = [20 - p.fitHalf, 20 - p.fitHalf];
  const px = cleanFrame(w, h, x0, y0);
  px.variance = block(w, new Float64Array(w * h));
  const fit = fitFrame(px, p, [[x0, y0]], 0, [gauss(x0, y0, bx, by, 2 * p.fitHalf + 1)], bx, by);
  assert.equal(fit.nPix, 0);
  assert.notEqual(fit.flags & bits.FIT_ERROR, 0n);
  assert.ok(Number.isNaN(fit.flux[0]));
  assert.ok(Number.isNaN(fit.fitQl));
});

test("background statistic: mode = 2.5 median - 1.5 mean after clipping; none gives bkgPre 0", () => {
  const [w, h] = [40, 40];
  const p = rustParams;
  const [x0, y0] = [20, 20];
  const [bx, by] = [20 - p.fitHalf, 20 - p.fitHalf];
  // A skewed, deterministic background; no value is beyond 3 sigma, so the clip removes nothing.
  const table = [0, 0, 0, 1, 1, 2, 5];
  const img = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img[y * w + x] = table[(3 * x + 5 * y) % 7];
  const px = { image: block(w, img), flags: block(w, new Float64Array(w * h)), variance: block(w, new Float64Array(w * h).fill(1)), height: h };
  const m = gauss(x0, y0, bx, by, 2 * p.fitHalf + 1);
  // the expected sample: the (2 bkgHalf + 1)^2 window around the rounded source, minus pixels within bkgExcludeR of the source
  const sample = [];
  for (let y = 20 - p.bkgHalf; y <= 20 + p.bkgHalf; y++)
    for (let x = 20 - p.bkgHalf; x <= 20 + p.bkgHalf; x++) if (Math.sqrt((x - x0) ** 2 + (y - y0) ** 2) >= p.bkgExcludeR) sample.push(img[y * w + x]);
  sample.sort((a, b) => a - b);
  const n = sample.length;
  const median = n % 2 === 1 ? sample[(n - 1) / 2] : 0.5 * (sample[n / 2 - 1] + sample[n / 2]);
  let sum = 0;
  for (const v of sample) sum += v;
  const mean = sum / n;
  let sd = 0;
  for (const v of sample) sd += (v - mean) ** 2;
  sd = Math.sqrt(sd / n);
  assert.ok(Math.max(...sample) - median <= 3 * sd, "test premise: nothing is clipped");
  assert.ok(mean > median + 0.1, "test premise: skewed sample");
  const bkg = (bkgStat) => fitFrame(px, { ...p, bkgStat }, [[x0, y0]], 0, [m], bx, by).bkgPre;
  assert.ok(Math.abs(bkg("median") - median) < 1e-12);
  assert.ok(Math.abs(bkg("mean") - mean) < 1e-12);
  assert.ok(Math.abs(bkg("mode") - (2.5 * median - 1.5 * mean)) < 1e-12);
  assert.equal(bkg("none"), 0);
});

test("background: a bright source pixel is sigma-clipped; SOURCE-flagged pixels are excluded unless fewer than 10 remain", () => {
  const [w, h] = [40, 40];
  const p = rustParams;
  const img = new Float64Array(w * h).fill(7);
  img[15 * w + 22] = 1e4; // an outlier inside the background window (rows 10..30; distance > bkgExcludeR from the source at 20, 20)
  const fl = new Float64Array(w * h);
  const m = gauss(20, 20, 15, 15, 11);
  const mk = (flags) => ({ image: block(w, img), flags: block(w, flags), variance: block(w, new Float64Array(w * h).fill(1)), height: h });
  assert.equal(fitFrame(mk(fl), p, [[20, 20]], 0, [m], 15, 15).bkgPre, 7);
  // every pixel flagged SOURCE: the first pass has no sample, the second (SOURCE allowed) restores it
  const all = new Float64Array(w * h).fill(Number(bits.SOURCE));
  assert.equal(fitFrame(mk(all), p, [[20, 20]], 0, [m], 15, 15).bkgPre, 7);
});

// ---- Frames, calibration cache and the run (port of spxphot src/archive.rs / src/main.rs) -----------------------------------------
// Parity: the fixture is a 0.06 deg cutout (IRSA cutout format, made by spxphot itself) of one DR1 detector-1 frame. Its headers carry
// CRPIX1A/2A (parent-frame pixels) and CRPIX1W/2W, so the measurement on it must reproduce spxphot's row for the full frame.

const {
  S3_BASE, IRSA_PREFIX, METHOD, frameFromImportRow, validateShape, parseTargetsCsv, selectFrames, createCalibCache, measureFrame,
  runForcedPhotometry, irsaColumns, rowsToIrsaCsv, rowsToSpectrumLabCsv,
} = ForcedPhot;

const dataFile = (name) => fileURLToPath(new URL("./data/spxphot/" + name, import.meta.url));
const fixtureBytes = new Uint8Array(readFileSync(dataFile("bd17-cutout.fits")));
const sidecar = JSON.parse(readFileSync(dataFile("bd17-cutout.frame.json"), "utf8"));
const bd17 = { name: sidecar.target.label, ra: sidecar.target.ra, dec: sidecar.target.dec, shape: null };

// The sidecar as an Observation Search row (tools/observation-csv.js parseIrsaResults shape, plus Task 7's `collection`).
const fixtureImportRow = {
  obsId: sidecar.obs_id,
  product: new URL(sidecar.access_url),
  release: "dr1",
  collection: sidecar.obs_collection,
  detector: Number(/D(\d)$/.exec(sidecar.energy_bandpassname)[1]),
  start: Number(sidecar.t_min),
};
const fixtureFrame = frameFromImportRow(fixtureImportRow);

// Plain CSV (no quoted fields in these files) -> array of { column: text }.
function readPlainCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(header.map((name, i) => [name, cells[i]]));
  });
}
const oracleRows = readPlainCsv(readFileSync(dataFile("bd17_spxphot.csv"), "utf8"));
const irsaRows = readPlainCsv(readFileSync(dataFile("bd17_irsa.csv"), "utf8"));
const oracleFor = (lvf, det) => oracleRows.find((r) => Number(r.lvf_id) === lvf && Number(r.det_id) === det);

const relDiff = (a, b) => (a === b ? 0 : Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)));

// Every column of spxphot's row: strings equal, flags exact, fit_ql to 1e-6 relative, every other number to 1e-9 relative.
// Returns the relative difference per numeric column.
function assertParity(row, oracle) {
  assert.ok(oracle, "oracle row for lvf_id " + row.lvf_id + " det_id " + row.det_id);
  const diffs = {};
  for (const column of irsaColumns) {
    const expected = oracle[column];
    if (column === "label" || column === "data_collection" || column === "deep_flg") {
      assert.equal(String(row[column]), expected, column);
    } else if (column === "flags") {
      assert.equal(row.flags, Number(expected), "flags");
    } else {
      const d = relDiff(row[column], Number(expected));
      diffs[column] = d;
      assert.ok(d <= (column === "fit_ql" ? 1e-6 : 1e-9), column + ": " + row[column] + " vs " + expected + " (relative " + d + ")");
    }
  }
  return diffs;
}

const fixtureSource = () => Range.createMemorySource(fixtureBytes);
const fullParams = withFitHalf(defaultParams);

test("parity: the fixture cutout reproduces spxphot's row to 1e-9", async (t) => {
  const rows = await measureFrame({ source: fixtureSource(), frame: fixtureFrame, targets: [bd17], params: fullParams, cache: createCalibCache() });
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]), irsaColumns);
  const oracle = oracleFor(sidecar.lvf_id, 1);
  const diffs = assertParity(rows[0], oracle);
  t.diagnostic("max relative difference per column: " + JSON.stringify(diffs));
});

test("runForcedPhotometry over one memory frame: report counts and sorted rows", async () => {
  const progress = [];
  const { rows, report } = await runForcedPhotometry({
    frames: [fixtureFrame], targets: [bd17], openSource: fixtureSource, onProgress: (p) => progress.push(p),
  });
  assert.equal(rows.length, 1);
  assertParity(rows[0], oracleFor(sidecar.lvf_id, 1));
  assert.equal(report.frames, 1);
  assert.equal(report.measured, 1);
  assert.equal(report.epsfDownloads, 1);
  assert.deepEqual(report.skipped, []);
  assert.deepEqual(report.failed, []);
  assert.equal(report.cancelled, false);
  assert.ok(report.seconds >= 0);
  assert.deepEqual(progress, [{ done: 1, total: 1, measured: 1, failed: 0 }]);

  // Two targets on the frame (the second ~10 px north, fit jointly): rows come back sorted by label.
  const near = { name: "aa-neighbour", ra: bd17.ra, dec: bd17.dec + 0.017, shape: null };
  const two = await runForcedPhotometry({ frames: [fixtureFrame], targets: [{ ...bd17, name: "zz-bd17" }, near], openSource: fixtureSource });
  assert.deepEqual(two.rows.map((r) => r.label), ["aa-neighbour", "zz-bd17"]);
  assert.equal(two.report.measured, 1);

  // A target far from the frame: the frame is skipped, not failed.
  const off = await runForcedPhotometry({ frames: [fixtureFrame], targets: [{ ...bd17, dec: bd17.dec + 1 }], openSource: fixtureSource });
  assert.deepEqual(off.rows, []);
  assert.deepEqual(off.report.skipped, [{ uri: fixtureFrame.uri, reason: "target off image" }]);
  assert.equal(off.report.measured, 0);

  // Wavelength filters drop rows after measuring.
  const lambda = rows[0].lambda;
  assert.equal((await runForcedPhotometry({ frames: [fixtureFrame], targets: [bd17], openSource: fixtureSource, filters: { wvlMin: lambda + 0.01 } })).rows.length, 0);
  assert.equal((await runForcedPhotometry({ frames: [fixtureFrame], targets: [bd17], openSource: fixtureSource, filters: { wvlMin: lambda - 0.01, wvlMax: lambda + 0.01 } })).rows.length, 1);
});

test("a frame without EPSF is skipped with its reason", async () => {
  // The fixture cut right after VARIANCE (PRIMARY, IMAGE, FLAGS, VARIANCE are 74880 bytes).
  const cut = fixtureBytes.slice(0, 74880);
  const { rows, report } = await runForcedPhotometry({ frames: [fixtureFrame], targets: [bd17], openSource: () => Range.createMemorySource(cut) });
  assert.deepEqual(rows, []);
  assert.equal(report.skipped.length, 1);
  assert.equal(report.skipped[0].uri, fixtureFrame.uri);
  assert.match(report.skipped[0].reason, /no EPSF extension/);
  assert.deepEqual(report.failed, []);
  assert.equal(report.measured, 0);
  assert.equal(report.epsfDownloads, 0);
});

const copyOf = (frame, i) => ({ ...frame, uri: frame.uri.replace(/\.fits$/, "-copy" + i + ".fits"), url: frame.url.replace(/\.fits$/, "-copy" + i + ".fits") });

test("a frame whose source rejects is listed as failed and the others are measured", async () => {
  const bad = copyOf(fixtureFrame, 1);
  const { rows, report } = await runForcedPhotometry({
    frames: [bad, fixtureFrame],
    targets: [bd17],
    openSource: async (frame) => {
      if (frame.uri === bad.uri) throw new Error("boom: network down");
      return fixtureSource();
    },
  });
  assert.equal(rows.length, 1);
  assert.equal(report.frames, 2);
  assert.equal(report.measured, 1);
  assert.deepEqual(report.failed, [{ uri: bad.uri, error: "boom: network down" }]);
  assert.deepEqual(report.skipped, []);
});

test("abort stops new frames and keeps rows measured so far", async () => {
  const frames = [0, 1, 2, 3, 4].map((i) => copyOf(fixtureFrame, i));
  const controller = new AbortController();
  const progress = [];
  const { rows, report } = await runForcedPhotometry({
    frames, targets: [bd17], concurrency: 1, openSource: fixtureSource, signal: controller.signal,
    onProgress: (p) => {
      progress.push(p);
      controller.abort();
    },
  });
  assert.equal(report.cancelled, true);
  assert.ok(rows.length >= 1);
  assert.ok(progress.at(-1).done < 5, "done " + progress.at(-1).done);
  assert.equal(report.frames, 5);
  assert.equal(report.measured, rows.length);
});

test("the IMAGE header offset is remembered per data collection for remote sources, and a stale memo falls back", async () => {
  // A source that counts reads by offset; its kind is not "memory", so the memo applies.
  const counted = (bytes, log) => {
    const inner = Range.createMemorySource(bytes);
    return { kind: "test", read: (off, len) => (log.push(off), inner.read(off, len)) };
  };
  const logs = [[], []];
  const frames = [copyOf(fixtureFrame, 1), copyOf(fixtureFrame, 2)];
  const run = await runForcedPhotometry({ frames, targets: [bd17], concurrency: 1, openSource: (f) => counted(fixtureBytes, logs[frames.indexOf(f)]) });
  assert.equal(run.rows.length, 2);
  assert.deepEqual(run.rows[0], run.rows[1]);
  assert.ok(logs[0].includes(0), "the first frame reads the PRIMARY header");
  assert.ok(!logs[1].includes(0), "the second frame starts at the remembered IMAGE header");
  assert.ok(logs[1].length < logs[0].length);

  // A second frame whose PRIMARY header is one block longer: the probe at the old offset finds no IMAGE header, so the full walk runs.
  const text = new TextDecoder("latin1").decode(fixtureBytes.subarray(0, 2880));
  let endCard = -1;
  for (let i = 0; i < 36; i++) if (text.slice(i * 80, i * 80 + 8) === "END     ") endCard = i;
  assert.ok(endCard >= 0);
  const shifted = new Uint8Array(fixtureBytes.length + 2880);
  shifted.set(fixtureBytes.subarray(0, 2880));
  shifted.set(new TextEncoder().encode("COMMENT padding".padEnd(80)), endCard * 80);
  shifted.set(new TextEncoder().encode("END".padEnd(2880)), 2880);
  shifted.set(fixtureBytes.subarray(2880), 5760);
  const stale = [[], []];
  const run2 = await runForcedPhotometry({
    frames, targets: [bd17], concurrency: 1, openSource: (f) => (f === frames[0] ? counted(fixtureBytes, stale[0]) : counted(shifted, stale[1])),
  });
  assert.deepEqual(run2.report.failed, []);
  assert.equal(run2.rows.length, 2);
  assert.deepEqual(run2.rows[0], run2.rows[1]);
  assert.ok(stale[1].includes(0), "the stale memo falls back to the walk from offset 0");

  // Memory sources (local files) never use the memo.
  const mem = [[], []];
  await runForcedPhotometry({
    frames, targets: [bd17], concurrency: 1,
    openSource: (f) => {
      const s = counted(fixtureBytes, mem[frames.indexOf(f)]);
      s.kind = "memory";
      return s;
    },
  });
  assert.ok(mem[1].includes(0));
});

test("selectFrames: deep, detector and MJD filters count what they exclude", () => {
  const f = (uri, collection, detector, mjd) => ({ uri, collection, deep: collection.endsWith("_deep"), detector, mjd });
  const frames = [
    f("a", "spherex_dr1", 1, 60800),
    f("b", "spherex_dr1_deep", 1, 60800),
    f("c", "spherex_qr3", 3, 60800),
    f("d", "spherex_qr3", 2, 60700),
    f("e", "spherex_qr3", 2, 60900),
    f("f", "spherex_dr1", 2, NaN),
  ];
  const all = selectFrames(frames);
  assert.deepEqual(all.frames.map((x) => x.uri), ["a", "c", "d", "e", "f"]);
  assert.deepEqual(all.excluded, { deep: 1, detector: 0, mjd: 0 });
  const some = selectFrames(frames, { deep: true, detectors: [1, 2], mjdMin: 60750, mjdMax: 60850 });
  assert.deepEqual(some.frames.map((x) => x.uri), ["a", "b"]);
  assert.deepEqual(some.excluded, { deep: 0, detector: 1, mjd: 3 });
  const late = selectFrames(frames, { mjdMin: 60850 });
  assert.deepEqual(late.frames.map((x) => x.uri), ["e"]);
  assert.deepEqual(late.excluded, { deep: 1, detector: 0, mjd: 4 });
});

test("parseTargetsCsv: 0 rows, 21 rows, missing dec, Sersic columns, Re < 1 is a point source", () => {
  assert.deepEqual(parseTargetsCsv("ra,dec\n"), { ok: false, reason: "targets file must have 1..=20 rows (got 0)" });
  const many = "ra,dec\n" + Array.from({ length: 21 }, (_, i) => i + ",1").join("\n");
  assert.deepEqual(parseTargetsCsv(many), { ok: false, reason: "targets file must have 1..=20 rows (got 21)" });
  assert.equal(parseTargetsCsv("ra,dec\n" + Array.from({ length: 20 }, (_, i) => i + ",1").join("\n")).targets.length, 20);
  assert.deepEqual(parseTargetsCsv("ra,name\n1,a\n"), { ok: false, reason: "targets need a 'dec' column" });
  assert.deepEqual(parseTargetsCsv("dec\n1\n"), { ok: false, reason: "targets need an 'ra' column" });
  assert.deepEqual(parseTargetsCsv("ra,dec\nabc,1\n"), { ok: false, reason: "invalid float literal" });
  assert.deepEqual(parseTargetsCsv("ra,dec\n1,2\n3\n").ok, false);

  const parsed = parseTargetsCsv(
    "﻿ RA , Dec ,Name,Sersic_N,re_arcsec,axis_ratio,pa_deg\r\n" +
    "10.5,-20.25,gal,1,2.5,0.5,30\r\n" +
    "11, 21 ,pt,1,0.5,0.5,30\r\n" +
    "\r\n" +
    '12,22,"star, bright",,,,\r\n'
  );
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.targets, [
    { name: "gal", ra: 10.5, dec: -20.25, shape: { n: 1, reArcsec: 2.5, axisRatio: 0.5, paDeg: 30 } },
    { name: "pt", ra: 11, dec: 21, shape: null },
    { name: "star, bright", ra: 12, dec: 22, shape: null },
  ]);
  assert.deepEqual(parseTargetsCsv("ra,dec\n1,2\n3,4\n").targets.map((t) => t.name), ["src1", "src2"]);
  assert.deepEqual(parseTargetsCsv("ra,dec,sersic_n,re_arcsec,axis_ratio,pa_deg\n1,2,7,2,0.5,0\n"), { ok: false, reason: "Sersic index must be within 0.5..6" });

  assert.deepEqual(validateShape(1, 0.99, 0.5, 0), { ok: true, shape: null });
  assert.deepEqual(validateShape(4, 3, 1, -360), { ok: true, shape: { n: 4, reArcsec: 3, axisRatio: 1, paDeg: -360 } });
  assert.deepEqual(validateShape(0.4, 3, 1, 0), { ok: false, reason: "Sersic index must be within 0.5..6" });
  assert.deepEqual(validateShape(1, 3, 0, 0), { ok: false, reason: "axis ratio must be in (0, 1]" });
  assert.deepEqual(validateShape(1, 3, 1, 361), { ok: false, reason: "position angle must be within -360..360" });
  assert.deepEqual(validateShape(1, 20, 1, 0), { ok: false, reason: "effective radius must be < 20 arcsec" });
});

test("frameFromImportRow maps the IRSA URL to the S3 URL and reads deep from the collection", () => {
  assert.equal(S3_BASE, "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/");
  assert.equal(IRSA_PREFIX, "https://irsa.ipac.caltech.edu/ibe/data/spherex/");
  const path = "dr1/level2/2025W21_2C/l2b-v27-2026-199/1/level2_2025W21_2C_0321_1D1_spx_l2b-v27-2026-199.fits";
  assert.deepEqual(fixtureFrame, {
    uri: path, url: S3_BASE + path, obsId: "2025W21_2C_0321_1", collection: "spherex_dr1", dataCollection: "dr1", deep: false, detector: 1, mjd: 60819.418091,
  });
  // Without `collection` (rows from before Task 7) the release names it; a string href works too.
  const noCollection = frameFromImportRow({ ...fixtureImportRow, collection: undefined, product: IRSA_PREFIX + path, release: "qr3", start: null });
  assert.equal(noCollection.collection, "spherex_qr3");
  assert.equal(noCollection.dataCollection, "qr3");
  assert.equal(noCollection.url, S3_BASE + path);
  assert.ok(Number.isNaN(noCollection.mjd));
  const deep = frameFromImportRow({ ...fixtureImportRow, collection: "spherex_qr3_deep" });
  assert.equal(deep.deep, true);
  assert.equal(deep.dataCollection, "qr3");
  assert.equal(frameFromImportRow({ ...fixtureImportRow, product: new URL("https://example.org/x.fits") }), null);
  assert.equal(frameFromImportRow(null), null);
});

test("rowsToIrsaCsv round-trips the parity row; rowsToSpectrumLabCsv is read by AstroNotSpectrum without warnings", async () => {
  const [row] = await measureFrame({ source: fixtureSource(), frame: fixtureFrame, targets: [bd17], params: fullParams, cache: createCalibCache() });
  const irsa = rowsToIrsaCsv([row]).trim().split("\n");
  assert.equal(irsa[0], irsaColumns.join(","));
  const cells = irsa[1].split(",");
  irsaColumns.forEach((column, i) => {
    if (typeof row[column] === "number") assert.equal(Number(cells[i]), row[column], column);
    else assert.equal(cells[i], String(row[column]), column);
  });
  assert.equal(cells[irsaColumns.indexOf("deep_flg")], "false");
  assert.equal(cells[irsaColumns.indexOf("flags")], "4364173383");
  // NaN is written as Rust's csv writer writes it; labels with commas are quoted.
  const odd = rowsToIrsaCsv([{ ...row, label: 'a,"b"', flux: NaN }]).trim().split("\n")[1];
  assert.ok(odd.startsWith('"a,""b""",'));
  assert.ok(odd.includes(",NaN,"));

  const text = rowsToSpectrumLabCsv([row]);
  assert.ok(text.startsWith("source_id,obs_id,mjd,ra,dec,wavelength,lambda_width,flux,flux_err,flags,method,lvf_id,det_id,x_image,y_image,fit_ql,flux_bkg,data_collection\n"));
  const table = Spectrum.readTable(text);
  assert.equal(table.ok, true);
  const detected = Spectrum.detectColumns(table.headers);
  assert.equal(detected.contract, true);
  assert.deepEqual(detected.notes, []);
  const spectrum = Spectrum.buildSpectrum(table, detected.mapping, detected.units);
  assert.equal(spectrum.ok, true);
  assert.deepEqual(spectrum.bad, []);
  assert.equal(spectrum.points.length, 1);
  assert.equal(spectrum.points[0].flux, row.flux);
  assert.equal(spectrum.points[0].wavelength, row.lambda);
  assert.equal(spectrum.points[0].method, METHOD);
  assert.equal(METHOD, "forced-epsf");
  // A NaN flux is left empty (the contract reader treats empty as missing).
  const nanLine = rowsToSpectrumLabCsv([{ ...row, flux: NaN, flux_err: NaN }]).trim().split("\n")[1].split(",");
  assert.equal(nanLine[7], "");
  assert.equal(nanLine[8], "");
});

// ---- LIVE: real frames from IRSA's S3 bucket -------------------------------------------------------------------------------------

function loadBd17Frames() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const assetContext = vm.createContext({ window: {} });
  vm.runInContext(readFileSync(root + "assets/tools/spherex-bd17-frames.js", "utf8"), assetContext);
  const data = assetContext.window.spherexBd17Frames;
  const observation = vm.createContext({ URL, URLSearchParams, Date, Number, Math });
  const lib = vm.runInContext(readFileSync(root + "tools/observation-csv.js", "utf8") + "\n({ parseIrsaResults });", observation);
  return data.files.flatMap((file) => {
    const parsed = lib.parseIrsaResults(file.text);
    assert.ok(parsed.ok, file.name);
    return parsed.rows.map((row) => frameFromImportRow(row));
  });
}

const irsaFor = (row) => irsaRows.find((r) => Number(r.lvf_id) === row.lvf_id && Number(r.det_id) === row.det_id);

test("LIVE: first 6 BD+17 frames from S3 match the oracle rows and IRSA's rows", { skip: !process.env.ASTRONOT_LIVE, timeout: 300000 }, async (t) => {
  const frames = loadBd17Frames().slice(0, 6);
  assert.equal(frames.length, 6);
  const { rows, report } = await runForcedPhotometry({ frames, targets: [bd17], concurrency: 6 });
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.skipped, []);
  assert.equal(rows.length, 6);
  const worst = {};
  for (const row of rows) {
    const diffs = assertParity(row, oracleFor(row.lvf_id, row.det_id));
    for (const [k, v] of Object.entries(diffs)) worst[k] = Math.max(worst[k] ?? 0, v);
    const irsa = irsaFor(row);
    assert.ok(irsa, "IRSA row for lvf_id " + row.lvf_id);
    const ratio = row.flux / Number(irsa.flux);
    assert.ok(ratio > 0.98 && ratio < 1.02, "flux ratio " + ratio);
    assert.equal(row.flags, Number(irsa.flags));
    assert.ok(Math.abs(row.x_image - Number(irsa.x_image)) < 1e-3 && Math.abs(row.y_image - Number(irsa.y_image)) < 1e-3);
  }
  t.diagnostic("max relative difference per column vs spxphot: " + JSON.stringify(worst));
  t.diagnostic("report: " + JSON.stringify({ ...report, rows: rows.length }));
});

test("LIVE FULL: all 352 frames, median flux ratio vs IRSA within 0.995–1.005", { skip: !process.env.ASTRONOT_LIVE_FULL, timeout: 900000 }, async (t) => {
  const frames = loadBd17Frames();
  assert.equal(frames.length, 352);
  const { rows, report } = await runForcedPhotometry({ frames, targets: [bd17], concurrency: 6 });
  assert.deepEqual(report.failed, []);
  assert.equal(rows.length, 352);
  const ratios = rows.map((row) => row.flux / Number(irsaFor(row).flux)).sort((a, b) => a - b);
  const median = 0.5 * (ratios[175] + ratios[176]);
  assert.ok(median > 0.995 && median < 1.005, "median flux ratio " + median);
  for (const row of rows) assertParity(row, oracleFor(row.lvf_id, row.det_id));
  t.diagnostic("median flux ratio " + median + "; " + report.epsfDownloads + " ePSF downloads; " + report.seconds + " s");
});
