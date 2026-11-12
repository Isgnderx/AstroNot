// Run with:  node --test tests/        (or: node tests/pair.test.mjs)
//
// Covers tools/pair.js, the observation-pair model behind Time Machine (and, later, Image Differencing):
// observation time, sky overlap, pixel-grid check, duplicate detection, link/blink decisions, shared view maths,
// display-only alignment, wavelength lookup and blink settings.
//   - Sections that build headers and arrays in this file are synthetic fixtures, not archive data.
//   - The "real pair" section uses assets/tools/spherex-time-machine-example.js: two IRSA SPHEREx QR2 cutouts of one
//     field (2025W21_2C_0280_1 and 2025W24_1A_0514_1, detector 2) on different dates. The expected wavelengths there
//     are the values Astropy WCS (key 'W') returned for the same files when the asset was made.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const Wcs = require("../tools/wcs.js");
const Pair = require("../tools/pair.js");

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

function observation(name, { size = 20, wcsFields = tanFields(), header = {}, values, unit = "MJy / sr", obsId = name, detector = 2 } = {}) {
  const fields = { BUNIT: unit, OBSID: obsId, DETECTOR: detector, XPOSURE: 100, RADESYS: "ICRS", "DATE-OBS": "2025-05-24T04:24:53.232", TIMESYS: "UTC", ...header };
  const hdu = { fields, axes: [size, size], name: "IMAGE" };
  const created = wcsFields ? Wcs.createWcs(wcsFields) : { ok: false, reason: "none" };
  const data = values ?? Float64Array.from({ length: size * size }, (_, i) => ((i * 7919) % 101) + name.charCodeAt(0));
  return {
    name, meta: Pair.describeObservation(hdu, 1), width: size, height: size, values: data,
    wcs: created.ok ? created.wcs : null, wcsReason: created.ok ? "" : created.reason, fingerprint: Pair.fingerprintValues(data),
  };
}

// ---- Observation time ---------------------------------------------------------------------------------------------------
test("time: DATE-OBS and MJD-OBS that agree give one valid UTC time", () => {
  const t = Pair.parseObservationTime({ "DATE-OBS": "2025-05-24T04:24:53.232", "MJD-OBS": 60819.183949444, TIMESYS: "UTC" });
  assert.equal(t.valid, true);
  assert.equal(t.scale, "UTC");
  assert.equal(t.display, "2025-05-24 04:24:53");
  assert.equal(t.sourceLabel, "DATE-OBS and MJD-OBS");
  near(t.mjd, 60819.183949444, 1e-8);
});

test("time: either keyword alone is enough, and the source is named", () => {
  const onlyDate = Pair.parseObservationTime({ "DATE-OBS": "2025-05-24T04:24:53", TIMESYS: "UTC" });
  assert.equal(onlyDate.sourceLabel, "DATE-OBS");
  near(onlyDate.mjd, 60819.1839, 1e-4);
  const onlyMjd = Pair.parseObservationTime({ "MJD-OBS": 60819.5, TIMESYS: "UTC" });
  assert.equal(onlyMjd.sourceLabel, "MJD-OBS");
  assert.equal(onlyMjd.display, "2025-05-24 12:00:00");
});

test("time: no usable keyword means Observation time unavailable, and DATE is never the observation time", () => {
  const t = Pair.parseObservationTime({ DATE: "2025-09-18T17:26:58.386", TIMESYS: "UTC" });
  assert.equal(t.valid, false);
  assert.equal(t.reason, "Observation time unavailable");
  assert.equal(t.processed, "2025-09-18T17:26:58.386");
  assert.equal(Pair.parseObservationTime({}).reason, "Observation time unavailable");
  assert.equal(Pair.parseObservationTime(undefined).valid, false);
});

