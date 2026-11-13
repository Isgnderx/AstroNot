// Run with:  node --test tests/        (or: node tests/source-detection.test.mjs)
//
// Covers tools/detect.js, the computation behind Source Detection.
//   - The "controlled image" sections build synthetic FITS files with tests/fits-builder.mjs: a flat background with seeded
//     Gaussian noise, Gaussian sources at KNOWN centres, a NaN block, a sub-threshold source and a close pair. They are test
//     fixtures, not archive data.
//   - The "real cutout" section uses assets/tools/spherex-example.js, a 70 x 70 IRSA SPHEREx QR2 cutout
//     (2025W21_2C_0280_1, detector 2). The number of candidates found there is not asserted; the checks follow each
//     candidate from its table row back to the pixel array.
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
const Detect = require("../tools/detect.js");

const fitsSandbox = vm.createContext({ TextDecoder, document: { querySelector: () => null }, atob, Uint8Array });
const fitsLib = vm.runInContext(readFileSync(join(root, "tools/fits.js"), "utf8") + "\n({ readFitsHdus, fitsPixelReader });", fitsSandbox);

const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, (message ?? "") + " expected " + expected + " +/- " + tolerance + ", got " + actual);

// ---- Fixtures ----------------------------------------------------------------------------------------------------------
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussianNoise(seed) {
  const next = random(seed);
  return () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
}

const sources = {
  A: { x: 30.3, y: 40.7, amp: 40, sigma: 1.3 },
  B: { x: 88.6, y: 62.2, amp: 25, sigma: 1.3 },
  C: { x: 97.5, y: 80, amp: 30, sigma: 1.3 }, // beside the masked block
  E: { x: 2, y: 50, amp: 30, sigma: 1.3 }, // on the image border
  F: { x: 60, y: 20, amp: 1.5, sigma: 1.3 }, // below the threshold
  G1: { x: 50, y: 80, amp: 30, sigma: 1.3 }, // close pair
  G2: { x: 54.5, y: 80, amp: 30, sigma: 1.3 },
  H: { x: 110, y: 80, amp: 60, sigma: 1.3 }, // hidden under the masked block
};
const mask = { x0: 100, x1: 118, y0: 70, y1: 90 }; // FITS pixel numbers, inclusive

function skyFields({ ra = 150, dec = 2, crpix = [64.5, 48.5], scale = 6 / 3600 } = {}) {
  return [
    ["CTYPE1", "RA---TAN"], ["CTYPE2", "DEC--TAN"], ["CRVAL1", ra], ["CRVAL2", dec], ["CRPIX1", crpix[0]], ["CRPIX2", crpix[1]],
    ["CD1_1", -scale], ["CD1_2", 0], ["CD2_1", 0], ["CD2_2", scale], ["RADESYS", "ICRS"], ["BUNIT", "MJy / sr"], ["OBSID", "TEST_FIXTURE_1"],
  ];
}

// value(x, y) in FITS pixel numbers.
function synthetic({ width = 128, height = 96, background = (x, y) => 50, noise = 1, seed = 7, list = Object.values(sources), masked = true, wcs = true, extra = [] } = {}) {
  const draw = gaussianNoise(seed);
  const data = new Float64Array(width * height);
  for (let y = 1; y <= height; y++) {
    for (let x = 1; x <= width; x++) {
      let value = background(x, y) + (noise ? noise * draw() : 0);
      for (const s of list) value += s.amp * Math.exp(-((x - s.x) ** 2 + (y - s.y) ** 2) / (2 * s.sigma ** 2));
      if (masked && x >= mask.x0 && x <= mask.x1 && y >= mask.y0 && y <= mask.y1) value = NaN;
      data[(y - 1) * width + (x - 1)] = value;
    }
  }
  const bytes = buildFits({ width, height, bitpix: -32, extra: [...(wcs ? skyFields() : [["BUNIT", "MJy / sr"]]), ...extra], pixels: (x, y) => data[y * width + x] });
  return { bytes, data, width, height };
}

