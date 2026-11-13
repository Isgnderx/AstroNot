// Run with:  node --test tests/        (or: node tests/mosaic.test.mjs)
//
// Covers tools/mosaic-model.js, the computation behind Mosaic Builder: unit checks, band checks, duplicate detection, the
// output grid (automatic TAN grid and reference-WCS grid, RA 0/360 wrap, rotated inputs, size and memory limits), the
// bilinear reprojection onto the grid, the mean and inverse-variance combination, the coverage map, invalid pixels and the
// FITS export.
//   - Sections that build headers and arrays in this file are synthetic fixtures, not archive data. The constant fields of
//     2 and 6 MJy/sr and the variances 1 and 4 exist only for these automatic checks.
//   - The "real pair" section uses assets/tools/spherex-time-machine-example.js: two IRSA SPHEREx QR2 cutouts of one field
//     (2025W21_2C_0280_1 and 2025W24_1A_0514_1, detector 2) on different dates.
//   - The "IRSA cutouts" section runs only when ASTRONOT_MOSAIC_CUTOUTS names a folder with real overlapping SPHEREx cutouts
//     (the full cutouts with VARIANCE, for example downloaded with the IRSA cutout service); otherwise it is skipped.
//   - When Python with astropy is available (set ASTRONOT_PYTHON) the exported FITS is also read back with astropy;
//     otherwise those checks are reported as skipped.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { buildFits } from "./fits-builder.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const Wcs = require("../tools/wcs.js");
const Pair = require("../tools/pair.js");
const Diff = require("../tools/difference.js");
const Mosaic = require("../tools/mosaic-model.js");

const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, (message ?? "") + " expected " + expected + " got " + actual);

// ---- Synthetic fixtures -------------------------------------------------------------------------------------------------
function tanFields({ ra = 150, dec = 2, crpix = [10.5, 10.5], scale = 6 / 3600, rotate = 0, extra = {} } = {}) {
  const c = Math.cos(rotate * Math.PI / 180);
  const s = Math.sin(rotate * Math.PI / 180);
  return {
    CTYPE1: "RA---TAN", CTYPE2: "DEC--TAN", CRVAL1: ra, CRVAL2: dec, CRPIX1: crpix[0], CRPIX2: crpix[1],
    CD1_1: -scale * c, CD1_2: scale * s, CD2_1: scale * s, CD2_2: scale * c, RADESYS: "ICRS", ...extra,
  };
}

// An image on a given WCS. `values` is a function (x, y) of FITS pixel coordinates (or of (ra, dec) with sky = true), or an array.
function image(name, { width = 20, height = 20, wcsFields = tanFields(), values = () => 0, sky = false, unit = "MJy / sr", variance, varianceUnit, obsId = name, mask, extraFields = {}, wavelengthAt, filter } = {}) {
  const fields = { BUNIT: unit, OBSID: obsId, DETECTOR: 2, "DATE-OBS": "2025-05-24T04:24:53.232", TIMESYS: "UTC", RADESYS: "ICRS", ...(filter ? { FILTER: filter } : {}), ...wcsFields, ...extraFields };
  const hdu = { fields, axes: [width, height], name: "IMAGE" };
  const created = Wcs.createWcs(wcsFields);
  const make = (f) => Float64Array.from({ length: width * height }, (_, i) => {
    const x = (i % width) + 1;
    const y = Math.floor(i / width) + 1;
    if (!sky) return f(x, y);
    const at = created.wcs.pixelToSky(x, y);
    return f(((at.ra + 180) % 360 + 360) % 360 - 180, at.dec);
  });
  const toArray = (v) => v === undefined ? undefined : typeof v === "function" ? make(v) : Float64Array.from(v);
  const array = typeof values === "function" ? make(values) : Float64Array.from(values);
  return {
    name, meta: Pair.describeObservation(hdu, 1), width, height, values: array, unit, fields,
    wcs: created.ok ? created.wcs : null, wcsReason: created.ok ? "" : created.reason,
    variance: toArray(variance), varianceUnit, mask, wavelengthAt,
  };
}

const must = (outcome) => {
  assert.equal(outcome.ok, true, outcome.reason);
  return outcome.result;
};

// Two 20 x 20 fields on one pixel lattice: B is A shifted by 10 pixels in x and y, so they overlap in a 10 x 10 square.
const fieldA = (options = {}) => image("A", { wcsFields: tanFields({ crpix: [10.5, 10.5] }), ...options });
const fieldB = (options = {}) => image("B", { wcsFields: tanFields({ crpix: [0.5, 0.5] }), ...options });
const inA = (x, y) => x >= 1 && x <= 20 && y >= 1 && y <= 20;
const inB = (x, y) => x >= 11 && x <= 30 && y >= 11 && y <= 30;
const at = (result, x, y) => (y - 1) * result.width + (x - 1); // Output pixel in the reference grid of A.

// ---- Acceptance numbers --------------------------------------------------------------------------------------------------
test("two overlapping constant fields of 2 and 6 MJy/sr average to 4 in the overlap, and pixels outside both stay invalid", () => {
  const a = fieldA({ values: () => 2 });
  const b = fieldB({ values: () => 6 });
  const r = must(Mosaic.buildMosaic([a, b], { gridMode: "reference", referenceIndex: 0 }));
  assert.equal(r.width, 30);
  assert.equal(r.height, 30);
  assert.equal(r.unit, "MJy/sr");
  let overlap = 0;
  let aOnly = 0;
  let bOnly = 0;
  let outside = 0;
  for (let y = 1; y <= 30; y++) {
    for (let x = 1; x <= 30; x++) {
      const index = at(r, x, y);
      if (inA(x, y) && inB(x, y)) {
        near(r.values[index], 4, 1e-12, "overlap " + x + "," + y);
        assert.equal(r.coverage[index], 2);
        overlap++;
      } else if (inA(x, y)) {
        near(r.values[index], 2, 1e-12);
        assert.equal(r.coverage[index], 1);
        aOnly++;
      } else if (inB(x, y)) {
        near(r.values[index], 6, 1e-12);
        assert.equal(r.coverage[index], 1);
        bOnly++;
      } else {
        assert.ok(Number.isNaN(r.values[index]), "outside both must be NaN at " + x + "," + y);
        assert.equal(r.valid[index], 0);
        assert.equal(r.coverage[index], 0);
        outside++;
      }
    }
  }
  assert.deepEqual({ overlap, aOnly, bOnly, outside }, { overlap: 100, aOnly: 300, bOnly: 300, outside: 200 });
  assert.deepEqual({ valid: r.counts.valid, invalid: r.counts.invalid, overlap: r.counts.overlap, max: r.counts.maxCoverage }, { valid: 700, invalid: 200, overlap: 100, max: 2 });
  assert.deepEqual(r.counts.histogram, [200, 600, 100]);
  assert.equal(r.variance, null); // No variance in either input.
  assert.equal(r.inputs[0].validPixels, 400);
  assert.equal(r.inputs[1].validPixels, 400);
});

