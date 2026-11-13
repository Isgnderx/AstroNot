// Run with:  node --test tests/        (or: node tests/motion.test.mjs)
//
// Covers tools/motion-model.js, the model behind Motion Detector: the sky geometry and sign conventions (east, north, position
// angle), displacement and rate from positions and observation times, the residual detection in a difference image, the
// pairing of negative and positive residuals, linking across epochs, missing and equal times, NaN and edge handling,
// time ordering and the CSV export.
//   - Everything built in this file (headers, star fields, noise) is a SYNTHETIC FIXTURE made for these checks. None of it is
//     archive data and none of it is a result for any real object.
//   - The "real pair" section uses assets/tools/spherex-time-machine-example.js: two IRSA SPHEREx QR2 cutouts of one field
//     taken on different dates. It checks that the real files run through the same code and that every reported position
//     can be traced to the epoch's own file. It makes no claim that a moving object is present.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const Motion = require("../tools/motion-model.js");

const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, (message ?? "") + " expected " + expected + " got " + actual);
const nearAngle = (actual, expected, tolerance, message) => near(((actual - expected + 540) % 360) - 180, 0, tolerance, message);

const fitsSandbox = vm.createContext({ TextDecoder, document: { querySelector: () => null }, atob, Uint8Array });
const fitsLib = vm.runInContext(readFileSync(join(root, "tools/fits.js"), "utf8") + "\n({ readFitsHdus, fitsPixelReader });", fitsSandbox);

// ---- Synthetic fixtures ---------------------------------------------------------------------------------------------------
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalNoise(random) {
  return Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
}

const scale = 6; // arcsec per pixel
const size = 80;
const baseRa = 150;
const baseDec = 2;

function wcsCards({ ra = baseRa, dec = baseDec, flip = false } = {}) {
  return [
    ["CTYPE1", "RA---TAN"], ["CTYPE2", "DEC--TAN"], ["CRVAL1", ra], ["CRVAL2", dec], ["CRPIX1", 40.5], ["CRPIX2", 40.5],
    ["CD1_1", -scale / 3600], ["CD1_2", 0], ["CD2_1", 0], ["CD2_2", (flip ? -1 : 1) * scale / 3600], ["RADESYS", "ICRS"],
  ];
}

// A star field. Sources are { x, y (FITS pixel), amp, sigma }. `nan` is a list of [x, y, width, height] blocks (FITS,
// 1-based) set to NaN. Noise has sd 1 and is independent per image (seeded).
function field({ sources = [], seed = 1, nan = [], noise = 1, cards = wcsCards(), time, obsId, extra = [], background = 10 }) {
  const random = mulberry32(seed);
  const bytes = buildFits({
    width: size, height: size, bitpix: -32,
    extra: [...cards, ["BUNIT", "MJy/sr"], ["OBSID", obsId], ...(time ? [["DATE-OBS", time], ["TIMESYS", "UTC"]] : []), ...extra],
    pixels: (column, row) => {
      const x = column + 1;
      const y = row + 1;
      if (nan.some(([nx, ny, w, h]) => x >= nx && x < nx + w && y >= ny && y < ny + h)) return NaN;
      let value = background + noise * normalNoise(random);
      for (const source of sources) value += source.amp * Math.exp(-((x - source.x) ** 2 + (y - source.y) ** 2) / (2 * (source.sigma ?? 1.5) ** 2));
      return value;
    },
  });
  return { bytes, obsId };
}

let nextId = 0;
async function epochFrom(bytes, name) {
  const file = new File([bytes], name);
  const hdus = await fitsLib.readFitsHdus(file);
  const hdu = hdus[0];
  const data = await file.slice(hdu.dataStart, hdu.dataStart + hdu.byteLength).arrayBuffer();
  const read = fitsLib.fitsPixelReader(data, hdu);
  const values = Float64Array.from({ length: hdu.pixels }, (_, index) => read(index));
  return Motion.buildEpoch(hdu, 0, values, { id: "E" + ++nextId, name });
}

const t0 = "2025-05-24T00:00:00";
const t1 = "2025-05-24T06:00:00";
const t2 = "2025-05-24T12:00:00";

const staticStar = { x: 20, y: 60, amp: 300 };

// A point source moving 5 pixels per epoch (30 arcsec). `direction` is the unit step in pixels per epoch.
async function movingSeries({ step = [-5, 0], times = [t0, t1, t2], start = [55, 30], extraSources = () => [], nan = [], seeds = [11, 12, 13], order = [0, 1, 2] } = {}) {
  const epochs = [];
  for (const k of order) {
    const mover = { x: start[0] + step[0] * k, y: start[1] + step[1] * k, amp: 200 };
    const built = field({ sources: [staticStar, mover, ...extraSources(k)], seed: seeds[k], time: times[k], obsId: "SYN-" + k, nan: nan[k] ?? [] });
    epochs.push(await epochFrom(built.bytes, "synthetic-" + k + ".fits"));
  }
  return epochs;
}

