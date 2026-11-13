// Run with:  node --test tests/        (or: node tests/difference.test.mjs)
//
// Covers tools/difference.js, the computation behind Image Differencing (and the input of Motion Detector): the direction
// of the subtraction, units, variance propagation, grid verification, bilinear reprojection, invalid pixels, the optional
// background offset, the display helpers and the FITS export.
//   - Sections that build headers and arrays in this file are synthetic fixtures, not archive data. In particular the
//     arrays [4, 8, 10, NaN] and [7, 6, 10, 5] exist only for these automatic checks.
//   - The "real pair" section uses assets/tools/spherex-time-machine-example.js: two IRSA SPHEREx QR2 cutouts of one field
//     (2025W21_2C_0280_1 and 2025W24_1A_0514_1, detector 2) on different dates.
//   - When Python with astropy and reproject is available (set ASTRONOT_PYTHON), the reprojection is compared with
//     reproject_interp(order='bilinear') on the real pair; otherwise those checks are reported as skipped.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const Wcs = require("../tools/wcs.js");
const Pair = require("../tools/pair.js");
const Diff = require("../tools/difference.js");

const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, (message ?? "") + " expected " + expected + " got " + actual);
const same = (actual, expected, message) => {
  assert.equal(actual.length, expected.length, message);
  for (let index = 0; index < expected.length; index++) {
    if (Number.isNaN(expected[index])) assert.ok(Number.isNaN(actual[index]), (message ?? "") + " index " + index + " should be NaN, is " + actual[index]);
    else assert.equal(actual[index], expected[index], (message ?? "") + " index " + index);
  }
};

// ---- Synthetic fixtures -------------------------------------------------------------------------------------------------
function tanFields({ ra = 150, dec = 2, crpix = [10.5, 10.5], scale = 6 / 3600, rotate = 0, extra = {} } = {}) {
  const c = Math.cos(rotate * Math.PI / 180);
  const s = Math.sin(rotate * Math.PI / 180);
  return {
    CTYPE1: "RA---TAN", CTYPE2: "DEC--TAN", CRVAL1: ra, CRVAL2: dec, CRPIX1: crpix[0], CRPIX2: crpix[1],
    CD1_1: -scale * c, CD1_2: scale * s, CD2_1: scale * s, CD2_2: scale * c, RADESYS: "ICRS", ...extra,
  };
}

// An image on a given WCS. `values` is a function (x, y) of FITS pixel coordinates or an array.
function image(name, { width = 20, height = 20, wcsFields = tanFields(), values = () => 0, unit = "MJy / sr", variance, varianceUnit, obsId = name, time = "2025-05-24T04:24:53.232", mask } = {}) {
  const fields = { BUNIT: unit, OBSID: obsId, DETECTOR: 2, "DATE-OBS": time, TIMESYS: "UTC", RADESYS: "ICRS", ...wcsFields };
  const hdu = { fields, axes: [width, height], name: "IMAGE" };
  const array = typeof values === "function" ? Float64Array.from({ length: width * height }, (_, i) => values((i % width) + 1, Math.floor(i / width) + 1)) : Float64Array.from(values);
  const created = Wcs.createWcs(wcsFields);
  const toArray = (v) => v === undefined ? undefined : typeof v === "function" ? Float64Array.from({ length: width * height }, (_, i) => v((i % width) + 1, Math.floor(i / width) + 1)) : v instanceof Float64Array ? v : Float64Array.from(v);
  return {
    name, meta: Pair.describeObservation(hdu, 1), width, height, values: array, unit, fields,
    wcs: created.ok ? created.wcs : null, wcsReason: created.ok ? "" : created.reason,
    variance: toArray(variance), varianceUnit, mask,
  };
}

const must = (outcome) => {
  assert.equal(outcome.ok, true, outcome.reason);
  return outcome.result;
};

// ---- Acceptance arrays ------------------------------------------------------------------------------------------------
test("direction: delta = target - reference, with NaN kept invalid and zero kept valid", () => {
  const wcsFields = tanFields({ crpix: [2.5, 0.5] });
  const reference = image("ref", { width: 4, height: 1, wcsFields, values: [4, 8, 10, NaN] });
  const target = image("tgt", { width: 4, height: 1, wcsFields, values: [7, 6, 10, 5] });
  const result = must(Diff.computeDifference(reference, target));
  same(result.difference, [3, -2, 0, NaN]);
  assert.deepEqual([...result.valid], [1, 1, 1, 0]);
  assert.equal(result.mode, "pixel-difference");
  assert.equal(result.label, "Δ = target − reference");
  assert.equal(result.sign, "target-minus-reference");
  assert.equal(result.resampling, null);
  assert.equal(result.counts.valid, 3);
  assert.equal(result.counts.referenceInvalid, 1);
  assert.deepEqual([...result.status], [0, 0, 0, 2]);
  // The zero pixel is a real zero, not an invalid pixel.
  assert.equal(Diff.pixelAt(result, 2, 0).difference, 0);
  assert.equal(Diff.pixelAt(result, 2, 0).valid, true);
  assert.equal(Diff.pixelAt(result, 3, 0).difference, null);
  assert.equal(Diff.pixelAt(result, 3, 0).reason, "Reference pixel is NaN, BLANK or masked");
});