test("inverse-variance weights with variances 1 and 4 give 2.8 in the overlap (and 1 / sum of weights as variance)", () => {
  const a = fieldA({ values: () => 2, variance: () => 1, varianceUnit: "(MJy / sr)^2" });
  const b = fieldB({ values: () => 6, variance: () => 4 });
  const r = must(Mosaic.buildMosaic([a, b], { gridMode: "reference", referenceIndex: 0, mode: "inverse-variance" }));
  for (let y = 11; y <= 20; y++) {
    for (let x = 11; x <= 20; x++) {
      near(r.values[at(r, x, y)], 2.8, 1e-12);
      near(r.variance[at(r, x, y)], 0.8, 1e-12);
      assert.equal(r.coverage[at(r, x, y)], 2);
    }
  }
  near(r.values[at(r, 5, 5)], 2, 1e-12);
  near(r.variance[at(r, 5, 5)], 1, 1e-12);
  near(r.values[at(r, 25, 25)], 6, 1e-12);
  near(r.variance[at(r, 25, 25)], 4, 1e-12);
  assert.ok(Number.isNaN(r.values[at(r, 5, 25)]));
  assert.ok(Number.isNaN(r.variance[at(r, 5, 25)]));
  // The equal-weight mean of the same inputs is 4, with variance (1 + 4) / 4.
  const mean = must(Mosaic.buildMosaic([a, b], { gridMode: "reference", referenceIndex: 0 }));
  near(mean.values[at(mean, 15, 15)], 4, 1e-12);
  near(mean.variance[at(mean, 15, 15)], 1.25, 1e-12);
  assert.equal(mean.weights, "equal");
});

test("the automatic north-up TAN grid gives the same overlap values and reports its own geometry", () => {
  const a = fieldA({ values: () => 2 });
  const b = fieldB({ values: () => 6 });
  const r = must(Mosaic.buildMosaic([a, b]));
  assert.equal(r.gridMode, "auto");
  near(r.scaleArcsec, 6, 1e-6);
  assert.ok(r.width >= 30 && r.width <= 31 && r.height >= 30 && r.height <= 31, r.width + " x " + r.height);
  assert.equal(r.wcsFields.CTYPE1, "RA---TAN");
  assert.ok(r.wcsFields.CD1_1 < 0 && r.wcsFields.CD2_2 > 0 && r.wcsFields.CD1_2 === 0 && r.wcsFields.CD2_1 === 0, "north up, east left");
  // Everything inside both footprints is 4; every valid pixel is 2, 4 or 6; the corners that no input covers are invalid.
  const seen = new Set();
  for (let index = 0; index < r.values.length; index++) {
    if (r.valid[index]) {
      if (r.coverage[index] === 2) near(r.values[index], 4, 1e-9);
      seen.add(Math.round(r.values[index] * 1e6) / 1e6);
    } else {
      assert.ok(Number.isNaN(r.values[index]));
    }
  }
  assert.deepEqual([...seen].sort(), [2, 4, 6]);
  const centre = r.wcs.pixelToSky((r.width + 1) / 2, (r.height + 1) / 2);
  const wanted = a.wcs.pixelToSky(15.5, 15.5);
  assert.ok(Wcs.angularSeparation(centre.ra, centre.dec, wanted.ra, wanted.dec) < 2 / 3600, "grid centred on the footprint union");
  assert.ok(r.counts.invalid > 150, "corners outside both inputs are invalid");
  assert.equal(r.counts.maxCoverage, 2);
});

// ---- Units ------------------------------------------------------------------------------------------------------------------
test("units: Jy prefixes are converted explicitly; other units, missing units and per-pixel fluxes are refused with the reason", () => {
  const a = fieldA({ values: () => 2000, unit: "kJy / sr" });
  const b = fieldB({ values: () => 6 });
  const r = must(Mosaic.buildMosaic([a, b], { gridMode: "reference", referenceIndex: 0 }));
  assert.equal(r.unit, "kJy/sr");
  near(r.values[at(r, 15, 15)], 4000, 1e-9); // (2000 kJy/sr + 6 MJy/sr = 6000 kJy/sr) / 2
  assert.equal(r.units.factors[1], 1000);
  assert.ok(r.notes.some((text) => /converted from MJy\/sr to kJy\/sr/.test(text)));
  assert.equal(r.inputs[1].unitFactor, 1000);

  const mismatch = Mosaic.buildMosaic([fieldA({ unit: "MJy / sr", values: () => 2 }), fieldB({ unit: "W / m2 / sr", values: () => 6 })]);
  assert.equal(mismatch.code, "unit-mismatch");
  assert.match(mismatch.reason, /MJy\/sr/);
  assert.equal(Mosaic.buildMosaic([fieldA({ unit: "mJy / sr", values: () => 2 }), fieldB({ unit: "MJy / sr", values: () => 6 })]).ok, true, "mJy/sr to MJy/sr is a prefix conversion");
  const missing = Mosaic.buildMosaic([fieldA({ values: () => 2 }), fieldB({ unit: "", values: () => 6 })]);
  assert.equal(missing.code, "unit-missing");
  assert.match(missing.reason, /BUNIT is missing/);
  for (const unit of ["Jy / pix", "Jy", "DN", "electron / s", "Jy / beam"]) {
    const refused = Mosaic.buildMosaic([fieldA({ unit, values: () => 2 }), fieldB({ unit, values: () => 6 })]);
    assert.equal(refused.code, "unit-unsupported", unit);
  }
  assert.match(Mosaic.buildMosaic([fieldA({ unit: "Jy / pix", values: () => 2 }), fieldB({ unit: "Jy / pix", values: () => 6 })]).reason, /area scaling/);
  assert.equal(Mosaic.classifyUnit("MJy / sr").kind, "surface-brightness");
  assert.equal(Mosaic.classifyUnit("erg / s / cm2 / arcsec2").kind, "surface-brightness");
  assert.equal(Mosaic.classifyUnit("K").kind, "intensive");
});

// ---- Duplicates, count, WCS ------------------------------------------------------------------------------------------------------
test("duplicates, too few inputs and inputs without a WCS are refused", () => {
  const a = fieldA({ values: () => 2 });
  const copy = Object.assign({}, a, { name: "copy.fits" });
  const duplicate = Mosaic.buildMosaic([a, copy]);
  assert.equal(duplicate.code, "duplicate");
  assert.match(duplicate.reason, /identical pixel values/);
  assert.equal(Mosaic.buildMosaic([a]).code, "too-few");
  assert.equal(Mosaic.buildMosaic([]).code, "too-few");
  const noWcs = image("C", { wcsFields: { CTYPE1: "GLON-CAR", CTYPE2: "GLAT-CAR" }, values: () => 7 });
  const refused = Mosaic.buildMosaic([a, noWcs]);
  assert.equal(refused.code, "no-wcs");
  assert.match(refused.reason, /C has no usable WCS/);
  assert.equal(Mosaic.buildMosaic(Array.from({ length: 25 }, (_, i) => fieldA({ values: () => i }))).code, "too-many");
});