// ---- Geometry: east, north, position angle, sign conventions ---------------------------------------------------------------
const at = (ra, dec) => ({ ra, dec });
const hoursAfter = (hours, extra = {}) => ({ valid: true, mjd: 60000 + hours / 24, scale: "UTC", precision: "second", ...extra });

test("geometry: the position angle runs from north through east and east is increasing RA", () => {
  const start = at(150, 2);
  const dEast = 2 / 3600 / Math.cos(2 * Math.PI / 180);
  const east = Motion.bearing(start, at(150 + dEast, 2));
  near(east.separation, 2, 1e-6);
  near(east.pa, 90, 1e-3); // constant Dec is a small circle: the great-circle bearing differs from 90 by ~1e-5 degree
  near(east.east, 2, 1e-6);
  near(east.north, 0, 1e-6);
  const north = Motion.bearing(start, at(150, 2 + 3 / 3600));
  near(north.pa, 0, 1e-6);
  near(north.north, 3, 1e-6);
  const west = Motion.bearing(start, at(150 - dEast, 2));
  near(west.pa, 270, 1e-4);
  near(west.east, -2, 1e-6);
  const south = Motion.bearing(start, at(150, 2 - 3 / 3600));
  near(south.pa, 180, 1e-6);
  near(south.north, -3, 1e-6);
  assert.equal(Motion.bearing(start, start).pa, null);
  assert.equal(Motion.compassDirection(90), "E");
  assert.equal(Motion.compassDirection(359), "N");
  assert.equal(Motion.compassDirection(225), "SW");
});

test("controlled case: 2 arcsec east in 0.5 day is 4 arcsec/day, with no change in north", () => {
  const dEast = 2 / 3600 / Math.cos(2 * Math.PI / 180);
  const track = Motion.fitTrack([
    { id: "A", ra: 150, dec: 2, time: hoursAfter(0), order: 0 },
    { id: "B", ra: 150 + dEast, dec: 2, time: hoursAfter(12), order: 1 },
  ]);
  assert.equal(track.ok, true);
  near(track.displacement.arcsec, 2, 1e-6);
  near(track.displacement.east, 2, 1e-6);
  near(track.displacement.north, 0, 1e-4);
  near(track.displacement.pa, 90, 1e-3);
  near(track.deltaTDays, 0.5, 1e-9);
  assert.equal(track.rate.method, "two-point");
  near(track.rate.perDay, 4, 1e-6);
  near(track.rate.speed, 4 / 24, 1e-9);
  near(track.rate.east, 4 / 24, 1e-9);
  near(track.rate.north, 0, 1e-6);
  near(track.rate.pa, 90, 1e-3);
  assert.equal(track.rate.direction, "E");
  assert.equal(track.rate.sigmaEast, null); // Two positions leave nothing to fit.
});

test("geometry: the 0/360 degree RA boundary and the polar region keep exact separations and signs", () => {
  const across = Motion.bearing(at(359.9999, 10), at(0.0001, 10));
  near(across.separation, 0.0002 * Math.cos(10 * Math.PI / 180) * 3600, 1e-4);
  near(across.pa, 90, 1e-3); // 0.0001 deg of RA later across the boundary is east.
  const back = Motion.bearing(at(0.0001, 10), at(359.9999, 10));
  near(back.pa, 270, 1e-3);
  const track = Motion.fitTrack([
    { id: "A", ra: 359.99995, dec: -30, time: hoursAfter(0), order: 0 },
    { id: "B", ra: 0.00005, dec: -30, time: hoursAfter(1), order: 1 },
  ]);
  assert.ok(track.rate.east > 0 && Math.abs(track.rate.north) < 1e-3 * track.rate.east);
  // Near the pole the arc separation stays exact: 10 arcsec of declination at Dec 89.9.
  const pole = Motion.bearing(at(10, 89.9), at(190, 89.9));
  near(pole.separation, 0.2 * 3600, 1e-3); // Across the pole the two points are 0.2 degrees apart.
  const small = Motion.bearing(at(10, 89.9), at(10, 89.9 + 10 / 3600));
  near(small.separation, 10, 1e-6);
  near(small.north, 10, 1e-6);
  assert.ok(Number.isFinite(Motion.bearing(at(10, 90), at(200, 89.9999)).separation));
});