test("direction: swapping the roles flips the sign, and the reference NaN becomes a valid pair only when both exist", () => {
  const wcsFields = tanFields({ crpix: [2.5, 0.5] });
  const a = image("a", { width: 4, height: 1, wcsFields, values: [4, 8, 10, NaN] });
  const b = image("b", { width: 4, height: 1, wcsFields, values: [7, 6, 10, 5] });
  same(must(Diff.computeDifference(b, a)).difference, [-3, 2, 0, NaN]);
});

test("the result keeps reference, target, units, observation IDs and the WCS for Motion Detector", () => {
  const wcsFields = tanFields({ crpix: [2.5, 0.5] });
  const reference = image("ref", { width: 4, height: 1, wcsFields, values: [4, 8, 10, NaN], obsId: "REF-1", time: "2025-05-24T04:24:53" });
  const target = image("tgt", { width: 4, height: 1, wcsFields, values: [7, 6, 10, 5], obsId: "TGT-1", time: "2025-06-11T14:21:56" });
  const r = must(Diff.computeDifference(reference, target));
  assert.equal(r.kind, "image-difference");
  assert.equal(r.reference.obsId, "REF-1");
  assert.equal(r.target.obsId, "TGT-1");
  assert.equal(r.reference.time.display, "2025-05-24 04:24:53");
  assert.equal(r.target.time.display, "2025-06-11 14:21:56");
  assert.equal(r.unit, "MJy / sr");
  assert.equal(r.width, 4);
  assert.equal(r.height, 1);
  assert.equal(r.wcs, reference.wcs);
  same(r.reference.values, [4, 8, 10, NaN]);
  same(r.target.values, [7, 6, 10, 5]);
  assert.ok(r.overlap instanceof Uint8Array && r.overlap.every((v) => v === 1));
  assert.deepEqual([...r.reference.valid], [1, 1, 1, 0]);
  assert.deepEqual([...r.target.valid], [1, 1, 1, 1]);
  assert.equal(r.variance, null);
  assert.equal(r.snr, null);
  assert.equal(r.psf.matched, false);
  assert.equal(r.background.method, "none");
  assert.match(r.interpretation, /Pixel difference/);
});

// ---- Variance ------------------------------------------------------------------------------------------------------------
test("variance: 4 + 9 = 13 for independent errors on one grid, and the SNR follows", () => {
  const wcsFields = tanFields({ crpix: [2.5, 0.5] });
  const reference = image("ref", { width: 4, height: 1, wcsFields, values: [4, 8, 10, NaN], variance: [4, 4, 4, 4] });
  const target = image("tgt", { width: 4, height: 1, wcsFields, values: [7, 6, 10, 5], variance: [9, 9, 9, 9] });
  const r = must(Diff.computeDifference(reference, target));
  same(r.variance, [13, 13, 13, NaN]);
  near(r.snr[0], 3 / Math.sqrt(13), 1e-12);
  near(r.snr[1], -2 / Math.sqrt(13), 1e-12);
  assert.equal(r.snr[2], 0);
  assert.ok(Number.isNaN(r.snr[3]));
  assert.match(r.varianceNote, /Var\(Δ\) = Var\(target\) \+ Var\(reference\)/);
});

test("variance: missing in either image leaves variance and SNR empty while the difference stays", () => {
  const wcsFields = tanFields({ crpix: [2.5, 0.5] });
  const reference = image("ref", { width: 4, height: 1, wcsFields, values: [4, 8, 10, 1], variance: [4, 4, 4, 4] });
  const target = image("tgt", { width: 4, height: 1, wcsFields, values: [7, 6, 10, 5] });
  const r = must(Diff.computeDifference(reference, target));
  assert.equal(r.variance, null);
  assert.equal(r.snr, null);
  assert.deepEqual([...r.valid], [1, 1, 1, 1]);
  assert.match(r.varianceNote, /Only the reference has a variance array/);
});

test("variance: unknown pixel variance gives an empty SNR at that pixel only, and a non-square unit rejects the variance", () => {
  const wcsFields = tanFields({ crpix: [2.5, 0.5] });
  const reference = image("ref", { width: 4, height: 1, wcsFields, values: [4, 8, 10, 1], variance: [4, NaN, 4, 4], varianceUnit: "(MJy / sr)^2" });
  const target = image("tgt", { width: 4, height: 1, wcsFields, values: [7, 6, 10, 5], variance: [9, 9, 9, 9], varianceUnit: "(MJy / sr)**2" });
  const r = must(Diff.computeDifference(reference, target));
  assert.equal(r.variance[0], 13);
  assert.ok(Number.isNaN(r.variance[1]));
  assert.ok(Number.isNaN(r.snr[1]));
  assert.equal(r.valid[1], 1); // The difference is still shown where the variance is unknown.
  assert.equal(r.difference[1], -2);
  const wrong = image("tgt", { width: 4, height: 1, wcsFields, values: [7, 6, 10, 5], variance: [9, 9, 9, 9], varianceUnit: "MJy / sr" });
  const rejected = must(Diff.computeDifference(reference, wrong));
  assert.equal(rejected.variance, null);
  assert.match(rejected.varianceNote, /not the square/);
});

