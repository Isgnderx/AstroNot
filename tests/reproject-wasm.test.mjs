// Run with:  node --test tests/        (or: node tests/reproject-wasm.test.mjs)
//
// Parity of the Rust/WebAssembly reprojection kernel (rust/crates/reproject, installed with Diff.useKernel) with the JavaScript
// reprojectBilinear in tools/difference.js (which uses tools/wcs.js): status codes, values and variances, on synthetic
// images (rotation, scale change, PC/CDELT and CD headers, TAN-SIP with and without AP/BP, RA wrap, high declination, NaN and
// masked neighbours, variance NaN/negative, outside the footprint) and on the two real SPHEREx QR2 cutouts bundled in
// assets/tools/spherex-time-machine-example.js (TAN-SIP order 3, 70 x 70), including the mosaic and the difference built on them.
//
// Two kernel modes are checked: exact (the same trigonometric chain as wcs.js, per pixel) and the default fast mode (one
// rotation per pixel, the same map up to rounding). The JavaScript chain itself rounds the position through RA/Dec in degrees
// (a quantisation of about 1e-11 pixel at RA 150), so the values are compared with a tolerance of 1e-9 of max(|value|, 1 % of
// the value range of the image), i.e. 1e-9 relative with a floor where the interpolated value crosses zero. Status codes must
// be identical except for pixels whose source position lies within 1e-8 pixel of a decision threshold (edge of the footprint,
// the 1e-7 snap to a pixel centre).
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
const Diff = require("../tools/difference.js");
const Mosaic = require("../tools/mosaic-model.js");
const Pair = require("../tools/pair.js");
const Wasm = require("../tools/wasm.js");

const kernel = await Wasm.load("reproject");
const modes = [{ name: "fast", exact: false }, { name: "exact", exact: true }];

// ---- Comparison helpers ----------------------------------------------------------------------------------------------------
function valueRange(array) {
  let low = Infinity;
  let high = -Infinity;
  for (const value of array) if (Number.isFinite(value)) { low = Math.min(low, value); high = Math.max(high, value); }
  return Number.isFinite(low) ? high - low : 1;
}

// Is the (JavaScript) source position of an output pixel within `margin` pixels of a threshold of reprojectBilinear?
function nearThreshold(source, grid, column, row, margin = 1e-8) {
  const sky = grid.wcs.pixelToSky(column + 1, row + 1);
  const at = sky && source.wcs.skyToPixel(sky.ra, sky.dec);
  if (!at) return true;
  const close = (value, limit) => Math.abs(value - limit) < margin;
  if ([1 - 1e-6, source.width + 1e-6].some((limit) => close(at.x, limit)) || [1 - 1e-6, source.height + 1e-6].some((limit) => close(at.y, limit))) return true;
  const fx = at.x - Math.floor(at.x);
  const fy = at.y - Math.floor(at.y);
  return [1e-7, 1 - 1e-7].some((limit) => close(fx, limit) || close(fy, limit));
}