// ---- Bands ------------------------------------------------------------------------------------------------------------------------
test("bands: the wavelength of two inputs is compared at the same sky positions", () => {
  const lookup = (micron, slope = 0) => (ra) => ({ micron: micron + slope * (ra - 150), bandwidth: 0.03 });
  const a = fieldA({ values: () => 2, wavelengthAt: lookup(1.30) });
  const same = fieldB({ values: () => 6, wavelengthAt: lookup(1.31) });
  const ok = must(Mosaic.buildMosaic([a, same], { gridMode: "reference", referenceIndex: 0 }));
  assert.equal(ok.bands.state, "same");
  assert.ok(ok.notes.some((text) => /same sky positions/.test(text)));
  const other = fieldB({ values: () => 6, wavelengthAt: lookup(1.50) });
  const refused = Mosaic.buildMosaic([a, other]);
  assert.equal(refused.code, "band-mismatch");
  assert.match(refused.reason, /0\.2 μm/);
  assert.match(refused.reason, /same sky positions/);
  // A sloping lookup: the centres agree but the wavelength at the shared positions differs by more than the bandwidth.
  const sloped = fieldB({ values: () => 6, wavelengthAt: (ra, dec) => ({ micron: 1.30 + (ra - 150) * 5, bandwidth: 0.03 }) });
  assert.equal(Mosaic.buildMosaic([fieldA({ values: () => 2, wavelengthAt: (ra, dec) => ({ micron: 1.30, bandwidth: 0.03 }) }), sloped]).code, "band-mismatch");
  // Filters named in the headers.
  assert.equal(Mosaic.buildMosaic([fieldA({ values: () => 2, filter: "F115W" }), fieldB({ values: () => 6, filter: "F200W" })]).code, "band-mismatch");
  assert.equal(Mosaic.buildMosaic([fieldA({ values: () => 2, filter: "F115W" }), fieldB({ values: () => 6, filter: "F115W" })], { gridMode: "reference" }).ok, true);
  // Nothing to compare: allowed, and said so.
  const unknown = must(Mosaic.buildMosaic([a, fieldB({ values: () => 6 })], { gridMode: "reference" }));
  assert.equal(unknown.bands.state, "unknown");
  assert.ok(unknown.notes.some((text) => /not verified/.test(text)));
});

// ---- Rotated WCS, RA wrap, mixed scales ----------------------------------------------------------------------------------------------
// A smooth function of the sky, linear in RA and Dec, so that bilinear resampling reproduces it to the curvature of the TAN plane.
const sky = (ra, dec) => 1000 + 5000 * (ra - 150) + 3000 * (dec - 2);

test("a rotated input is placed by its WCS: every overlapping value equals the sky function, and the footprint is a rotated square", () => {
  const a = image("A", { width: 30, height: 30, wcsFields: tanFields({ crpix: [15.5, 15.5] }), sky: true, values: sky });
  const b = image("B", { width: 30, height: 30, wcsFields: tanFields({ ra: 150.004, dec: 2.002, crpix: [15.5, 15.5], rotate: 30 }), sky: true, values: sky });
  const r = must(Mosaic.buildMosaic([a, b]));
  let checked = 0;
  for (let row = 0; row < r.height; row++) {
    for (let column = 0; column < r.width; column++) {
      const index = row * r.width + column;
      if (!r.valid[index]) continue;
      const position = r.wcs.pixelToSky(column + 1, row + 1);
      const wrapped = position.ra;
      near(r.values[index], sky(wrapped, position.dec), 0.05, "value at " + column + "," + row);
      checked++;
    }
  }
  assert.ok(checked > 900, "valid pixels " + checked);
  assert.ok(r.counts.overlap > 300 && r.coverage.some((count) => count === 2));
  // The mosaic is north up, B is rotated, so B's own corner pixels map to a diamond: output pixels covered only by B exist
  // at positions where B's WCS says so, and uncovered corners of the output stay invalid.
  assert.ok(r.counts.invalid > 0);
  const fromB = b.wcs.pixelToSky(3, 3);
  const outside = r.wcs.skyToPixel(fromB.ra, fromB.dec);
  const probe = r.coverage[Math.round(outside.y - 1) * r.width + Math.round(outside.x - 1)];
  assert.ok(probe >= 1, "a pixel of the rotated input is covered in the mosaic at its sky position");
  assert.ok(Math.abs(r.inputs[1].footprint.rotationDegrees - (-30)) < 0.1 || Math.abs(r.inputs[1].footprint.rotationDegrees - 30) < 0.1);
  // The windowed reprojection equals a full-grid call of the difference.js reprojection.
  const full = Diff.reprojectBilinear({ width: b.width, height: b.height, wcs: b.wcs, values: b.values }, { width: r.width, height: r.height, wcs: r.wcs });
  for (let index = 0; index < full.values.length; index++) {
    if (full.status[index] !== Diff.status.valid) continue;
    if (r.coverage[index] === 1 && !Number.isNaN(full.values[index])) {
      const column = index % r.width;
      const row = Math.floor(index / r.width);
      const position = r.wcs.pixelToSky(column + 1, row + 1);
      // A-only pixels are impossible here (A is covered by B only partly), so check the B contribution where A is absent.
      const aAt = a.wcs.skyToPixel(position.ra, position.dec);
      if (!Wcs.insideImage(aAt.x, aAt.y, 30, 30)) near(r.values[index], full.values[index], 1e-9);
    }
  }
});

test("RA 0/360 wrap: inputs on both sides of RA = 0 give a small grid that places both fields correctly", () => {
  const west = image("W", { width: 30, height: 30, wcsFields: tanFields({ ra: 359.99, dec: 10, crpix: [15.5, 15.5] }), sky: true, values: sky });
  const east = image("E", { width: 30, height: 30, wcsFields: tanFields({ ra: 0.01, dec: 10, crpix: [15.5, 15.5] }), sky: true, values: sky });
  const r = must(Mosaic.buildMosaic([west, east]));
  assert.ok(r.width < 100 && r.height < 100, "the grid spans the 0.02 degree gap, not 360 degrees: " + r.width + " x " + r.height);
  assert.ok(r.center.ra > 359.9 || r.center.ra < 0.1, "centre RA " + r.center.ra);
  near(Wcs.angularSeparation(r.center.ra, r.center.dec, 0, 10), 0, 0.01);
  let both = 0;
  for (let row = 0; row < r.height; row++) {
    for (let column = 0; column < r.width; column++) {
      const index = row * r.width + column;
      if (!r.valid[index]) continue;
      const position = r.wcs.pixelToSky(column + 1, row + 1);
      const wrapped = ((position.ra + 180) % 360 + 360) % 360 - 180;
      near(r.values[index], sky(wrapped, position.dec), 0.05);
      if (r.coverage[index] === 2) both++;
    }
  }
  assert.ok(both > 50, "the two fields overlap across RA 0: " + both);
  // The same two fields moved to RA 100 give the same grid size and the same coverage counts.
  const west2 = image("W", { width: 30, height: 30, wcsFields: tanFields({ ra: 99.99, dec: 10, crpix: [15.5, 15.5] }), sky: true, values: sky });
  const east2 = image("E", { width: 30, height: 30, wcsFields: tanFields({ ra: 100.01, dec: 10, crpix: [15.5, 15.5] }), sky: true, values: sky });
  const moved = must(Mosaic.buildMosaic([west2, east2]));
  assert.equal(moved.width, r.width);
  assert.equal(moved.height, r.height);
  assert.deepEqual(moved.counts.histogram, r.counts.histogram);
  // A reference grid taken from the western input also wraps.
  const reference = must(Mosaic.buildMosaic([west, east], { gridMode: "reference", referenceIndex: 0 }));
  assert.ok(reference.width < 100);
  assert.deepEqual(reference.counts.histogram.slice(2).reduce((s, v) => s + v, 0), reference.counts.overlap);
});