// ---- Units ---------------------------------------------------------------------------------------------------------------
test("units: identical units pass, Jy prefixes are converted, the rest is refused with the reason", () => {
  assert.equal(Diff.unitConversion("MJy / sr", "MJy/sr").factor, 1);
  assert.equal(Diff.unitConversion("MJy / sr", "MJy/sr").state, "same");
  near(Diff.unitConversion("kJy/sr", "MJy/sr").factor, 1e-3, 1e-15);
  near(Diff.unitConversion("MJy/sr", "Jy/sr").factor, 1e6, 1e-6);
  near(Diff.unitConversion("mJy/sr", "MJy/sr").factor, 1e-9, 1e-24); // case is kept: mJy is not MJy
  assert.equal(Diff.unitConversion("DN", "MJy/sr").ok, false);
  assert.match(Diff.unitConversion("DN", "MJy/sr").reason, /different units|Only identical units/);
  assert.equal(Diff.unitConversion("MJy/sr", "MJy/arcsec^2").ok, false); // Different denominator.
  assert.equal(Diff.unitConversion(undefined, "MJy/sr").state, "unknown");
  assert.equal(Diff.unitConversion("DN", "DN").ok, true);
});

test("units: a unit mismatch or a missing BUNIT is refused, and the conversion scales values and variance", () => {
  const wcsFields = tanFields({ crpix: [2.5, 0.5] });
  const reference = image("ref", { width: 4, height: 1, wcsFields, values: [4, 8, 10, 1], unit: "MJy / sr" });
  const dn = image("dn", { width: 4, height: 1, wcsFields, values: [7, 6, 10, 5], unit: "DN" });
  const refused = Diff.computeDifference(reference, dn);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "unit-mismatch");
  assert.match(refused.reason, /DN/);

  const missing = image("none", { width: 4, height: 1, wcsFields, values: [7, 6, 10, 5], unit: "" });
  missing.unit = undefined;
  const noUnit = Diff.computeDifference(reference, missing);
  assert.equal(noUnit.code, "unit-missing");
  const forced = Diff.computeDifference(reference, missing, { assumeSameUnit: true });
  const forcedResult = must(forced);
  assert.equal(forcedResult.unitCheck.state, "assumed");
  assert.ok(forcedResult.warnings.some((text) => /ASSUMED/.test(text)));

  const kilo = image("kilo", { width: 4, height: 1, wcsFields, values: [7000, 6000, 10000, 5000], unit: "kJy/sr", variance: [9e6, 9e6, 9e6, 9e6] });
  const base = image("base", { width: 4, height: 1, wcsFields, values: [4, 8, 10, 1], unit: "MJy/sr", variance: [4, 4, 4, 4] });
  const scaled = must(Diff.computeDifference(base, kilo));
  same(scaled.difference, [3, -2, 0, 4]); // 7000 kJy/sr = 7 MJy/sr
  assert.equal(scaled.unit, "MJy/sr");
  assert.equal(scaled.target.originalUnit, "kJy/sr");
  near(scaled.variance[0], 4 + 9, 1e-9);
  assert.equal(scaled.unitCheck.state, "scaled");
});

// ---- Grids, WCS, reprojection ------------------------------------------------------------------------------------------------
test("grid: equal sizes are not enough, so a half-pixel offset is reprojected or refused, never subtracted as it is", () => {
  const reference = image("ref", { values: (x) => x });
  const shifted = image("shift", { wcsFields: tanFields({ crpix: [10.5 + 0.5, 10.5] }), values: (x) => x + 0.5 });
  const refused = Diff.computeDifference(reference, shifted, { alignment: "require-same-grid" });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "grid-differs");
  assert.match(refused.reason, /0\.5 pixels/);
  const r = must(Diff.computeDifference(reference, shifted));
  assert.equal(r.mode, "reprojected-difference");
  assert.equal(r.resampling.method, "bilinear");
  near(r.resampling.gridOffsetBeforePixels, 0.5, 1e-6);
  assert.match(r.summary, /reprojected/);
  // A ramp interpolates exactly: target pixel x' = x + 0.5 holds x' + 0.5 ... so the reprojected value is x + 1 and delta = 1.
  const middle = Diff.pixelAt(r, 9, 9);
  near(middle.difference, 1, 1e-6);
  assert.ok(r.warnings.some((text) => /bilinear interpolation/.test(text)));
});

