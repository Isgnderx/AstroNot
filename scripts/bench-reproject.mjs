// Times reprojectBilinear in JavaScript against the Rust/WebAssembly kernel (rust/crates/reproject).
//   node scripts/bench-reproject.mjs [maxSide]      (default 4096; use 2048 for a quicker run)
// The same call goes through AstroNotDifference: reprojectBilinearJs is the JavaScript loop, reprojectBilinear with a kernel
// installed is the wasm path (it includes copying the source into wasm memory and the result back). Times are medians of
// warm runs for small sizes and single runs for the large ones.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Wcs = require("../tools/wcs.js");
const Diff = require("../tools/difference.js");
const Wasm = require("../tools/wasm.js");

const kernel = await Wasm.load("reproject");
if (!kernel) throw new Error("tools/wasm/reproject.wasm is missing: run node scripts/build-wasm.mjs reproject");
const maxSide = Number(process.argv[2]) || 4096;

function fields(size, rotate, scaleArcsec, sip) {
  const c = Math.cos(rotate * Math.PI / 180);
  const s = Math.sin(rotate * Math.PI / 180);
  const scale = scaleArcsec / 3600;
  const f = {
    CTYPE1: sip ? "RA---TAN-SIP" : "RA---TAN", CTYPE2: sip ? "DEC--TAN-SIP" : "DEC--TAN", CRVAL1: 150, CRVAL2: 2,
    CRPIX1: (size + 1) / 2, CRPIX2: (size + 1) / 2, CD1_1: -scale * c, CD1_2: scale * s, CD2_1: scale * s, CD2_2: scale * c, RADESYS: "ICRS",
  };
  if (sip) {
    const k = 1 / (size * size);
    Object.assign(f, {
      A_ORDER: 3, B_ORDER: 3, A_2_0: 2 * k, A_1_1: -k, A_0_2: k, B_2_0: -k, B_1_1: 2 * k, B_0_2: 1.5 * k, A_3_0: k / size, B_0_3: -k / size,
      AP_ORDER: 3, BP_ORDER: 3, AP_2_0: -2 * k, AP_1_1: k, AP_0_2: -k, BP_2_0: k, BP_1_1: -2 * k, BP_0_2: -1.5 * k,
    });
  }
  return f;
}

// A source of `sourceSide`^2 pixels and an output grid of `side`^2 pixels covering about the same sky (output slightly finer, rotated).
function pair(side, sourceSide, sip) {
  const source = {
    width: sourceSide, height: sourceSide, wcs: Wcs.createWcs(fields(sourceSide, 3, 6, sip)).wcs,
    values: Float64Array.from({ length: sourceSide * sourceSide }, (_, i) => Math.sin(i * 0.001) + (i * 7919) % 13),
  };
  const grid = { width: side, height: side, wcs: Wcs.createWcs(fields(side, 0, 6 * sourceSide / side * 0.9, sip)).wcs };
  return { source, grid };
}

function time(fn, repeats) {
  const samples = [];
  for (let i = 0; i < repeats; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[samples.length >> 1];
}

function repeatsFor(pixels) {
  return pixels < 20000 ? 200 : pixels < 300000 ? 9 : pixels < 2e6 ? 3 : 1;
}

function row(side, sourceSide, sip) {
  const { source, grid } = pair(side, sourceSide, sip);
  const pixels = side * side;
  const repeats = repeatsFor(pixels);
  Diff.useKernel(null);
  Diff.reprojectBilinearJs(source, grid); // warm up
  const js = time(() => Diff.reprojectBilinearJs(source, grid), repeats);
  const out = { js };
  for (const exact of [false, true]) {
    Diff.useKernel(kernel, { minPixels: 1, exact });
    Diff.reprojectBilinear(source, grid);
    out[exact ? "exact" : "fast"] = time(() => Diff.reprojectBilinear(source, grid), repeats);
  }
  Diff.useKernel(null);
  return out;
}

const fmt = (ms) => (ms < 10 ? ms.toFixed(3) : ms < 100 ? ms.toFixed(1) : ms.toFixed(0)).padStart(9);
const line = (label, r) => console.log(label.padEnd(24) + fmt(r.js) + fmt(r.fast) + fmt(r.exact) + (r.js / r.fast).toFixed(1).padStart(9) + (r.js / r.exact).toFixed(1).padStart(9));
const head = (title) => {
  console.log("\n" + title);
  console.log("output / source (px)".padEnd(24) + "JS ms".padStart(9) + "wasm ms".padStart(9) + "wasm exact".padStart(9) + "x fast".padStart(9) + "x exact".padStart(9));
};

for (const sip of [false, true]) {
  head("Output n x n from a source n x n, " + (sip ? "TAN-SIP order 3" : "TAN") + " (f64 values, no variance)");
  for (const side of [256, 512, 1024, 2048, 4096].filter((n) => n <= maxSide)) line(side + "² / " + side + "²", row(side, side, sip));
}

head("Crossover: small outputs from a 70 x 70 source (a SPHEREx cutout), TAN-SIP");
for (const side of [8, 12, 16, 24, 32, 48, 64, 100, 128]) line(side + "² / 70²", row(side, 70, true));
head("Crossover: small outputs from a 70 x 70 source, TAN");
for (const side of [8, 12, 16, 24, 32, 48, 64, 100, 128]) line(side + "² / 70²", row(side, 70, false));
head("Crossover: the upload of a large source weighs on a small output, TAN-SIP");
for (const [side, source] of [[100, 1024], [100, 2048], [200, 2048], [400, 2048], [800, 2048], [1600, 2048]]) line(side + "² / " + source + "²", row(side, source, true));
head("Same, TAN");
for (const [side, source] of [[100, 1024], [100, 2048], [200, 2048], [400, 2048], [800, 2048], [1600, 2048]]) line(side + "² / " + source + "²", row(side, source, false));

console.log("\nwasm memory now: " + (kernel.exports.memory.buffer.byteLength / 1048576).toFixed(0) + " MiB (grown for the largest call, then reused)");