test("different pixel scales: the default scale is the finest input; a coarser output averages sub-samples of fine inputs", () => {
  const fine = image("fine", { width: 60, height: 60, wcsFields: tanFields({ scale: 2 / 3600, crpix: [30.5, 30.5] }), sky: true, values: sky });
  const coarse = image("coarse", { width: 30, height: 30, wcsFields: tanFields({ ra: 150.01, scale: 6 / 3600, crpix: [15.5, 15.5] }), sky: true, values: sky });
  const r = must(Mosaic.buildMosaic([fine, coarse]));
  near(r.scaleArcsec, Pair.pixelScaleArcsec(fine.wcs, 60, 60), 1e-9);
  assert.equal(r.inputs[0].samples, 1);
  const wide = must(Mosaic.buildMosaic([fine, coarse], { scaleArcsec: 6 }));
  assert.equal(wide.inputs[0].samples, 3, "2 arcsec inputs on a 6 arcsec grid average 3 x 3 samples");
  assert.equal(wide.inputs[1].samples, 1);
  assert.ok(wide.resampling.notes.some((text) => /3 × 3 bilinear samples/.test(text)));
  assert.ok(wide.width < r.width);
  for (let row = 0; row < wide.height; row++) {
    for (let column = 0; column < wide.width; column++) {
      const index = row * wide.width + column;
      if (!wide.valid[index]) continue;
      const position = wide.wcs.pixelToSky(column + 1, row + 1);
      near(wide.values[index], sky(position.ra, position.dec), 0.2);
    }
  }
  // A constant field stays constant under sub-sampling (surface brightness is averaged, never summed).
  const flat = must(Mosaic.buildMosaic([image("f1", { width: 60, height: 60, wcsFields: tanFields({ scale: 2 / 3600, crpix: [30.5, 30.5] }), values: () => 5 }), image("f2", { width: 30, height: 30, wcsFields: tanFields({ ra: 150.01, scale: 6 / 3600, crpix: [15.5, 15.5] }), values: () => 5 })], { scaleArcsec: 6 }));
  for (let index = 0; index < flat.values.length; index++) if (flat.valid[index]) near(flat.values[index], 5, 1e-9);
});

// ---- Masks and invalid pixels ------------------------------------------------------------------------------------------------------
test("partial mask and NaN: masked pixels drop out of the average and uncovered pixels stay invalid", () => {
  const mask = new Uint8Array(400);
  for (let y = 11; y <= 15; y++) for (let x = 11; x <= 15; x++) mask[(y - 1) * 20 + (x - 1)] = 1; // In the overlap.
  for (let y = 1; y <= 3; y++) for (let x = 1; x <= 3; x++) mask[(y - 1) * 20 + (x - 1)] = 1; // In A only.
  const a = fieldA({ values: () => 2, mask });
  const bValues = Float64Array.from({ length: 400 }, (_, i) => (i === (14 - 1) * 20 + (14 - 1) ? NaN : 6)); // B pixel (14, 14) = A pixel (24, 24)
  const b = fieldB({ values: bValues });
  const r = must(Mosaic.buildMosaic([a, b], { gridMode: "reference", referenceIndex: 0 }));
  near(r.values[at(r, 12, 12)], 6, 1e-12); // A masked, B valid: B alone.
  assert.equal(r.coverage[at(r, 12, 12)], 1);
  near(r.values[at(r, 16, 16)], 4, 1e-12); // Both valid.
  assert.equal(r.coverage[at(r, 16, 16)], 2);
  assert.ok(Number.isNaN(r.values[at(r, 2, 2)]), "masked in A and covered by no other input");
  assert.equal(r.valid[at(r, 2, 2)], 0);
  assert.equal(r.coverage[at(r, 2, 2)], 0);
  assert.ok(Number.isNaN(r.values[at(r, 24, 24)]), "NaN in B and not covered by A");
  near(r.values[at(r, 25, 25)], 6, 1e-12);
  assert.equal(r.inputs[0].validPixels, 400 - 25 - 9);
  assert.equal(r.inputs[1].validPixels, 399);
  // Zero is a valid value, not a mask.
  const zero = must(Mosaic.buildMosaic([fieldA({ values: () => 0 }), fieldB({ values: (x, y) => (x === 1 && y === 1 ? 1 : 0) })], { gridMode: "reference", referenceIndex: 0 }));
  assert.equal(zero.valid[at(zero, 15, 15)], 1);
  assert.equal(zero.values[at(zero, 15, 15)], 0);
  // An input that is entirely invalid leaves the other one untouched; two that are leave an empty mosaic.
  const allNaN = fieldB({ values: () => NaN });
  const only = must(Mosaic.buildMosaic([fieldA({ values: () => 2 }), allNaN], { gridMode: "reference", referenceIndex: 0 }));
  assert.equal(only.counts.valid, 400);
  const empty = must(Mosaic.buildMosaic([fieldA({ values: () => 2, mask: new Uint8Array(400).fill(1) }), allNaN], { gridMode: "reference", referenceIndex: 0 }));
  assert.equal(empty.empty, true);
  assert.match(empty.emptyReason, /No output pixel/);
});

test("inverse variance: pixels without a usable variance are left out, and the mode is refused when a variance is missing", () => {
  const a = fieldA({ values: () => 2, variance: () => 1 });
  const bVariance = Float64Array.from({ length: 400 }, (_, i) => (i === (3 - 1) * 20 + (3 - 1) ? 0 : 4));
  const b = fieldB({ values: () => 6, variance: bVariance }); // B pixel (3, 3) = output (13, 13): zero variance.
  const r = must(Mosaic.buildMosaic([a, b], { gridMode: "reference", referenceIndex: 0, mode: "inverse-variance" }));
  near(r.values[at(r, 13, 13)], 2, 1e-12);
  assert.equal(r.coverage[at(r, 13, 13)], 1);
  assert.equal(r.inputs[1].noVariancePixels, 1);
  assert.ok(r.warnings.some((text) => /missing, zero or negative variance/.test(text)));
  const refused = Mosaic.buildMosaic([a, fieldB({ values: () => 6 })], { gridMode: "reference", mode: "inverse-variance" });
  assert.equal(refused.code, "no-variance");
  assert.match(refused.reason, /B has no VARIANCE image/);
  const wrongUnit = Mosaic.buildMosaic([a, fieldB({ values: () => 6, variance: () => 4, varianceUnit: "MJy / sr" })], { gridMode: "reference", mode: "inverse-variance" });
  assert.equal(wrongUnit.code, "no-variance");
  assert.match(wrongUnit.reason, /not the square/);
  // The variance is converted with the unit: kJy/sr variance of 1e6 (kJy/sr)^2 equals 1 (MJy/sr)^2.
  const kilo = fieldA({ values: () => 2000, unit: "kJy / sr", variance: () => 1e6 });
  const converted = must(Mosaic.buildMosaic([fieldB({ values: () => 6, variance: () => 4 }), kilo], { gridMode: "reference", referenceIndex: 0, mode: "inverse-variance" }));
  assert.equal(converted.unit, "MJy/sr");
  // 2000 kJy/sr = 2 MJy/sr with variance 1 and 6 MJy/sr with variance 4: the same 2.8 as in MJy/sr.
  near(converted.values[(15 - 1) * converted.width + 15 - 1], 2.8, 1e-9);
});

test("non-overlapping inputs give a mosaic with an invalid gap and a warning, and no pixel is averaged", () => {
  const left = image("L", { wcsFields: tanFields({ crpix: [10.5, 10.5] }), values: () => 2 });
  const right = image("R", { wcsFields: tanFields({ crpix: [-29.5, 10.5] }), values: () => 6 }); // 20 pixels of gap in x.
  const r = must(Mosaic.buildMosaic([left, right], { gridMode: "reference", referenceIndex: 0 }));
  assert.equal(r.width, 60);
  assert.equal(r.counts.overlap, 0);
  assert.equal(r.counts.maxCoverage, 1);
  assert.equal(r.counts.valid, 800);
  assert.ok(Number.isNaN(r.values[at(r, 30, 10)]));
  assert.equal(r.connectivity.groups.length, 2);
  assert.ok(r.warnings.some((text) => /do not overlap/.test(text)));
  assert.ok(r.warnings.some((text) => /nothing was averaged/.test(text)));
  near(r.values[at(r, 5, 5)], 2, 1e-12);
  near(r.values[at(r, 55, 5)], 6, 1e-12);
  // Far-apart fields cannot share one grid at all.
  const far = image("F", { wcsFields: tanFields({ ra: 150, dec: -60 }), values: () => 3 });
  const refused = Mosaic.buildMosaic([left, far]);
  assert.ok(["too-large", "field-too-large"].includes(refused.code), refused.code);
});