test("grid: one verified grid is subtracted directly and labeled a pixel difference", () => {
  const reference = image("ref", { values: (x, y) => x + y });
  const target = image("tgt", { values: (x, y) => x + y + 2, wcsFields: tanFields({ crpix: [10.5 + 0.004, 10.5] }) });
  const r = must(Diff.computeDifference(reference, target));
  assert.equal(r.mode, "pixel-difference");
  assert.equal(r.resampling, null);
  assert.ok(r.difference.every((v) => v === 2));
  assert.match(r.summary, /Pixel difference on one verified pixel grid/);
});

test("grid: a missing WCS is refused even when both arrays have the same size", () => {
  const reference = image("ref");
  const target = image("tgt", { wcsFields: { CTYPE1: "GLON-CAR" }, values: () => 1 });
  const outcome = Diff.computeDifference(reference, target);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "no-wcs");
  assert.match(outcome.reason, /Equal array sizes alone/);
});

test("grid: images that do not overlap on the sky are refused", () => {
  const reference = image("ref", { values: () => 1 });
  const far = image("far", { wcsFields: tanFields({ ra: 150.5 }), values: () => 2 });
  const outcome = Diff.computeDifference(reference, far);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "no-overlap");
});

test("overlap: a whole-pixel shift gives an exact copy, a partial footprint and the right counts", () => {
  const reference = image("ref", { values: () => 100 });
  // Target pixel x' = x + 5 for the same sky position: reference columns 1..15 are covered.
  const target = image("tgt", { wcsFields: tanFields({ crpix: [10.5 + 5, 10.5] }), values: (x, y) => 10 * x + y });
  const r = must(Diff.computeDifference(reference, target));
  assert.equal(r.mode, "reprojected-difference");
  assert.equal(r.counts.covered, 15 * 20);
  assert.equal(r.counts.valid, 15 * 20);
  assert.equal(r.counts.outside, 5 * 20);
  for (const [x, y] of [[1, 1], [8, 12], [15, 20]]) {
    const pixel = Diff.pixelAt(r, x - 1, y - 1);
    assert.equal(pixel.target, 10 * (x + 5) + y);
    near(pixel.difference, 10 * (x + 5) + y - 100, 1e-6);
  }
  const edge = Diff.pixelAt(r, 15, 0);
  assert.equal(edge.valid, false);
  assert.equal(edge.reason, "Outside the area covered by the target");
  assert.equal(r.overlap[15], 0);
  assert.equal(r.overlap[14], 1);
});

test("overlap: a half-pixel shift uses all four neighbours and ends one pixel centre before the target edge", () => {
  const reference = image("ref", { values: () => 0 });
  const target = image("tgt", { wcsFields: tanFields({ crpix: [10.5 + 0.5, 10.5] }), values: (x, y) => 2 * x + 3 * y });
  const r = must(Diff.computeDifference(reference, target));
  assert.equal(r.counts.valid, 19 * 20); // x' = x + 0.5 must be at most 20.
  near(Diff.pixelAt(r, 4, 6).difference, 2 * (5.5) + 3 * 7, 1e-6);
});

test("overlap: a NaN target pixel invalidates its interpolation stencil, but not neighbours with zero weight", () => {
  const nan = (x, y) => x === 10 && y === 10 ? NaN : 1;
  const reference = image("ref", { values: () => 0 });
  const half = must(Diff.computeDifference(reference, image("tgt", { wcsFields: tanFields({ crpix: [10.5 + 0.5, 10.5 + 0.5] }), values: nan })));
  // Output pixels whose stencil includes target pixel (10, 10): output (9,9), (10,9), (9,10), (10,10) with x' = x + 0.5.
  assert.equal(half.counts.targetInvalid, 4);
  const whole = must(Diff.computeDifference(reference, image("tgt", { wcsFields: tanFields({ crpix: [10.5 + 1, 10.5] }), values: nan })));
  assert.equal(whole.counts.targetInvalid, 1); // Weights 1 and 0 only: just the output pixel sitting on the NaN.
  assert.equal(Diff.pixelAt(whole, 8, 9).reason, "Target pixel is NaN, BLANK or masked");
});

test("rotation: a 30 degree rotated target is reprojected onto the reference grid, and a rotated grid is not 'one grid'", () => {
  const reference = image("ref", { width: 40, height: 40, wcsFields: tanFields({ crpix: [20.5, 20.5] }), values: () => 0 });
  const sky = Wcs.createWcs(tanFields({ crpix: [20.5, 20.5] })).wcs;
  const plane = (ra, dec) => 1000 + 5000 * (ra - 150) * Math.cos(2 * Math.PI / 180) + 7000 * (dec - 2); // linear in the sky
  const rotated = image("rot", { width: 40, height: 40, wcsFields: tanFields({ crpix: [20.5, 20.5], rotate: 30 }), values: () => 0 });
  rotated.values = Float64Array.from({ length: 1600 }, (_, i) => {
    const at = rotated.wcs.pixelToSky((i % 40) + 1, Math.floor(i / 40) + 1);
    return plane(at.ra, at.dec);
  });
  reference.values = Float64Array.from({ length: 1600 }, (_, i) => {
    const at = sky.pixelToSky((i % 40) + 1, Math.floor(i / 40) + 1);
    return plane(at.ra, at.dec);
  });
  assert.equal(Diff.computeDifference(reference, rotated, { alignment: "require-same-grid" }).code, "grid-differs");
  const r = must(Diff.computeDifference(reference, rotated));
  assert.equal(r.mode, "reprojected-difference");
  assert.ok(r.counts.valid > 0.7 * 1600 && r.counts.valid < 1600, "valid pixels " + r.counts.valid);
  let worst = 0;
  for (let index = 0; index < 1600; index++) if (r.valid[index]) worst = Math.max(worst, Math.abs(r.difference[index]));
  assert.ok(worst < 1e-3, "largest residual " + worst); // The planar field is reproduced by bilinear interpolation.
  // The corners of the reference lie outside the rotated image.
  assert.equal(r.valid[0], 0);
  assert.equal(r.status[0], 1);
});