// Runs both implementations and compares them. Returns { js, wasm, counts, flips }.
function compare(label, source, grid, { minFlipsAllowed = 0, tolerance = 1e-9 } = {}) {
  const results = {};
  Diff.useKernel(null);
  const js = Diff.reprojectBilinearJs(source, grid);
  for (const mode of modes) {
    assert.equal(Diff.useKernel(kernel, { minPixels: 1, exact: mode.exact }), true);
    const before = Diff.kernelStatus().calls.wasm;
    const wasm = Diff.reprojectBilinear(source, grid);
    assert.equal(Diff.kernelStatus().calls.wasm, before + 1, label + " (" + mode.name + "): the wasm path did not run");
    Diff.useKernel(null);

    assert.equal(wasm.values.length, js.values.length);
    assert.equal(Boolean(wasm.variance), Boolean(js.variance));
    const scale = valueRange(source.values);
    const varianceScale = source.variance ? valueRange(source.variance) : 1;
    const counts = [0, 0, 0, 0];
    let flips = 0;
    let worst = 0;
    for (let index = 0; index < js.values.length; index++) {
      if (js.status[index] !== wasm.status[index]) {
        const column = index % grid.width;
        const row = Math.floor(index / grid.width);
        assert.ok(nearThreshold(source, grid, column, row), label + " (" + mode.name + "): status " + wasm.status[index] + " instead of " + js.status[index] + " at (" + column + ", " + row + ") away from every threshold");
        flips++;
        continue;
      }
      counts[js.status[index]]++;
      const pairs = [[js.values[index], wasm.values[index], scale]];
      if (js.variance) pairs.push([js.variance[index], wasm.variance[index], varianceScale]);
      for (const [a, b, range] of pairs) {
        if (Number.isNaN(a) || Number.isNaN(b)) {
          assert.ok(Number.isNaN(a) && Number.isNaN(b), label + " (" + mode.name + "): NaN mismatch at " + index + ": " + a + " vs " + b);
          continue;
        }
        const limit = tolerance * Math.max(Math.abs(a), Math.abs(b), 0.01 * range);
        worst = Math.max(worst, Math.abs(a - b) / limit);
        assert.ok(Math.abs(a - b) <= limit, label + " (" + mode.name + "): " + a + " vs " + b + " at " + index);
      }
    }
    assert.ok(flips <= minFlipsAllowed + 2, label + " (" + mode.name + "): " + flips + " status flips");
    results[mode.name] = { js, wasm, counts, flips, worst };
  }
  return results;
}

// ---- Synthetic fixtures -------------------------------------------------------------------------------------------------------
let seed = 12345;
function random() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}

function tan({ ra = 150, dec = 2, size = [100, 100], scale = 6, rotate = 0, flip = false, pc = false, sip = null, ap = true, extra = {} } = {}) {
  const [nx, ny] = size;
  const c = Math.cos(rotate * Math.PI / 180);
  const s = Math.sin(rotate * Math.PI / 180);
  const d = scale / 3600;
  const fields = {
    CTYPE1: "RA---TAN" + (sip ? "-SIP" : ""), CTYPE2: "DEC--TAN" + (sip ? "-SIP" : ""), CRVAL1: ra, CRVAL2: dec,
    CRPIX1: (nx + 1) / 2 + 0.3, CRPIX2: (ny + 1) / 2 - 0.2, RADESYS: "ICRS", ...extra,
  };
  const sign = flip ? 1 : -1;
  if (pc) Object.assign(fields, { CDELT1: sign * d, CDELT2: d, PC1_1: c, PC1_2: -s, PC2_1: s, PC2_2: c });
  else Object.assign(fields, { CD1_1: sign * d * c, CD1_2: d * s, CD2_1: d * s, CD2_2: d * c });
  if (sip) {
    const order = sip;
    const reach = Math.max(nx, ny);
    // Distortion of up to about 2 pixels at the edge from each term; AP/BP are the first-order inverse (minus A and B).
    fields.A_ORDER = order;
    fields.B_ORDER = order;
    if (ap) {
      fields.AP_ORDER = order;
      fields.BP_ORDER = order;
    }
    for (let p = 0; p <= order; p++) {
      for (let q = 0; q <= order - p; q++) {
        if (p + q < 2) continue;
        for (const [name, inverse] of [["A", "AP"], ["B", "BP"]]) {
          const c = (random() * 2 - 1) * 2 / reach ** (p + q);
          fields[name + "_" + p + "_" + q] = c;
          if (ap) fields[inverse + "_" + p + "_" + q] = -c * (0.9 + 0.2 * random());
        }
      }
    }
  }
  return fields;
}

function wcsOf(fields) {
  const created = Wcs.createWcs(fields);
  assert.ok(created.ok, created.reason);
  return created.wcs;
}