test("time: invalid dates, implausible MJD, conflicts and unsupported scales are not trusted", () => {
  assert.equal(Pair.parseObservationTime({ "DATE-OBS": "2025-02-30T00:00:00" }).valid, false);
  assert.equal(Pair.parseObservationTime({ "DATE-OBS": "24/05/25" }).valid, false);
  assert.equal(Pair.parseObservationTime({ "DATE-OBS": "2025-05-24T25:00:00" }).valid, false);
  assert.equal(Pair.parseObservationTime({ "MJD-OBS": 12.5 }).valid, false);
  assert.equal(Pair.parseObservationTime({ "MJD-OBS": "60819" }).valid, false);
  const conflict = Pair.parseObservationTime({ "DATE-OBS": "2025-05-24T04:24:53", "MJD-OBS": 60820.2 });
  assert.equal(conflict.valid, false);
  assert.match(conflict.issues.join(" "), /disagree/);
  assert.equal(Pair.parseObservationTime({ "DATE-OBS": "2025-05-24T04:24:53", TIMESYS: "LOCAL" }).valid, false);
});

test("time: a missing TIMESYS assumes UTC and says so; date-only values have day precision", () => {
  const t = Pair.parseObservationTime({ "DATE-OBS": "2025-05-24" });
  assert.equal(t.valid, true);
  assert.equal(t.scale, "UTC");
  assert.equal(t.precision, "day");
  assert.equal(t.display, "2025-05-24");
  assert.match(t.issues.join(" "), /TIMESYS is missing/);
});

test("time: a manual time is UTC and labelled as entered manually", () => {
  const t = Pair.manualObservationTime("2024-01-02T03:04:05", "2025-09-18");
  assert.equal(t.valid, true);
  assert.equal(t.manual, true);
  assert.equal(t.sourceLabel, "Entered manually");
  assert.equal(t.display, "2024-01-02 03:04:05");
  assert.equal(Pair.manualObservationTime("yesterday").valid, false);
  assert.equal(Pair.manualObservationTime("2024-13-01").valid, false);
});

test("time: comparing and ordering", () => {
  const a = Pair.parseObservationTime({ "DATE-OBS": "2025-05-24T04:24:53", TIMESYS: "UTC" });
  const b = Pair.parseObservationTime({ "DATE-OBS": "2025-06-11T14:21:56", TIMESYS: "UTC" });
  const forward = Pair.compareTimes(a, b);
  assert.equal(forward.state, "ordered");
  assert.equal(forward.earlier, "reference");
  assert.equal(forward.text, "18 d 9 h after the reference");
  const backward = Pair.compareTimes(b, a);
  assert.equal(backward.earlier, "comparison");
  assert.equal(backward.text, "18 d 9 h before the reference");
  assert.equal(Pair.compareTimes(a, a).state, "same");
  const tt = Pair.parseObservationTime({ "DATE-OBS": "2025-05-24T04:24:53", TIMESYS: "TT" });
  assert.equal(Pair.compareTimes(a, tt).state, "unavailable");
  assert.equal(Pair.compareTimes(a, Pair.parseObservationTime({})).state, "unavailable");
  const dayOnly = Pair.parseObservationTime({ "DATE-OBS": "2025-05-24", TIMESYS: "UTC" });
  assert.equal(Pair.compareTimes(a, dayOnly).state, "same");
});

test("time: the timeline orders valid times and is absent when a time is missing", () => {
  const early = Pair.parseObservationTime({ "DATE-OBS": "2025-01-01T00:00:00", TIMESYS: "UTC" });
  const late = Pair.parseObservationTime({ "DATE-OBS": "2025-03-01T00:00:00", TIMESYS: "UTC" });
  const forward = Pair.timelineModel(early, late);
  assert.deepEqual(forward.items.map((item) => item.role), ["reference", "comparison"]);
  const swapped = Pair.timelineModel(late, early); // The reference is the later observation.
  assert.deepEqual(swapped.items.map((item) => item.role), ["comparison", "reference"]);
  assert.deepEqual(swapped.items.map((item) => item.fraction), [0, 1]);
  near(swapped.spanDays, 59, 1e-9);
  assert.equal(Pair.timelineModel(early, Pair.parseObservationTime({})), null);
  assert.deepEqual(Pair.timelineModel(early, early).items.map((item) => item.fraction), [0.5, 0.5]);
  assert.equal(Pair.formatDuration(0.5), "12 h 0 min");
  assert.equal(Pair.formatDuration(30 / 86400), "30 s");
});