test("scale: a target with much finer pixels is refused instead of aliased, a coarser one is reprojected with a warning", () => {
  const reference = image("ref", { values: () => 0 });
  const fine = image("fine", { width: 60, height: 60, wcsFields: tanFields({ crpix: [30.5, 30.5], scale: 2 / 3600 }), values: () => 1 });
  const refused = Diff.computeDifference(reference, fine);
  assert.equal(refused.code, "target-finer");
  assert.match(refused.reason, /alias/);
  const coarse = image("coarse", { width: 10, height: 10, wcsFields: tanFields({ crpix: [5.5, 5.5], scale: 12 / 3600 }), values: () => 1 });
  const r = must(Diff.computeDifference(reference, coarse));
  assert.ok(r.warnings.some((text) => /larger than the reference pixels/.test(text)));
});

// ---- Empty and invalid results -----------------------------------------------------------------------------------------------
test("empty overlap mask: the result says so and keeps every pixel invalid", () => {
  const reference = image("ref", { values: () => NaN });
  const target = image("tgt", { values: () => 5 });
  const r = must(Diff.computeDifference(reference, target));
  assert.equal(r.empty, true);
  assert.match(r.emptyReason, /NaN, BLANK or masked/);
  assert.equal(r.counts.valid, 0);
  assert.ok(r.difference.every(Number.isNaN));
  assert.equal(Diff.symmetricLimit(r.difference, r.valid), null);
});

test("masked pixels stay out of the result without being treated as NaN values", () => {
  const wcsFields = tanFields({ crpix: [2.5, 0.5] });
  const reference = image("ref", { width: 4, height: 1, wcsFields, values: [1, 2, 3, 4], mask: Uint8Array.from([0, 1, 0, 0]) });
  const target = image("tgt", { width: 4, height: 1, wcsFields, values: [2, 3, 4, 5], mask: Uint8Array.from([0, 0, 0, 1]) });
  const r = must(Diff.computeDifference(reference, target));
  assert.deepEqual([...r.valid], [1, 0, 1, 0]);
  assert.deepEqual([...r.status], [0, 2, 0, 3]);
  same(r.difference, [1, NaN, 1, NaN]);
});

test("the same pixel data twice, or an array that does not match its size, is refused", () => {
  const a = image("a", { values: (x, y) => x * y });
  const b = image("b", { values: (x, y) => x * y });
  assert.equal(Diff.computeDifference(a, b).code, "duplicate");
  const broken = image("c", { values: (x) => x });
  broken.values = new Float64Array(5);
  assert.equal(Diff.computeDifference(a, broken).code, "bad-array");
});

test("background: nothing is removed by default, and a median offset is applied, reported and optional", () => {
  const reference = image("ref", { values: (x, y) => (x * 7 + y * 13) % 11 });
  const target = image("tgt", { values: (x, y) => ((x * 7 + y * 13) % 11) + 5 + (x === 3 && y === 3 ? 400 : 0) });
  const plain = must(Diff.computeDifference(reference, target));
  assert.equal(plain.background.method, "none");
  assert.equal(Diff.pixelAt(plain, 0, 0).difference, 5);
  const corrected = must(Diff.computeDifference(reference, target, { background: "median" }));
  assert.equal(corrected.background.method, "median");
  assert.equal(corrected.background.value, 5);
  assert.equal(corrected.background.pixels, 400);
  assert.equal(Diff.pixelAt(corrected, 0, 0).difference, 0);
  assert.equal(Diff.pixelAt(corrected, 2, 2).difference, 400); // A real source survives a median offset.
  assert.ok(corrected.warnings.some((text) => /global median offset of 5/.test(text)));
  assert.match(corrected.interpretation, /^Pixel difference/);
  assert.doesNotMatch(corrected.interpretation, /No PSF matching or background/);
  assert.equal(corrected.psf.matched, false);
});

