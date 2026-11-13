// Run with:  node --test tests/        (or: node tests/spectrophotometry.test.mjs)
//
// Covers tools/photometry.js, the computation behind Spectrophotometry: exact circular-aperture weights, the flux formula
// F[Jy] = 1e6 * SUM w (I - b) Omega, units, masked and flagged pixels, the annulus background, partial and off-image apertures,
// the wavelength lookup, variance propagation and the CSV contract that Spectrum Lab reads.
//   - Sections that build images in this file are synthetic fixtures (including the Prompt 11 case: background 1 MJy/sr, two
//     full pixels of 3 and 5 MJy/sr, a pixel solid angle of 1e-10 sr, expected 600 microJy). They are not archive data.
//   - The "real data" section uses the bundled SPHEREx QR2 cutouts (assets/tools/spherex-time-machine-example.js and
//     assets/tools/spherex-example.js, observations 2025W21_2C_0280_1 and 2025W24_1A_0514_1, detector 2). Those two files keep
//     only IMAGE and WCS-WAVE, so they have no FLAGS and no VARIANCE. The measurement of the bright source there is checked
//     against a separate, straightforward implementation (brute-force sub-pixel sampling, finite-difference solid angle).
//   - When ASTRONOT_SPHEREX_CUTOUT points to a full IRSA cutout (IMAGE, FLAGS, VARIANCE, ZODI, PSF, WCS-WAVE) the same check runs on
//     it, with flags and variance; without it that test is skipped.
//   - Astropy and photutils are not required and are not used. Nothing here is compared with the archive's forced photometry.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { buildFits } from "./fits-builder.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const Wcs = require("../tools/wcs.js");
const Pair = require("../tools/pair.js");
const Phot = require("../tools/photometry.js");

const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, (message ?? "") + " expected " + expected + " got " + actual);
const relative = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance * Math.abs(expected), (message ?? "") + " expected " + expected + " got " + actual + " (relative tolerance " + tolerance + ")");

// ---- Synthetic fixtures ---------------------------------------------------------------------------------------------------
const degPerRad = 180 / Math.PI;
const scaleForOmega = (omega) => Math.sqrt(omega) * degPerRad; // degrees per pixel of a square pixel with the given solid angle

function tanFields({ ra = 150, dec = 2, crpix = [11, 11], scale = scaleForOmega(1e-10), extra = {} } = {}) {
  return { CTYPE1: "RA---TAN", CTYPE2: "DEC--TAN", CRVAL1: ra, CRVAL2: dec, CRPIX1: crpix[0], CRPIX2: crpix[1], CD1_1: -scale, CD1_2: 0, CD2_1: 0, CD2_2: scale, RADESYS: "ICRS", ...extra };
}

// An observation as photometry.js expects it. `values`, `variance`, `flags` are functions (x, y) of FITS pixel coordinates.
function observation({ name = "synthetic", width = 21, height = 21, unit = "MJy/sr", values = () => 1, variance, varianceUnit = "MJy2 / sr2", flags, waveTable = null, fields: headerFields = {}, wcsFields = tanFields() } = {}) {
  const make = (fn, Type = Float64Array) => (fn ? Type.from({ length: width * height }, (_, i) => fn((i % width) + 1, Math.floor(i / width) + 1)) : undefined);
  const created = Wcs.createWcs(wcsFields);
  return {
    name, width, height, unit, values: make(values), variance: make(variance), varianceUnit, flags: make(flags, Uint32Array),
    waveTable, wcs: created.ok ? created.wcs : null, wcsReason: created.ok ? "" : created.reason,
    fields: { OBSID: name, TIMESYS: "UTC", "DATE-OBS": "2025-05-24T04:24:53.232", ...wcsFields, ...headerFields },
  };
}

const targetAt = (obs, x, y) => obs.wcs.pixelToSky(x, y);

// The Prompt 11 image: background 1 MJy/sr everywhere, the pixels (10, 10) and (11, 10) hold 3 and 5 MJy/sr.
const prompt11 = (extra = {}) => observation({ values: (x, y) => (y === 10 && x === 10 ? 3 : y === 10 && x === 11 ? 5 : 1), ...extra });
const prompt11Params = { radius: 1.2, innerRadius: 3, outerRadius: 5, minAnnulusPixels: 10 };

// ---- Acceptance case --------------------------------------------------------------------------------------------------------
test("Prompt 11: background 1, two full pixels of 3 and 5 MJy/sr, 1e-10 sr each, gives 600 microJy", () => {
  const formula = Phot.fluxFromSamples([{ value: 3, weight: 1, omega: 1e-10 }, { value: 5, weight: 1, omega: 1e-10 }], 1, 1);
  relative(formula.microJy, 600, 1e-12);
  relative(formula.jy, 6e-4, 1e-12);

  const obs = prompt11();
  const target = targetAt(obs, 10.5, 10);
  // The WCS solid angle of a 1e-10 sr pixel differs from 1e-10 only by the tangent-plane distortion over a few pixels.
  const wcsRun = Phot.measureAperture(obs, target, prompt11Params);
  assert.equal(wcsRun.status, "ok");
  assert.equal(wcsRun.measured, true);
  assert.equal(wcsRun.methodLabel, "Aperture flux density");
  assert.equal(wcsRun.method, "aperture-photometry");
  assert.equal(wcsRun.background.value, 1);
  near(wcsRun.aperture.coverage, 1, 1e-12);
  relative(wcsRun.flux.microJy, 600, 1e-6, "flux with the WCS solid angle");
  assert.equal(wcsRun.flux.unit, "μJy");

  // With the solid angle fixed at exactly 1e-10 sr the same image gives 600 microJy to rounding error.
  const exact = Phot.measureAperture(obs, target, prompt11Params, { solidAngleSr: 1e-10 });
  relative(exact.flux.microJy, 600, 1e-12, "flux with Omega = 1e-10 sr");
  assert.equal(exact.fluxErrMicroJy, null);
  assert.match(exact.fluxErrReason, /No VARIANCE image/);
  assert.equal(exact.spectrumPoint, false, "no wavelength table: not a spectrum point");
});

// ---- Aperture weights ---------------------------------------------------------------------------------------------------------
// Straightforward reference: overlap of the circle with a pixel by sampling an n x n grid of sub-pixel centres.
function sampledWeight(cx, cy, r, column, row, n = 400) {
  let inside = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = column + 0.5 + (i + 0.5) / n;
      const y = row + 0.5 + (j + 0.5) / n;
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) inside++;
    }
  }
  return inside / (n * n);
}