// Reads a built FITS file the way the workspace does (fits.js), so BLANK and scaling are handled by the shared reader.
async function openImage(bytes, { hduIndex = 0 } = {}) {
  const file = new File([bytes], "synthetic.fits");
  const hdus = await fitsLib.readFitsHdus(file);
  const hdu = hdus[hduIndex];
  const buffer = await file.slice(hdu.dataStart, hdu.dataStart + hdu.byteLength).arrayBuffer();
  const read = fitsLib.fitsPixelReader(buffer, hdu);
  const values = Float64Array.from({ length: hdu.pixels }, (_, i) => read(i));
  const created = Wcs.createWcs(hdu.fields);
  return { width: hdu.axes[0], height: hdu.axes[1], values, hdu, wcs: created.ok ? created.wcs : null, unit: hdu.fields.BUNIT ?? "", fields: hdu.fields };
}

const detect = (image, params = {}, hooks) => Detect.detectSources(image, params, hooks);
const closest = (result, target) => result.sources.reduce((best, source) => Math.hypot(source.x - target.x, source.y - target.y) < Math.hypot(best.x - target.x, best.y - target.y) ? source : best);
const within = (result, target, radius) => result.sources.filter((source) => Math.hypot(source.x - target.x, source.y - target.y) <= radius);

const fixture = synthetic();
const image = await openImage(fixture.bytes);
const base = await detect(image);

// ---- Controlled image --------------------------------------------------------------------------------------------------
test("controlled image: two well separated sources are found at their known centres", () => {
  assert.equal(base.ok, true, base.reason);
  for (const key of ["A", "B"]) {
    const found = within(base, sources[key], 1);
    assert.equal(found.length, 1, key + " must be found exactly once");
    near(found[0].x, sources[key].x, 0.2, key + " x");
    near(found[0].y, sources[key].y, 0.2, key + " y");
    assert.deepEqual(found[0].flags, [], key + " is clean: no edge, mask, saturation or blend flag");
  }
});

test("controlled image: RA and Dec match the WCS at the known centres", () => {
  assert.ok(image.wcs, "the synthetic header must give a usable WCS");
  const scaleDeg = 6 / 3600;
  for (const key of ["A", "B"]) {
    const source = within(base, sources[key], 1)[0];
    const truth = image.wcs.pixelToSky(sources[key].x, sources[key].y);
    const separation = Wcs.angularSeparation(source.ra, source.dec, truth.ra, truth.dec);
    assert.ok(separation < 0.2 * scaleDeg, key + " separation " + (separation * 3600).toFixed(3) + " arcsec");
    const again = image.wcs.pixelToSky(source.x, source.y);
    near(source.ra, again.ra, 1e-12);
    near(source.dec, again.dec, 1e-12);
  }
});

test("controlled image: the masked block stays out, sources beside it and on the border are flagged", () => {
  const inside = base.sources.filter((source) => source.pixels.some((p) => {
    const x = (p % base.width) + 1;
    const y = Math.floor(p / base.width) + 1;
    return x >= mask.x0 && x <= mask.x1 && y >= mask.y0 && y <= mask.y1;
  }));
  assert.equal(inside.length, 0, "no candidate may contain a NaN pixel");
  assert.equal(within(base, sources.H, 6).length, 0, "the source hidden under the NaN block is not detected");
  assert.equal(base.counts.invalid, (mask.x1 - mask.x0 + 1) * (mask.y1 - mask.y0 + 1));
  const beside = within(base, sources.C, 3);
  assert.equal(beside.length, 1);
  assert.ok(beside[0].flags.includes("masked_neighbour"));
  const border = within(base, sources.E, 3);
  assert.equal(border.length, 1);
  assert.ok(border[0].flags.includes("edge"));
  assert.ok(!within(base, sources.A, 1)[0].flags.includes("edge"));
});

test("controlled image: a source below the threshold is not detected, and only the known sources appear", () => {
  assert.equal(within(base, sources.F, 4).length, 0);
  assert.equal(base.sources.length, 6, "A, B, C, E and the pair (two) at this seed: " + base.sources.map((s) => s.id + "@" + s.x.toFixed(1) + "," + s.y.toFixed(1)).join(" "));
});