test("time: positions are ordered by time, not by the order they are given", () => {
  const dEast = 5 / 3600 / Math.cos(2 * Math.PI / 180);
  const points = [
    { id: "late", ra: 150 + 2 * dEast, dec: 2, time: hoursAfter(2), order: 0 },
    { id: "early", ra: 150, dec: 2, time: hoursAfter(0), order: 1 },
    { id: "mid", ra: 150 + dEast, dec: 2, time: hoursAfter(1), order: 2 },
  ];
  const track = Motion.fitTrack(points);
  assert.deepEqual(track.ordered, ["early", "mid", "late"]);
  assert.equal(track.chronological, true);
  assert.equal(track.rate.method, "linear fit");
  near(track.rate.speed, 5 / 3600 * 3600 / 1, 1e-6); // 5 arcsec per hour
  near(track.rate.pa, 90, 1e-3);
  assert.equal(track.rate.dof, 1);
  near(track.rate.residualRms, 0, 1e-5);
  for (const residual of track.rate.residuals) near(residual.norm, 0, 1e-5);
  // Reversing the times reverses the sign of the east rate and the angle.
  const reversed = Motion.fitTrack(points.map((point) => Object.assign({}, point, { time: hoursAfter(2 - (point.time.mjd - 60000) * 24) })));
  near(reversed.rate.pa, 270, 1e-3);
});

test("fit: a position off the line shows as a residual and gives a rate uncertainty", () => {
  const dEast = 5 / 3600 / Math.cos(2 * Math.PI / 180);
  const track = Motion.fitTrack([
    { id: "A", ra: 150, dec: 2, time: hoursAfter(0), order: 0 },
    { id: "B", ra: 150 + dEast, dec: 2 + 1.5 / 3600, time: hoursAfter(1), order: 1 },
    { id: "C", ra: 150 + 2 * dEast, dec: 2, time: hoursAfter(2), order: 2 },
    { id: "D", ra: 150 + 3 * dEast, dec: 2, time: hoursAfter(3), order: 3 },
  ]);
  assert.equal(track.rate.dof, 2);
  assert.ok(track.rate.residualRms > 0.3);
  assert.ok(track.rate.sigmaNorth > 0 && track.rate.sigmaEast >= 0);
  assert.ok(track.rate.sigmaSpeed >= 0);
  const worst = track.rate.residuals.reduce((best, item) => item.norm > best.norm ? item : best);
  assert.ok(["B", "A", "C", "D"].includes(worst.id));
  near(track.rate.pa, 90, 5);
  assert.equal(track.rate.residuals.length, 4);
});

test("time: a missing time leaves the rate empty with the reason, the displacement is still given", () => {
  const dEast = 5 / 3600 / Math.cos(2 * Math.PI / 180);
  const track = Motion.fitTrack([
    { id: "E1", ra: 150, dec: 2, time: hoursAfter(0), order: 0 },
    { id: "E2", ra: 150 + dEast, dec: 2, time: null, order: 1 },
  ]);
  assert.equal(track.ok, true);
  assert.equal(track.rate, null);
  assert.match(track.rateReason, /Observation time unavailable for E2/);
  near(track.displacement.arcsec, 5, 1e-6);
  assert.equal(track.chronological, false);
  assert.ok(track.notes.some((note) => /ordered by epoch/.test(note)));
  const invalid = Motion.fitTrack([
    { id: "E1", ra: 150, dec: 2, time: { valid: false }, order: 0 },
    { id: "E2", ra: 150 + dEast, dec: 2, time: { valid: false }, order: 1 },
  ]);
  assert.equal(invalid.rate, null);
});

test("time: equal times and different time scales give no rate", () => {
  const same = Motion.fitTrack([
    { id: "A", ra: 150, dec: 2, time: hoursAfter(0), order: 0 },
    { id: "B", ra: 150.001, dec: 2, time: hoursAfter(0), order: 1 },
  ]);
  assert.equal(same.rate, null);
  assert.match(same.rateReason, /Δt is zero/);
  assert.ok(same.displacement.arcsec > 3);
  const scales = Motion.fitTrack([
    { id: "A", ra: 150, dec: 2, time: hoursAfter(0), order: 0 },
    { id: "B", ra: 150.001, dec: 2, time: hoursAfter(1, { scale: "TT" }), order: 1 },
  ]);
  assert.equal(scales.rate, null);
  assert.match(scales.rateReason, /time scales/);
  assert.equal(Motion.fitTrack([{ id: "A", ra: 150, dec: 2, time: hoursAfter(0), order: 0 }]).ok, false);
  assert.equal(Motion.fitTrack([]).ok, false);
  const bad = Motion.fitTrack([
    { id: "A", ra: NaN, dec: 2, time: hoursAfter(0), order: 0 },
    { id: "B", ra: 150, dec: 2, time: hoursAfter(1), order: 1 },
  ]);
  assert.equal(bad.ok, false);
  // A coarse (date-only) time is accepted with a note.
  const coarse = Motion.fitTrack([
    { id: "A", ra: 150, dec: 2, time: hoursAfter(0, { precision: "day" }), order: 0 },
    { id: "B", ra: 150.001, dec: 2, time: hoursAfter(24, { precision: "day" }), order: 1 },
  ]);
  assert.ok(coarse.rate);
  assert.ok(coarse.notes.some((note) => /date precision/.test(note)));
});