function field(fields, width, height, { nan = [], mask = [], variance = false, badVariance = [], noise = 3 } = {}) {
  const values = Float64Array.from({ length: width * height }, (_, i) => {
    const x = i % width;
    const y = Math.floor(i / width);
    return 10 * Math.sin(x / 7) * Math.cos(y / 9) + x * 0.05 + noise * random();
  });
  for (const index of nan) values[index] = NaN;
  const out = { width, height, wcs: wcsOf(fields), values };
  if (mask.length) {
    out.mask = new Uint8Array(width * height);
    for (const index of mask) out.mask[index] = 1;
  }
  if (variance) {
    out.variance = Float64Array.from({ length: width * height }, () => 0.5 + random());
    for (const [index, value] of badVariance) out.variance[index] = value;
  }
  return out;
}

const grid = (fields, width, height) => ({ width, height, wcs: wcsOf(fields) });
const summary = (r) => Object.fromEntries(modes.map((m) => [m.name, r[m.name].counts]));

test("the kernel is built and loads", () => {
  assert.ok(kernel, "tools/wasm/reproject.wasm is missing: run node scripts/build-wasm.mjs reproject");
  assert.equal(typeof kernel.exports.reproject_bilinear, "function");
  assert.equal(Diff.useKernel({ exports: {} }), false);
  assert.equal(Diff.kernelStatus().active, false);
});

test("TAN, rotated and rescaled output, larger than the source: valid, outside and identical status codes", () => {
  const source = field(tan({ size: [120, 100], rotate: 0 }), 120, 100);
  const output = grid(tan({ size: [160, 140], scale: 5.3, rotate: 31, ra: 150.002, dec: 2.001 }), 160, 140);
  const r = compare("rotated TAN", source, output);
  for (const mode of modes) {
    assert.ok(r[mode.name].counts[0] > 5000, "valid pixels");
    assert.ok(r[mode.name].counts[1] > 1000, "outside pixels");
  }
});

test("PC/CDELT headers, mirrored axes and a pixel scale change in both directions", () => {
  const a = field(tan({ size: [90, 90], pc: true, rotate: -17, flip: true }), 90, 90);
  const outputs = [
    grid(tan({ size: [140, 130], scale: 3.9, pc: true, rotate: 5 }), 140, 130),
    grid(tan({ size: [70, 60], scale: 11, rotate: 90, flip: true }), 70, 60),
  ];
  for (const [index, output] of outputs.entries()) compare("PC/CDELT " + index, a, output);
});

test("NaN and masked source pixels make every stencil that touches them invalid (status 3), zero stays valid", () => {
  const nan = [];
  const mask = [];
  for (let i = 0; i < 400; i++) { nan.push(Math.floor(random() * 80 * 80)); mask.push(Math.floor(random() * 80 * 80)); }
  const source = field(tan({ size: [80, 80] }), 80, 80, { nan, mask, variance: true });
  source.values[40 * 80 + 40] = 0;
  const output = grid(tan({ size: [90, 90], scale: 6.7, rotate: 12 }), 90, 90);
  const r = compare("NaN and mask", source, output);
  for (const mode of modes) {
    assert.ok(r[mode.name].counts[3] > 50, "pixels with an invalid neighbour: " + r[mode.name].counts[3]);
    assert.ok(r[mode.name].counts[0] > 1000);
  }
});

test("variance: sum of squared weights, NaN or negative variance of a tap gives NaN variance with a valid value", () => {
  const source = field(tan({ size: [60, 60] }), 60, 60, { variance: true, badVariance: [[30 * 60 + 30, NaN], [20 * 60 + 25, -1], [10 * 60 + 12, Infinity], [5 * 60 + 5, 0]] });
  const output = grid(tan({ size: [64, 64], scale: 6.3, rotate: 8 }), 64, 64);
  const r = compare("variance", source, output);
  const { js } = r.fast;
  assert.ok(js.variance.some(Number.isNaN) && js.variance.some((v) => v > 0), "both NaN and finite variances occur");
  assert.ok(js.status.some((s, i) => s === 0 && Number.isNaN(js.variance[i])), "valid value with NaN variance occurs");
});