// ---- Display helpers do not touch the computation --------------------------------------------------------------------------------
test("display: the diverging scale is symmetric around a neutral zero, and contrast never changes the numbers", () => {
  const zero = Diff.divergingColor(0);
  assert.deepEqual(zero, [247, 247, 247]);
  const negative = Diff.divergingColor(-1);
  const positive = Diff.divergingColor(1);
  assert.ok(negative[2] > negative[0], "negative end is blue");
  assert.ok(positive[0] > positive[2], "positive end is red");
  assert.deepEqual(Diff.divergingColor(5), positive); // Clipped, not wrapped.
  assert.deepEqual(Diff.divergingColor(-5), negative);
  // Moving away from zero darkens/saturates on both sides at the same rate.
  for (const t of [0.25, 0.5, 0.75]) {
    const lo = Diff.divergingColor(-t);
    const hi = Diff.divergingColor(t);
    assert.ok(lo[0] < zero[0] && hi[2] < zero[2]);
  }
  const wcsFields = tanFields({ crpix: [2.5, 0.5] });
  const reference = image("ref", { width: 4, height: 1, wcsFields, values: [4, 8, 10, NaN] });
  const target = image("tgt", { width: 4, height: 1, wcsFields, values: [7, 6, 10, 5] });
  const before = must(Diff.computeDifference(reference, target));
  const copy = Float64Array.from(before.difference);
  for (const percentile of [50, 90, 99, 100]) Diff.symmetricLimit(before.difference, before.valid, percentile);
  for (let t = -1; t <= 1; t += 0.1) Diff.divergingColor(t);
  same(before.difference, copy);
  near(Diff.symmetricLimit(before.difference, before.valid, 100), 3, 0);
  near(Diff.symmetricLimit(before.difference, before.valid, 50), 2, 0);
});

// ---- FITS export ------------------------------------------------------------------------------------------------------------
const fitsSandbox = vm.createContext({ TextDecoder, document: { querySelector: () => null }, atob, Uint8Array });
const fitsLib = vm.runInContext(readFileSync(join(root, "tools/fits.js"), "utf8") + "\n({ readFitsHdus, fitsPixelReader });", fitsSandbox);

async function readBack(bytes) {
  const file = new File([bytes], "difference.fits");
  const hdus = await fitsLib.readFitsHdus(file);
  const out = {};
  for (const hdu of hdus) {
    if (!hdu.image) continue;
    const buffer = await file.slice(hdu.dataStart, hdu.dataStart + hdu.byteLength).arrayBuffer();
    const read = fitsLib.fitsPixelReader(buffer, hdu);
    out[hdu.name] = { hdu, values: Float64Array.from({ length: hdu.pixels }, (_, i) => read(i)) };
  }
  return { hdus, images: out };
}

test("export: the FITS file keeps direction, unit, mask, variance, observation IDs and the reference WCS", async () => {
  const wcsFields = tanFields({ crpix: [2.5, 0.5], extra: { LONPOLE: 180 } });
  const reference = image("ref", { width: 4, height: 1, wcsFields, values: [4, 8, 10, NaN], variance: [4, 4, 4, 4], obsId: "REF-1" });
  const target = image("tgt", { width: 4, height: 1, wcsFields, values: [7, 6, 10, 5], variance: [9, 9, 9, 9], obsId: "TGT-1" });
  const r = must(Diff.computeDifference(reference, target));
  const bytes = Diff.buildDifferenceFits(r);
  assert.equal(bytes.length % 2880, 0);
  const { hdus, images } = await readBack(bytes);
  assert.deepEqual(Array.from(hdus, (hdu) => hdu.name), ["Primary", "DIFFERENCE", "MASK", "VARIANCE"]);
  const difference = images.DIFFERENCE;
  same(difference.values, [3, -2, 0, NaN]);
  assert.equal(difference.hdu.fields.BUNIT, "MJy / sr");
  assert.equal(difference.hdu.fields.DIFFDIR, "TARGET-REFERENCE");
  assert.equal(difference.hdu.fields.DIFFMODE, "PIXEL-DIFF");
  assert.equal(difference.hdu.fields.REFOBS, "REF-1");
  assert.equal(difference.hdu.fields.TGTOBS, "TGT-1");
  assert.deepEqual([...images.MASK.values], [0, 0, 0, 1]);
  same(images.VARIANCE.values, [13, 13, 13, NaN]);
  assert.equal(images.VARIANCE.hdu.fields.BUNIT, "(MJy / sr)^2");
  const exported = Wcs.createWcs(difference.hdu.fields);
  assert.equal(exported.ok, true);
  for (const [x, y] of [[1, 1], [3.5, 1], [4.5, 0.5]]) {
    const a = reference.wcs.pixelToSky(x, y);
    const b = exported.wcs.pixelToSky(x, y);
    assert.ok(Wcs.angularSeparation(a.ra, a.dec, b.ra, b.dec) < 1e-12);
  }
  assert.ok(difference.hdu.cards.some((card) => card.startsWith("HISTORY") && /target - reference/.test(card)));
});