test("aperture weights are the exact overlaps of the circle with each pixel", () => {
  for (const [cx, cy, r] of [[10.5, 10.5, 1], [10, 10, 2.5], [10.3, 9.7, 1.7], [12.45, 11.2, 3.3], [10, 10, 0.5], [10.25, 10, 0.4]]) {
    const weights = Phot.apertureWeights(cx, cy, r, 21, 21);
    let sum = 0;
    for (const entry of weights) {
      near(entry.w, sampledWeight(cx, cy, r, entry.column, entry.row), 2e-3, "pixel " + entry.column + "," + entry.row + " of circle " + [cx, cy, r]);
      assert.ok(entry.w > 0 && entry.w <= 1);
      sum += entry.w;
    }
    relative(sum, Math.PI * r * r, 1e-12, "weights add up to the circle area for " + [cx, cy, r]);
  }
  // Closed forms.
  const quarter = Phot.apertureWeights(10.5, 10.5, 1, 21, 21); // centred on a pixel corner: four pixels of pi/4
  assert.equal(quarter.length, 4);
  for (const entry of quarter) near(entry.w, Math.PI / 4, 1e-14);
  const single = Phot.apertureWeights(10, 10, 0.5, 21, 21); // a circle inscribed in one pixel touches the neighbours only at points
  assert.equal(single.length, 1);
  near(single[0].w, Math.PI / 4, 1e-14);
  const whole = Phot.apertureWeights(10, 10, 0.4, 21, 21);
  assert.equal(whole.length, 1);
  near(whole[0].w, Math.PI * 0.16, 1e-14);
  // Pixels fully inside have weight exactly 1.
  assert.equal(Phot.apertureWeights(10, 10, 3, 21, 21).find((entry) => entry.column === 9 && entry.row === 9).w, 1);
});

test("partial aperture at the image edge: weights, coverage and status", () => {
  const obs = observation({ values: () => 2, width: 21, height: 21 });
  // The target sits on the centre of the first column; half of the circle (radius 2.5) hangs over the edge x = 0.5.
  const target = targetAt(obs, 1, 10);
  const run = Phot.measureAperture(obs, target, { radius: 2.5, background: "none", minCoverage: 0.4 });
  assert.equal(run.status, "partial-aperture");
  assert.equal(run.measured, true);
  const circle = Math.PI * 2.5 * 2.5;
  // Area of the circle inside x >= 0.5 (the image edge is 0.5 from the centre): circular segment formula.
  const d = 0.5;
  const r = 2.5;
  const outside = r * r * Math.acos(d / r) - d * Math.sqrt(r * r - d * d); // segment beyond a chord at distance d
  const expectedCoverage = (circle - outside) / circle;
  near(run.aperture.coverage, expectedCoverage, 1e-9);
  near(run.aperture.offImageShare, outside / circle, 1e-9);
  assert.ok(run.reasons.some((text) => /Partial aperture/.test(text)));
  // Default minimum coverage 0.9 refuses it.
  const refused = Phot.measureAperture(obs, target, { radius: 2.5, background: "none" });
  assert.equal(refused.status, "insufficient-coverage");
  assert.equal(refused.measured, false);
  assert.equal(refused.flux, null);
  // Without a background and a constant image the sum equals value * covered solid angle.
  const omega = run.aperture.solidAngleSr;
  relative(run.flux.jy, 1e6 * 2 * omega, 1e-12);
});

// ---- Masked pixels and flags ---------------------------------------------------------------------------------------------------
test("a NaN pixel in the aperture is left out, its share is reported and low coverage is refused", () => {
  const withHole = prompt11({ values: (x, y) => (x === 10 && y === 10 ? NaN : y === 10 && x === 11 ? 5 : 1) });
  const target = targetAt(withHole, 10.5, 10);
  const run = Phot.measureAperture(withHole, target, { ...prompt11Params, minCoverage: 0.5 }, { solidAngleSr: 1e-10 });
  const circle = Math.PI * 1.2 * 1.2;
  assert.equal(run.status, "partial-aperture");
  near(run.aperture.maskedShare, 1 / circle, 1e-12);
  near(run.aperture.nanShare, 1 / circle, 1e-12);
  near(run.aperture.coverage, 1 - 1 / circle, 1e-12);
  relative(run.flux.microJy, 400, 1e-12, "only the 5 MJy/sr pixel contributes: (5 - 1) * 1e-10 sr");
  assert.ok(run.flags >= Phot.containsBadPixel, "CONTAINS_BAD_PIXEL is set");
  const pixel = run.pixels.find((entry) => entry.x === 10 && entry.y === 10);
  assert.equal(pixel.status, "nan");

  const strict = Phot.measureAperture(withHole, target, prompt11Params, { solidAngleSr: 1e-10 });
  assert.equal(strict.status, "insufficient-coverage");
  assert.equal(strict.measured, false);
  assert.match(strict.reasons.join(" "), /below the minimum of 90%/);
});

test("FLAGS: bad bits are left out, other bits are propagated, the mask can be switched off", () => {
  const HOT = 1 << 10;
  const SOURCE = 1 << 21;
  const obs = prompt11({ flags: (x, y) => (x === 10 && y === 10 ? HOT : x === 11 && y === 10 ? SOURCE : 0) });
  const target = targetAt(obs, 10.5, 10);
  const masked = Phot.measureAperture(obs, target, { ...prompt11Params, minCoverage: 0.5 }, { solidAngleSr: 1e-10 });
  relative(masked.flux.microJy, 400, 1e-12, "the HOT pixel is left out");
  assert.equal(masked.flags, HOT + SOURCE + Phot.containsBadPixel);
  assert.deepEqual(masked.flagNames.map((entry) => entry.name), ["HOT", "SOURCE", "CONTAINS_BAD_PIXEL"]);
  assert.equal(masked.pixels.find((entry) => entry.x === 10 && entry.y === 10).status, "flag");
  near(masked.aperture.flagShare, 1 / (Math.PI * 1.44), 1e-12);

  const unmasked = Phot.measureAperture(obs, target, { ...prompt11Params, maskFlags: false }, { solidAngleSr: 1e-10 });
  relative(unmasked.flux.microJy, 600, 1e-12, "with the mask off the HOT pixel counts");
  assert.equal(unmasked.flags, HOT + SOURCE, "the flags are still reported, without CONTAINS_BAD_PIXEL");
  // SOURCE alone never masks a pixel: it flags 94% of a real cutout.
  const sourceOnly = prompt11({ flags: () => SOURCE });
  const kept = Phot.measureAperture(sourceOnly, targetAt(sourceOnly, 10.5, 10), prompt11Params, { solidAngleSr: 1e-10 });
  relative(kept.flux.microJy, 600, 1e-12);
  assert.equal(kept.flags, SOURCE);
  // A flagged annulus pixel is not used for the background.
  const spoiled = prompt11({ values: (x, y) => (y === 10 && x === 10 ? 3 : y === 10 && x === 11 ? 5 : 1), flags: (x, y) => (x === 10 && y === 14 ? HOT : 0) });
  const withBad = Phot.measureAperture(spoiled, targetAt(spoiled, 10.5, 10), prompt11Params, { solidAngleSr: 1e-10 });
  assert.equal(withBad.annulus.flagCount, 1);
});

test("flag definitions come from the FLAGS header and fall back to the documented table", () => {
  const cards = ["HIERARCH MP_OVERFLOW = 1 / Overflow detected during SUR", "MP_HOT  =                   10 / Hot pixel", "HIERARCH MP_NEWBIT = 30 / A bit only this file defines", "HIERARCH L2 N_OUTLIER = 5"];
  const { definitions, fromHeader } = Phot.flagDefinitions(cards);
  assert.equal(fromHeader, 3);
  assert.equal(definitions.find((entry) => entry.name === "HOT").bit, 10);
  assert.equal(definitions.find((entry) => entry.name === "NEWBIT").bit, 30);
  assert.equal(definitions.find((entry) => entry.name === "NONFUNC").bit, 6, "documented bit kept");
  assert.equal(Phot.bitMask(definitions, Phot.excludedFlagNames) & (1 << 10), 1 << 10);
  assert.deepEqual(Phot.describeFlags(4297064453).map((entry) => entry.name), ["TRANSIENT", "SUR_ERROR", "SOURCE", "CONTAINS_BAD_PIXEL"]);
  assert.deepEqual(Phot.describeFlags(0), []);
  assert.equal(Phot.describeFlags(1 << 25 >>> 0)[0].name, "STREAK");
  assert.equal(Phot.describeFlags(2 ** 31)[0].name, "BIT31", "an undocumented bit keeps its number");
});