test("TAN-SIP: forward and iterative inverse, with AP/BP, without AP/BP, and at orders 3, 5 and 9", () => {
  for (const [order, ap] of [[2, true], [3, true], [3, false], [5, true], [5, false], [9, true]]) {
    const source = field(tan({ size: [110, 100], sip: order, ap, rotate: 4 }), 110, 100);
    const output = grid(tan({ size: [130, 120], scale: 5.5, sip: order, ap, rotate: -9, ra: 150.001 }), 130, 120);
    const r = compare("SIP order " + order + (ap ? "" : " without AP/BP"), source, output);
    for (const mode of modes) assert.ok(r[mode.name].counts[0] > 3000, "SIP order " + order + ": " + r[mode.name].counts[0] + " valid pixels");
  }
  // SIP on one side only.
  const plain = field(tan({ size: [100, 100] }), 100, 100);
  compare("SIP output only", plain, grid(tan({ size: [100, 100], sip: 3, scale: 5.8 }), 100, 100));
  compare("SIP source only", field(tan({ size: [100, 100], sip: 3 }), 100, 100), grid(tan({ size: [100, 100], scale: 5.8 }), 100, 100));
});

test("RA wrap: grids on both sides of RA 0 / 360, tangent point at 359.995 and at 0.003", () => {
  const cases = [[359.997, 0.004], [0.003, 359.996], [359.999, 359.999], [0.001, 0.001]];
  for (const [sourceRa, outputRa] of cases) {
    const source = field(tan({ ra: sourceRa, dec: 0.5, size: [100, 100], rotate: 10 }), 100, 100);
    const output = grid(tan({ ra: outputRa, dec: 0.5, size: [110, 110], scale: 5.7 }), 110, 110);
    const r = compare("RA wrap " + sourceRa + " / " + outputRa, source, output);
    for (const mode of modes) assert.ok(r[mode.name].counts[0] > 1000, "RA wrap " + sourceRa + "/" + outputRa + ": valid " + r[mode.name].counts[0]);
  }
});

test("high declination, negative declination and a tangent point 0.4 degree from the pole", () => {
  for (const dec of [-62, 70, 89.6]) {
    const source = field(tan({ dec, size: [100, 100], scale: 20, rotate: 20 }), 100, 100);
    const output = grid(tan({ dec: dec + (dec > 0 ? -0.01 : 0.01), ra: 150.3, size: [96, 96], scale: 21, rotate: 25 }), 96, 96);
    // Near the pole the JavaScript chain loses precision itself (Dec comes back through asin(), RA through atan2 of a tiny
    // circle), so the comparison is 1e-7 there.
    const r = compare("dec " + dec, source, output, { tolerance: dec > 89 ? 1e-7 : 1e-9 });
    for (const mode of modes) assert.ok(r[mode.name].counts[0] > 500, "dec " + dec + ": valid " + r[mode.name].counts[0]);
  }
});

test("the same grid returns the source values; no overlap returns status 1 everywhere", () => {
  const fields = tan({ size: [64, 48], rotate: 13, sip: 3 });
  const source = field(fields, 64, 48);
  const same = compare("same grid", source, grid(fields, 64, 48));
  for (const mode of modes) {
    let worst = 0;
    for (let i = 0; i < source.values.length; i++) {
      assert.equal(same[mode.name].wasm.status[i], 0);
      worst = Math.max(worst, Math.abs(same[mode.name].wasm.values[i] - source.values[i]));
    }
    assert.ok(worst < 1e-9, "same grid: values reproduce the source to " + worst);
  }
  const far = compare("no overlap", source, grid(tan({ ra: 151, size: [40, 40] }), 40, 40));
  for (const mode of modes) assert.deepEqual(far[mode.name].counts, [0, 1600, 0, 0]);
  const antipode = compare("opposite side of the sky", source, grid(tan({ ra: 330, dec: -2, size: [30, 30] }), 30, 30));
  for (const mode of modes) assert.deepEqual(antipode[mode.name].counts, [0, 900, 0, 0]);
});