// ---- Sky overlap and grid -----------------------------------------------------------------------------------------------
test("overlap: identical footprints, offset footprints, distant footprints and a missing WCS", () => {
  const a = observation("a");
  assert.equal(Pair.skyOverlap(a, observation("b")).state, "full");
  const step = (pixels) => 150 + pixels * 6 / 3600 / Math.cos(2 * Math.PI / 180);
  const half = Pair.skyOverlap(a, observation("c", { wcsFields: tanFields({ ra: step(8) }) }));
  assert.equal(half.state, "substantial");
  near(half.referenceCovered, 0.6, 0.06);
  assert.equal(Pair.skyOverlap(a, observation("d", { wcsFields: tanFields({ ra: step(18) }) })).state, "partial");
  const none = Pair.skyOverlap(a, observation("e", { wcsFields: tanFields({ ra: 151, dec: 3 }) }));
  assert.equal(none.state, "none");
  assert.equal(none.referenceCovered, 0);
  assert.equal(Pair.skyOverlap(a, observation("f", { wcsFields: null })).state, "unavailable");
});

test("grid: same size alone is not a common grid", () => {
  const a = observation("a");
  const same = Pair.gridCompatibility(a, observation("b"));
  assert.equal(same.state, "same-grid");
  assert.equal(same.ok, true);

  const shift = Pair.gridCompatibility(a, observation("c", { wcsFields: tanFields({ crpix: [12.5, 10.5] }) })); // 2 pixel shift
  assert.equal(shift.state, "different-wcs");
  assert.equal(shift.ok, false);
  near(shift.maxOffsetPixels, 2, 0.01);

  assert.equal(Pair.gridCompatibility(a, observation("d", { wcsFields: tanFields({ rotate: 90 }) })).state, "different-wcs");
  assert.equal(Pair.gridCompatibility(a, observation("m", { wcsFields: tanFields({ extra: { CD1_1: 6 / 3600 } }) })).state, "different-wcs"); // RA axis flipped
  assert.equal(Pair.gridCompatibility(a, observation("e", { size: 30 })).state, "different-size");
  assert.equal(Pair.gridCompatibility(a, observation("f", { wcsFields: null })).state, "no-wcs");
  // A sub-pixel shift fails the default tolerance but passes a looser one.
  const tiny = observation("g", { wcsFields: tanFields({ crpix: [10.9, 10.5] }) });
  assert.equal(Pair.gridCompatibility(a, tiny).ok, false);
  assert.equal(Pair.gridCompatibility(a, tiny, 0.5).ok, true);
});

test("a wrong WCS is reported, not guessed", () => {
  const unsupported = Wcs.createWcs(tanFields({ extra: { CTYPE1: "RA---ARC", CTYPE2: "DEC--ARC" } }));
  assert.equal(unsupported.ok, false);
  const a = observation("a");
  const b = observation("b", { wcsFields: tanFields({ extra: { CTYPE1: "GLON-TAN", CTYPE2: "GLAT-TAN" } }) });
  assert.equal(b.wcs, null);
  const pair = Pair.compareObservations(a, b);
  assert.equal(pair.grid.state, "no-wcs");
  assert.equal(pair.linkedView.allowed, false);
  assert.equal(pair.blink.allowed, false);
  assert.equal(pair.overlap.state, "unavailable");
});

