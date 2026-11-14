// Run with:  node --test tests/        (or: node tests/forced-phot.test.mjs)
//
// Covers tools/forced-phot.js, the forced-photometry measurement module (a port of spxphot, the Rust reimplementation of the
// IRSA SPHEREx Spectrophotometry Tool).
//   - Coordinate layer (port of spxphot src/wcs.rs): TAN-SIP, pixel solid angle and the WCS-WAVE lookup, checked against
//     tests/data/spxphot/wcs_vectors.json (astropy values for a real SPHEREx IMAGE header) and against tools/wcs.js.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Wcs = require("../tools/wcs.js");
const ForcedPhot = require("../tools/forced-phot.js");

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
  img[5 * w + 22] = 1e4; // an outlier inside the background window (distance > bkgExcludeR from the source at 20, 20)
  const fl = new Float64Array(w * h);
  const m = gauss(20, 20, 15, 15, 11);
  const mk = (flags) => ({ image: block(w, img), flags: block(w, flags), variance: block(w, new Float64Array(w * h).fill(1)), height: h });
  assert.equal(fitFrame(mk(fl), p, [[20, 20]], 0, [m], 15, 15).bkgPre, 7);
  // every pixel flagged SOURCE: the first pass has no sample, the second (SOURCE allowed) restores it
  const all = new Float64Array(w * h).fill(Number(bits.SOURCE));
  assert.equal(fitFrame(mk(all), p, [[20, 20]], 0, [m], 15, 15).bkgPre, 7);
});