test("a window of a bigger output grid (the mosaic's kernelBase offsets with sub-pixel sampling) matches the JavaScript wrapper", () => {
  const source = field(tan({ size: [120, 120], sip: 3, rotate: 3 }), 120, 120, { variance: true });
  const full = wcsOf(tan({ size: [300, 300], scale: 2.4, sip: 3, rotate: 20, ra: 150.002 }));
  for (const [c0, r0, cols, rows, dx, dy] of [[17, 40, 90, 70, 0, 0], [120, 130, 111, 77, -0.25, 0.25], [0, 0, 64, 64, 0.1, -0.4]]) {
    const window = {
      width: cols, height: rows,
      wcs: { pixelToSky: (x, y) => full.pixelToSky(x + c0 + dx, y + r0 + dy) },
      kernelBase: { wcs: full, x: c0, y: r0, dx, dy },
    };
    const r = compare("window " + c0 + "," + r0, source, window);
    for (const mode of modes) assert.ok(r[mode.name].counts[0] > 500);
  }
});

test("large output goes through wasm memory in chunks; memory is released and does not grow call after call", () => {
  const source = field(tan({ size: [200, 200] }), 200, 200, { variance: true });
  const output = grid(tan({ size: [1200, 900], scale: 0.9, rotate: 2 }), 1200, 900); // 1.08 M pixels: more than one chunk
  const r = compare("chunked 1.08 M pixels", source, output);
  assert.ok(r.fast.counts[0] > 400000);
  Diff.useKernel(kernel, { minPixels: 1 });
  const small = grid(tan({ size: [300, 300], scale: 4 }), 300, 300);
  Diff.reprojectBilinear(source, small);
  const size = kernel.exports.memory.buffer.byteLength;
  for (let i = 0; i < 25; i++) Diff.reprojectBilinear(source, small);
  assert.equal(kernel.exports.memory.buffer.byteLength, size, "wasm memory grew across repeated calls: regions are not freed");
  // A kept source is uploaded once, reused by the next windows and released on request.
  const kept = Object.assign({}, source, { keepInKernel: true });
  Diff.reprojectBilinear(kept, small);
  const withCache = kernel.exports.memory.buffer.byteLength;
  for (let i = 0; i < 10; i++) Diff.reprojectBilinear(kept, small);
  assert.equal(kernel.exports.memory.buffer.byteLength, withCache);
  Diff.releaseKernelCache();
  const first = Diff.reprojectBilinear(kept, small);
  assert.deepEqual(first.status, Diff.reprojectBilinear(kept, small).status);
  Diff.useKernel(null);
});