// ---- Units ---------------------------------------------------------------------------------------------------------------------
test("unknown or unsupported BUNIT: no flux", () => {
  for (const unit of ["electron/s", "", "Jy/beam", "DN", "MJy", "K"]) {
    const obs = prompt11({ unit });
    const run = Phot.measureAperture(obs, targetAt(obs, 10.5, 10), prompt11Params);
    assert.equal(run.status, "unit-unsupported", "unit '" + unit + "'");
    assert.equal(run.measured, false);
    assert.equal(run.flux, null);
    assert.equal(run.spectrumPoint, false);
    assert.equal(Phot.csvRow(run, { sourceId: "x" }), null);
  }
  const missing = prompt11({ unit: null });
  assert.equal(Phot.measureAperture(missing, targetAt(missing, 10.5, 10), prompt11Params).status, "unit-unsupported");
});

test("MJy/sr and other Jy/sr prefixes: only the prefix scales the flux; case matters", () => {
  const base = Phot.measureAperture(prompt11(), targetAt(prompt11(), 10.5, 10), prompt11Params, { solidAngleSr: 1e-10 }).flux.microJy;
  relative(base, 600, 1e-12);
  const cases = { "MJy/sr": 1, "MJy / sr": 1, "kJy/sr": 1e-3, "Jy/sr": 1e-6, "mJy/sr": 1e-9, "GJy/sr": 1e3, "MJy sr-1": 1, "MJy/sr ": 1 };
  for (const [unit, factor] of Object.entries(cases)) {
    const obs = prompt11({ unit });
    const run = Phot.measureAperture(obs, targetAt(obs, 10.5, 10), prompt11Params, { solidAngleSr: 1e-10 });
    assert.equal(run.status, "ok", unit);
    relative(run.flux.microJy, 600 * factor, 1e-12, "unit " + unit);
  }
  assert.equal(Phot.unitScale("mJy/sr").factor, 1e-9);
  assert.equal(Phot.unitScale("MJy/sr").factor, 1);
  assert.equal(Phot.unitScale("MJY/sr").ok, false, "case is kept: MJY is not a prefix of Jy");
});

// ---- Background -----------------------------------------------------------------------------------------------------------------
test("background: robust to outliers, mean and none, annulus counts", () => {
  // A ring with a few bright outliers: the clipped median stays at 1.
  const noisy = prompt11({ values: (x, y) => ((x === 10 && y === 10) ? 3 : (x === 11 && y === 10) ? 5 : (x + y) % 11 === 0 && Math.hypot(x - 10.5, y - 10) > 3.2 ? 40 : 1) });
  const run = Phot.measureAperture(noisy, targetAt(noisy, 10.5, 10), prompt11Params, { solidAngleSr: 1e-10 });
  assert.equal(run.background.value, 1);
  assert.ok(run.annulus.clippedCount > 0, "outliers were clipped");
  relative(run.flux.microJy, 600, 1e-12);
  assert.equal(run.annulus.usedCount + run.annulus.clippedCount, run.annulus.validCount);

  // Mean of a linear ramp background: b is the mean of the ring.
  const ramp = observation({ values: (x) => 1 + 0.01 * x });
  const target = targetAt(ramp, 10.5, 10);
  const meanRun = Phot.measureAperture(ramp, target, { ...prompt11Params, background: "mean", clipSigma: 100 });
  const ring = Phot.apertureWeights(10.5, 10, 5, 21, 21).filter((entry) => entry.distance >= 3 && entry.distance <= 5 && !Phot.apertureWeights(10.5, 10, 1.2, 21, 21).some((a) => a.index === entry.index));
  const expected = ring.reduce((sum, entry) => sum + 1 + 0.01 * (entry.column + 1), 0) / ring.length;
  near(meanRun.background.value, expected, 1e-12);
  assert.equal(meanRun.annulus.validCount, ring.length);

  // No background: pixel values are used as they are and the result says so.
  const none = Phot.measureAperture(prompt11(), targetAt(prompt11(), 10.5, 10), { radius: 1.2, background: "none" }, { solidAngleSr: 1e-10 });
  relative(none.flux.microJy, 1e6 * 1e-10 * 1e6 * (3 + 5 + (Math.PI * 1.44 - 2) * 1), 1e-9);
  assert.equal(none.annulus, null);
  assert.ok(none.reasons.some((text) => /No background was subtracted/.test(text)));
});

test("insufficient annulus: too few valid pixels, or an annulus mostly off the image", () => {
  const holes = prompt11({ values: (x, y) => (y === 10 && x === 10 ? 3 : y === 10 && x === 11 ? 5 : Math.hypot(x - 10.5, y - 10) > 2.9 && (x + y) % 3 !== 0 ? NaN : 1) });
  const run = Phot.measureAperture(holes, targetAt(holes, 10.5, 10), { ...prompt11Params, minAnnulusPixels: 20 }, { solidAngleSr: 1e-10 });
  assert.equal(run.status, "insufficient-background");
  assert.equal(run.measured, false);
  assert.equal(run.flux, null);
  assert.ok(run.annulus.validCount < 20 && run.annulus.nanCount > 0);
  assert.match(run.reasons.join(" "), /fewer than the minimum of 20/);

  // Near a corner of a small image most of the annulus is off the image.
  const small = observation({ width: 8, height: 8, values: () => 1, wcsFields: tanFields({ crpix: [4.5, 4.5] }) });
  const corner = Phot.measureAperture(small, targetAt(small, 1.2, 1.2), { radius: 1, innerRadius: 3, outerRadius: 5, minAnnulusPixels: 40, minCoverage: 0.5 });
  assert.equal(corner.status, "insufficient-background");

  // The same measurement with a modest minimum works.
  const fine = Phot.measureAperture(prompt11(), targetAt(prompt11(), 10.5, 10), { ...prompt11Params, minAnnulusPixels: 5 }, { solidAngleSr: 1e-10 });
  assert.equal(fine.status, "ok");
});