// ---- Detection in synthetic images -----------------------------------------------------------------------------------------
test("detection: a point source that moves 5 pixels per epoch is recovered with its position, displacement, rate and angle", async () => {
  const epochs = await movingSeries();
  const series = Motion.analyzeSeries(epochs);
  assert.equal(series.ok, true);
  assert.equal(series.referenceId, epochs[0].id);
  assert.equal(series.candidates.length, 1, JSON.stringify(series.counts));
  const candidate = series.candidates[0];
  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.origin, "detected");
  assert.equal(candidate.epochsSeen, 2);
  near(candidate.positions[epochs[0].id].x, 55, 0.15);
  near(candidate.positions[epochs[0].id].y, 30, 0.15);
  near(candidate.positions[epochs[1].id].x, 50, 0.15);
  near(candidate.positions[epochs[2].id].x, 45, 0.15);
  near(candidate.positions[epochs[2].id].y, 30, 0.15);
  assert.ok(candidate.reasons[0].startsWith("Candidate because"));

  const evaluated = Motion.evaluateCandidate(series, candidate);
  assert.equal(evaluated.points.length, 3);
  const { track } = evaluated;
  near(track.displacement.arcsec, 60, 1.2);
  near(track.displacement.pa, 90, 1); // moving to smaller x is moving east with this WCS
  near(track.displacement.north, 0, 1.2);
  assert.ok(track.displacement.east > 0);
  near(track.deltaTHours, 12, 1e-9);
  assert.equal(track.rate.method, "linear fit");
  near(track.rate.speed, 5, 0.1); // 30 arcsec per 6 hours
  near(track.rate.perDay, 120, 2.5);
  near(track.rate.pa, 90, 1);
  assert.equal(track.rate.direction, "E");
  assert.ok(track.rate.residualRms < 0.5);
  // Each position can be traced to the epoch's own file (the grids here are identical).
  for (const point of evaluated.points) {
    assert.ok(point.source);
    near(point.source.x, point.x, 1e-3);
    assert.equal(point.epoch.meta.obsId, "SYN-" + epochs.indexOf(point.epoch));
  }
  // The signed difference came from difference.js: positive where the epoch has the source.
  const diff = series.entries[2].diff;
  assert.equal(diff.sign, "target-minus-reference");
  assert.ok(diff.difference[(30 - 1) * size + (45 - 1)] > 100);
  assert.ok(diff.difference[(30 - 1) * size + (55 - 1)] < -100);
});

test("detection: motion toward larger y is north (position angle 0), toward smaller y is south", async () => {
  const north = Motion.analyzeSeries(await movingSeries({ step: [0, 5], start: [60, 20] }));
  assert.equal(north.candidates.length, 1);
  const northTrack = Motion.evaluateCandidate(north, north.candidates[0]).track;
  assert.ok(northTrack.displacement.north > 55);
  nearAngle(northTrack.rate.pa, 0, 1);
  const south = Motion.analyzeSeries(await movingSeries({ step: [0, -5], start: [60, 50] }));
  const southTrack = Motion.evaluateCandidate(south, south.candidates[0]).track;
  assert.ok(southTrack.displacement.north < -55);
  near(southTrack.rate.pa, 180, 1);
});

test("a static star is not flagged, and neither are brightness changes or a small registration shift", async () => {
  // Identical star in every epoch: the residuals are noise only.
  const quiet = await movingSeries({ step: [0, 0], start: [60, 20] });
  const none = Motion.analyzeSeries(quiet.slice(0, 3).map((epoch) => epoch));
  // (The "mover" does not move, so it is a second static star here.)
  assert.equal(none.candidates.length, 0, "static sources must not become candidates");
  assert.equal(none.counts.pairs, 0);

  // The static star gets brighter by 30% in the last epoch: one positive residual, no negative partner.
  const epochs = [];
  for (const [k, time] of [[0, t0], [1, t1], [2, t2]]) {
    const star = { ...staticStar, amp: k === 2 ? 390 : 300 };
    epochs.push(await epochFrom(field({ sources: [star], seed: 20 + k, time, obsId: "VAR-" + k }).bytes, "variable-" + k + ".fits"));
  }
  const variable = Motion.analyzeSeries(epochs);
  assert.equal(variable.candidates.length, 0);
  const last = variable.entries[2];
  assert.equal(last.unpaired.positive.length, 1);
  assert.equal(last.unpaired.negative.length, 0);
  near(last.unpaired.positive[0].x, 20, 0.2);
  assert.ok(variable.counts.unpairedPositive >= 1);

  // The static star is shifted by 0.7 pixel in the last epoch: a dipole across the star, whose midpoint is bright in both images.
  const shifted = [];
  for (const [k, time] of [[0, t0], [1, t2]]) {
    const star = { ...staticStar, x: staticStar.x + (k === 1 ? 0.7 : 0) };
    shifted.push(await epochFrom(field({ sources: [star], seed: 30 + k, time, obsId: "SHIFT-" + k }).bytes, "shift-" + k + ".fits"));
  }
  const registration = Motion.analyzeSeries(shifted);
  assert.equal(registration.candidates.length, 0);
  assert.ok(registration.counts.rejected >= 1, "the dipole of a shifted static star should be rejected with a reason");
  assert.match(registration.entries[1].rejected[0].reason, /static source|registration/);
});