// ---- Size and memory limits ------------------------------------------------------------------------------------------------------------
test("an oversize output is refused before any array exists, with a coarser scale and a smaller field suggested", () => {
  const a = fieldA({ values: () => 2 });
  const b = fieldB({ values: () => 6 });
  const refused = Mosaic.buildMosaic([a, b], { scaleArcsec: 0.0005 });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "too-large");
  assert.match(refused.reason, /more than 4,194,304 pixels|longer than 4,096/);
  assert.ok(refused.suggestion.scaleArcsec > 0.0005);
  assert.ok(refused.suggestion.field.width * refused.suggestion.field.height <= 4194304);
  // The suggestions work: they plan cleanly (the grid is not built here, to keep the test fast).
  const coarse = Mosaic.planGrid([a, b], { scaleArcsec: refused.suggestion.scaleArcsec });
  assert.equal(coarse.ok, true);
  assert.ok(coarse.grid.pixels <= 4194304 && coarse.grid.width <= 4096);
  assert.deepEqual([coarse.grid.width, coarse.grid.height], [refused.suggestion.scaleSize.width, refused.suggestion.scaleSize.height]);
  const cropped = Mosaic.planGrid([a, b], { scaleArcsec: 0.0005, width: refused.suggestion.field.width, height: refused.suggestion.field.height });
  assert.equal(cropped.ok, true);
  assert.equal(cropped.grid.width, refused.suggestion.field.width);
  // An explicit size above the axis limit, and a memory cap.
  assert.equal(Mosaic.buildMosaic([a, b], { width: 5000, height: 10 }).code, "too-large");
  const tight = Mosaic.buildMosaic([a, b], { memoryBytes: 20000 });
  assert.equal(tight.code, "too-large");
  assert.match(tight.reason, /of memory/);
  assert.equal(Mosaic.buildMosaic([a, b], { memoryBytes: 100 }).code, "inputs-too-large");
  assert.equal(Mosaic.buildMosaic([a, b], { scaleArcsec: -1 }).code, "bad-scale");
  assert.equal(Mosaic.buildMosaic([a, b], { width: 2.5 }).code, "bad-size");
  assert.equal(Mosaic.buildMosaic([a, b], { gridMode: "reference", scaleArcsec: 3 }).code, "scale-fixed");
  // planGrid alone reports the same without computing anything.
  const plan = Mosaic.planGrid([a, b], { scaleArcsec: 0.0005 });
  assert.equal(plan.ok, false);
  assert.ok(plan.grid.width * plan.grid.height > 4194304);
  // A size override crops around the centre; the cropped corner pixels stay valid only where inputs cover them.
  const crop = must(Mosaic.buildMosaic([a, b], { gridMode: "reference", referenceIndex: 0, width: 10, height: 10 }));
  assert.equal(crop.width, 10);
  assert.equal(crop.counts.total, 100);
});

// ---- Incremental computation and per-pixel contributions -----------------------------------------------------------------------------------
test("the computation can be run in slices, and the same result comes out", async () => {
  const a = fieldA({ values: () => 2 });
  const b = fieldB({ values: () => 6 });
  const progress = [];
  const sliced = await Mosaic.buildMosaicAsync([a, b], { gridMode: "reference", referenceIndex: 0 }, { onProgress: (step) => progress.push(step.phase), pause: async () => {}, cancelled: () => false });
  const direct = Mosaic.buildMosaic([a, b], { gridMode: "reference", referenceIndex: 0 });
  assert.deepEqual([...sliced.result.values.slice(0, 900)].map(String), [...direct.result.values.slice(0, 900)].map(String));
  assert.ok(progress.length >= 0);
  let cancelled = false;
  const stopped = await Mosaic.buildMosaicAsync([a, b], { gridMode: "reference" }, { cancelled: () => { const was = cancelled; cancelled = true; return was; }, pause: async () => {}, onProgress() {} });
  assert.equal(stopped.code, "cancelled");
});

test("pixel contributions list every input's value and position for one output pixel", () => {
  const a = fieldA({ values: () => 2 });
  const b = fieldB({ values: () => 6 });
  const r = must(Mosaic.buildMosaic([a, b], { gridMode: "reference", referenceIndex: 0 }));
  const pieces = Mosaic.pixelContributions(r, [a, b], 14, 14); // Output pixel (15, 15).
  assert.equal(pieces.length, 2);
  near(pieces[0].value, 2, 1e-12);
  near(pieces[1].value, 6, 1e-12);
  near(pieces[1].position.x, 5, 1e-6);
  near(pieces[1].position.y, 5, 1e-6);
  const solo = Mosaic.pixelContributions(r, [a, b], 2, 2); // (3, 3): A only.
  near(solo[0].value, 2, 1e-12);
  assert.equal(solo[1].value, null);
  assert.equal(solo[1].reason, "Outside this input");
  assert.deepEqual(Mosaic.pixelAt(r, 14, 14), { index: 14 * 30 + 14, column: 14, row: 14, value: 4, variance: null, coverage: 2, valid: true });
  assert.equal(Mosaic.pixelAt(r, 99, 0), null);
});

// ---- FITS export ------------------------------------------------------------------------------------------------------------------------
const fitsSandbox = vm.createContext({ TextDecoder, document: { querySelector: () => null }, atob, Uint8Array });
const fitsLib = vm.runInContext(readFileSync(join(root, "tools/fits.js"), "utf8") + "\n({ readFitsHdus, fitsPixelReader });", fitsSandbox);

async function readBack(bytes) {
  const file = new File([bytes], "mosaic.fits");
  const hdus = await fitsLib.readFitsHdus(file);
  const out = {};
  for (const hdu of hdus) {
    if (!hdu.image) continue;
    const buffer = await file.slice(hdu.dataStart, hdu.dataStart + hdu.byteLength).arrayBuffer();
    const read = fitsLib.fitsPixelReader(buffer, hdu);
    out[hdu.fields.EXTNAME ?? hdu.name] = { hdu, values: Float64Array.from({ length: hdu.pixels }, (_, i) => read(i)) };
  }
  return { hdus, images: out };
}