// ---- The pair -----------------------------------------------------------------------------------------------------------
test("pair: two epochs on one grid allow linked views and blink", () => {
  const a = observation("a", { header: { "DATE-OBS": "2025-05-24T04:24:53" } });
  const b = observation("b", { header: { "DATE-OBS": "2025-06-11T14:21:56" } });
  const pair = Pair.compareObservations(a, b);
  assert.equal(pair.duplicate, null);
  assert.equal(pair.time.state, "ordered");
  assert.equal(pair.grid.ok, true);
  assert.equal(pair.linkedView.allowed, true);
  assert.equal(pair.blink.allowed, true);
  assert.equal(pair.sharedContrast.allowed, true);
  assert.deepEqual(pair.warnings, []);
  assert.deepEqual(pair.timeline.items.map((item) => item.role), ["reference", "comparison"]);
});

test("pair: a copy of one observation is never an epoch pair", () => {
  const a = observation("a");
  const copy = Object.assign({}, a, { name: "copy.fits" });
  const sameTime = Pair.compareObservations(a, copy);
  assert.match(sameTime.duplicate, /identical pixel values/);
  assert.equal(sameTime.blink.allowed, false);
  assert.equal(sameTime.linkedView.allowed, false);
  assert.equal(sameTime.warnings[0].severity, "error");

  // Same pixels under an edited header date still count as the same observation.
  const relabelled = observation("a", { header: { "DATE-OBS": "2026-01-01T00:00:00" }, values: a.values });
  const edited = Pair.compareObservations(a, relabelled);
  assert.ok(edited.duplicate);
  assert.equal(edited.time.state, "ordered");
  assert.equal(edited.blink.allowed, false);

  // The same exposure in another file: equal OBSID, detector, HDU and time.
  const sameExposure = observation("a", { values: Float64Array.from(a.values, (v) => v + 1) });
  assert.match(Pair.compareObservations(a, sameExposure).duplicate, /same observation/);
});

test("pair: the same time for different observations is flagged", () => {
  const pair = Pair.compareObservations(observation("a"), observation("b"));
  assert.equal(pair.time.state, "same");
  assert.ok(pair.warnings.some((warning) => warning.code === "same-time"));
});

test("pair: non-overlapping fields cannot be linked or blinked", () => {
  const pair = Pair.compareObservations(observation("a"), observation("b", { wcsFields: tanFields({ ra: 151, dec: 3 }) }));
  assert.equal(pair.overlap.state, "none");
  assert.equal(pair.linkedView.allowed, false);
  assert.equal(pair.blink.allowed, false);
  assert.ok(pair.warnings.some((warning) => warning.code === "no-overlap" && warning.severity === "error"));
});

test("pair: different units forbid a shared contrast range; different bands and exposures are reported", () => {
  const a = observation("a");
  const pair = Pair.compareObservations(a, observation("b", { unit: "DN", header: { XPOSURE: 300 } }));
  assert.equal(pair.sharedContrast.allowed, false);
  assert.equal(pair.units, "different");
  assert.equal(pair.conditions.find((item) => item.key === "exposure").status, "different");
  assert.equal(Pair.compareObservations(a, observation("c", { unit: "MJy/sr" })).sharedContrast.allowed, true); // Spacing does not matter.
  assert.equal(Pair.compareObservations(a, observation("d", { unit: "" })).sharedContrast.allowed, false); // Missing unit: not known to match.

  const withWave = (item, micron) => Object.assign(item, { meta: Object.assign({}, item.meta, { wavelength: { center: { micron, bandwidth: 0.03 }, min: micron, max: micron } }) });
  const different = Pair.compareObservations(withWave(observation("x"), 1.3), withWave(observation("y"), 1.5));
  assert.equal(different.conditions.find((item) => item.key === "wavelength").status, "different");
  assert.ok(different.warnings.some((warning) => warning.code === "band"));
  const alike = Pair.compareObservations(withWave(observation("x"), 1.3), withWave(observation("y"), 1.31));
  assert.equal(alike.conditions.find((item) => item.key === "wavelength").status, "same");
});

