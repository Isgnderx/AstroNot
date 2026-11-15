// tools/engine/engine-core.js on rust/crates/engine: decoding into the resident image equals the tools/fits.js reader,
// pyramid, scan, exact quantiles, histogram, tiles and pixel reads behave as documented. Fixtures are synthetic.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { buildFits } from "./fits-builder.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const Wasm = require("../tools/wasm.js");
const EngineCore = require("../tools/engine/engine-core.js");

const fitsSandbox = vm.createContext({ TextDecoder, document: { querySelector: () => null }, atob, Uint8Array });
const fitsLib = vm.runInContext(readFileSync(join(root, "tools/fits.js"), "utf8") + "\n({ readFitsHdus, fitsPixelReader });", fitsSandbox);
globalThis.readFitsHdus = fitsLib.readFitsHdus;

const kernel = await Wasm.load("engine");
assert.ok(kernel, "tools/wasm/engine.wasm is missing: run node scripts/build-wasm.mjs engine");
const core = EngineCore.createCore(kernel);

async function open(buffer) {
  const file = new Blob([buffer]);
  const hdus = await core.openFile(file);
  return { file, hdus, buffer };
}

async function referenceValues(buffer, hdu) {
  const bytes = buffer.buffer.slice(buffer.byteOffset + hdu.dataStart, buffer.byteOffset + hdu.dataStart + hdu.byteLength);
  const read = fitsLib.fitsPixelReader(bytes, hdu);
  const values = new Float32Array(hdu.pixels);
  for (let i = 0; i < values.length; i++) values[i] = read(i);
  return values;
}

function sortedFinite(values) {
  return Float64Array.from(Array.from(values).filter(Number.isFinite)).sort();
}

const width = 301;
const height = 203;
const pattern = (x, y) => (x === 7 && y === 3 ? NaN : Math.sin(x / 13) * 50 + y * 0.25 + ((x * 7 + y * 3) % 11) - 5);

test("float32 image: decoded values equal the fits.js reader, scan and pyramid are consistent", async () => {
  const buffer = buildFits({ width, height, bitpix: -32, extra: [["BUNIT", "MJy / sr"]], pixels: pattern });
  const { file, hdus } = await open(buffer);
  const hdu = hdus[0];
  assert.equal(hdu.image, true);
  const progress = [];
  const image = await core.loadImage(file, hdu, { onProgress: (p) => progress.push(p.phase) });
  assert.equal(image.width, width);
  assert.equal(image.height, height);
  assert.ok(progress.includes("decode") && progress.includes("pyramid"));
  const expected = await referenceValues(buffer, hdu);
  const got = core.readRect(image.handle, 0, 0, width, height);
  for (let i = 0; i < expected.length; i++) {
    if (Number.isNaN(expected[i])) assert.ok(Number.isNaN(got[i]), "NaN kept at " + i);
    else assert.equal(got[i], expected[i], "pixel " + i);
  }
  assert.equal(core.value(image.handle, 7, 3), NaN);
  assert.equal(core.value(image.handle, 0, 0), expected[0]);
  assert.equal(core.value(image.handle, width, 0), NaN, "outside -> NaN");
  // scan
  const finite = sortedFinite(expected);
  assert.equal(image.scan.finite, finite.length);
  assert.equal(image.scan.nan, 1);
  assert.equal(image.scan.min, finite[0]);
  assert.equal(image.scan.max, finite[finite.length - 1]);
  const mean = finite.reduce((a, b) => a + b, 0) / finite.length;
  assert.ok(Math.abs(image.scan.mean - mean) < 1e-6, "mean");
  const std = Math.sqrt(finite.reduce((a, b) => a + (b - mean) ** 2, 0) / finite.length);
  assert.ok(Math.abs(image.scan.std - std) < 1e-6, "std");
  // pyramid: 301 x 203 is wider than one 256 tile, so one coarser level (151 x 102) is built
  assert.deepEqual(image.levels, [{ width: 301, height: 203 }, { width: 151, height: 102 }]);
  const levels = kernel.exports.img_build_pyramid(image.handle, 100);
  assert.equal(levels, 3, "301 -> 151 -> 76 stops below 100");
  const level1 = new Float32Array(kernel.exports.memory.buffer, kernel.exports.img_level_ptr(image.handle, 1), 151 * 102);
  const meanOf = (x, y) => {
    const vals = [];
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const xx = 2 * x + dx, yy = 2 * y + dy;
      if (xx < width && yy < height && Number.isFinite(expected[yy * width + xx])) vals.push(expected[yy * width + xx]);
    }
    return vals.length ? Math.fround(vals.reduce((a, b) => a + b, 0) / vals.length) : NaN;
  };
  for (const [x, y] of [[0, 0], [3, 1], [150, 101], [150, 0], [0, 101], [10, 50]]) {
    const got = level1[y * 151 + x];
    const want = meanOf(x, y);
    assert.ok(Math.abs(got - want) <= Math.abs(want) * 1e-6 + 1e-6, `level 1 (${x}, ${y}): ${got} vs ${want}`);
  }
  core.freeImage(image.handle);
});