test("export: a reprojected result says so, and an unavailable observation ID stays unavailable", async () => {
  const reference = image("ref", { values: () => 1 });
  reference.meta.obsId = null;
  const target = image("tgt", { wcsFields: tanFields({ crpix: [11, 10.5] }), values: () => 3 });
  const r = must(Diff.computeDifference(reference, target));
  const { images } = await readBack(Diff.buildDifferenceFits(r));
  assert.equal(images.DIFFERENCE.hdu.fields.DIFFMODE, "BILINEAR-REPROJ");
  assert.equal(images.DIFFERENCE.hdu.fields.REFOBS, "unavailable");
  assert.equal(images.MASK.values.filter((v) => v === 1).length, r.counts.total - r.counts.valid);
  assert.ok(!images.VARIANCE);
});

// ---- Real pair -------------------------------------------------------------------------------------------------------------------
const exampleSource = readFileSync(join(root, "assets/tools/spherex-time-machine-example.js"), "utf8");
const realEncoded = vm.runInNewContext(exampleSource + "\nspherexTimeMachineExample;");

async function loadReal(encoded, name) {
  const bytes = Buffer.from(encoded, "base64");
  const file = new File([bytes], name);
  const hdus = await fitsLib.readFitsHdus(file);
  const index = hdus.findIndex((hdu) => hdu.fields.EXTNAME === "IMAGE");
  const hdu = hdus[index];
  const data = await file.slice(hdu.dataStart, hdu.dataStart + hdu.byteLength).arrayBuffer();
  const read = fitsLib.fitsPixelReader(data, hdu);
  const values = Float64Array.from({ length: hdu.pixels }, (_, i) => read(i));
  const table = hdus.find((entry) => entry.fields.EXTNAME === "WCS-WAVE");
  const parsed = Pair.parseWaveTable(await file.slice(table.dataStart, table.dataStart + table.byteLength).arrayBuffer(), table.fields, hdu.fields);
  const wavelength = Pair.wavelengthSummary(parsed, hdu.fields, hdu.axes[0], hdu.axes[1]);
  const created = Wcs.createWcs(hdu.fields);
  return { name, bytes, meta: Pair.describeObservation(hdu, index, { wavelength }), width: hdu.axes[0], height: hdu.axes[1], values, wcs: created.wcs, unit: hdu.fields.BUNIT, fields: hdu.fields };
}

const realReference = await loadReal(realEncoded.reference, "reference.fits");
const realTarget = await loadReal(realEncoded.comparison, "target.fits");

test("real pair: target (later) minus reference, reprojected, with the observation IDs and a zero-centred scale", () => {
  const r = must(Diff.computeDifference(realReference, realTarget));
  assert.equal(r.reference.obsId, "2025W21_2C_0280_1");
  assert.equal(r.target.obsId, "2025W24_1A_0514_1");
  assert.equal(r.reference.time.display, "2025-05-24 04:24:53");
  assert.equal(r.target.time.display, "2025-06-11 14:21:56");
  assert.equal(r.unit, "MJy / sr");
  assert.equal(r.mode, "reprojected-difference");
  near(r.resampling.gridOffsetBeforePixels, 0.488, 0.01);
  near(r.resampling.referencePixelScaleArcsec, 6.14, 0.01);
  assert.deepEqual({ valid: r.counts.valid, outside: r.counts.outside, referenceInvalid: r.counts.referenceInvalid, targetInvalid: r.counts.targetInvalid, covered: r.counts.covered }, { valid: 4760, outside: 139, referenceInvalid: 1, targetInvalid: 0, covered: 4761 });
  assert.equal(r.variance, null); // The cutouts have no variance HDU.
  assert.equal(r.snr, null);
  assert.match(r.varianceNote, /Neither image has a variance array/);
  // Spot checks against a hand computation: sky position -> target pixel -> four neighbours.
  for (const [column, row] of [[34, 34], [10, 50], [60, 5]]) {
    const sky = realReference.wcs.pixelToSky(column + 1, row + 1);
    const at = realTarget.wcs.skyToPixel(sky.ra, sky.dec);
    const [i, j] = [Math.floor(at.x), Math.floor(at.y)];
    const [fx, fy] = [at.x - i, at.y - j];
    const v = (x, y) => realTarget.values[(y - 1) * 70 + (x - 1)];
    const hand = (1 - fx) * (1 - fy) * v(i, j) + fx * (1 - fy) * v(i + 1, j) + (1 - fx) * fy * v(i, j + 1) + fx * fy * v(i + 1, j + 1);
    const pixel = Diff.pixelAt(r, column, row);
    near(pixel.target, hand, 1e-9 * Math.abs(hand));
    near(pixel.difference, hand - realReference.values[row * 70 + column], 1e-9 * Math.max(1, Math.abs(hand)));
  }
  // The scale limit is a display value derived from Δ and is symmetric.
  const limit = Diff.symmetricLimit(r.difference, r.valid, 99);
  assert.ok(limit > 0);
  near(Diff.divergingColor(0)[0], 247, 0);
  // Swapping the roles reverses the label's meaning: the reference is now the June image.
  const swapped = must(Diff.computeDifference(realTarget, realReference));
  assert.equal(swapped.reference.obsId, "2025W24_1A_0514_1");
  assert.equal(swapped.target.obsId, "2025W21_2C_0280_1");
});