test("controlled image: a close pair is split by deblending and flagged blended", () => {
  assert.equal(base.params.deblend, true);
  const g1 = within(base, sources.G1, 1.5);
  const g2 = within(base, sources.G2, 1.5);
  assert.equal(g1.length, 1);
  assert.equal(g2.length, 1);
  assert.notEqual(g1[0], g2[0]);
  near(g1[0].x, sources.G1.x, 0.6, "G1 x");
  near(g2[0].x, sources.G2.x, 0.6, "G2 x");
  assert.ok(g1[0].flags.includes("blended") && g2[0].flags.includes("blended"));
  assert.equal(g1[0].pixels.filter((p) => g2[0].pixels.includes(p)).length, 0, "the two sources share no pixel");
});

test("controlled image: with deblending off the pair stays one flagged source", async () => {
  const merged = await detect(image, { deblend: false });
  assert.equal(merged.ok, true);
  const pair = within(merged, { x: 52.25, y: 80 }, 3);
  assert.equal(pair.length, 1);
  assert.ok(pair[0].flags.includes("blended"));
  assert.equal(merged.sources.length, base.sources.length - 1);
  near(pair[0].x, 52.25, 0.4);
});

test("controlled image: a single bright source is never split by noise", async () => {
  const single = await openImage(synthetic({ list: [{ x: 60, y: 48, amp: 400, sigma: 4 }], masked: false, seed: 11 }).bytes);
  const result = await detect(single);
  assert.equal(result.sources.length, 1);
  assert.deepEqual(result.sources[0].flags, []);
});

test("controlled image: results are repeatable and the input array is not changed", async () => {
  const before = Float64Array.from(image.values);
  const again = await detect(image);
  assert.deepEqual(again.sources.map((s) => [s.id, s.x, s.y, s.area]), base.sources.map((s) => [s.id, s.x, s.y, s.area]));
  assert.ok(before.every((value, index) => Object.is(value, image.values[index])));
});

test("controlled image: flux, peak and area follow the segment pixels and the stated background", () => {
  for (const source of base.sources) {
    let flux = 0;
    let peak = -Infinity;
    for (const p of source.pixels) {
      const d = image.values[p] - base.background.globalMedian;
      flux += d;
      peak = Math.max(peak, d);
    }
    near(source.fluxSum, flux, 1e-6 * Math.abs(flux), source.id + " flux");
    near(source.peak, peak, 1e-9, source.id + " peak");
    assert.equal(source.area, source.pixels.length);
    assert.ok(source.pixels.every((p) => Number.isFinite(image.values[p])));
    assert.ok(source.significance > base.params.threshold, source.id + " significance");
  }
  near(base.background.globalMedian, 50, 0.2);
  near(base.noise.sigma, 1, 0.1);
});

test("controlled image: a higher threshold or more pixels removes candidates and replaces the earlier result", async () => {
  const strict = await detect(image, { threshold: 22 });
  assert.ok(strict.sources.length < base.sources.length);
  assert.ok(strict.sources.length >= 1);
  const larger = await detect(image, { minPixels: 60 });
  assert.ok(larger.sources.length < base.sources.length);
  assert.ok(larger.sources.every((source) => source.area >= 60));
  const lenient = await detect(image, { threshold: 2, minPixels: 5 });
  assert.ok(lenient.counts.aboveThreshold > base.counts.aboveThreshold);
});

test("controlled image: the threshold in sigma is reported as an image-unit level", () => {
  near(base.threshold.levelMedian, 3 * base.noise.sigma, 1e-6);
  assert.equal(base.threshold.unit, "MJy / sr");
});