test("parameter checks refuse impossible geometry", () => {
  const obs = prompt11();
  const t = targetAt(obs, 10.5, 10);
  assert.equal(Phot.measureAperture(obs, t, { radius: 3, innerRadius: 2, outerRadius: 5 }).status, "invalid-parameters", "annulus inside the aperture");
  assert.equal(Phot.measureAperture(obs, t, { radius: 1, innerRadius: 3, outerRadius: 3 }).status, "invalid-parameters", "empty annulus");
  assert.equal(Phot.measureAperture(obs, t, { radius: -1 }).status, "invalid-parameters");
  assert.equal(Phot.measureAperture(obs, t, { radius: 1, innerRadius: 3, outerRadius: 5, minCoverage: 1.5 }).status, "invalid-parameters");
  assert.equal(Phot.measureAperture(obs, { ra: NaN, dec: 0 }, {}).status, "invalid-parameters");
  assert.equal(Phot.measureAperture(obs, t, { radius: 500, background: "none" }).status, "invalid-parameters");
  const noWcs = observation({ wcsFields: { CTYPE1: "RA---ARC", CTYPE2: "DEC--ARC" } });
  assert.equal(Phot.measureAperture(noWcs, { ra: 150, dec: 2 }, {}).status, "no-wcs");
  assert.deepEqual(["156.02", "-41.6", "0", "359.99999"].map((text) => Phot.parseCoordinate(text, "ra").ok), [true, true, true, true].map((_, i) => i !== 1));
  assert.equal(Phot.parseCoordinate("10h30m", "ra").ok, false);
  assert.equal(Phot.parseCoordinate("360", "ra").ok, false);
  assert.equal(Phot.parseCoordinate("-90.5", "dec").ok, false);
  assert.equal(Phot.parseCoordinate("", "dec").ok, false);
});

// ---- Position ---------------------------------------------------------------------------------------------------------------------
test("target off the image is not measured, edge positions are decided by pixel centres of the FITS grid", () => {
  const obs = observation();
  const outside = Phot.measureAperture(obs, targetAt(obs, 30, 10), prompt11Params);
  assert.equal(outside.status, "off-image");
  assert.equal(outside.measured, false);
  assert.equal(outside.flux, null);
  assert.equal(outside.inImage, false);
  assert.match(outside.reasons.join(" "), /outside this 21 × 21 pixel image/);
  assert.equal(Phot.measureAperture(obs, targetAt(obs, 0.45, 10), { radius: 2, background: "none", minCoverage: 0.1 }).status, "off-image");
  assert.notEqual(Phot.measureAperture(obs, targetAt(obs, 0.55, 10), { radius: 2, background: "none", minCoverage: 0.1 }).status, "off-image");
  // A position on the other side of the sky cannot be projected on a TAN plane at all.
  assert.equal(Phot.measureAperture(obs, { ra: 330, dec: -2 }, prompt11Params).status, "off-image");
  // The pixel position returned is the WCS position.
  const run = Phot.measureAperture(obs, targetAt(obs, 10.3, 9.8), prompt11Params);
  near(run.position.x, 10.3, 1e-8);
  near(run.position.y, 9.8, 1e-8);
});

test("radii in arcsec use the local pixel scale", () => {
  const obs = prompt11();
  const t = targetAt(obs, 10.5, 10);
  const pixelScale = 1e-5 * 206264.80624709636; // arcsec per pixel for 1e-10 sr pixels
  const inPixels = Phot.measureAperture(obs, t, prompt11Params, { solidAngleSr: 1e-10 });
  const inArcsec = Phot.measureAperture(obs, t, { radiusUnit: "arcsec", radius: 1.2 * pixelScale, innerRadius: 3 * pixelScale, outerRadius: 5 * pixelScale, minAnnulusPixels: 10 }, { solidAngleSr: 1e-10 });
  near(inArcsec.aperture.radiusPixels, 1.2, 1e-6);
  relative(inArcsec.flux.microJy, inPixels.flux.microJy, 1e-6);
  near(inArcsec.pixelScaleArcsec, pixelScale, 1e-4);
});

test("pixel solid angle from the WCS matches the analytic value", () => {
  const obs = observation({ wcsFields: tanFields({ ra: 10, dec: 60, scale: 6.142 / 3600, crpix: [11, 11] }) });
  // On a TAN plane the solid angle of a square pixel at angular distance theta from the reference point is s^2 cos^3(theta) (rad^2).
  for (const [col, row] of [[10, 10], [0, 0], [20, 20], [5, 17]]) {
    const sky = obs.wcs.pixelToSky(col + 1, row + 1);
    const centre = obs.wcs.pixelToSky(11, 11);
    const theta = Wcs.angularSeparation(sky.ra, sky.dec, centre.ra, centre.dec) / degPerRad;
    const s = 6.142 / 3600 / degPerRad;
    relative(Phot.pixelSolidAngle(obs.wcs, col, row), s * s * Math.cos(theta) ** 3, 1e-5, "pixel " + col + "," + row);
  }
});

// ---- Wavelength ----------------------------------------------------------------------------------------------------------------------
function waveTableBytes(fn) {
  const xs = [1, 11, 21];
  const ys = [1, 6, 11];
  const bytes = new ArrayBuffer((xs.length + ys.length) * 4 + 2 * xs.length * ys.length * 4);
  const view = new DataView(bytes);
  xs.forEach((value, index) => view.setInt32(index * 4, value));
  ys.forEach((value, index) => view.setInt32(xs.length * 4 + index * 4, value));
  for (let iy = 0; iy < ys.length; iy++) {
    for (let ix = 0; ix < xs.length; ix++) {
      const [wave, band] = fn(xs[ix], ys[iy]);
      const at = (xs.length + ys.length) * 4 + 2 * (ix + xs.length * iy) * 4;
      view.setFloat32(at, wave);
      view.setFloat32(at + 4, band);
    }
  }
  return bytes;
}
const tableFields = { XTENSION: "BINTABLE", NAXIS1: 6 * 4 + 18 * 4, NAXIS2: 1, TFIELDS: 3, TTYPE1: "X", TFORM1: "3J", TTYPE2: "Y", TFORM2: "3J", TTYPE3: "VALUES", TFORM3: "18E" };
const waveHeader = { CRPIX1W: 0, CRPIX2W: 0, CRVAL1W: 1, CRVAL2W: 1, CDELT1W: 1, CDELT2W: 1, CUNIT1W: "um", CUNIT2W: "um", PV1_3W: 1, PV2_3W: 2, PS1_0W: "WCS-WAVE", PS1_1W: "VALUES", PS1_2W: "X", PS2_2W: "Y" };
const waveTable = Pair.parseWaveTable(waveTableBytes((x, y) => [1 + 0.01 * x + 0.02 * y, 0.5 + 0.001 * x]), tableFields, waveHeader);

test("wavelength comes from the per-pixel lookup at the target pixel, never from a name or a detector", () => {
  assert.ok(waveTable);
  const obs = prompt11({ waveTable, fields: { ...waveHeader, DETECTOR: 5, FILTER: "wrong 9.9 um" } });
  const t = targetAt(obs, 10.5, 10);
  const run = Phot.measureAperture(obs, t, prompt11Params, { solidAngleSr: 1e-10 });
  // Lookup coordinate = pixel - CRPIX + CRVAL = pixel + 1. Linear field, so bilinear interpolation is exact.
  const x = 10.5 + 1;
  const y = 10 + 1;
  near(run.wavelength.micron, 1 + 0.01 * x + 0.02 * y, 1e-5);
  near(run.wavelength.bandwidth, 0.5 + 0.001 * x, 1e-6);
  assert.equal(run.spectrumPoint, true);
  assert.ok(run.wavelength.rangeMax >= run.wavelength.micron && run.wavelength.rangeMin <= run.wavelength.micron);
  // The same pixel scale of an image in another place of the table gives another wavelength.
  const other = Phot.measureAperture(obs, targetAt(obs, 4, 4), { radius: 1.2, background: "none" }, { solidAngleSr: 1e-10 });
  assert.notEqual(other.wavelength.micron, run.wavelength.micron);
});