test("units: case is kept, so mJy/sr and MJy/sr never share a contrast range", () => {
  assert.notEqual(Pair.normalizeUnit("mJy/sr"), Pair.normalizeUnit("MJy/sr"));
  assert.equal(Pair.normalizeUnit("MJy / sr"), "MJy/sr"); // Whitespace is still normalised.
  assert.equal(Pair.normalizeUnit("  MJy   /  sr "), Pair.normalizeUnit("MJy/sr"));
  assert.equal(Pair.normalizeUnit("W m**-2"), Pair.normalizeUnit("W m^-2"));
  assert.equal(Pair.normalizeUnit("  "), null);
  assert.equal(Pair.normalizeUnit(undefined), null);
  const a = observation("a", { unit: "MJy/sr" });
  const milli = Pair.compareObservations(a, observation("b", { unit: "mJy/sr" }));
  assert.equal(milli.units, "different");
  assert.equal(milli.sharedContrast.allowed, false);
  assert.ok(milli.warnings.some((warning) => warning.code === "unit"));
  assert.equal(Pair.compareObservations(a, observation("c", { unit: "MJy / sr" })).sharedContrast.allowed, true);
});

test("pair: swapping roles swaps labels, times and order together", () => {
  const early = observation("a", { header: { "DATE-OBS": "2025-01-01T00:00:00" } });
  const late = observation("b", { header: { "DATE-OBS": "2025-03-01T00:00:00" } });
  const swapped = Pair.swapRoles(Pair.compareObservations(early, late));
  assert.equal(swapped.reference.name, "b");
  assert.equal(swapped.comparison.name, "a");
  assert.equal(swapped.reference.meta.time.display, "2025-03-01 00:00:00");
  assert.equal(swapped.time.earlier, "comparison");
  assert.deepEqual(swapped.timeline.items.map((item) => item.role), ["comparison", "reference"]);
  assert.equal(swapped.timeline.items[0].time.display, "2025-01-01 00:00:00");
});

test("pair: a missing time leaves the timeline out and a manual time restores it", () => {
  const hdu = (fields) => ({ fields: { BUNIT: "MJy / sr", OBSID: "x", ...fields }, axes: [20, 20], name: "IMAGE" });
  const noTime = Pair.describeObservation(hdu({ DATE: "2025-09-18" }), 1);
  assert.equal(noTime.time.valid, false);
  const manual = Pair.describeObservation(hdu({ DATE: "2025-09-18" }), 1, { manualTime: Pair.manualObservationTime("2025-05-01T00:00:00") });
  assert.equal(manual.time.valid, true);
  assert.equal(manual.time.manual, true);
  assert.equal(manual.processed, "2025-09-18");

  const a = observation("a");
  const b = observation("b");
  b.meta = noTime;
  const pair = Pair.compareObservations(a, b);
  assert.equal(pair.timeline, null);
  assert.equal(pair.time.state, "unavailable");
  const fixed = observation("c");
  fixed.meta = manual;
  assert.ok(Pair.compareObservations(a, fixed).timeline);
});

// ---- Alignment ----------------------------------------------------------------------------------------------------------
test("resampling copies the nearest source pixel and leaves uncovered pixels undefined", () => {
  const size = 20;
  const reference = observation("a", { size });
  const shifted = observation("b", { size, wcsFields: tanFields({ crpix: [12.5, 10.5] }), values: Float64Array.from({ length: size * size }, (_, i) => i) });
  assert.equal(Pair.gridCompatibility(reference, shifted).ok, false);
  const aligned = Pair.resampleOntoGrid(shifted, reference);
  assert.equal(aligned.width, size);
  // CRPIX moved by +2, so the sky point at reference pixel x sits at source pixel x + 2.
  const probe = (x, y) => aligned.values[(y - 1) * size + (x - 1)];
  const source = (x, y) => shifted.values[(y - 1) * size + (x - 1)];
  assert.equal(probe(10, 10), source(12, 10));
  assert.ok(Number.isNaN(probe(20, 10)), "uncovered edge pixels are undefined");
  assert.ok(aligned.coveredFraction < 1 && aligned.coveredFraction > 0.8);
  const sourceValues = new Set(shifted.values); // Every defined value is a value of the source, never a blend.
  for (const value of aligned.values) if (!Number.isNaN(value)) assert.ok(sourceValues.has(value));
  assert.equal(Pair.gridCompatibility(reference, aligned).ok, true);
  assert.equal(Pair.resampleOntoGrid(Object.assign({}, shifted, { wcs: null }), reference), null);
});