// ---- Noise, masks and special images -----------------------------------------------------------------------------------
test("zero noise: a threshold in sigma is refused with the reason, an absolute threshold works", async () => {
  const flat = await openImage(synthetic({ noise: 0, masked: false, list: [sources.A, sources.B] }).bytes);
  const refused = await detect(flat);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "no-noise");
  assert.match(refused.reason, /absolute threshold/);
  const absolute = await detect(flat, { thresholdMode: "absolute", threshold: 2, minPixels: 5 });
  assert.equal(absolute.ok, true);
  assert.equal(absolute.sources.length, 2);
  near(closest(absolute, sources.A).x, sources.A.x, 0.05);
  near(closest(absolute, sources.A).y, sources.A.y, 0.05);
  assert.equal(absolute.sources[0].significance, null, "no S/N without a noise level");
  const empty = await openImage(synthetic({ noise: 0, masked: false, list: [] }).bytes);
  const none = await detect(empty, { thresholdMode: "absolute", threshold: 1 });
  assert.equal(none.ok, true);
  assert.equal(none.sources.length, 0);
});

test("an image with no valid pixel, or too few, is refused", async () => {
  const allNaN = { width: 40, height: 30, values: new Float64Array(40 * 30).fill(NaN) };
  const none = await detect(allNaN);
  assert.equal(none.ok, false);
  assert.equal(none.code, "too-few-pixels");
  assert.match(none.reason, /no valid pixels/);
  const few = new Float64Array(40 * 30).fill(NaN);
  for (let i = 0; i < 50; i++) few[i] = i % 7;
  const sparse = await detect({ width: 40, height: 30, values: few });
  assert.equal(sparse.code, "too-few-pixels");
  const infinite = await detect({ width: 20, height: 20, values: new Float64Array(400).fill(Infinity) });
  assert.equal(infinite.code, "too-few-pixels");
});

test("BLANK pixels are invalid, not zero or the BLANK number, and do not disturb background or noise", async () => {
  const width = 100;
  const height = 80;
  const draw = gaussianNoise(3);
  const counts = new Int16Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const blank = x >= 70 && x < 90 && y >= 30 && y < 50;
      const star = 600 * Math.exp(-((x + 1 - 30) ** 2 + (y + 1 - 40) ** 2) / (2 * 1.5 ** 2)) + 600 * Math.exp(-((x + 1 - 69) ** 2 + (y + 1 - 40) ** 2) / (2 * 1.5 ** 2));
      counts[y * width + x] = blank ? -32768 : Math.round(1000 + 4 * draw() + star);
    }
  }
  const bytes = buildFits({ width, height, bitpix: 16, extra: [["BLANK", -32768], ["BSCALE", 1], ["BZERO", 0], ["BUNIT", "adu"]], pixels: (x, y) => counts[y * width + x] });
  const blank = await openImage(bytes);
  assert.equal(blank.values.filter(Number.isNaN).length, 20 * 20, "BLANK pixels become NaN in the shared reader");
  const result = await detect(blank);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.counts.invalid, 400);
  near(result.background.globalMedian, 1000, 1);
  near(result.noise.sigma, 4, 0.5);
  const first = within(result, { x: 30, y: 40 }, 2);
  const second = within(result, { x: 69, y: 40 }, 2.5);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.deepEqual(first[0].flags, []);
  assert.ok(second[0].flags.includes("masked_neighbour"), "a star next to BLANK pixels is flagged");
  assert.ok(result.sources.every((source) => source.pixels.every((p) => blank.values[p] > 0)));
});

test("a VARIANCE image gives the noise pixel by pixel; zero, negative and NaN variance are not tested", async () => {
  const data = synthetic({ masked: false, list: [sources.A, sources.B], seed: 21 });
  const flat = await openImage(data.bytes);
  const variance = new Float64Array(flat.values.length).fill(1);
  for (let y = 80; y <= 90; y++) {
    for (let x = 100; x <= 110; x++) variance[(y - 1) * flat.width + (x - 1)] = (x + y) % 3 === 0 ? 0 : (x + y) % 3 === 1 ? -4 : NaN;
  }
  const measured = await detect(flat);
  const withVariance = await detect({ ...flat, variance }, { noise: "variance" });
  assert.equal(withVariance.ok, true, withVariance.reason);
  assert.equal(withVariance.noise.method, "variance");
  near(withVariance.noise.sigmaFromVariance, 1, 1e-9);
  assert.equal(withVariance.sources.length, measured.sources.length);
  assert.ok(withVariance.warnings.some((text) => /zero, negative or non-finite variance/.test(text)));
  assert.ok(withVariance.counts.untestable >= 121);
  const none = await detect(flat, { noise: "variance" });
  assert.equal(none.code, "no-variance");
  const badOnly = await detect({ ...flat, variance: new Float64Array(flat.values.length).fill(0) }, { noise: "variance" });
  assert.equal(badOnly.code, "no-noise");
  const inflated = await detect({ ...flat, variance: new Float64Array(flat.values.length).fill(400) }, { noise: "variance" });
  assert.ok(inflated.warnings.some((text) => /differs from the scatter measured/.test(text)));
  assert.ok(inflated.sources.length < measured.sources.length || inflated.sources.length === 0 || inflated.sources[0].significance < measured.sources[0].significance);
});