test("missing wavelength calibration: the flux is shown but it is not a spectrum point and no CSV row exists", () => {
  const none = prompt11();
  const run = Phot.measureAperture(none, targetAt(none, 10.5, 10), prompt11Params, { solidAngleSr: 1e-10 });
  assert.equal(run.measured, true);
  assert.equal(run.wavelength, null);
  assert.equal(run.spectrumPoint, false);
  assert.match(run.notSpectrumReason, /no readable WCS-WAVE/);
  assert.equal(Phot.csvRow(run, { sourceId: "s", obsId: "o" }), null);
  // A table that does not cover the pixel, or that the header cannot use, also refuses the point.
  const shifted = prompt11({ waveTable, fields: { ...waveHeader, CRPIX1W: -500 } });
  const outside = Phot.measureAperture(shifted, targetAt(shifted, 10.5, 10), prompt11Params, { solidAngleSr: 1e-10 });
  assert.equal(outside.spectrumPoint, false);
  assert.match(outside.wavelengthReason, /does not cover/);
  const withPc = prompt11({ waveTable, fields: { ...waveHeader, PC1_1W: 1 } });
  assert.equal(Phot.measureAperture(withPc, targetAt(withPc, 10.5, 10), prompt11Params, { solidAngleSr: 1e-10 }).spectrumPoint, false);
  // No wavelength in the CSV rows list of a mixed run.
  const withTable = prompt11({ waveTable, fields: waveHeader });
  const rows = [none, withTable].map((obs) => Phot.csvRow(Phot.measureAperture(obs, targetAt(obs, 10.5, 10), prompt11Params, { solidAngleSr: 1e-10 }), { sourceId: "s", obsId: obs.name })).filter(Boolean);
  assert.equal(rows.length, 1);
});

// ---- Uncertainty ------------------------------------------------------------------------------------------------------------------------
function expectedSigmaMicroJy(run, variance, kind) {
  // Independent restatement of the model in the file header: Var = SUM (w Omega)^2 var + (SUM w Omega)^2 var_b.
  const omega = 1e-10;
  const weights = run.pixels.filter((entry) => entry.status === "valid");
  const apertureTerm = weights.reduce((sum, entry) => sum + (entry.w * omega) ** 2 * variance, 0);
  const sumWeightOmega = weights.reduce((sum, entry) => sum + entry.w * omega, 0);
  const k = kind === "median" ? Math.PI / 2 : 1;
  const backgroundTerm = kind === "none" ? 0 : sumWeightOmega ** 2 * k * variance / run.annulus.usedCount;
  return 1e12 * Math.sqrt(apertureTerm + backgroundTerm);
}

test("variance propagation: aperture term plus background-level term, in microJy", () => {
  const v = 0.04; // (MJy/sr)^2
  const obs = prompt11({ variance: () => v });
  const t = targetAt(obs, 10.5, 10);
  for (const background of ["mean", "median", "none"]) {
    const run = Phot.measureAperture(obs, t, { ...prompt11Params, background }, { solidAngleSr: 1e-10 });
    assert.ok(run.fluxErrMicroJy > 0, background);
    relative(run.fluxErrMicroJy, expectedSigmaMicroJy(run, v, background), 1e-9, background);
  }
  // Hand calculation for the no-background case: 2 full pixels plus the partial ones of the r = 1.2 circle.
  const noBackground = Phot.measureAperture(obs, t, { radius: 1.2, background: "none" }, { solidAngleSr: 1e-10 });
  const sumW2 = noBackground.pixels.reduce((sum, entry) => sum + entry.w * entry.w, 0);
  relative(noBackground.fluxErrMicroJy, 1e12 * 1e-10 * Math.sqrt(sumW2 * v), 1e-12);
  assert.match(noBackground.fluxErrReason, /VARIANCE image/);
});

test("variance propagation agrees with a Monte Carlo of the same noise", () => {
  // Gaussian noise of sigma 0.2 MJy/sr on a flat image; mean background without clipping so the model is exactly the one tested.
  let seed = 12345;
  const random = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  const sigma = 0.2;
  const params = { radius: 2.5, innerRadius: 4, outerRadius: 8, background: "mean", clipSigma: 1e9, minAnnulusPixels: 10 };
  const fluxes = [];
  let modelled;
  for (let trial = 0; trial < 2500; trial++) {
    const noise = Float64Array.from({ length: 21 * 21 }, () => 3 + sigma * gauss());
    const obs = observation({ values: (x, y) => noise[(y - 1) * 21 + x - 1], variance: () => sigma * sigma });
    const run = Phot.measureAperture(obs, targetAt(obs, 10.3, 10.6), params, { solidAngleSr: 1e-10 });
    fluxes.push(run.flux.microJy);
    modelled = run.fluxErrMicroJy;
  }
  const mean = fluxes.reduce((a, b) => a + b, 0) / fluxes.length;
  const spread = Math.sqrt(fluxes.reduce((a, b) => a + (b - mean) ** 2, 0) / (fluxes.length - 1));
  // The standard deviation of 2500 draws is known to about 1.4%; allow 6%.
  relative(spread, modelled, 0.06, "Monte Carlo spread " + spread + " vs model " + modelled);
  assert.ok(Math.abs(mean) < 4 * spread / Math.sqrt(fluxes.length) + 1e-9, "flux of pure noise around a constant has mean zero (mean " + mean + ")");
});

test("no uncertainty without a usable VARIANCE image", () => {
  const t = (obs) => targetAt(obs, 10.5, 10);
  const none = prompt11();
  assert.equal(Phot.measureAperture(none, t(none), prompt11Params, { solidAngleSr: 1e-10 }).fluxErrMicroJy, null);
  const wrongUnit = prompt11({ variance: () => 0.04, varianceUnit: "Jy2/sr2" });
  const wrong = Phot.measureAperture(wrongUnit, t(wrongUnit), prompt11Params, { solidAngleSr: 1e-10 });
  assert.equal(wrong.fluxErrMicroJy, null);
  assert.match(wrong.fluxErrReason, /not the square of the image unit/);
  for (const unit of ["MJy2 / sr2", "MJy^2/sr^2", "(MJy/sr)^2", "MJy2/sr2"]) {
    const ok = prompt11({ variance: () => 0.04, varianceUnit: unit });
    assert.ok(Phot.measureAperture(ok, t(ok), prompt11Params, { solidAngleSr: 1e-10 }).fluxErrMicroJy > 0, unit);
  }
  // A kJy/sr image needs a kJy2/sr2 variance and the error scales with the unit.
  const kilo = prompt11({ unit: "kJy/sr", variance: () => 0.04, varianceUnit: "kJy2/sr2" });
  const base = prompt11({ variance: () => 0.04 });
  const kiloRun = Phot.measureAperture(kilo, t(kilo), prompt11Params, { solidAngleSr: 1e-10 });
  relative(kiloRun.fluxErrMicroJy, Phot.measureAperture(base, t(base), prompt11Params, { solidAngleSr: 1e-10 }).fluxErrMicroJy * 1e-3, 1e-9);
  // A NaN or negative variance in the aperture, or no BUNIT (assumed), is handled explicitly.
  const gap = prompt11({ variance: (x, y) => (x === 10 && y === 10 ? NaN : 0.04) });
  const gapRun = Phot.measureAperture(gap, t(gap), prompt11Params, { solidAngleSr: 1e-10 });
  assert.equal(gapRun.fluxErrMicroJy, null);
  assert.match(gapRun.fluxErrReason, /no valid variance/);
  const assumed = prompt11({ variance: () => 0.04, varianceUnit: null });
  const assumedRun = Phot.measureAperture(assumed, t(assumed), prompt11Params, { solidAngleSr: 1e-10 });
  assert.ok(assumedRun.fluxErrMicroJy > 0);
  assert.match(assumedRun.fluxErrReason, /assumed to be the square/);
});