// ---- Shared view --------------------------------------------------------------------------------------------------------
test("shared view: one state puts the same sky position under the same screen point of both panels", () => {
  const a = observation("a");
  const b = observation("b");
  assert.equal(Pair.gridCompatibility(a, b).ok, true);
  const panel = { width: 300, height: 200 };
  const view = Pair.createView(a.width, a.height);
  Pair.zoomViewAt(view, 4, a.width, a.height, panel, panel, 220, 60);
  Pair.panViewByScreen(view, 25, -10, a.width, a.height, panel, panel);
  const geoA = Pair.viewGeometry(view, a.width, a.height, panel, panel);
  const geoB = Pair.viewGeometry(view, b.width, b.height, panel, panel);
  for (const [sx, sy] of [[10, 10], [150, 100], [290, 190]]) {
    const pa = Wcs.screenToFits(geoA, sx, sy);
    const pb = Wcs.screenToFits(geoB, sx, sy);
    const skyA = a.wcs.pixelToSky(pa.x, pa.y);
    const skyB = b.wcs.pixelToSky(pb.x, pb.y);
    near(Wcs.angularSeparation(skyA.ra, skyA.dec, skyB.ra, skyB.dec) * 3600, 0, 1e-6);
  }
});

test("view maths: zoom keeps the pointed position, limits hold, and 1x recenters", () => {
  const panel = { width: 400, height: 400 };
  const view = Pair.createView(70, 70);
  const before = Wcs.screenToFits(Pair.viewGeometry(view, 70, 70, panel, panel), 300, 100);
  Pair.zoomViewAt(view, 2, 70, 70, panel, panel, 300, 100);
  const after = Wcs.screenToFits(Pair.viewGeometry(view, 70, 70, panel, panel), 300, 100);
  near(after.x, before.x, 1e-9);
  near(after.y, before.y, 1e-9);
  Pair.zoomViewAt(view, 1e9, 70, 70, panel, panel);
  assert.ok(view.zoom <= Pair.zoomLimit(70, 70, panel) + 1e-9);
  Pair.zoomViewAt(view, 1e-9, 70, 70, panel, panel);
  assert.equal(view.zoom, 1);
  assert.deepEqual([view.centerX, view.centerY], [35.5, 35.5]);
  Pair.panViewByScreen(view, -1e6, 1e6, 70, 70, panel, panel);
  assert.ok(view.centerX <= 70.5 && view.centerY >= 0.5);
});

// ---- Display range, blink -----------------------------------------------------------------------------------------------
test("display range skips undefined pixels and can combine two images", () => {
  assert.deepEqual(Pair.displayRange([Float64Array.from([NaN, 1, 2, 3, Infinity, 4])], 0, 1), { low: 1, high: 4 });
  assert.deepEqual(Pair.displayRange([Float64Array.from([0, 10]), Float64Array.from([100, 110])], 0, 1), { low: 0, high: 110 });
  assert.equal(Pair.displayRange([Float64Array.from([NaN, NaN])]), null);
  assert.deepEqual(Pair.displayRange([Float64Array.from([5, 5, 5])]), { low: 5, high: 5 });
});

test("blink: starts stopped, speeds are readable, reduced motion allows only the slow ones", () => {
  const normal = Pair.createBlinkState(false);
  assert.equal(normal.running, false);
  assert.equal(normal.frame, "reference");
  assert.deepEqual(Pair.blinkSpeedOptions(false), [0.5, 1, 2]);
  assert.deepEqual(Pair.blinkSpeedOptions(true), [0.5, 1]);
  assert.equal(Pair.clampBlinkSpeed(2, true), 1);
  assert.equal(Pair.clampBlinkSpeed(10, false), 2);
  assert.equal(Pair.createBlinkState(true).running, false);
  assert.equal(Pair.otherFrame("reference"), "comparison");
  assert.equal(Pair.otherFrame("comparison"), "reference");
});