test("VARIANCE unit check accepts the SPHEREx spelling and refuses a wrong unit", () => {
  assert.equal(Detect.varianceUnitCheck("MJy2 / sr2", "MJy / sr").ok, true);
  assert.equal(Detect.varianceUnitCheck("(MJy/sr)^2", "MJy / sr").ok, true);
  assert.equal(Detect.varianceUnitCheck("MJy^2/sr^2", "MJy/sr").ok, true);
  assert.equal(Detect.varianceUnitCheck("", "MJy/sr").assumed, true);
  assert.equal(Detect.varianceUnitCheck("MJy / sr", "MJy / sr").ok, false);
  assert.equal(Detect.varianceUnitCheck("Jy2", "MJy / sr").ok, false);
});

test("a mesh background follows a gradient that a global background cannot", async () => {
  const sloped = await openImage(synthetic({ masked: false, list: [sources.A, sources.B], background: (x) => 50 + 0.2 * x, seed: 5 }).bytes);
  const global = await detect(sloped);
  const mesh = await detect(sloped, { background: "mesh", meshSize: 16 });
  assert.equal(mesh.ok, true, mesh.reason);
  assert.equal(mesh.sources.length, 2, mesh.sources.map((s) => s.id + "@" + s.x.toFixed(1)).join(" "));
  near(closest(mesh, sources.A).x, sources.A.x, 0.25);
  near(closest(mesh, sources.B).y, sources.B.y, 0.25);
  assert.ok(global.noise.sigma > 3 * mesh.noise.sigma, "the ramp inflates the global noise estimate: " + global.noise.sigma + " vs " + mesh.noise.sigma);
  assert.ok(mesh.background.levelMax - mesh.background.levelMin > 15, "the mesh follows the 25-count ramp");
  assert.equal(mesh.background.method, "mesh");
});

test("smoothing finds a faint extended source that the raw pixels do not show", async () => {
  const faint = { x: 64, y: 48, amp: 1.2, sigma: 2.5 };
  const data = await openImage(synthetic({ masked: false, list: [faint], seed: 9 }).bytes);
  const raw = await detect(data);
  assert.equal(within(raw, faint, 4).length, 0);
  const smooth = await detect(data, { smoothFwhm: 5 });
  assert.equal(smooth.ok, true);
  const found = within(smooth, faint, 4);
  assert.equal(found.length, 1);
  near(found[0].x, faint.x, 1);
  assert.ok(smooth.noise.detectionSigma < 0.2 * smooth.noise.sigma, "smoothing lowers the noise of the detection image");
});

test("a smoothed image treats masked pixels as missing, not as zero", async () => {
  const data = await openImage(synthetic({ masked: true, list: [sources.G1, sources.G2, sources.C], seed: 4 }).bytes);
  const result = await detect(data, { smoothFwhm: 3 });
  assert.equal(result.ok, true);
  assert.ok(result.sources.every((source) => source.pixels.every((p) => Number.isFinite(data.values[p]))));
  const beside = within(result, sources.C, 4);
  assert.equal(beside.length, 1);
  assert.ok(beside[0].flags.includes("masked_neighbour"));
});

test("saturation: flagged only when a level is known and reached", async () => {
  const none = within(base, sources.A, 1)[0];
  assert.ok(!none.flags.includes("saturated"));
  const saturated = await detect(image, { saturation: 80 });
  assert.ok(within(saturated, sources.A, 1)[0].flags.includes("saturated"), "A peaks near 90");
  assert.ok(!within(saturated, sources.B, 1)[0].flags.includes("saturated"), "B peaks near 75");
});