// ---- CSV contract ---------------------------------------------------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; } else if (c === "\r") { /* skip */ } else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

test("CSV contract: header, units, empty uncertainty, quoting, order by wavelength", () => {
  assert.deepEqual(Phot.csvColumns, ["source_id", "obs_id", "mjd", "ra", "dec", "wavelength", "lambda_width", "flux", "flux_err", "flags", "method"]);
  const withError = prompt11({ waveTable, fields: waveHeader, variance: () => 0.04, name: "OBS-A" });
  assert.equal(Phot.csvField(60819.18394944444, "mjd"), "60819.183949444");
  const noError = prompt11({ waveTable, fields: { ...waveHeader, "MJD-AVG": 60819.5, "DATE-AVG": "2025-05-24T12:00:00.000" }, name: "OBS,B" });
  noError.values[0] = 1; // unchanged background
  const rows = [withError, noError].map((obs) => Phot.csvRow(Phot.measureAperture(obs, targetAt(obs, 10.5, 10), prompt11Params, { solidAngleSr: 1e-10 }), { sourceId: 'target "1", north', obsId: obs.name, detector: 2, fileName: obs.name + ".fits" }));
  assert.ok(rows.every(Boolean));
  const csv = Phot.toCsv(rows);
  const table = parseCsv(csv);
  assert.deepEqual(table[0].slice(0, 11), Phot.csvColumns, "contract header, lowercase, exact");
  assert.equal(table[0][11], "x_image", "extra columns follow the contract columns");
  assert.ok(csv.startsWith("source_id,obs_id,mjd,ra,dec,wavelength,lambda_width,flux,flux_err,flags,method,"));
  assert.equal(table.length, 3);
  const [first] = table.slice(1);
  const column = (name) => table[0].indexOf(name);
  assert.equal(first[column("source_id")], 'target "1", north', "quoting survives a round trip");
  assert.equal(first[column("method")], "aperture-photometry");
  assert.equal(Number(first[column("flags")]), 0);
  near(Number(first[column("flux")]), 600, 1e-6);
  assert.ok(Number(first[column("flux_err")]) > 0);
  near(Number(first[column("wavelength")]), rows[0].wavelength, 1e-9);
  assert.equal(table[2][column("flux_err")], "", "unknown uncertainty is an empty field, not 0");
  assert.equal(table[2][column("obs_id")], "OBS,B");
  // mjd: mid-exposure when MJD-AVG and DATE-AVG agree, else the start from DATE-OBS.
  near(Number(table[2][column("mjd")]), 60819.5, 1e-9);
  assert.equal(table[2][column("mjd_source")], "MJD-AVG");
  near(Number(table[1][column("mjd")]), Pair.parseObservationTime({ "DATE-OBS": "2025-05-24T04:24:53.232" }).mjd, 1e-9);
  assert.equal(table[1][column("mjd_source")], "MJD-OBS");
  // Rows are sorted by wavelength (equal here, so only check that a sort is stable and numeric).
  const sorted = Phot.toCsv([{ ...rows[0], wavelength: 3 }, { ...rows[0], wavelength: 1.5 }]);
  assert.deepEqual(parseCsv(sorted).slice(1).map((r) => Number(r[5])), [1.5, 3]);
  assert.equal(Phot.csvField(null), "");
  assert.equal(Phot.csvField(NaN), "");
  assert.equal(Phot.csvField("a\nb"), '"a\nb"');
});

test("observation time: UTC only, mid-exposure preferred, no guessing for other time scales", () => {
  assert.equal(Phot.observationEpoch({ TIMESYS: "UTC", "MJD-AVG": 60819.184615634, "DATE-AVG": "2025-05-24T04:25:50.791", "MJD-OBS": 60819.183949444, "DATE-OBS": "2025-05-24T04:24:53.232" }).source, "MJD-AVG");
  const start = Phot.observationEpoch({ TIMESYS: "UTC", "DATE-OBS": "2025-05-24T04:24:53.232", "MJD-OBS": 60819.183949444 });
  assert.equal(start.source, "MJD-OBS");
  near(start.mjd, 60819.183949444, 1e-9);
  const tai = Phot.observationEpoch({ TIMESYS: "TAI", "DATE-OBS": "2025-05-24T04:24:53.232" });
  assert.equal(tai.mjd, null);
  assert.match(tai.reason, /TAI/);
  assert.equal(Phot.observationEpoch({}).mjd, null);
  assert.equal(Phot.observationEpoch({ TIMESYS: "UTC", "DATE-OBS": "2025-05-24T04:24:53.232", "MJD-OBS": 60000 }).mjd, null, "disagreeing times are not trusted");
});

// ---- A synthetic FITS file through the shared reader --------------------------------------------------------------------------------------
const fitsSandbox = vm.createContext({ TextDecoder, document: { querySelector: () => null }, atob, Uint8Array });
const fitsLib = vm.runInContext(readFileSync(join(root, "tools/fits.js"), "utf8") + "\n({ readFitsHdus, fitsPixelReader });", fitsSandbox);

async function observationFromBytes(bytes, name) {
  const file = new File([bytes], name);
  const hdus = await fitsLib.readFitsHdus(file);
  const index = hdus.findIndex((hdu) => hdu.renderable);
  const hdu = hdus[index];
  const data = await file.slice(hdu.dataStart, hdu.dataStart + hdu.byteLength).arrayBuffer();
  const read = fitsLib.fitsPixelReader(data, hdu);
  const values = Float64Array.from({ length: hdu.pixels }, (_, i) => read(i));
  const created = Wcs.createWcs(hdu.fields);
  return { name, width: hdu.axes[0], height: hdu.axes[1], values, unit: hdu.fields.BUNIT, wcs: created.ok ? created.wcs : null, fields: hdu.fields, cards: hdu.cards };
}