test("two neighbouring stars that brighten and fade are not a mover: both sources exist in both epochs", async () => {
  const epochs = [];
  for (const [k, time, a, b] of [[0, t0, 300, 300], [1, t2, 390, 210]]) {
    const sources = [{ x: 30, y: 40, amp: a }, { x: 37, y: 40, amp: b }];
    epochs.push(await epochFrom(field({ sources, seed: 40 + k, time, obsId: "SWAP-" + k }).bytes, "swap-" + k + ".fits"));
  }
  const series = Motion.analyzeSeries(epochs);
  assert.equal(series.candidates.length, 0);
  assert.ok(series.counts.rejected >= 1);
  assert.match(series.entries[1].rejected[0].reason, /both epochs/);
  // A lone mover pair carries no ambiguity flag (its partner is not a competing neighbour).
  return movingSeries().then((moving) => {
    const clean = Motion.analyzeSeries(moving);
    assert.deepEqual(clean.entries[1].pairs[0].flags, []);
    assert.equal(clean.entries[1].pairs[0].neighbours.positive + clean.entries[1].pairs[0].neighbours.negative, 0);
  });
});

test("detection: a mover next to a static star is still found, and the static star is not part of it", async () => {
  const epochs = await movingSeries();
  const series = Motion.analyzeSeries(epochs);
  for (const candidate of series.candidates) {
    for (const position of Object.values(candidate.positions)) assert.ok(Math.hypot(position.x - staticStar.x, position.y - staticStar.y) > 10);
  }
});

test("NaN and edge handling: peaks near NaN pixels, the image edge or the overlap boundary are not examined", async () => {
  // Second mover close to the left edge: its lobes lie within 2 pixels of the edge or of NaN and cannot be certified.
  const nanBlocks = [[], [[2, 2, 2, 2]], []];
  const epochs = await movingSeries({
    nan: nanBlocks,
    extraSources: (k) => [{ x: 4 + k * 3, y: 45, amp: 200 }],
  });
  const series = Motion.analyzeSeries(epochs);
  assert.equal(series.ok, true);
  for (const candidate of series.candidates) {
    for (const position of Object.values(candidate.positions)) {
      assert.ok(position.x > 2.5 && position.y > 2.5 && position.x < size - 2.5 && position.y < size - 2.5, "candidate inside the examined area");
    }
  }
  assert.ok(series.counts.nearInvalid >= 1, "edge peaks are counted as not examined");
  // The invalid pixels stay invalid in the difference and never become residuals.
  const diff = series.entries[1].diff;
  assert.ok(Number.isNaN(diff.difference[(2 - 1) * size + (2 - 1)]));
  for (const entry of series.entries) {
    if (!entry.detection) continue;
    for (const peak of entry.detection.peaks) assert.ok(Number.isFinite(diff.difference[peak.row * size + peak.column]) || entry !== series.entries[1]);
  }

  // A NaN patch where the positive lobe would be: no pair, so no candidate for that epoch.
  const covered = await movingSeries({ nan: [[], [], [[42, 27, 7, 7]]] });
  const hidden = Motion.analyzeSeries(covered);
  const withLast = hidden.candidates.filter((candidate) => candidate.positions[covered[2].id]);
  assert.equal(withLast.length, 0);
  assert.equal(hidden.candidates.length, 1); // the epoch-1 pair is still found
  assert.equal(Object.keys(hidden.candidates[0].positions).length, 2);
});