test("without a WCS the pixel candidates still work and RA/Dec are null", async () => {
  const bare = await openImage(synthetic({ wcs: false }).bytes);
  assert.equal(bare.wcs, null);
  const result = await detect(bare);
  assert.equal(result.ok, true);
  assert.equal(result.sources.length, base.sources.length);
  assert.ok(result.sources.every((source) => source.ra === null && source.dec === null));
});

test("limits: too large, wrong array size, too many candidates and bad parameters are refused with a reason", async () => {
  assert.equal((await detect({ width: 4096, height: 4096, values: new Float64Array(1) })).code, "too-large");
  assert.equal((await detect({ width: 10, height: 10, values: new Float64Array(5) })).code, "bad-image");
  const noisy = await openImage(synthetic({ masked: false, list: [], seed: 2, width: 300, height: 300 }).bytes);
  const crowded = await detect(noisy, { threshold: 1.5, minPixels: 1 });
  assert.equal(crowded.ok, false);
  assert.equal(crowded.code, "too-many-sources");
  const check = Detect.validateParams({ threshold: "abc", minPixels: 2.5, smoothFwhm: 0.4, meshSize: 4, valleySigma: -1, background: "x", saturation: "no" });
  assert.equal(check.ok, false);
  assert.equal(check.errors.length, 7);
  assert.equal(Detect.validateParams({ threshold: " 4.5 ", minPixels: "7", saturation: "" }).params.minPixels, 7);
  assert.equal((await detect(image, { threshold: 0 })).code, "bad-parameters");
});

test("a newer run can cancel an older one and progress is reported", async () => {
  const stages = [];
  const finished = await detect(image, {}, { progress: (name) => stages.push(name), tick: () => Promise.resolve() });
  assert.equal(finished.ok, true);
  assert.ok(stages.length >= 4 && stages[0] === "Reading pixel values…");
  let calls = 0;
  const cancelled = await detect(image, {}, { cancelled: () => ++calls > 3 });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.code, "cancelled");
});

// ---- CSV for Catalog Cross-Match ---------------------------------------------------------------------------------------
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
    else if (c === ",") { row.push(field); field = ""; } else if (c === "\r") { /* skipped */ } else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; } else field += c;
  }
  return rows;
}

test("CSV: the Cross-Match columns, 1-based pixels, pixel_origin 1 and sky coordinates in degrees", () => {
  const csv = Detect.buildCsv(base, { sourceFile: "synthetic.fits", obsId: "TEST_FIXTURE_1", hduIndex: 0 });
  const rows = parseCsv(csv);
  assert.deepEqual(rows[0], ["source_id", "x_pixel", "y_pixel", "ra", "dec", "area_pixels", "peak", "flux_sum", "flags", "source_file", "obs_id", "hdu", "pixel_origin"]);
  assert.equal(rows.length - 1, base.sources.length);
  const a = within(base, sources.A, 1)[0];
  const row = rows.find((entry) => entry[0] === a.id);
  near(Number(row[1]), a.x, 5e-5);
  near(Number(row[2]), a.y, 5e-5);
  near(Number(row[3]), a.ra, 1e-8);
  near(Number(row[4]), a.dec, 1e-8);
  assert.equal(Number(row[5]), a.area);
  near(Number(row[6]), a.peak, 1e-6 * a.peak);
  near(Number(row[7]), a.fluxSum, 1e-6 * a.fluxSum);
  assert.deepEqual(row.slice(9), ["synthetic.fits", "TEST_FIXTURE_1", "0", "1"]);
  assert.ok(Number(row[1]) >= 1 && Number(row[1]) <= image.width, "first pixel centre is 1, not 0");
  const flagged = rows.find((entry) => entry[8].includes("blended"));
  assert.match(flagged[8], /^[a-z_;]+$/);
});