// ---- Wavelength lookup --------------------------------------------------------------------------------------------------
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

test("wavelength: bilinear lookup of a WCS-WAVE style table", () => {
  const tableFields = { XTENSION: "BINTABLE", NAXIS1: 6 * 4 + 18 * 4, NAXIS2: 1, TFIELDS: 3, TTYPE1: "X", TFORM1: "3J", TTYPE2: "Y", TFORM2: "3J", TTYPE3: "VALUES", TFORM3: "18E" };
  const imageFields = { CRPIX1W: -100, CRPIX2W: -50, CRVAL1W: 1, CRVAL2W: 1, CDELT1W: 1, CDELT2W: 1, CUNIT1W: "um", CUNIT2W: "um", PV1_3W: 1, PV2_3W: 2, PS1_0W: "WCS-WAVE", PS1_1W: "VALUES", PS1_2W: "X", PS2_2W: "Y" };
  const table = Pair.parseWaveTable(waveTableBytes((x, y) => [1 + 0.01 * x + 0.02 * y, 0.5 + 0.001 * x]), tableFields, imageFields);
  assert.ok(table);
  // Image pixel p maps to table coordinate p - CRPIX + CRVAL, so x = p + 101 and y = q + 51.
  near(Pair.wavelengthAt(table, imageFields, -90, -40).micron, 1 + 0.11 + 0.22, 1e-5); // x = 11, y = 11
  const mid = Pair.wavelengthAt(table, imageFields, -85.5, -43.5); // x = 15.5, y = 7.5; bilinear is exact for a linear field
  near(mid.micron, 1 + 0.155 + 0.15, 1e-5);
  near(mid.bandwidth, 0.5 + 0.0155, 1e-5);
  assert.equal(Pair.wavelengthAt(table, imageFields, 500, 500), null); // Outside the table.
  assert.equal(Pair.wavelengthAt(table, Object.assign({}, imageFields, { PC1_1W: 1 }), -90, -40), null);
  assert.equal(Pair.parseWaveTable(new ArrayBuffer(8), tableFields, imageFields), null);
});

// ---- Real pair ----------------------------------------------------------------------------------------------------------
const fitsSandbox = vm.createContext({ TextDecoder, document: { querySelector: () => null }, atob, Uint8Array });
const fitsLib = vm.runInContext(readFileSync(join(root, "tools/fits.js"), "utf8") + "\n({ readFitsHdus, fitsPixelReader });", fitsSandbox);
const exampleSource = readFileSync(join(root, "assets/tools/spherex-time-machine-example.js"), "utf8");
const realEncoded = vm.runInNewContext(exampleSource + "\nspherexTimeMachineExample;");

async function loadReal(encoded, name) {
  const file = new File([Buffer.from(encoded, "base64")], name);
  const hdus = await fitsLib.readFitsHdus(file);
  const index = hdus.findIndex((hdu) => hdu.fields.EXTNAME === "IMAGE");
  const hdu = hdus[index];
  const bytes = await file.slice(hdu.dataStart, hdu.dataStart + hdu.byteLength).arrayBuffer();
  const read = fitsLib.fitsPixelReader(bytes, hdu);
  const values = Float64Array.from({ length: hdu.pixels }, (_, i) => read(i));
  const table = hdus.find((entry) => entry.fields.EXTNAME === "WCS-WAVE");
  const parsed = Pair.parseWaveTable(await file.slice(table.dataStart, table.dataStart + table.byteLength).arrayBuffer(), table.fields, hdu.fields);
  const wavelength = Pair.wavelengthSummary(parsed, hdu.fields, hdu.axes[0], hdu.axes[1]);
  const created = Wcs.createWcs(hdu.fields);
  return { name, meta: Pair.describeObservation(hdu, index, { wavelength }), width: hdu.axes[0], height: hdu.axes[1], values, wcs: created.ok ? created.wcs : null, fingerprint: Pair.fingerprintValues(values) };
}