test("detection: threshold modes, an all-NaN difference and SNR without variance are reported, not guessed", async () => {
  const epochs = await movingSeries();
  const snr = Motion.analyzeSeries(epochs, { mode: "snr" });
  assert.equal(snr.ok, true);
  assert.equal(snr.candidates.length, 0);
  assert.ok(snr.entries.slice(1).every((entry) => !entry.included && /variance/.test(entry.reason)));
  const absolute = Motion.analyzeSeries(epochs, { mode: "absolute", threshold: 60 });
  assert.equal(absolute.candidates.length, 1);
  assert.match(absolute.settings.thresholdText, /60 MJy\/sr/);
  const high = Motion.analyzeSeries(epochs, { mode: "absolute", threshold: 1e6 });
  assert.equal(high.candidates.length, 0);
  const global = Motion.analyzeSeries(epochs, { mode: "global-mad" });
  assert.equal(global.candidates.length, 1);
  assert.equal(Motion.detectResiduals(null).ok, false);
  assert.equal(Motion.detectResiduals(absolute.entries[1].diff, { threshold: -1 }).ok, false);
  assert.equal(Motion.detectResiduals(absolute.entries[1].diff, { mode: "nonsense" }).ok, false);
  // Everything NaN: no pixel is valid, the difference is empty and the epoch is left out with the reason.
  const blank = await epochFrom(field({ sources: [], seed: 5, time: t1, obsId: "BLANK", nan: [[1, 1, size, size]] }).bytes, "blank.fits");
  const withBlank = Motion.analyzeSeries([epochs[0], blank]);
  assert.equal(withBlank.entries[1].included, false);
  assert.match(withBlank.entries[1].reason, /NaN|overlap|masked|identical|valid/i);
  assert.equal(withBlank.candidates.length, 0);
  assert.ok(withBlank.notes.length > 0);
});

test("a series needs at least two observations, a usable reference WCS and a unique id for each", async () => {
  const epochs = await movingSeries();
  assert.equal(Motion.analyzeSeries([epochs[0]]).ok, false);
  assert.equal(Motion.analyzeSeries([]).ok, false);
  const clone = Object.assign({}, epochs[1], { id: epochs[0].id });
  assert.equal(Motion.analyzeSeries([epochs[0], clone]).ok, false);
  const noWcs = Object.assign({}, epochs[0], { wcs: null, wcsReason: "test" });
  const refused = Motion.analyzeSeries([noWcs, epochs[1]]);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /no usable WCS/);
  assert.equal(Motion.analyzeSeries(epochs, { referenceId: "nope" }).ok, false);
});

test("time ordering: files loaded out of order give the same track, and the default reference is the earliest epoch", async () => {
  const shuffled = await movingSeries({ order: [2, 0, 1] });
  assert.equal(Motion.defaultReference(shuffled), 1); // loaded second, observed first
  const series = Motion.analyzeSeries(shuffled);
  assert.equal(series.reference.meta.obsId, "SYN-0");
  assert.equal(series.candidates.length, 1);
  const { track } = Motion.evaluateCandidate(series, series.candidates[0]);
  assert.deepEqual(track.ordered.map((id) => series.entries.find((entry) => entry.id === id).epoch.meta.obsId), ["SYN-0", "SYN-1", "SYN-2"]);
  near(track.rate.speed, 5, 0.1);
  near(track.rate.pa, 90, 1);

  // A middle epoch as the reference: the sign of Δ flips for the earlier epoch, the track is the same.
  const ordered = await movingSeries();
  const middle = Motion.analyzeSeries(ordered, { referenceId: ordered[1].id });
  assert.equal(middle.candidates.length, 1);
  const track2 = Motion.evaluateCandidate(middle, middle.candidates[0]).track;
  assert.equal(track2.chronological, true);
  near(track2.rate.speed, 5, 0.1);
  near(track2.rate.pa, 90, 1);
  near(track2.displacement.arcsec, 60, 1.2);
});

test("missing and equal times: candidates are still found, the rate is empty with a reason, a manual time fills it in", async () => {
  const noTime = await movingSeries({ times: [t0, undefined, t2] });
  assert.equal(noTime[1].meta.time.valid, false);
  const series = Motion.analyzeSeries(noTime);
  assert.equal(series.candidates.length, 1);
  const missing = Motion.evaluateCandidate(series, series.candidates[0]).track;
  assert.equal(missing.rate, null);
  assert.match(missing.rateReason, /Observation time unavailable for/);
  near(missing.displacement.arcsec, 60, 1.2);
  // The user types the time of the epoch without one; it is labelled manual.
  const bad = Motion.withManualTime(noTime[1], "not a date");
  assert.equal(bad.ok, false);
  const good = Motion.withManualTime(noTime[1], t1);
  assert.equal(good.ok, true);
  assert.equal(noTime[1].meta.time.manual, true);
  const again = Motion.analyzeSeries(noTime);
  const fixed = Motion.evaluateCandidate(again, again.candidates[0]).track;
  near(fixed.rate.speed, 5, 0.1);

  const equal = await movingSeries({ times: [t0, t0, t0] });
  const same = Motion.analyzeSeries(equal);
  assert.equal(same.candidates.length, 1);
  const flat = Motion.evaluateCandidate(same, same.candidates[0]).track;
  assert.equal(flat.rate, null);
  assert.match(flat.rateReason, /Δt is zero/);
  assert.ok(flat.displacement.arcsec > 50);
});