test("export: the FITS file re-opens with the FITS reader and keeps image, WCS, BUNIT, mask, coverage, variance and the sources", async () => {
  const a = fieldA({ values: () => 2, variance: () => 1, obsId: "OBS-A" });
  const b = fieldB({ values: () => 6, variance: () => 4, obsId: "OBS-B" });
  const r = must(Mosaic.buildMosaic([a, b], { gridMode: "reference", referenceIndex: 0, mode: "inverse-variance" }));
  const bytes = Mosaic.buildMosaicFits(r, { date: "2026-01-01T00:00:00" });
  assert.equal(bytes.length % 2880, 0);
  const { hdus, images } = await readBack(bytes);
  assert.deepEqual(Array.from(hdus, (hdu) => hdu.fields.EXTNAME), ["MOSAIC", "MASK", "COVERAGE", "VARIANCE"]);
  const mosaic = images.MOSAIC;
  assert.equal(mosaic.hdu.fields.BUNIT, "MJy / sr");
  assert.equal(mosaic.hdu.fields.COMBINE, "INVVAR");
  assert.equal(mosaic.hdu.fields.NINPUTS, 2);
  assert.equal(mosaic.hdu.fields.SRCFIL01, "A");
  assert.equal(mosaic.hdu.fields.SRCOBS01, "OBS-A");
  assert.equal(mosaic.hdu.fields.SRCOBS02, "OBS-B");
  assert.equal(mosaic.hdu.fields.RESAMPLE, "BILINEAR");
  assert.equal(mosaic.hdu.fields.GRIDMODE, "REFERENCE");
  assert.ok(mosaic.hdu.cards.some((card) => card.startsWith("HISTORY") && /Input 2: B, observation OBS-B/.test(card)));
  assert.ok(mosaic.hdu.cards.some((card) => card.startsWith("HISTORY") && /never summed/.test(card)));
  for (let index = 0; index < r.values.length; index++) {
    if (Number.isNaN(r.values[index])) assert.ok(Number.isNaN(mosaic.values[index]));
    else assert.equal(mosaic.values[index], r.values[index]);
  }
  near(mosaic.values[at(r, 15, 15)], 2.8, 1e-12);
  assert.equal(images.COVERAGE.values[at(r, 15, 15)], 2);
  assert.equal(images.COVERAGE.values[at(r, 5, 25)], 0);
  assert.equal(images.MASK.values[at(r, 5, 25)], 1);
  assert.equal(images.MASK.values[at(r, 15, 15)], 0);
  assert.equal(images.MASK.values.reduce((s, v) => s + v, 0), r.counts.invalid);
  near(images.VARIANCE.values[at(r, 15, 15)], 0.8, 1e-12);
  assert.equal(images.VARIANCE.hdu.fields.BUNIT, "(MJy / sr)^2");
  // The WCS read back from the header gives the same sky as the mosaic grid, in every HDU.
  for (const name of ["MOSAIC", "MASK", "COVERAGE", "VARIANCE"]) {
    const exported = Wcs.createWcs(images[name].hdu.fields);
    assert.equal(exported.ok, true, name);
    for (const [x, y] of [[1, 1], [15.5, 15.5], [30.5, 30.5]]) {
      const one = r.wcs.pixelToSky(x, y);
      const two = exported.wcs.pixelToSky(x, y);
      assert.ok(Wcs.angularSeparation(one.ra, one.dec, two.ra, two.dec) < 1e-12);
    }
  }
  // The input A pixel (15, 15) of the mosaic lies where A's own WCS says.
  const exported = Wcs.createWcs(mosaic.hdu.fields).wcs;
  const sa = a.wcs.pixelToSky(15, 15);
  const back = exported.skyToPixel(sa.ra, sa.dec);
  near(back.x, 15, 1e-6);
  near(back.y, 15, 1e-6);
  // Without a variance the extension is absent, and a unit with non-ASCII text cannot break the header.
  const plain = must(Mosaic.buildMosaic([fieldA({ values: () => 2 }), fieldB({ values: () => 6 })], { gridMode: "reference", referenceIndex: 0 }));
  const again = await readBack(Mosaic.buildMosaicFits(plain));
  assert.deepEqual(Array.from(again.hdus, (hdu) => hdu.fields.EXTNAME), ["MOSAIC", "MASK", "COVERAGE"]);
});

test("export: an automatic north-up grid and SIP-free TAN header read back to the same sky positions", async () => {
  const a = image("A", { width: 30, height: 30, wcsFields: tanFields({ crpix: [15.5, 15.5] }), sky: true, values: sky });
  const b = image("B", { width: 30, height: 30, wcsFields: tanFields({ ra: 150.004, dec: 2.002, crpix: [15.5, 15.5], rotate: 30 }), sky: true, values: sky });
  const r = must(Mosaic.buildMosaic([a, b]));
  const { images } = await readBack(Mosaic.buildMosaicFits(r));
  const exported = Wcs.createWcs(images.MOSAIC.hdu.fields).wcs;
  assert.equal(images.MOSAIC.hdu.fields.GRIDMODE, "AUTO-TAN");
  for (const [x, y] of [[1, 1], [r.width, 1], [(r.width + 1) / 2, (r.height + 1) / 2], [r.width, r.height]]) {
    const one = r.wcs.pixelToSky(x, y);
    const two = exported.pixelToSky(x, y);
    assert.ok(Wcs.angularSeparation(one.ra, one.dec, two.ra, two.dec) < 1e-12);
  }
});

// ---- Real pair -------------------------------------------------------------------------------------------------------------------------------
const exampleSource = readFileSync(join(root, "assets/tools/spherex-time-machine-example.js"), "utf8");
const realEncoded = vm.runInNewContext(exampleSource + "\nspherexTimeMachineExample;");

// Loads one image HDU of a FITS file as a mosaic input, as the page does.
async function loadInput(bytes, name, { variance = false } = {}) {
  const file = new File([bytes], name);
  const hdus = await fitsLib.readFitsHdus(file);
  const index = hdus.findIndex((hdu) => hdu.fields.EXTNAME === "IMAGE");
  const hdu = hdus[index];
  const read = async (entry) => {
    const data = await file.slice(entry.dataStart, entry.dataStart + entry.byteLength).arrayBuffer();
    const reader = fitsLib.fitsPixelReader(data, entry);
    return Float64Array.from({ length: entry.pixels }, (_, i) => reader(i));
  };
  const values = await read(hdu);
  const table = hdus.find((entry) => entry.fields.EXTNAME === "WCS-WAVE");
  const parsed = table ? Pair.parseWaveTable(await file.slice(table.dataStart, table.dataStart + table.byteLength).arrayBuffer(), table.fields, hdu.fields) : null;
  const wavelength = parsed ? Pair.wavelengthSummary(parsed, hdu.fields, hdu.axes[0], hdu.axes[1]) : null;
  const created = Wcs.createWcs(hdu.fields);
  const varianceHdu = variance ? hdus.find((entry) => entry.fields.EXTNAME === "VARIANCE") : null;
  return {
    name, bytes, meta: Pair.describeObservation(hdu, index, { wavelength }), width: hdu.axes[0], height: hdu.axes[1], values,
    wcs: created.wcs, unit: hdu.fields.BUNIT, fields: hdu.fields, wavelength,
    wavelengthAt: parsed ? Mosaic.wavelengthSampler(parsed, hdu.fields, created.wcs) : null,
    variance: varianceHdu ? await read(varianceHdu) : undefined, varianceUnit: varianceHdu ? varianceHdu.fields.BUNIT : undefined,
  };
}

// Intensity-weighted centroid (FITS pixel coordinates) of the excess over the local median in a (2h+1)^2 box around (x, y).
function centroid(input, x, y, h = 3, values = input.values, width = input.width, height = input.height) {
  const box = [];
  for (let dy = -h; dy <= h; dy++) for (let dx = -h; dx <= h; dx++) box.push(values[(y + dy - 1) * width + (x + dx - 1)]);
  const sorted = box.filter(Number.isFinite).sort((p, q) => p - q);
  const floor = sorted[sorted.length >> 1];
  let sum = 0;
  let sx = 0;
  let sy = 0;
  for (let dy = -h; dy <= h; dy++) {
    for (let dx = -h; dx <= h; dx++) {
      const value = values[(y + dy - 1) * width + (x + dx - 1)] - floor;
      if (!(value > 0)) continue;
      sum += value;
      sx += value * (x + dx);
      sy += value * (y + dy);
    }
  }
  return { x: sx / sum, y: sy / sum };
}

