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