test("review choices change the status only, never a measurement", async () => {
  const series = Motion.analyzeSeries(await movingSeries());
  const candidate = series.candidates[0];
  const before = JSON.stringify(Motion.evaluateCandidate(series, candidate).track);
  candidate.status = "keep";
  assert.equal(JSON.stringify(Motion.evaluateCandidate(series, candidate).track), before);
  candidate.status = "dismissed";
  assert.equal(JSON.stringify(Motion.evaluateCandidate(series, candidate).track), before);
  // A corrected position is kept next to the detected one.
  const id = series.entries[2].id;
  const detected = { x: candidate.positions[id].x, y: candidate.positions[id].y };
  Motion.setPosition(candidate, id, { x: 44, y: 31, method: "typed" });
  assert.equal(candidate.detected[id].x, detected.x);
  const edited = Motion.evaluateCandidate(series, candidate);
  assert.equal(edited.points.find((point) => point.id === id).edited, true);
  assert.equal(edited.points.find((point) => point.id === id).method, "typed");
  assert.ok(Math.abs(edited.track.displacement.north) > 3);
  // A hand-made candidate has no detection behind it.
  const manual = Motion.newCandidate(series, 9);
  assert.equal(manual.origin, "manual");
  assert.equal(Motion.evaluateCandidate(series, manual).track.ok, false);
  Motion.setPosition(manual, series.entries[0].id, { x: 10, y: 10, method: "clicked" });
  Motion.setPosition(manual, series.entries[1].id, { x: 14, y: 10, method: "clicked" });
  const track = Motion.evaluateCandidate(series, manual).track;
  near(track.displacement.arcsec, 24, 0.1);
  near(track.displacement.pa, 270, 0.1); // larger x is west
});

test("centroid refinement finds the centre of a star on the reference grid and says when it cannot", async () => {
  const star = { x: 30.4, y: 40.3, amp: 400 };
  const epoch = await epochFrom(field({ sources: [star], seed: 3, time: t0, obsId: "CEN" }).bytes, "centroid.fits");
  const image = { width: size, height: size, values: epoch.values, valid: Uint8Array.from(epoch.values, (value) => Number.isFinite(value) ? 1 : 0) };
  const refined = Motion.refineCentroid(image, 31, 40);
  assert.equal(refined.refined, true);
  near(refined.x, 30.4, 0.1);
  near(refined.y, 40.3, 0.1);
  const outside = Motion.refineCentroid(image, 500, 500);
  assert.equal(outside.refined, false);
  assert.match(outside.reason, /outside/);
  const flat = Motion.refineCentroid({ width: 20, height: 20, values: new Float64Array(400).fill(5), valid: new Uint8Array(400).fill(1) }, 10, 10);
  assert.equal(flat.refined, false);
});

test("pairing and linking: pairs are matched once, ambiguity is flagged, and epochs share one reference position", () => {
  const peak = (x, y, sign, significance = 20) => ({ x, y, column: Math.round(x) - 1, row: Math.round(y) - 1, sign, value: sign * 100, significance });
  const peaks = [peak(10, 10, -1), peak(16, 10, 1), peak(10.5, 13, 1, 8)];
  const paired = Motion.pairResiduals(peaks, { minSeparationPixels: 2.5, maxSeparationPixels: 15, pixelScale: 6 });
  assert.equal(paired.pairs.length, 1);
  assert.equal(paired.pairs[0].positive.x, 16); // the stronger lobe wins
  near(paired.pairs[0].separationArcsec, 36, 1e-9);
  assert.equal(paired.unpaired.positive.length, 1);
  assert.ok(paired.pairs[0].flags.some((flag) => /Other residuals/.test(flag)));
  const tooClose = Motion.pairResiduals([peak(10, 10, -1), peak(11, 10, 1)], { minSeparationPixels: 2.5 });
  assert.equal(tooClose.pairs.length, 0);
  assert.equal(tooClose.rejected.length, 1);
  const far = Motion.pairResiduals([peak(10, 10, -1), peak(60, 10, 1)], { maxSeparationPixels: 15 });
  assert.equal(far.pairs.length, 0);
  assert.equal(far.unpaired.positive.length + far.unpaired.negative.length, 2);
  const make = (nx, ny, px, py) => ({ negative: peak(nx, ny, -1), positive: peak(px, py, 1), separationPixels: 5, flags: [] });
  const clusters = Motion.linkPairs({ A: [make(10, 10, 15, 10), make(40, 40, 45, 40)], B: [make(10.4, 9.8, 20, 10), make(10.2, 10.1, 30, 30)] }, { linkTolerancePixels: 2 });
  assert.equal(clusters.length, 2);
  const shared = clusters.find((cluster) => Object.keys(cluster.members).length === 2);
  assert.ok(shared);
  assert.equal(shared.extra.B, 1); // a second pair of epoch B fell on the same reference position
  near(shared.reference.x, 10.2, 0.2);
});