test("dispatch: JavaScript stays in charge without a kernel, for tiny outputs, hand-made WCS and other array types", () => {
  const source = field(tan({ size: [100, 100] }), 100, 100);
  const output = grid(tan({ size: [100, 100], scale: 6.2 }), 100, 100);
  const reference = Diff.reprojectBilinearJs(source, output);
  const calls = () => Diff.kernelStatus().calls;
  Diff.useKernel(null);
  assert.deepEqual(Diff.reprojectBilinear(source, output).values, reference.values);
  assert.equal(Diff.kernelStatus().active, false);

  Diff.useKernel(kernel); // default thresholds
  assert.equal(Diff.kernelStatus().active, true);
  assert.equal(Diff.kernelStatus().minPixels, 64);
  let before = { ...calls() };
  Diff.reprojectBilinear(source, grid(tan({ size: [7, 7] }), 7, 7)); // 49 pixels: below the crossover
  assert.equal(calls().js, before.js + 1);
  before = { ...calls() };
  const fast = Diff.reprojectBilinear(source, output);
  assert.equal(calls().wasm, before.wasm + 1);
  assert.ok(fast.status.some((s) => s === 0));
  // A window far smaller than the source: copying the source costs more than the loop saves.
  const big = { width: 1500, height: 1500, wcs: source.wcs, values: new Float64Array(1500 * 1500) };
  before = { ...calls() };
  Diff.reprojectBilinear(big, grid(tan({ size: [100, 100] }), 100, 100));
  assert.equal(calls().js, before.js + 1, "100 x 100 output of a 1500 x 1500 source stays in JavaScript");

  // Hand-made wcs objects (no params) and non-Float64 arrays use the JS loop and give the same answers.
  const handmade = { width: 100, height: 100, wcs: { skyToPixel: source.wcs.skyToPixel, pixelToSky: source.wcs.pixelToSky }, values: source.values };
  before = { ...calls() };
  Diff.useKernel(kernel, { minPixels: 1 });
  assert.deepEqual(Diff.reprojectBilinear(handmade, output).values, reference.values);
  assert.equal(calls().js, before.js + 1);
  const single = { width: 100, height: 100, wcs: source.wcs, values: Float32Array.from(source.values) };
  before = { ...calls() };
  assert.deepEqual(Diff.reprojectBilinear(single, output).values, Diff.reprojectBilinearJs(single, output).values);
  assert.equal(calls().js, before.js + 1);
  Diff.useKernel(null);
});

// ---- Real SPHEREx images ----------------------------------------------------------------------------------------------------------
const fitsSandbox = vm.createContext({ TextDecoder, document: { querySelector: () => null }, atob, Uint8Array });
const fitsLib = vm.runInContext(readFileSync(join(root, "tools/fits.js"), "utf8") + "\n({ readFitsHdus, fitsPixelReader });", fitsSandbox);
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
  const created = Wcs.createWcs(hdu.fields);
  return { name, meta: Pair.describeObservation(hdu, index), width: hdu.axes[0], height: hdu.axes[1], values, wcs: created.wcs, unit: hdu.fields.BUNIT, fields: hdu.fields };
}

const realReference = await loadReal(realEncoded.reference, "reference.fits");
const realComparison = await loadReal(realEncoded.comparison, "comparison.fits");

// A TAN output grid (optionally with SIP terms) centred on the sky position of an image, `refine` times finer than it.
function gridAround(image, refine, side, sip) {
  const centre = image.wcs.pixelToSky((image.width + 1) / 2, (image.height + 1) / 2);
  const east = image.wcs.pixelToSky((image.width + 1) / 2 + 1, (image.height + 1) / 2);
  const scale = Wcs.angularSeparation(centre.ra, centre.dec, east.ra, east.dec) / refine;
  const fields = tan({ ra: centre.ra, dec: centre.dec, size: [side, side], scale: scale * 3600, rotate: 20, sip: sip ? 3 : null });
  fields.CRPIX1 = (side + 1) / 2;
  fields.CRPIX2 = (side + 1) / 2;
  return grid(fields, side, side);
}

test("real SPHEREx cutouts (TAN-SIP, 70 x 70): both directions, onto their own grid and onto finer and larger output grids", () => {
  assert.equal(realReference.wcs.projection, "TAN-SIP");
  const a = realReference;
  const b = realComparison;
  const own = (image) => ({ width: image.width, height: image.height, wcs: image.wcs });
  const r1 = compare("real: comparison onto reference grid", b, own(a));
  const r2 = compare("real: reference onto comparison grid", a, own(b));
  assert.deepEqual(summary(r1).fast, [4761, 139, 0, 0], "valid and outside counts of tests/difference.test.mjs (4760 valid + the one invalid reference pixel, 139 outside)");
  for (const [label, source] of [["reference", a], ["comparison", b]]) {
    for (const [refine, side, sip] of [[1, 70, false], [4.3, 300, false], [9, 320, true], [0.7, 60, true], [2.2, 240, false], ...(label === "reference" ? [[14.6, 768, false]] : [])]) {
      const r = compare("real " + label + " onto " + side + "² (x" + refine + (sip ? ", SIP" : "") + ")", source, gridAround(a, refine, side, sip));
      for (const mode of modes) assert.ok(r[mode.name].counts[0] > 100, label + ": " + r[mode.name].counts[0] + " valid pixels");
    }
  }
  // NaN inside the real image (the cutouts contain one) is respected: compare with the one NaN pixel and with more.
  const holes = Object.assign({}, b, { values: Float64Array.from(b.values) });
  for (let i = 0; i < 60; i++) holes.values[Math.floor(random() * holes.values.length)] = NaN;
  const r3 = compare("real with extra NaN pixels", holes, gridAround(a, 6, 300, true));
  assert.ok(r3.fast.counts[3] > 20, "invalid neighbours: " + r3.fast.counts[3]);
});