const realReference = await loadInput(Buffer.from(realEncoded.reference, "base64"), "reference.fits");
const realComparison = await loadInput(Buffer.from(realEncoded.comparison, "base64"), "comparison.fits");

test("real pair: the two SPHEREx QR2 cutouts of one field form a mosaic whose sources sit at their input sky positions", () => {
  const r = must(Mosaic.buildMosaic([realReference, realComparison]));
  assert.equal(r.unit, "MJy/sr");
  assert.equal(r.bands.state, "same");
  assert.ok(r.notes.some((text) => /same sky positions/.test(text)));
  near(r.scaleArcsec, 6.1418, 0.001); // The finer of the two inputs.
  assert.equal(r.inputs[0].obsId, "2025W21_2C_0280_1");
  assert.equal(r.inputs[1].obsId, "2025W24_1A_0514_1");
  assert.ok(r.counts.overlap > 4000, "the cutouts overlap almost completely: " + r.counts.overlap);
  assert.equal(r.counts.maxCoverage, 2);
  assert.equal(r.variance, null);
  assert.ok(r.wavelengthRange.min > 1.29 && r.wavelengthRange.max < 1.33);
  // Overlap pixels are the mean of the two reprojected inputs, taken from the same arrays by hand.
  const one = Diff.reprojectBilinear({ width: 70, height: 70, wcs: realReference.wcs, values: realReference.values }, { width: r.width, height: r.height, wcs: r.wcs });
  const two = Diff.reprojectBilinear({ width: 70, height: 70, wcs: realComparison.wcs, values: realComparison.values }, { width: r.width, height: r.height, wcs: r.wcs });
  let checked = 0;
  for (let index = 0; index < r.values.length; index++) {
    if (r.coverage[index] === 2) {
      near(r.values[index], (one.values[index] + two.values[index]) / 2, 1e-9 * Math.max(1, Math.abs(r.values[index])));
      checked++;
    }
  }
  assert.equal(checked, r.counts.overlap);
  // Two sources that both exposures show: sky position of the centroid in each input and in the mosaic.
  for (const [ra, dec, label] of [[156.09697, -41.68346, "source 1"], [156.09913, -41.61973, "source 2"]]) {
    const inputs = [realReference, realComparison].map((input) => {
      const at0 = input.wcs.skyToPixel(ra, dec);
      const peak = centroid(input, Math.round(at0.x), Math.round(at0.y), 2);
      return input.wcs.pixelToSky(peak.x, peak.y);
    });
    const at1 = r.wcs.skyToPixel(ra, dec);
    const mid = centroid(r, Math.round(at1.x), Math.round(at1.y), 2, r.values, r.width, r.height);
    const found = r.wcs.pixelToSky(mid.x, mid.y);
    const pixelArcsec = r.scaleArcsec;
    const moved = Wcs.angularSeparation(inputs[0].ra, inputs[0].dec, inputs[1].ra, inputs[1].dec) * 3600;
    assert.ok(moved < 1.2 * pixelArcsec, label + ": the two inputs agree to " + moved.toFixed(2) + " arcsec");
    // The mosaic centroid lies between the two input centroids, within a fraction of a pixel of each.
    for (const position of inputs) {
      const gap = Wcs.angularSeparation(found.ra, found.dec, position.ra, position.dec) * 3600;
      assert.ok(gap < 0.75 * pixelArcsec, label + ": mosaic centroid is " + gap.toFixed(2) + " arcsec from an input centroid");
    }
    const middleRa = (inputs[0].ra + inputs[1].ra) / 2;
    const middleDec = (inputs[0].dec + inputs[1].dec) / 2;
    assert.ok(Wcs.angularSeparation(found.ra, found.dec, middleRa, middleDec) * 3600 < 0.5 * pixelArcsec, label + ": mosaic centroid vs mean of input centroids");
  }
});

test("real pair: a copy of one cutout is refused as a duplicate and the order of the inputs does not change the pixels", () => {
  assert.equal(Mosaic.buildMosaic([realReference, Object.assign({}, realReference, { name: "copy.fits" })]).code, "duplicate");
  const forward = must(Mosaic.buildMosaic([realReference, realComparison], { gridMode: "reference", referenceIndex: 0 }));
  const backward = must(Mosaic.buildMosaic([realComparison, realReference], { gridMode: "reference", referenceIndex: 1 }));
  assert.equal(forward.width, backward.width);
  assert.equal(forward.counts.valid, backward.counts.valid);
  for (let index = 0; index < forward.values.length; index++) {
    if (forward.valid[index]) near(forward.values[index], backward.values[index], 1e-9 * Math.max(1, Math.abs(forward.values[index])));
  }
});

test("real pair: with the reference WCS of the first input, the first cutout is not resampled where it lies on the grid", () => {
  const r = must(Mosaic.buildMosaic([realReference, realComparison], { gridMode: "reference", referenceIndex: 0 }));
  assert.equal(r.gridMode, "reference");
  near(r.scaleArcsec, Pair.pixelScaleArcsec(realReference.wcs, 70, 70), 1e-9);
  assert.ok(r.width >= 70 && r.width <= 72 && r.height >= 70 && r.height <= 72, r.width + " x " + r.height);
  // The SIP header of the reference is reused: its pixel (35, 35) is the mosaic pixel at the integer offset.
  const sky35 = realReference.wcs.pixelToSky(35, 35);
  const out = r.wcs.skyToPixel(sky35.ra, sky35.dec);
  near(out.x - Math.round(out.x), 0, 1e-6);
  near(out.y - Math.round(out.y), 0, 1e-6);
  const index = (Math.round(out.y) - 1) * r.width + (Math.round(out.x) - 1);
  assert.equal(r.coverage[index], 2);
});

// ---- Real IRSA cutouts (optional) ------------------------------------------------------------------------------------------------------------------
const cutoutDirectory = process.env.ASTRONOT_MOSAIC_CUTOUTS;
const cutoutNames = cutoutDirectory && existsSync(cutoutDirectory) ? readdirSync(cutoutDirectory).filter((name) => /\.fits$/i.test(name)).sort() : [];
const skipCutouts = cutoutNames.length >= 2 ? false : "Set ASTRONOT_MOSAIC_CUTOUTS to a folder with two or more overlapping SPHEREx cutouts (with VARIANCE) to run this check.";