const realReference = await loadReal(realEncoded.reference, "reference.fits");
const realComparison = await loadReal(realEncoded.comparison, "comparison.fits");

test("real pair: headers of two different SPHEREx QR2 observations", () => {
  assert.equal(realReference.meta.obsId, "2025W21_2C_0280_1");
  assert.equal(realComparison.meta.obsId, "2025W24_1A_0514_1");
  assert.equal(realReference.meta.time.display, "2025-05-24 04:24:53");
  assert.equal(realComparison.meta.time.display, "2025-06-11 14:21:56");
  assert.equal(realReference.meta.time.sourceLabel, "DATE-OBS and MJD-OBS");
  assert.equal(realReference.meta.unit, "MJy / sr");
  assert.equal(realReference.meta.frame, "ICRS");
  assert.equal(realReference.meta.detector, 2);
  // HDU creation time (DATE) is separate metadata and is not the observation time.
  assert.equal(realReference.meta.processed, "2025-09-18T17:26:58.386");
  assert.notEqual(realReference.meta.processed.slice(0, 10), realReference.meta.time.display.slice(0, 10));
  assert.notEqual(realReference.fingerprint, realComparison.fingerprint);
});

test("real pair: wavelengths equal Astropy's WAVE-TAB result", () => {
  // Astropy WCS(header, key='W', fobj=hdul).wcs_pix2world at pixel (35.5, 35.5), origin 1.
  near(realReference.meta.wavelength.center.micron, 1.3142981134987644, 1e-6);
  near(realReference.meta.wavelength.center.bandwidth, 0.03164398270848013, 1e-6);
  near(realComparison.meta.wavelength.center.micron, 1.303465840893472, 1e-6);
});

test("real pair: same field, different dates, but not one pixel grid", () => {
  const pair = Pair.compareObservations(realReference, realComparison);
  assert.equal(pair.duplicate, null);
  assert.equal(pair.time.state, "ordered");
  near(pair.time.deltaDays, 18.4146, 1e-3);
  assert.equal(pair.overlap.state, "full");
  assert.equal(pair.grid.state, "different-wcs"); // Same 70 x 70 size, but offset by about half a pixel.
  near(pair.grid.maxOffsetPixels, 0.488, 0.01);
  assert.equal(pair.linkedView.allowed, false);
  assert.equal(pair.blink.allowed, false);
  assert.equal(pair.sharedContrast.allowed, true);
  assert.equal(pair.conditions.find((item) => item.key === "wavelength").status, "same");
  assert.deepEqual(pair.timeline.items.map((item) => item.role), ["reference", "comparison"]);
});

test("real pair: display alignment puts the comparison on the reference grid", () => {
  const aligned = Pair.resampleOntoGrid(realComparison, realReference);
  assert.ok(aligned.coveredFraction > 0.9);
  const decision = Pair.linkedViewDecision(Pair.gridCompatibility(realReference, aligned), Pair.skyOverlap(realReference, aligned), null);
  assert.equal(decision.allowed, true);
});

test("real pair: the same file twice is rejected, and swapping roles reverses the timeline", () => {
  const twice = Pair.compareObservations(realReference, Object.assign({}, realReference, { name: "other-name.fits" }));
  assert.ok(twice.duplicate);
  assert.equal(twice.blink.allowed, false);
  const swapped = Pair.swapRoles(Pair.compareObservations(realReference, realComparison));
  assert.equal(swapped.reference.meta.obsId, "2025W24_1A_0514_1");
  assert.equal(swapped.time.earlier, "comparison");
  assert.deepEqual(swapped.timeline.items.map((item) => item.role), ["comparison", "reference"]);
  assert.match(swapped.time.text, /before the reference/);
});