test("real pair: computeDifference gives the same difference, valid mask and counts with the kernel", () => {
  Diff.useKernel(null);
  const js = Diff.computeDifference(realReference, realComparison);
  assert.ok(js.ok, js.reason);
  for (const mode of modes) {
    Diff.useKernel(kernel, { minPixels: 1, exact: mode.exact });
    const before = Diff.kernelStatus().calls.wasm;
    const wasm = Diff.computeDifference(realReference, realComparison);
    assert.ok(wasm.ok, wasm.reason);
    assert.ok(Diff.kernelStatus().calls.wasm > before, "the wasm path ran");
    Diff.useKernel(null);
    assert.deepEqual(wasm.result.counts, js.result.counts);
    assert.deepEqual(wasm.result.valid, js.result.valid);
    for (let i = 0; i < js.result.difference.length; i++) {
      const a = js.result.difference[i];
      const b = wasm.result.difference[i];
      if (Number.isNaN(a)) assert.ok(Number.isNaN(b));
      else assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b), 0.01 * valueRange(realComparison.values)), mode.name + " " + a + " vs " + b);
    }
  }
});

test("real pair: the mosaic (windows, supersampling, mean and inverse-variance) is the same with the kernel", () => {
  const variance = (image) => Float64Array.from(image.values, (v) => 0.4 + 0.1 * Math.abs(Math.sin(v * 3)));
  const withVariance = (image) => Object.assign({}, image, { variance: variance(image), varianceUnit: "MJy2 / sr2" });
  const inputs = [withVariance(realReference), withVariance(realComparison)];
  for (const options of [{}, { mode: "inverse-variance" }, { scaleArcsec: 12 }, { scaleArcsec: 1.6 }, { gridMode: "reference", referenceIndex: 1 }]) {
    Diff.useKernel(null);
    const js = Mosaic.buildMosaic(inputs, options);
    assert.ok(js.ok, js.reason);
    for (const mode of modes) {
      Diff.useKernel(kernel, { minPixels: 1, exact: mode.exact });
      const before = Diff.kernelStatus().calls.wasm;
      const wasm = Mosaic.buildMosaic(inputs, options);
      assert.ok(Diff.kernelStatus().calls.wasm > before, "the wasm path ran");
      Diff.useKernel(null);
      assert.ok(wasm.ok, wasm.reason);
      const label = JSON.stringify(options) + " " + mode.name;
      assert.equal(wasm.result.width, js.result.width);
      assert.deepEqual(wasm.result.coverage, js.result.coverage, label);
      assert.deepEqual(wasm.result.valid, js.result.valid, label);
      const scale = valueRange(realComparison.values);
      for (const key of ["values", "variance"]) {
        if (!js.result[key]) continue;
        for (let i = 0; i < js.result[key].length; i++) {
          const a = js.result[key][i];
          const b = wasm.result[key][i];
          if (Number.isNaN(a) || Number.isNaN(b)) { assert.ok(Number.isNaN(a) && Number.isNaN(b), label + " " + key + " NaN at " + i); continue; }
          assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b), 0.01 * scale), label + " " + key + " " + a + " vs " + b);
        }
      }
    }
  }
  assert.equal(Diff.kernelStatus().active, false);
});