test("IRSA cutouts: overlapping real cutouts give one consistent mosaic (mean and inverse variance) and a FITS file that re-opens", { skip: skipCutouts }, async () => {
  const inputs = [];
  for (const name of cutoutNames) inputs.push(await loadInput(readFileSync(join(cutoutDirectory, name)), name, { variance: true }));
  const mean = must(Mosaic.buildMosaic(inputs));
  assert.ok(mean.counts.overlap > 0, "the cutouts overlap");
  const weighted = inputs.every((input) => input.variance) ? must(Mosaic.buildMosaic(inputs, { mode: "inverse-variance" })) : null;
  for (const result of [mean, weighted].filter(Boolean)) {
    for (let column = 0; column < result.width; column += 7) {
      for (let row = 0; row < result.height; row += 7) {
        const index = row * result.width + column;
        if (!result.valid[index]) continue;
        const pieces = Mosaic.pixelContributions(result, inputs, column, row).filter((piece) => piece.value !== null);
        assert.equal(pieces.length, result.coverage[index]);
        const lo = Math.min(...pieces.map((piece) => piece.value));
        const hi = Math.max(...pieces.map((piece) => piece.value));
        assert.ok(result.values[index] >= lo - 1e-9 && result.values[index] <= hi + 1e-9, "the combined value lies between the contributing values");
      }
    }
  }
  // The brightest isolated source in the area covered by two or more cutouts: its centroid in the mosaic and in every
  // contributing cutout gives the same sky position (within a pixel), each through its own WCS.
  const best = weighted ?? mean;
  let peak = null;
  for (let y = 3; y < best.height - 3; y++) {
    for (let x = 3; x < best.width - 3; x++) {
      const index = y * best.width + x;
      if (best.coverage[index] < 2) continue;
      const here = best.wcs.pixelToSky(x + 1, y + 1);
      const interior = inputs.filter((input) => { const at1 = input.wcs.skyToPixel(here.ra, here.dec); return at1.x >= 5 && at1.y >= 5 && at1.x <= input.width - 4 && at1.y <= input.height - 4; }).length;
      if (interior < 2) continue;
      let top = true;
      for (let dy = -2; dy <= 2 && top; dy++) for (let dx = -2; dx <= 2; dx++) if ((dx || dy) && !(best.values[index + dy * best.width + dx] < best.values[index])) { top = false; break; }
      if (top && (!peak || best.values[index] > peak.value)) peak = { value: best.values[index], x: x + 1, y: y + 1 };
    }
  }
  assert.ok(peak, "a source in the overlap");
  const sky0 = best.wcs.pixelToSky(peak.x, peak.y);
  const mosaicCentre = centroid(best, peak.x, peak.y, 2, best.values, best.width, best.height);
  const found = best.wcs.pixelToSky(mosaicCentre.x, mosaicCentre.y);
  let compared = 0;
  for (const input of inputs) {
    const at0 = input.wcs.skyToPixel(sky0.ra, sky0.dec);
    if (at0.x < 5 || at0.y < 5 || at0.x > input.width - 4 || at0.y > input.height - 4) continue;
    const c = centroid(input, Math.round(at0.x), Math.round(at0.y), 2);
    const there = input.wcs.pixelToSky(c.x, c.y);
    assert.ok(Wcs.angularSeparation(found.ra, found.dec, there.ra, there.dec) * 3600 < best.scaleArcsec, input.name + ": source position in the mosaic and in the cutout agree to a pixel");
    compared++;
  }
  assert.ok(compared >= 2, "the source is measured in at least two cutouts");
  const { images } = await readBack(Mosaic.buildMosaicFits(weighted ?? mean));
  assert.ok(images.MOSAIC && images.MASK && images.COVERAGE);
});

// ---- Cross-check with astropy (optional) ----------------------------------------------------------------------------------------------------------------
function runReference(request) {
  const python = process.env.ASTRONOT_PYTHON ?? "python";
  const result = spawnSync(python, ["-I", join(root, "tests/mosaic-reference.py")], { input: JSON.stringify(request), encoding: "utf8", maxBuffer: 1 << 28 });
  if (result.error || result.status !== 0) return { unavailable: (result.error?.message ?? result.stderr ?? "").trim().split("\n").pop() };
  return JSON.parse(result.stdout);
}

const scratch = mkdtempSync(join(tmpdir(), "astronot-mosaic-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const realMosaic = must(Mosaic.buildMosaic([realReference, realComparison]));
const realPath = join(scratch, "mosaic.fits");
writeFileSync(realPath, Mosaic.buildMosaicFits(realMosaic, { date: "2026-01-01T00:00:00" }));
const probePixels = [[1, 1], [20.5, 30.25], [Math.round(realMosaic.width / 2), Math.round(realMosaic.height / 2)], [realMosaic.width, realMosaic.height]];
const probe = runReference({ read: realPath, pixels: probePixels });
const skipAstropy = probe.unavailable ? "astropy is not available (" + probe.unavailable + "). Set ASTRONOT_PYTHON to a Python with astropy." : false;
if (!probe.unavailable) console.log("astropy " + probe.astropy + " is available as the reference reader for the exported mosaic.");

test("export: astropy reads the mosaic, mask, coverage and WCS back", { skip: skipAstropy }, () => {
  const [primary, mask, coverage] = probe.hdus;
  assert.equal(primary.name, "MOSAIC");
  assert.deepEqual(primary.shape, [realMosaic.height, realMosaic.width]);
  assert.equal(primary.BUNIT, "MJy / sr");
  assert.equal(primary.COMBINE, "MEAN");
  assert.equal(primary.NINPUTS, 2);
  assert.equal(primary.SRCOBS01, "2025W21_2C_0280_1");
  assert.equal(primary.SRCOBS02, "2025W24_1A_0514_1");
  assert.equal(primary.nan, realMosaic.counts.invalid);
  assert.equal(mask.name, "MASK");
  assert.equal(mask.sum, realMosaic.counts.invalid);
  assert.equal(coverage.name, "COVERAGE");
  assert.equal(coverage.sum, realMosaic.coverage.reduce((s, v) => s + v, 0));
  assert.ok(primary.history.some((line) => /Input 2: comparison\.fits/.test(line)));
  probePixels.forEach(([x, y], index) => {
    const mine = realMosaic.wcs.pixelToSky(x, y);
    near(probe.sky[index][0], mine.ra, 1e-9);
    near(probe.sky[index][1], mine.dec, 1e-9);
  });
  const finite = primary.values.filter((value) => value !== null);
  assert.equal(finite.length, realMosaic.counts.valid);
});

test("a FITS file built with the test fixture builder opens as a mosaic input (header and BSCALE path)", async () => {
  const bytes = buildFits({
    width: 8, height: 8, bitpix: -32,
    extra: [["BUNIT", "MJy / sr"], ["CTYPE1", "RA---TAN"], ["CTYPE2", "DEC--TAN"], ["CRVAL1", 150], ["CRVAL2", 2], ["CRPIX1", 4.5], ["CRPIX2", 4.5], ["CD1_1", -0.001], ["CD1_2", 0], ["CD2_1", 0], ["CD2_2", 0.001], ["RADESYS", "ICRS"]],
    pixels: (x, y) => 10 + x + y,
  });
  const file = new File([bytes], "tiny.fits");
  const hdus = await fitsLib.readFitsHdus(file);
  const hdu = hdus[0];
  const data = await file.slice(hdu.dataStart, hdu.dataStart + hdu.byteLength).arrayBuffer();
  const reader = fitsLib.fitsPixelReader(data, hdu);
  const values = Float64Array.from({ length: 64 }, (_, i) => reader(i));
  const wcs = Wcs.createWcs(hdu.fields).wcs;
  const first = { name: "tiny-1", meta: Pair.describeObservation(hdu, 0), width: 8, height: 8, values, wcs, unit: hdu.fields.BUNIT, fields: hdu.fields };
  const shifted = Object.assign({}, first, {
    name: "tiny-2", values: values.map((value) => value + 100),
    wcs: Wcs.createWcs(Object.assign({}, hdu.fields, { CRPIX1: -3.5 })).wcs, fields: Object.assign({}, hdu.fields, { CRPIX1: -3.5 }),
  });
  const r = must(Mosaic.buildMosaic([first, shifted], { gridMode: "reference", referenceIndex: 0 }));
  assert.equal(r.width, 16);
  assert.equal(r.counts.overlap, 0, "the two tiles touch without overlapping");
  assert.equal(r.counts.valid, 128);
});
