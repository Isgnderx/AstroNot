// Run with:  node --test tests/        (or: node tests/epsf.test.mjs)
//
// Covers tools/epsf.js, the PSF models behind Forced Spectrophotometry: the not-a-knot cubic spline weights, ePSF rendering at native
// pixel centres, parsing of the EPSF table, and the Sersic model convolved with the ePSF. It is a port of spxphot's psf.rs, sersic.rs
// and archive.rs::parse_epsf.
//   - The spline test is psf.rs::spline_reproduces_cubics_exactly; the flux test is sersic.rs::model_conserves_flux_and_shrinks_to_psf
//     with the same numbers; lnGamma is sersic.rs::gamma_is_right.
//   - The render test compares with tests/data/spxphot/epsf_vectors.json: stamps made by photutils ImagePSF.evaluate on a real ePSF
//     (tolerance of psf.rs::matches_photutils_on_real_epsf, |g - w| < 1e-12 + 1e-9 |w|).
//   - The parse test reads the EPSF table of tests/data/spxphot/bd17-cutout.fits (441 zones, 33x33, oversample 5).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const Epsf = require("../tools/epsf.js");
const Fits = require("../tools/fits-range.js");
const { createSpline1D, createEpsfSet, parseEpsf, createSersic, bN, lnGamma } = Epsf;

const fixture = new Uint8Array(readFileSync(root + "tests/data/spxphot/bd17-cutout.fits"));
const vectors = JSON.parse(readFileSync(root + "tests/data/spxphot/epsf_vectors.json", "utf8"));

test("not-a-knot spline reproduces cubics exactly and returns false outside the grid", () => {
  // A not-a-knot spline is exact for any cubic polynomial.
  const n = 12;
  const s = createSpline1D(n);
  const f = (x) => 0.3 * x ** 3 - 2.0 * x * x + x - 5.0;
  const y = Array.from({ length: n }, (_, i) => f(i));
  const w = new Float64Array(n);
  for (const t of [0.0, 0.37, 3.5, 7.92, 11.0]) {
    assert.equal(s.weights(t, w), true);
    let v = 0;
    for (let j = 0; j < n; j++) v += w[j] * y[j];
    assert.ok(Math.abs(v - f(t)) < 1e-9, t + ": " + v + " vs " + f(t));
  }
  assert.equal(s.weights(-0.01, w), false);
  assert.equal(s.weights(11.01, w), false);
  assert.equal(s.weights(NaN, w), false);
  assert.equal(s.n, n);
  assert.throws(() => createSpline1D(3), /cubic spline needs >= 4 points/);
});

test("render matches photutils ImagePSF on the real ePSF cases", () => {
  const data = Float64Array.from(vectors.epsf.flat());
  const n = Math.floor(Math.sqrt(data.length));
  const e = { nx: n, ny: n, oversample: vectors.ovs, data };
  const set = createEpsfSet([{ x: 0, y: 0, epsf: e }]);
  assert.equal(vectors.cases.length, 4);
  for (const c of vectors.cases) {
    const got = set.render(e, c.x0, c.y0, c.xa, c.ya, c.size, c.size);
    const want = c.stamp.flat();
    assert.ok(got instanceof Float64Array);
    assert.equal(got.length, c.size * c.size);
    assert.equal(want.length, got.length);
    let peak = 0;
    for (let i = 0; i < got.length; i++) {
      assert.ok(Math.abs(got[i] - want[i]) < 1e-12 + 1e-9 * Math.abs(want[i]), got[i] + " vs " + want[i]);
      peak = Math.max(peak, Math.abs(want[i]));
    }
    assert.ok(peak > 1e-3, "the stamp is not empty");
  }
});

test("parseEpsf on the fixture: 441 zones, 33x33, oversample 5, nearest picks the closest centre", async () => {
  const source = Fits.createMemorySource(fixture);
  const hdus = await Fits.walkHdus(source);
  const hdu = hdus.find((h) => h.name === "EPSF");
  const table = Fits.createBinTable(hdu.header, await Fits.readTableBytes(source, hdu));
  const set = parseEpsf(hdu.header, table);
  assert.equal(set.zones.length, 441);
  const z0 = set.zones[0];
  assert.equal(z0.x, table.scalar(0, "XCENTER"));
  assert.equal(z0.y, table.scalar(0, "YCENTER"));
  assert.equal(z0.epsf.nx, 33);
  assert.equal(z0.epsf.ny, 33);
  assert.equal(z0.epsf.oversample, 5);
  assert.ok(z0.epsf.data instanceof Float64Array);
  assert.equal(z0.epsf.data.length, 33 * 33);
  assert.deepEqual(Array.from(z0.epsf.data), Array.from(table.get(0, "EPSF")));

  const closest = (x, y) => {
    let best = 0;
    let bestD = Infinity;
    set.zones.forEach((z, i) => {
      const d = (z.x - x) ** 2 + (z.y - y) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    });
    return set.zones[best].epsf;
  };
  // on a zone centre, and at points that are not on one
  for (const k of [0, 37, 220, 440]) assert.equal(set.nearest(set.zones[k].x, set.zones[k].y), set.zones[k].epsf);
  for (const [x, y] of [[1, 1], [1000.3, 1020.7], [2040, 5], [-50, 3000], [517.25, 1500.5]]) {
    assert.equal(set.nearest(x, y), closest(x, y), x + "," + y);
  }
  assert.notEqual(set.nearest(5, 5), set.nearest(2000, 2000));
});