test("real pair: demanding one grid is refused with the measured offset, and the same file twice is refused", () => {
  const refused = Diff.computeDifference(realReference, realTarget, { alignment: "require-same-grid" });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "grid-differs");
  assert.match(refused.reason, /0\.4\d+ pixels/);
  assert.equal(Diff.computeDifference(realReference, Object.assign({}, realReference, { name: "copy.fits" })).code, "duplicate");
});

// ---- Cross-check with reproject (optional) ----------------------------------------------------------------------------------------
function runReference(request) {
  const python = process.env.ASTRONOT_PYTHON ?? "python";
  const result = spawnSync(python, ["-I", join(root, "tests/difference-reference.py")], { input: JSON.stringify(request), encoding: "utf8", maxBuffer: 1 << 28 });
  if (result.error || result.status !== 0) return { unavailable: (result.error?.message ?? result.stderr ?? "").trim().split("\n").pop() };
  return JSON.parse(result.stdout);
}

const scratch = mkdtempSync(join(tmpdir(), "astronot-diff-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
writeFileSync(join(scratch, "reference.fits"), realReference.bytes);
writeFileSync(join(scratch, "target.fits"), realTarget.bytes);
const probe = runReference({ reproject: { reference: join(scratch, "reference.fits"), target: join(scratch, "target.fits") } });
const skipReproject = probe.unavailable ? "astropy or reproject is not available (" + probe.unavailable + "). Set ASTRONOT_PYTHON to a Python with astropy and reproject." : false;
if (!probe.unavailable) console.log("reproject " + probe.reproject + " / astropy " + probe.astropy + " is available as the reference for reprojection.");

test("real pair: bilinear reprojection equals reproject_interp(order='bilinear') inside the target footprint", { skip: skipReproject }, () => {
  const r = must(Diff.computeDifference(realReference, realTarget));
  let compared = 0;
  let worst = 0;
  const extra = [];
  for (let index = 0; index < r.width * r.height; index++) {
    const expected = probe.values[index];
    const mine = r.status[index] === Diff.status.outside ? null : r.target.values[index];
    if (mine !== null && expected !== null) {
      compared++;
      worst = Math.max(worst, Math.abs(mine - expected) / Math.max(1, Math.abs(expected)));
    } else if (mine !== null) {
      assert.fail("AstroNot has a value where reproject has none, at index " + index);
    } else if (expected !== null) {
      extra.push(index);
    }
  }
  assert.equal(compared, 4761);
  assert.ok(worst < 1e-6, "largest relative difference " + worst);
  // reproject also fills the half-pixel border around the target centres by edge extension. AstroNot does not
  // extrapolate, so those pixels (all on the outer rim of the reference grid) are marked outside.
  assert.equal(extra.length, 139);
  for (const index of extra) {
    const column = index % r.width;
    const row = Math.floor(index / r.width);
    const sky = realReference.wcs.pixelToSky(column + 1, row + 1);
    const at = realTarget.wcs.skyToPixel(sky.ra, sky.dec);
    assert.ok(at.x < 1 || at.x > 70 || at.y < 1 || at.y > 70, "pixel " + column + "," + row + " is inside the usable footprint");
  }
});

test("export: astropy reads the DIFFERENCE, MASK and WCS back", { skip: skipReproject }, () => {
  const r = must(Diff.computeDifference(realReference, realTarget));
  const path = join(scratch, "difference.fits");
  writeFileSync(path, Diff.buildDifferenceFits(r));
  const reply = runReference({ read: path });
  assert.ok(!reply.unavailable, reply.unavailable);
  const [primary, difference, mask] = reply.hdus;
  assert.equal(primary.shape, null);
  assert.deepEqual(difference.shape, [70, 70]);
  assert.equal(difference.BUNIT, "MJy / sr");
  assert.equal(difference.DIFFDIR, "TARGET-REFERENCE");
  assert.equal(difference.REFOBS, "2025W21_2C_0280_1");
  assert.equal(difference.TGTOBS, "2025W24_1A_0514_1");
  assert.equal(difference.nan, r.counts.total - r.counts.valid);
  assert.equal(mask.name, "MASK");
  assert.equal(mask.sum, r.counts.total - r.counts.valid);
  const centre = realReference.wcs.pixelToSky(36, 36);
  near(difference.centre_sky[0], centre.ra, 1e-9);
  near(difference.centre_sky[1], centre.dec, 1e-9);
  assert.equal(difference.values.filter((value) => value !== null).length, r.counts.valid);
});

test("SPHEREx variance unit spelling 'MJy2 / sr2' is accepted for MJy / sr images", () => {
  assert.equal(Diff.varianceUnitCheck("MJy2 / sr2", "MJy / sr").ok, true);
  assert.equal(Diff.varianceUnitCheck("MJy2/sr2", "MJy/sr").ok, true);
  assert.equal(Diff.varianceUnitCheck("MJy / sr", "MJy / sr").ok, false);
});