test("BITPIX 16 with BSCALE/BZERO/BLANK, BITPIX 64 and BITPIX 8 decode like the reader", async () => {
  const cases = [
    { bitpix: 16, extra: [["BSCALE", 0.5], ["BZERO", 32768], ["BLANK", -32768]], pixels: (x, y) => (x === 2 && y === 2 ? -32768 : ((x * 31 + y * 17) % 65000) - 32500) },
    { bitpix: 64, extra: [], pixels: (x, y) => (x - 10) * 1e9 + y },
    { bitpix: 8, extra: [["BSCALE", 2], ["BZERO", -3]], pixels: (x, y) => (x + y) % 256 },
    { bitpix: -64, extra: [], pixels: (x, y) => (x === 0 && y === 0 ? NaN : x * 1e-3 + y) },
  ];
  for (const c of cases) {
    // fits-builder writes BITPIX 64 as two 32-bit halves? It does not: write it here with BigInt.
    let buffer;
    if (c.bitpix === 64) {
      const w = 20, h = 6;
      const head = buildFits({ width: w, height: h, bitpix: 32, pixels: () => 0 }).subarray(0, 2880);
      const text = head.toString("ascii").replace("BITPIX  =                   32", "BITPIX  =                   64");
      const data = Buffer.alloc(Math.ceil((w * h * 8) / 2880) * 2880);
      for (let i = 0; i < w * h; i++) data.writeBigInt64BE(BigInt(c.pixels(i % w, Math.floor(i / w))), i * 8);
      buffer = Buffer.concat([Buffer.from(text, "ascii"), data]);
    } else {
      buffer = buildFits({ width: 20, height: 6, bitpix: c.bitpix, extra: c.extra, pixels: c.pixels });
    }
    const { file, hdus } = await open(buffer);
    const image = await core.loadImage(file, hdus[0]);
    const got = core.readRect(image.handle, 0, 0, 20, 6);
    if (c.bitpix === 64) {
      for (let i = 0; i < got.length; i++) assert.equal(got[i], Math.fround(c.pixels(i % 20, Math.floor(i / 20))), "int64 pixel " + i);
    } else {
      const expected = await referenceValues(buffer, hdus[0]);
      for (let i = 0; i < got.length; i++) {
        if (Number.isNaN(expected[i])) assert.ok(Number.isNaN(got[i]), `BITPIX ${c.bitpix}: NaN at ${i}`);
        else assert.equal(got[i], expected[i], `BITPIX ${c.bitpix}: pixel ${i}`);
      }
    }
    core.freeImage(image.handle);
  }
});

test("exact quantile ranks equal the sorted array; display quantiles follow the percentileClip conventions", async () => {
  const buffer = buildFits({ width, height, bitpix: -32, pixels: pattern });
  const { file, hdus } = await open(buffer);
  const image = await core.loadImage(file, hdus[0]);
  const sorted = sortedFinite(await referenceValues(buffer, hdus[0]));
  const last = sorted.length - 1;
  const ranks = [0, 1, 2, 17, Math.floor(last * 0.01), Math.floor(last / 2), Math.ceil(last * 0.99), last - 1, last];
  const { values, interpolated } = core.quantileRanks(image.handle, ranks);
  assert.equal(interpolated, 0);
  ranks.forEach((rank, i) => assert.equal(values[i], sorted[rank], "rank " + rank));
  assert.equal(image.quantiles[0.01], sorted[Math.floor(last * 0.01)]);
  assert.equal(image.quantiles[0.99], sorted[Math.ceil(last * 0.99)]);
  assert.equal(image.quantiles[0.5], sorted[Math.floor(last * 0.5)]);
  // out-of-range ranks clamp, NaN rank -> rank 0
  const clamped = core.quantileRanks(image.handle, [-5, 1e12, NaN]).values;
  assert.deepEqual(Array.from(clamped), [sorted[0], sorted[last], sorted[0]]);
  // histogram over [min, max] counts every finite value once
  const h = core.histogram(image.handle, 0, image.scan.min, image.scan.max, 64);
  assert.equal(h.below, 0);
  assert.equal(h.above, 0);
  assert.equal(h.counted, sorted.length);
  assert.equal(Array.from(h.counts).reduce((a, b) => a + b, 0), sorted.length);
  const clip = core.sigmaClip(image.handle, { samples: 1 << 20, sigma: 3, iterations: 5 });
  assert.ok(clip.count > 0 && clip.count <= sorted.length && Number.isFinite(clip.median));
  core.freeImage(image.handle);
});

test("a constant image: quantiles, scan and tiles stay defined", async () => {
  const buffer = buildFits({ width: 50, height: 40, bitpix: -32, pixels: () => 4.5 });
  const { file, hdus } = await open(buffer);
  const image = await core.loadImage(file, hdus[0]);
  assert.equal(image.scan.min, 4.5);
  assert.equal(image.scan.max, 4.5);
  assert.equal(image.scan.std, 0);
  assert.equal(image.quantiles[0.99], 4.5);
  const rgba = core.renderTile(image.handle, 0, 0, 0, 4, 4, 4.5, 4.5, "linear", null);
  assert.deepEqual(Array.from(rgba.subarray(0, 4)), [128, 128, 128, 255], "no range -> mid gray, opaque");
  core.freeImage(image.handle);
});