const prompt11Params0 = { radius: 1.2, innerRadius: 3, outerRadius: 5, minAnnulusPixels: 10, minCoverage: 0.5 };
test("a synthetic FITS file: BSCALE, BZERO and BLANK are applied once and a BLANK pixel stays invalid", async () => {
  const wcsPairs = Object.entries(tanFields()).filter(([key]) => key !== "RADESYS").concat([["RADESYS", "ICRS"]]);
  // Stored integers v; physical value = 0.5 * v + 10. A pixel of 4 MJy/sr is stored as -12; BLANK = -32768 marks an invalid pixel.
  const bytes = buildFits({
    width: 21, height: 21, bitpix: 16,
    extra: [["BSCALE", 0.5], ["BZERO", 10], ["BLANK", -32768], ["BUNIT", "MJy/sr"], ["DATE-OBS", "2025-05-24T04:24:53.232"], ["TIMESYS", "UTC"], ...wcsPairs],
    pixels: (x, y) => (x === 9 && y === 9 ? -32768 : x === 10 && y === 9 ? -12 : -18), // (10,10) FITS = -12 -> 4 MJy/sr; others -18 -> 1 MJy/sr
  });
  const obs = await observationFromBytes(bytes, "synthetic.fits");
  assert.ok(Number.isNaN(obs.values[9 * 21 + 9]), "BLANK becomes NaN");
  assert.equal(obs.values[9 * 21 + 10], 4, "0.5 * -12 + 10");
  assert.equal(obs.values[0], 1, "0.5 * -18 + 10");
  const run = Phot.measureAperture(obs, targetAt(obs, 10.5, 10), prompt11Params0, { solidAngleSr: 1e-10 });
  assert.equal(run.status, "partial-aperture");
  assert.equal(run.pixels.find((p) => p.x === 10 && p.y === 10).status, "nan");
  relative(run.flux.microJy, 300, 1e-12, "(4 - 1) MJy/sr * 1e-10 sr, the BLANK pixel left out");
});

// ---- Real data -------------------------------------------------------------------------------------------------------------------------------
// A separate, deliberately plain implementation: every number is computed again from the arrays and the WCS with different code.
function plainMeasurement(obs, ra, dec, { radius, inner, outer, sigma = 3, iterations = 5, bad = () => false }) {
  const p = obs.wcs.skyToPixel(ra, dec);
  const n = 400;
  const ring = [];
  const apertureSamples = [];
  let area = 0;
  let validArea = 0;
  for (let row = 0; row < obs.height; row++) {
    for (let col = 0; col < obs.width; col++) {
      const index = row * obs.width + col;
      const dx = col + 1 - p.x;
      const dy = row + 1 - p.y;
      if (Math.abs(dx) > outer + 1 || Math.abs(dy) > outer + 1) continue;
      // Aperture weight by sub-pixel counting.
      let w = 0;
      if (Math.hypot(Math.abs(dx) - 0.5, Math.abs(dy) - 0.5) < radius) {
        let hit = 0;
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
          const x = col + 0.5 + (i + 0.5) / n;
          const y = row + 0.5 + (j + 0.5) / n;
          if ((x - p.x) ** 2 + (y - p.y) ** 2 <= radius * radius) hit++;
        }
        w = hit / (n * n);
      }
      const valid = Number.isFinite(obs.values[index]) && !bad(index);
      if (w > 0) {
        area += w;
        // Solid angle by the Jacobian of the sky position at the pixel centre (finite differences of 1e-3 pixel).
        const h = 1e-3;
        const c = obs.wcs.pixelToSky(col + 1, row + 1);
        const e = obs.wcs.pixelToSky(col + 1 + h, row + 1);
        const nn = obs.wcs.pixelToSky(col + 1, row + 1 + h);
        const cosd = Math.cos(c.dec / degPerRad);
        const dAx = (e.ra - c.ra) * cosd / h, dDx = (e.dec - c.dec) / h, dAy = (nn.ra - c.ra) * cosd / h, dDy = (nn.dec - c.dec) / h;
        const omega = Math.abs(dAx * dDy - dAy * dDx) / (degPerRad * degPerRad);
        if (valid) { validArea += w; apertureSamples.push({ w, value: obs.values[index], omega }); }
      } else if (valid && Math.hypot(dx, dy) >= inner && Math.hypot(dx, dy) <= outer) {
        ring.push(obs.values[index]);
      }
    }
  }
  let kept = ring.slice();
  for (let it = 0; it < iterations; it++) {
    const sorted = kept.slice().sort((a, b) => a - b);
    const med = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    const m = kept.reduce((a, b) => a + b, 0) / kept.length;
    const sd = Math.sqrt(kept.reduce((a, b) => a + (b - m) ** 2, 0) / kept.length);
    const next = kept.filter((v) => Math.abs(v - med) <= sigma * sd);
    if (next.length === kept.length) break;
    kept = next;
  }
  const sorted = kept.slice().sort((a, b) => a - b);
  const b = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  let sum = 0;
  for (const s of apertureSamples) sum += s.w * (s.value - b) * s.omega;
  return { x: p.x, y: p.y, background: b, ringUsed: kept.length, ringTotal: ring.length, coverage: validArea / (Math.PI * radius * radius), microJy: 1e6 * sum * 1e6 };
}

const exampleTarget = { ra: 156.02411, dec: -41.66916 };
const realParams = { radius: 2.5, innerRadius: 4, outerRadius: 7, minAnnulusPixels: 20 };

async function loadBundled(encoded, name) {
  const bytes = Buffer.from(encoded, "base64");
  const file = new File([bytes], name);
  const hdus = await fitsLib.readFitsHdus(file);
  const hdu = hdus.find((entry) => entry.fields.EXTNAME === "IMAGE");
  const read = async (entry, Type = Float64Array) => {
    const data = await file.slice(entry.dataStart, entry.dataStart + entry.byteLength).arrayBuffer();
    const reader = fitsLib.fitsPixelReader(data, entry);
    return Type.from({ length: entry.pixels }, (_, i) => reader(i));
  };
  const values = await read(hdu);
  const table = hdus.find((entry) => entry.fields.EXTNAME === (hdu.fields.PS1_0W ?? "WCS-WAVE"));
  const waveTable = table ? Pair.parseWaveTable(await file.slice(table.dataStart, table.dataStart + table.byteLength).arrayBuffer(), table.fields, hdu.fields) : null;
  const variance = hdus.find((entry) => entry !== hdu && entry.fields.EXTNAME === "VARIANCE");
  const flags = hdus.find((entry) => entry !== hdu && entry.fields.EXTNAME === "FLAGS");
  const created = Wcs.createWcs(hdu.fields);
  return {
    name, width: hdu.axes[0], height: hdu.axes[1], values, unit: hdu.fields.BUNIT, wcs: created.ok ? created.wcs : null, fields: hdu.fields, cards: hdu.cards, waveTable,
    variance: variance ? await read(variance) : undefined, varianceUnit: variance?.fields.BUNIT,
    flags: flags ? await read(flags, Uint32Array) : undefined, flagDefinitions: flags ? Phot.flagDefinitions(flags.cards).definitions : undefined,
    hduNames: hdus.map((entry) => entry.name),
  };
}

const bundledPair = vm.runInNewContext(readFileSync(join(root, "assets/tools/spherex-time-machine-example.js"), "utf8") + "\nspherexTimeMachineExample;");
const bundledSingle = vm.runInNewContext(readFileSync(join(root, "assets/tools/spherex-example.js"), "utf8") + "\nspherexExampleData;");
const realReference = await loadBundled(bundledPair.reference, "2025W21_2C_0280_1-D2.fits");
const realComparison = await loadBundled(bundledPair.comparison, "2025W24_1A_0514_1-D2.fits");
const realSingle = await loadBundled(bundledSingle, "SPHEREx-QR2-D2.fits");