test("parseEpsf reads TDIMn or sqrt(repeat), and refuses anisotropic oversampling, a missing column and an empty table", () => {
  const stub = (cards, repeat, rows = 2) => ({
    header: { num: (k, fallback) => (k in cards ? cards[k] : fallback), str: (k) => cards[k] },
    table: {
      columns: [{ name: "XCENTER", repeat: 1 }, { name: "YCENTER", repeat: 1 }, { name: "EPSF", repeat }],
      rows,
      scalar: (r, name) => (name === "XCENTER" ? 10 * r : 20 * r + 1),
      get: (r) => Float64Array.from({ length: repeat }, (_, i) => r + i),
    },
  });
  // TDIM3 = '(4,5)' wins over sqrt(20)
  let { header, table } = stub({ OVSMPX: 2, TDIM3: "(4,5)" }, 20);
  let set = parseEpsf(header, table);
  assert.deepEqual([set.zones[0].epsf.nx, set.zones[0].epsf.ny, set.zones[1].epsf.oversample], [4, 5, 2]);
  assert.deepEqual([set.zones[1].x, set.zones[1].y], [10, 21]);
  // no TDIM: n = floor(sqrt(repeat))
  ({ header, table } = stub({ OVSMPX: 3 }, 16));
  set = parseEpsf(header, table);
  assert.deepEqual([set.zones[0].epsf.nx, set.zones[0].epsf.ny], [4, 4]);
  // a TDIM that does not hold two integers falls back to sqrt(repeat)
  ({ header, table } = stub({ OVSMPX: 1, TDIM3: "(16)" }, 16));
  set = parseEpsf(header, table);
  assert.deepEqual([set.zones[0].epsf.nx, set.zones[0].epsf.ny, set.zones[0].epsf.oversample], [4, 4, 1]);
  // OVSMPX defaults to 1
  ({ header, table } = stub({}, 16));
  assert.equal(parseEpsf(header, table).zones[0].epsf.oversample, 1);
  // anisotropic
  ({ header, table } = stub({ OVSMPX: 5, OVSMPY: 4 }, 16));
  assert.throws(() => parseEpsf(header, table), /anisotropic ePSF oversampling is not supported/);
  // no EPSF column
  ({ header, table } = stub({ OVSMPX: 5 }, 16));
  table.columns = table.columns.filter((c) => c.name !== "EPSF");
  assert.throws(() => parseEpsf(header, table), /no EPSF column/);
  // the Rust indexes zones[0]
  ({ header, table } = stub({ OVSMPX: 5 }, 16, 0));
  assert.throws(() => parseEpsf(header, table));
  assert.throws(() => createEpsfSet([]));
});

test("lnGamma(5) = ln 24 and lnGamma(0.5) = ln sqrt(pi) to 1e-12", () => {
  assert.ok(Math.abs(lnGamma(5.0) - Math.log(24)) < 1e-12);
  assert.ok(Math.abs(lnGamma(0.5) - Math.log(Math.sqrt(Math.PI))) < 1e-12);
  // the Ciotti & Bertin expansion at n = 1: 2 - 1/3 + 4/405 + 46/25515 + 131/1148175, close to the exact 1.67834699
  assert.ok(Math.abs(bN(1) - 1.678460165) < 1e-9);
  assert.ok(Math.abs(bN(1) - 1.67834699) < 2e-4);
});

test("Sersic model conserves flux to 5e-3 on a Gaussian-like ePSF", () => {
  // Gaussian-ish ePSF on a 5x oversampled 33x33 grid, unit sum.
  const n = 33;
  const d = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = i - 16.0;
      const y = j - 16.0;
      d[j * n + i] = Math.exp(-(x * x + y * y) / (2.0 * 25.0));
    }
  }
  let s = 0;
  for (const v of d) s += v;
  for (let i = 0; i < d.length; i++) d[i] /= s;
  const e = { nx: n, ny: n, oversample: 5.0, data: d };
  const aff = [[-6.15, 0.0], [0.0, 6.15]];
  const g = createSersic({ n: 1.0, reArcsec: 3.0, axisRatio: 0.7, paDeg: 30.0 });
  const m = g.render(e, aff, 30.3, 29.8, 15, 15, 31, 31);
  assert.ok(m instanceof Float64Array);
  assert.equal(m.length, 31 * 31);
  let tot = 0;
  for (const v of m) tot += v;
  assert.ok(Math.abs(tot - 1.0) < 5e-3, "total " + tot);
  // the model peaks near the galaxy centre (pixel 30, 30 -> row 15, column 15 of the box)
  let best = 0;
  m.forEach((v, i) => { if (v > m[best]) best = i; });
  assert.deepEqual([best % 31, Math.floor(best / 31)], [15, 15]);
});