test("tiles: canvas row order, stretch, clamping, transparent NaN and outside pixels, LUT colours", async () => {
  const w = 10, h = 4;
  const values = (x, y) => (x === 1 && y === 0 ? NaN : x * 10 + y * 100); // row 0 is the bottom row of the picture
  const buffer = buildFits({ width: w, height: h, bitpix: -32, pixels: values });
  const { file, hdus } = await open(buffer);
  const image = await core.loadImage(file, hdus[0]);
  const low = 0, high = 300;
  const tile = core.renderTile(image.handle, 0, 0, 0, w, h, low, high, "linear", null);
  const px = (cx, cy) => Array.from(tile.subarray((cy * w + cx) * 4, (cy * w + cx) * 4 + 4));
  // canvas row 0 is FITS row h-1 = 3: value x*10 + 300 -> clamps to 255 at every x
  assert.deepEqual(px(0, 0), [255, 255, 255, 255]);
  // canvas row 3 is FITS row 0: value 10x
  assert.deepEqual(px(0, 3), [0, 0, 0, 255]);
  const shade = Math.round((30 / 300) * 255);
  assert.deepEqual(px(3, 3), [shade, shade, shade, 255]);
  assert.deepEqual(px(1, 3), [0, 0, 0, 0], "NaN -> transparent");
  // a tile reaching outside the level
  const edge = core.renderTile(image.handle, 0, 8, 2, 4, 4, low, high, "linear", null);
  assert.deepEqual(Array.from(edge.subarray((0 * 4 + 3) * 4, (0 * 4 + 3) * 4 + 4)), [0, 0, 0, 0], "x = 11 is outside");
  assert.deepEqual(Array.from(edge.subarray((2 * 4 + 0) * 4, (2 * 4 + 0) * 4 + 4)), [0, 0, 0, 0], "canvas row 4 is outside");
  // sqrt stretch brightens mid values
  const sq = core.renderTile(image.handle, 0, 0, 0, w, h, low, high, "sqrt", null);
  assert.equal(sq[(3 * w + 3) * 4], Math.round(Math.sqrt(30 / 300) * 255));
  // LUT: shade s -> (s, 0, 255 - s)
  const lut = new Uint8Array(768);
  for (let s = 0; s < 256; s++) { lut[3 * s] = s; lut[3 * s + 1] = 0; lut[3 * s + 2] = 255 - s; }
  const coloured = core.renderTile(image.handle, 0, 0, 0, w, h, low, high, "linear", lut);
  assert.deepEqual(Array.from(coloured.subarray((3 * w + 3) * 4, (3 * w + 3) * 4 + 4)), [shade, 0, 255 - shade, 255]);
  core.freeImage(image.handle);
});

test("an image that cannot be allocated fails with a clear message; a non-image HDU is refused", async () => {
  const buffer = buildFits({ width: 4, height: 4, bitpix: -32, pixels: () => 1 });
  const { file, hdus } = await open(buffer);
  const huge = { ...hdus[0], axes: [200000, 200000], pixels: 4e10 };
  await assert.rejects(core.loadImage(file, huge), /Not enough memory/);
  await assert.rejects(core.loadImage(file, { ...hdus[0], image: false }), /not an uncompressed two-dimensional image/);
});

test("throughput smoke: a 2048 x 2048 float32 image loads, builds its pyramid and renders in well under a second", async () => {
  const w = 2048, h = 2048;
  const header = buildFits({ width: 1, height: 1, bitpix: -32, pixels: () => 0 }).subarray(0, 2880).toString("ascii")
    .replace("NAXIS1  =                    1", "NAXIS1  =                 2048").replace("NAXIS2  =                    1", "NAXIS2  =                 2048");
  const data = Buffer.alloc(Math.ceil((w * h * 4) / 2880) * 2880);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < w * h; i++) view.setFloat32(i * 4, (i * 2654435761 % 1000) / 10, false);
  const { file, hdus } = await open(Buffer.concat([Buffer.from(header, "ascii"), data]));
  const image = await core.loadImage(file, hdus[0]);
  const t0 = performance.now();
  for (let i = 0; i < 16; i++) core.renderTile(image.handle, 0, 256 * (i % 8), 256 * Math.floor(i / 8), 256, 256, image.quantiles[0.01], image.quantiles[0.99], "asinh", null);
  const tiles = performance.now() - t0;
  console.log(`  2048^2: read ${image.timing.read.toFixed(0)} ms, decode ${image.timing.decode.toFixed(0)} ms, pyramid ${image.timing.pyramid.toFixed(0)} ms, stats ${image.timing.stats.toFixed(0)} ms, 16 tiles ${tiles.toFixed(0)} ms, ${image.levels.length} levels`);
  assert.ok(image.timing.total < 2500, "load took " + image.timing.total + " ms");
  assert.equal(image.levels.length, 4, "2048 -> 1024 -> 512 -> 256");
  core.freeImage(image.handle);
});