// ---- CSV export --------------------------------------------------------------------------------------------------------------
test("CSV export: one row per position with the same measurements, review status and source identifiers", async () => {
  const epochs = await movingSeries();
  epochs[1].name = '=HYPERLINK("x"),evil.fits';
  const series = Motion.analyzeSeries(epochs);
  series.candidates[0].status = "keep";
  const text = Motion.candidatesCsv(series, series.candidates);
  assert.ok(text.endsWith("\r\n"));
  const lines = text.trim().split("\r\n");
  assert.equal(lines[0], Motion.csvColumns.join(","));
  assert.equal(lines.length, 4);
  assert.ok(!/NaN|undefined|Infinity/.test(text));
  assert.ok(lines[1].startsWith("C1,keep for review,detected,"));
  assert.ok(text.includes("SYN-0") && text.includes("SYN-2"));
  assert.ok(text.includes("'=HYPERLINK(\"\"x\"\"),evil.fits") || text.includes("\"'=HYPERLINK"), "spreadsheet formulas are neutralised");
  assert.ok(!lines.some((line) => /^=/.test(line)));
  assert.ok(text.includes("2025-05-24T06:00:00"));
  assert.ok(text.includes("target - reference"));
  const header = lines[0].split(",");
  const rateColumn = header.indexOf("rate_arcsec_per_hour");
  // Simple split is safe for the first row: it holds no quoted text before this column.
  near(Number(lines[1].split(",")[rateColumn]), 5, 0.1);
  assert.equal(Motion.csvCell(null), "");
  assert.equal(Motion.csvCell(NaN), "");
  assert.equal(Motion.csvCell('a "b", c'), '"a ""b"", c"');
  assert.equal(Motion.csvCell("-5"), "-5");
  assert.equal(Motion.csvCell(-5), "-5");
});

// ---- Real pair -------------------------------------------------------------------------------------------------------------------
const exampleSource = readFileSync(join(root, "assets/tools/spherex-time-machine-example.js"), "utf8");
const realEncoded = vm.runInNewContext(exampleSource + "\nspherexTimeMachineExample;");

async function loadReal(encoded, name) {
  const file = new File([Buffer.from(encoded, "base64")], name);
  const hdus = await fitsLib.readFitsHdus(file);
  const index = hdus.findIndex((hdu) => hdu.fields.EXTNAME === "IMAGE");
  const hdu = hdus[index];
  const data = await file.slice(hdu.dataStart, hdu.dataStart + hdu.byteLength).arrayBuffer();
  const read = fitsLib.fitsPixelReader(data, hdu);
  const values = Float64Array.from({ length: hdu.pixels }, (_, i) => read(i));
  return Motion.buildEpoch(hdu, index, values, { id: "R" + ++nextId, name });
}

test("real SPHEREx pair: runs through the same code, in time order, and every reported position traces back to a file pixel", async () => {
  const june = await loadReal(realEncoded.comparison, "2025W24_1A_0514_1.fits");
  const may = await loadReal(realEncoded.reference, "2025W21_2C_0280_1.fits");
  const series = Motion.analyzeSeries([june, may]); // loaded in the wrong order on purpose
  assert.equal(series.ok, true);
  assert.equal(series.reference.meta.obsId, "2025W21_2C_0280_1", "the earlier observation is the default reference");
  assert.equal(series.entries.length, 2);
  const entry = series.entries.find((item) => !item.isReference);
  assert.equal(entry.included, true);
  assert.equal(entry.diff.mode, "reprojected-difference");
  assert.equal(entry.diff.sign, "target-minus-reference");
  assert.equal(series.settings.unit, "MJy / sr");
  assert.ok(entry.detection.ok);
  // Whatever the detector reports (possibly nothing) must have positions inside the files and a valid track or reason.
  for (const candidate of series.candidates) {
    const evaluated = Motion.evaluateCandidate(series, candidate);
    for (const point of evaluated.points) {
      assert.ok(point.source, "position inside the epoch's own image");
      assert.ok(Number.isFinite(point.ra) && Number.isFinite(point.dec));
    }
    assert.equal(evaluated.track.ok, true);
    assert.equal(evaluated.track.chronological, true);
    assert.ok(evaluated.track.rate);
    near(evaluated.track.deltaTDays, 18.4, 0.2);
  }
  const csv = Motion.candidatesCsv(series, series.candidates);
  assert.ok(csv.startsWith("candidate_id,"));
  assert.ok(Pair.formatMjd(may.meta.time.mjd).startsWith("2025-05-24"));
  assert.ok(Wcs.angularSeparation(150, 2, 150, 2) === 0);
});