test("CSV: ra and dec stay empty without a WCS, text is quoted, formulas are neutralised, onlySky drops rows", async () => {
  const bare = await detect(await openImage(synthetic({ wcs: false }).bytes));
  const csv = Detect.buildCsv(bare, { sourceFile: '=cmd,"x".fits', obsId: "id,1", hduIndex: 1 });
  const rows = parseCsv(csv);
  assert.ok(rows.slice(1).every((row) => row[3] === "" && row[4] === ""));
  assert.equal(rows[1][9], "'=cmd,\"x\".fits");
  assert.equal(rows[1][10], "id,1");
  assert.equal(parseCsv(Detect.buildCsv(bare, { sourceFile: "a.fits" }, { onlySky: true })).length, 1, "only the header remains");
  assert.equal(parseCsv(Detect.buildCsv(base, { sourceFile: "a.fits" }, { onlySky: true })).length - 1, base.sources.length);
  assert.equal(rows[1][11], "1");
});

test("metadata keeps the file, HDU, units and every parameter, and calls the sources candidates", () => {
  const metadata = Detect.buildMetadata(base, { sourceFile: "synthetic.fits", obsId: "TEST_FIXTURE_1", hduIndex: 0, hduName: "Primary", wcsSummary: "RA---TAN" });
  assert.equal(metadata.pixel_origin, 1);
  assert.equal(metadata.source.bunit, "MJy / sr");
  assert.equal(metadata.parameters.threshold, 3);
  assert.equal(metadata.parameters.threshold_unit, "sigma above the local background");
  assert.equal(metadata.parameters.minimum_connected_pixels, 5);
  assert.match(metadata.note, /not catalog identifications/);
  assert.doesNotThrow(() => JSON.stringify(metadata));
});

// ---- Real cutout -------------------------------------------------------------------------------------------------------
const exampleSource = readFileSync(join(root, "assets/tools/spherex-example.js"), "utf8");
const exampleBytes = Buffer.from(vm.runInNewContext(exampleSource + "\nspherexExampleData;"), "base64");

test("real SPHEREx cutout: every candidate is traceable from its table row to the pixel array", async () => {
  const real = await openImage(exampleBytes, { hduIndex: 1 });
  assert.equal(real.width, 70);
  assert.equal(real.height, 70);
  assert.ok(real.wcs, "the example has a TAN-SIP WCS");
  const result = await detect(real, { threshold: 3, minPixels: 5 });
  assert.equal(result.ok, true, result.reason);
  assert.ok(Array.isArray(result.sources));
  assert.equal(result.counts.total, 4900);
  if (result.sources.length === 0) return; // an empty list is a valid result; the count is not fixed in advance
  const buffer = await new File([exampleBytes], "e.fits").slice(real.hdu.dataStart, real.hdu.dataStart + real.hdu.byteLength).arrayBuffer();
  const read = fitsLib.fitsPixelReader(buffer, real.hdu); // independent read of the array
  const median = result.background.globalMedian;
  const sigma = result.noise.sigma;
  for (const source of result.sources) {
    assert.match(source.id, /^S\d{3,}$/);
    assert.ok(source.x >= 0.5 && source.x <= 70.5 && source.y >= 0.5 && source.y <= 70.5);
    assert.ok(source.x >= source.bbox.xMin - 0.5 && source.x <= source.bbox.xMax + 0.5 && source.y >= source.bbox.yMin - 0.5 && source.y <= source.bbox.yMax + 0.5);
    let flux = 0;
    for (const p of source.pixels) {
      const value = read(p);
      assert.ok(Number.isFinite(value));
      assert.ok(value - median > 3 * sigma - 1e-6, source.id + " pixel " + p + " is above the stated threshold");
      flux += value - median;
    }
    near(source.fluxSum, flux, 1e-9 * Math.abs(flux) + 1e-12);
    const peakIndex = (source.peakY - 1) * 70 + (source.peakX - 1);
    assert.equal(read(peakIndex), source.peakValue);
    near(source.peak, source.peakValue - median, 1e-9);
    const sky = real.wcs.pixelToSky(source.x, source.y);
    assert.equal(source.ra, sky.ra);
    assert.equal(source.dec, sky.dec);
  }
});