test("real data: the bundled cutouts have IMAGE and WCS-WAVE only, so there is no uncertainty and no flag", () => {
  assert.deepEqual(Array.from(realReference.hduNames), ["Primary", "IMAGE", "WCS-WAVE"]);
  assert.deepEqual(Array.from(realSingle.hduNames), ["Primary", "IMAGE"]);
  assert.equal(realReference.variance, undefined);
  assert.equal(realReference.flags, undefined);
  assert.equal(realReference.unit, "MJy / sr");
  assert.ok(realReference.waveTable && realComparison.waveTable);
  assert.equal(realSingle.waveTable, null);
});

test("real data: aperture photometry of the bright source in the bundled SPHEREx cutouts matches a separate implementation", () => {
  for (const [obs, expectedWavelength] of [[realReference, 1.3064], [realComparison, null]]) {
    const run = Phot.measureAperture(obs, exampleTarget, realParams);
    const plain = plainMeasurement(obs, exampleTarget.ra, exampleTarget.dec, { radius: 2.5, inner: 4, outer: 7 });
    console.log("  real", obs.name, "flux", run.flux?.microJy, "uJy; plain", plain.microJy, "; background", run.background?.value, "vs", plain.background, "; status", run.status, "; wavelength", run.wavelength?.micron);
    assert.equal(run.status, "ok", obs.name + ": " + run.reasons.join(" "));
    near(run.position.x, plain.x, 1e-9);
    near(run.position.y, plain.y, 1e-9);
    near(run.aperture.coverage, plain.coverage, 1e-4); // the reference counts 400 x 400 sub-pixels per pixel
    // Same background: both do the same clipping about the same ring (no flags in these files).
    assert.equal(run.annulus.validCount, plain.ringTotal);
    assert.equal(run.annulus.usedCount, plain.ringUsed);
    relative(run.background.value, plain.background, 1e-12, "background");
    // Flux: exact weights and the spherical solid angle against 400 x 400 sub-pixel counting and a finite-difference Jacobian.
    relative(run.flux.microJy, plain.microJy, 1e-4, obs.name + " flux");
    assert.equal(run.fluxErrMicroJy, null, "no VARIANCE image in the bundled cutouts");
    assert.equal(run.flags, 0, "no FLAGS image: nothing is flagged and nothing is claimed");
    assert.equal(run.spectrumPoint, true);
    assert.ok(run.flux.microJy > 1e4, "a bright source (tens of mJy)");
    // The wavelength is the one of the file's own spectral WCS at the target pixel (verified against Astropy in pair.test.mjs).
    const direct = Pair.wavelengthAt(obs.waveTable, obs.fields, run.position.x, run.position.y);
    near(run.wavelength.micron, direct.micron, 1e-12);
    near(run.wavelength.bandwidth, direct.bandwidth, 1e-12);
    if (expectedWavelength) near(run.wavelength.micron, expectedWavelength, 1e-3);
    // The WCS pixel solid angle agrees with the pipeline's own OMEGA_MEDIAN to well under 1%.
    near(run.omega.ratioToHeader, 1, 5e-3);
  }
  // The two observations are two different wavelengths of the same sky position.
  const a = Phot.measureAperture(realReference, exampleTarget, realParams);
  const b = Phot.measureAperture(realComparison, exampleTarget, realParams);
  assert.notEqual(a.wavelength.micron.toFixed(3), b.wavelength.micron.toFixed(3));
  assert.notEqual(a.epoch.mjd, b.epoch.mjd);
});

test("real data: the single bundled cutout has no wavelength table, so its flux is not a spectrum point", () => {
  const run = Phot.measureAperture(realSingle, exampleTarget, realParams);
  assert.equal(run.measured, true);
  assert.equal(run.spectrumPoint, false);
  assert.equal(run.wavelength, null);
  assert.equal(Phot.csvRow(run, { sourceId: "x" }), null);
  const ref = Phot.measureAperture(realReference, exampleTarget, realParams);
  assert.equal(run.flux.microJy, ref.flux.microJy, "the same observation gives the same flux whatever file it came in");
});

test("real data: a position outside the real cutouts is not measured", () => {
  const run = Phot.measureAperture(realReference, { ra: 150, dec: -41.6 }, realParams);
  assert.equal(run.status, "off-image");
  const edge = Phot.measureAperture(realReference, realReference.wcs.pixelToSky(1.5, 35), { radius: 2.5, innerRadius: 4, outerRadius: 7, minCoverage: 0.5 });
  assert.equal(edge.status, "partial-aperture");
});

const cutoutPath = process.env.ASTRONOT_SPHEREX_CUTOUT;
test("real full IRSA cutout (IMAGE, FLAGS, VARIANCE, WCS-WAVE): flags, error and wavelength agree with a separate implementation", { skip: !cutoutPath || !existsSync(cutoutPath) ? "set ASTRONOT_SPHEREX_CUTOUT to a downloaded SPHEREx QR2 cutout" : false }, async () => {
  const bytes = readFileSync(cutoutPath);
  const full = await loadBundled(bytes.toString("base64"), "irsa-cutout.fits");
  assert.ok(full.variance && full.flags && full.waveTable);
  const run = Phot.measureAperture(full, exampleTarget, realParams);
  const bad = Phot.bitMask(full.flagDefinitions, Phot.excludedFlagNames);
  const plain = plainMeasurement(full, exampleTarget.ra, exampleTarget.dec, { radius: 2.5, inner: 4, outer: 7, bad: (index) => (full.flags[index] & bad) !== 0 });
  console.log("  full cutout flux", run.flux.microJy, "+-", run.fluxErrMicroJy, "uJy; plain", plain.microJy, "; wavelength", run.wavelength.micron, "um; flags", run.flags, run.flagNames.map((x) => x.name).join("|"));
  assert.equal(run.status, "ok");
  assert.equal(run.annulus.validCount, plain.ringTotal);
  relative(run.background.value, plain.background, 1e-12);
  relative(run.flux.microJy, plain.microJy, 1e-4);
  assert.ok(run.fluxErrMicroJy > 0 && run.fluxErrMicroJy < 0.05 * run.flux.microJy);
  // The same noise model written out again from the arrays.
  const weights = Phot.apertureWeights(run.position.x, run.position.y, 2.5, full.width, full.height);
  let apertureTerm = 0;
  let sumWeightOmega = 0;
  for (const entry of weights) {
    const omega = Phot.pixelSolidAngle(full.wcs, entry.column, entry.row);
    apertureTerm += (entry.w * omega) ** 2 * full.variance[entry.index];
    sumWeightOmega += entry.w * omega;
  }
  assert.ok(run.annulus.usedCount > 0);
  assert.ok(run.fluxErrMicroJy >= 1e12 * Math.sqrt(apertureTerm) * (1 - 1e-9), "the error includes at least the aperture term");
  assert.ok(sumWeightOmega > 0);
  near(run.omega.ratioToHeader, 1, 5e-3);
  assert.equal(run.flags & (1 << 21), 1 << 21, "the SOURCE flag of the bright source is propagated");
  const row = Phot.csvRow(run, { sourceId: "real", obsId: "2025W21_2C_0280_1", detector: 2, fileName: "irsa-cutout.fits" });
  assert.ok(row && row.flux_err > 0);
});
