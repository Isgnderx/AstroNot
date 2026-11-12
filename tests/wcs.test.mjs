// Run with:  node --test tests/        (or: node tests/wcs.test.mjs)
//
// Verifies tools/wcs.js against two independent references that are computed at run time:
//   1. An independent JavaScript implementation in this file. It uses the direct gnomonic (standard coordinates)
//      formulas instead of the native-spherical rotation in tools/wcs.js, and it reads the raw header cards itself
//      instead of using tools/fits.js.
//   2. Astropy WCS (wcslib), run through tests/wcs-reference.py when a Python with Astropy is available
//      (set ASTRONOT_PYTHON to choose the interpreter). Without Astropy those checks are reported as skipped.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { buildFits } from "./fits-builder.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const wcsLib = require("../tools/wcs.js");
const { createWcs, angularSeparation, normalizeRa } = wcsLib;

// ---- Load the shared FITS reader (tools/fits.js) without a DOM ------------------------------------------------------
const fitsSandbox = vm.createContext({ TextDecoder, document: { querySelector: () => null }, atob, Uint8Array });
const fitsLib = vm.runInContext(
  readFileSync(join(root, "tools/fits.js"), "utf8") + "\n({ readFitsHdus, fitsPixelReader, drawFitsImage });",
  fitsSandbox,
);

// ---- The real SPHEREx example ---------------------------------------------------------------------------------------
const exampleSource = readFileSync(join(root, "assets/tools/spherex-example.js"), "utf8");
const exampleBase64 = vm.runInNewContext(exampleSource + "\nspherexExampleData;");
const exampleBytes = Buffer.from(exampleBase64, "base64");
const exampleFile = new File([exampleBytes], "SPHEREx-QR2-D2.fits");
const hdus = await fitsLib.readFitsHdus(exampleFile);
const imageHdu = hdus.find((hdu) => hdu.fields.EXTNAME === "IMAGE");
const [width, height] = imageHdu.axes;

// ---- Independent reference ------------------------------------------------------------------------------------------
const DEG = Math.PI / 180;

function rawHeader(bytes, extensionIndex) {
  // Reads cards directly: the header of the n-th HDU, numbers only (strings are kept as text).
  const cards = [];
  let offset = 0;
  let current = 0;
  for (;;) {
    let done = false;
    for (let start = 0; start < 2880; start += 80) {
      const text = bytes.subarray(offset + start, offset + start + 80).toString("ascii");
      if (current === extensionIndex) cards.push(text);
      if (text.startsWith("END     ")) done = true;
    }
    offset += 2880;
    if (done) {
      if (current === extensionIndex) break;
      current++; // The primary HDU of the example has NAXIS = 0, so no data blocks follow it.
    }
  }
  const header = {};
  for (const text of cards) {
    if (text[8] !== "=") continue;
    const key = text.slice(0, 8).trim();
    const value = text.slice(10).split("/")[0].trim();
    header[key] = /^[-+0-9.]/.test(value) ? parseFloat(value) : value.replace(/^'|'\s*$/g, "").trim();
  }
  return header;
}

function referenceWcs(h) {
  const sip = (name) => {
    const terms = [];
    for (const key of Object.keys(h)) {
      const m = new RegExp("^" + name + "_(\\d+)_(\\d+)$").exec(key);
      if (m) terms.push([Number(m[1]), Number(m[2]), h[key]]);
    }
    return terms;
  };
  const A = sip("A");
  const B = sip("B");
  const evaluate = (terms, u, v) => terms.reduce((sum, [p, q, c]) => sum + c * Math.pow(u, p) * Math.pow(v, q), 0);
  const a0 = h.CRVAL1 * DEG;
  const d0 = h.CRVAL2 * DEG;
  const cd = h.CD1_1 !== undefined
    ? [h.CD1_1, h.CD1_2 ?? 0, h.CD2_1 ?? 0, h.CD2_2]
    : [h.CDELT1 * (h.PC1_1 ?? 1), h.CDELT1 * (h.PC1_2 ?? 0), h.CDELT2 * (h.PC2_1 ?? 0), h.CDELT2 * (h.PC2_2 ?? 1)];
  return {
    pixelToSky(x, y) {
      const u = x - h.CRPIX1;
      const v = y - h.CRPIX2;
      const f = u + evaluate(A, u, v);
      const g = v + evaluate(B, u, v);
      const xi = (cd[0] * f + cd[1] * g) * DEG;
      const eta = (cd[2] * f + cd[3] * g) * DEG;
      const denominator = Math.cos(d0) - eta * Math.sin(d0);
      const ra = a0 + Math.atan2(xi, denominator);
      const dec = Math.atan2(Math.sin(d0) + eta * Math.cos(d0), Math.hypot(xi, denominator));
      return { ra: normalizeRa(ra / DEG), dec: dec / DEG };
    },
  };
}

const arcsec = (degrees) => degrees * 3600;
const separationArcsec = (a, b) => arcsec(angularSeparation(a.ra, a.dec, b.ra, b.dec));
const exampleHeader = rawHeader(exampleBytes, 1);

// ---- Astropy bridge -------------------------------------------------------------------------------------------------
function runAstropy(request) {
  const python = process.env.ASTRONOT_PYTHON ?? "python";
  const result = spawnSync(python, ["-I", join(root, "tests/wcs-reference.py")], {
    input: JSON.stringify(request), encoding: "utf8", maxBuffer: 1 << 26,
  });
  if (result.error || result.status !== 0) return { unavailable: (result.error?.message ?? result.stderr ?? "").trim().split("\n").pop() };
  return JSON.parse(result.stdout);
}
const astropyProbe = runAstropy({ header: { CTYPE1: "RA---TAN", CTYPE2: "DEC--TAN", CRVAL1: 1, CRVAL2: 1, CRPIX1: 1, CRPIX2: 1, CDELT1: 1, CDELT2: 1 }, pixels: [[1, 1]] });
const hasAstropy = !astropyProbe.unavailable;
const skipAstropy = hasAstropy ? false : "Astropy is not available (" + astropyProbe.unavailable + "). Set ASTRONOT_PYTHON to a Python with astropy.";
if (hasAstropy) console.log("Astropy " + astropyProbe.astropy + " / NumPy " + astropyProbe.numpy + " is available as the reference.");

// ---- Test points on the 70 x 70 image -------------------------------------------------------------------------------
const centre = { x: (width + 1) / 2, y: (height + 1) / 2 };
const namedPoints = [
  ["centre", centre.x, centre.y],
  ["lower-left corner (outer edge)", 0.5, 0.5],
  ["lower-right corner (outer edge)", width + 0.5, 0.5],
  ["upper-left corner (outer edge)", 0.5, height + 0.5],
  ["upper-right corner (outer edge)", width + 0.5, height + 0.5],
  ["first pixel centre", 1, 1],
  ["last pixel centre", width, height],
  ["off-centre A", 10, 20],
  ["off-centre B", 60, 15],
  ["off-centre C", 22.25, 48.75],
];
const gridPoints = [];
for (let i = 0; i <= 14; i++) for (let j = 0; j <= 14; j++) gridPoints.push([0.5 + (width * i) / 14, 0.5 + (height * j) / 14]);

// Tolerance rationale (see the measured values printed by the tests): all computations are IEEE double precision, so
// both implementations agree to about 1e-10 arcsec. We require 1 mas, which is 6e-5 of an SPHEREx pixel (6.15 arcsec)
// and 100 times tighter than the 0.1 arcsec acceptance figure, yet still ten million times larger than rounding noise.
const toleranceArcsec = 0.001;

test("the real example exposes a TAN-SIP WCS with negative CRPIX", () => {
  assert.deepEqual(Array.from(imageHdu.axes), [70, 70]);
  assert.equal(imageHdu.fields.OBSID, "2025W21_2C_0280_1");
  const result = createWcs(imageHdu.fields);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.wcs.projection, "TAN-SIP");
  assert.equal(result.wcs.sipOrder, 3);
  assert.deepEqual(Array.from(result.wcs.crpix), [-405.5, -63.5]);
  assert.equal(result.wcs.frame, "ICRS");
});

test("CRVAL is not the image centre; the centre is the pixel-coordinate result", () => {
  const { wcs } = createWcs(imageHdu.fields);
  const middle = wcs.pixelToSky(centre.x, centre.y);
  const fromCrval = angularSeparation(middle.ra, middle.dec, imageHdu.fields.CRVAL1, imageHdu.fields.CRVAL2);
  const fromTarget = angularSeparation(middle.ra, middle.dec, 156.09328159, -41.64466331);
  console.log("  example centre RA/Dec = " + middle.ra.toFixed(6) + ", " + middle.dec.toFixed(6) + " deg; " +
    fromCrval.toFixed(3) + " deg from CRVAL; " + arcsec(fromTarget).toFixed(2) + " arcsec from the cutout target");
  assert.ok(fromCrval > 0.5, "CRVAL is far from the image");
  assert.ok(arcsec(fromTarget) < 12, "the centre agrees with the cutout centre within about 2 pixels");
});

test("example matches the independent JavaScript reference (centre, off-centre points, edges, grid)", () => {
  const { wcs } = createWcs(imageHdu.fields);
  const reference = referenceWcs(exampleHeader);
  let worst = 0;
  for (const [name, x, y] of [...namedPoints, ...gridPoints.map((p, i) => ["grid " + i, p[0], p[1]])]) {
    const ours = wcs.pixelToSky(x, y);
    const expected = reference.pixelToSky(x, y);
    const error = separationArcsec(ours, expected);
    worst = Math.max(worst, error);
    assert.ok(error < toleranceArcsec, name + " differs by " + error + " arcsec");
  }
  console.log("  max |ours - JS reference| = " + worst.toExponential(2) + " arcsec over " + (namedPoints.length + gridPoints.length) + " points");
});

test("example matches Astropy WCS, including the inverse and view-boundary separations", { skip: skipAstropy }, () => {
  const dir = mkdtempSync(join(tmpdir(), "astronot-wcs-"));
  try {
    const path = join(dir, "example.fits");
    writeFileSync(path, exampleBytes);
    const { wcs } = createWcs(imageHdu.fields);
    const points = [...namedPoints.map(([, x, y]) => [x, y]), ...gridPoints];
    // View boundaries: horizontal and vertical lines through several view centres (some off-centre, partly clipped).
    const segments = [
      [0.5, 35.5, 70.5, 35.5], [35.5, 0.5, 35.5, 70.5],
      [0.5, 20, 70.5, 20], [60, 0.5, 60, 70.5], [5, 10, 40, 10], [12.5, 8, 12.5, 60],
    ];
    const astropy = runAstropy({ fits_path: path, extname: "IMAGE", pixels: points, sky: points.map(([x, y]) => {
      const sky = wcs.pixelToSky(x, y);
      return [sky.ra, sky.dec];
    }), segments });
    assert.equal(astropy.sip, true);
    let worstSky = 0;
    let worstBack = 0;
    let worstSegment = 0;
    points.forEach(([x, y], index) => {
      const ours = wcs.pixelToSky(x, y);
      const [ra, dec] = astropy.pixels[index];
      worstSky = Math.max(worstSky, separationArcsec(ours, { ra, dec }));
      const [ax, ay] = astropy.sky[index];
      worstBack = Math.max(worstBack, Math.hypot(ax - x, ay - y));
      const back = wcs.skyToPixel(ours.ra, ours.dec);
      assert.ok(Math.hypot(back.x - ax, back.y - ay) < 1e-5, "inverse differs from astropy at " + x + "," + y);
    });
    segments.forEach(([x1, y1, x2, y2], index) => {
      const a = wcs.pixelToSky(x1, y1);
      const b = wcs.pixelToSky(x2, y2);
      worstSegment = Math.max(worstSegment, Math.abs(arcsec(angularSeparation(a.ra, a.dec, b.ra, b.dec) - astropy.segments[index])));
    });
    console.log("  Astropy " + astropy.astropy + ": max sky difference " + worstSky.toExponential(2) + " arcsec; astropy round trip " +
      worstBack.toExponential(2) + " px; boundary separations " + worstSegment.toExponential(2) + " arcsec; " + points.length + " points");
    assert.ok(worstSky < toleranceArcsec, "sky difference " + worstSky);
    assert.ok(worstSegment < toleranceArcsec, "separation difference " + worstSegment);
    assert.ok(worstBack < 1e-4, "astropy inverse differs by " + worstBack + " px");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pixel -> sky -> pixel returns the starting pixel (SIP inverse by iteration)", () => {
  const { wcs } = createWcs(imageHdu.fields);
  let worst = 0;
  for (const [x, y] of gridPoints) {
    const sky = wcs.pixelToSky(x, y);
    const back = wcs.skyToPixel(sky.ra, sky.dec);
    worst = Math.max(worst, Math.hypot(back.x - x, back.y - y));
  }
  console.log("  max round-trip error = " + worst.toExponential(2) + " px");
  assert.ok(worst < 1e-8);
});

// ---- Synthetic headers: rotation, wrap-around, pole, CD matrix, far CRPIX, SIP ---------------------------------------
const base = { CTYPE1: "RA---TAN", CTYPE2: "DEC--TAN", RADESYS: "ICRS", CUNIT1: "deg", CUNIT2: "deg" };
const rotation = (degrees) => ({ PC1_1: Math.cos(degrees * DEG), PC1_2: -Math.sin(degrees * DEG), PC2_1: Math.sin(degrees * DEG), PC2_2: Math.cos(degrees * DEG) });
const syntheticCases = {
  "rotated PC matrix, CDELT1 < 0": { ...base, CRVAL1: 210.5, CRVAL2: 15, CRPIX1: 50.5, CRPIX2: 40.5, CDELT1: -0.002, CDELT2: 0.002, ...rotation(30) },
  "RA 0/360 wrap": { ...base, CRVAL1: 0.003, CRVAL2: -20, CRPIX1: 100.5, CRPIX2: 100.5, CDELT1: -0.01, CDELT2: 0.01, ...rotation(-70) },
  "pole crossing": { ...base, CRVAL1: 40, CRVAL2: 89.99, CRPIX1: 500, CRPIX2: 500, CDELT1: -0.001, CDELT2: 0.001, ...rotation(12) },
  "CD matrix, CRPIX far outside": { ...base, CRVAL1: 83.8, CRVAL2: -5.4, CRPIX1: 5000.5, CRPIX2: -2000.25, CD1_1: -0.0004, CD1_2: 0.00009, CD2_1: 0.0001, CD2_2: 0.00041 },
  "SIP without AP/BP": {
    ...base, CTYPE1: "RA---TAN-SIP", CTYPE2: "DEC--TAN-SIP", CRVAL1: 12.25, CRVAL2: 41.5, CRPIX1: 20, CRPIX2: 30,
    CDELT1: 1, CDELT2: 1, PC1_1: -0.0017, PC1_2: 0.00004, PC2_1: 0.00005, PC2_2: 0.0017,
    A_ORDER: 3, A_2_0: 3e-5, A_1_1: -2e-5, A_0_3: 1e-8, A_0_0: 0.04, B_ORDER: 3, B_0_2: 2.5e-5, B_1_1: 1e-5, B_3_0: -2e-8, B_0_0: -0.3,
  },
};
const syntheticPixels = [];
for (const x of [-300, -50, 1, 37.5, 120.25, 800]) for (const y of [-250, 0.5, 44, 99.75, 640]) syntheticPixels.push([x, y]);

for (const [name, header] of Object.entries(syntheticCases)) {
  test("synthetic WCS (" + name + ") matches the JS reference and round-trips", () => {
    const result = createWcs(header);
    assert.equal(result.ok, true, result.reason);
    const reference = referenceWcs(header);
    let worst = 0;
    let worstPixel = 0;
    for (const [x, y] of syntheticPixels) {
      const ours = result.wcs.pixelToSky(x, y);
      assert.ok(ours.ra >= 0 && ours.ra < 360, "RA is normalised to [0, 360)");
      worst = Math.max(worst, separationArcsec(ours, reference.pixelToSky(x, y)));
      const back = result.wcs.skyToPixel(ours.ra, ours.dec);
      worstPixel = Math.max(worstPixel, Math.hypot(back.x - x, back.y - y));
    }
    console.log("  " + name + ": reference difference " + worst.toExponential(2) + " arcsec, round trip " + worstPixel.toExponential(2) + " px");
    assert.ok(worst < toleranceArcsec);
    assert.ok(worstPixel < 1e-6);
  });

  test("synthetic WCS (" + name + ") matches Astropy", { skip: skipAstropy }, () => {
    const result = createWcs(header);
    const sky = syntheticPixels.map(([x, y]) => {
      const point = result.wcs.pixelToSky(x, y);
      return [point.ra, point.dec];
    });
    const astropy = runAstropy({ header, pixels: syntheticPixels, sky, segments: [[-300, 0.5, 800, 0.5], [37.5, -250, 37.5, 640]] });
    let worst = 0;
    syntheticPixels.forEach(([x, y], index) => {
      const ours = result.wcs.pixelToSky(x, y);
      worst = Math.max(worst, separationArcsec(ours, { ra: astropy.pixels[index][0], dec: astropy.pixels[index][1] }));
      assert.ok(Math.hypot(astropy.sky[index][0] - x, astropy.sky[index][1] - y) < 1e-4, "astropy round trip");
    });
    const a = result.wcs.pixelToSky(-300, 0.5);
    const b = result.wcs.pixelToSky(800, 0.5);
    const separationError = Math.abs(arcsec(angularSeparation(a.ra, a.dec, b.ra, b.dec) - astropy.segments[0]));
    console.log("  " + name + ": Astropy sky difference " + worst.toExponential(2) + " arcsec, separation difference " + separationError.toExponential(2) + " arcsec");
    assert.ok(worst < toleranceArcsec);
    assert.ok(separationError < toleranceArcsec);
  });
}

test("a header without WCS keys, or with an unsupported WCS, reports a reason and never a position", () => {
  const cases = {
    "no WCS keys": {},
    "galactic axes": { ...base, CTYPE1: "GLON-TAN", CTYPE2: "GLAT-TAN", CRVAL1: 1, CRVAL2: 1, CRPIX1: 1, CRPIX2: 1, CDELT1: 1, CDELT2: 1 },
    "SIN projection": { ...base, CTYPE1: "RA---SIN", CTYPE2: "DEC--SIN", CRVAL1: 1, CRVAL2: 1, CRPIX1: 1, CRPIX2: 1, CDELT1: 1, CDELT2: 1 },
    "legacy CROTA2 only": { ...base, CRVAL1: 1, CRVAL2: 1, CRPIX1: 1, CRPIX2: 1, CDELT1: 1, CDELT2: 1, CROTA2: 20 },
    "FK5 frame": { ...base, RADESYS: "FK5", CRVAL1: 1, CRVAL2: 1, CRPIX1: 1, CRPIX2: 1, CDELT1: 1, CDELT2: 1 },
    "arcsec CUNIT": { ...base, CUNIT1: "arcsec", CRVAL1: 1, CRVAL2: 1, CRPIX1: 1, CRPIX2: 1, CDELT1: 1, CDELT2: 1 },
    "-SIP without coefficients": { ...base, CTYPE1: "RA---TAN-SIP", CTYPE2: "DEC--TAN-SIP", CRVAL1: 1, CRVAL2: 1, CRPIX1: 1, CRPIX2: 1, CDELT1: 1, CDELT2: 1 },
    "PV keywords": { ...base, CRVAL1: 1, CRVAL2: 1, CRPIX1: 1, CRPIX2: 1, CDELT1: 1, CDELT2: 1, PV2_1: 3 },
    "CD and PC together": { ...base, CRVAL1: 1, CRVAL2: 1, CRPIX1: 1, CRPIX2: 1, CD1_1: 1, CD2_2: 1, PC1_1: 1 },
    "missing CRPIX": { ...base, CRVAL1: 1, CRVAL2: 1, CDELT1: 1, CDELT2: 1 },
    "singular matrix": { ...base, CRVAL1: 1, CRVAL2: 1, CRPIX1: 1, CRPIX2: 1, CD1_1: 1, CD1_2: 1, CD2_1: 1, CD2_2: 1 },
  };
  for (const [name, header] of Object.entries(cases)) {
    const result = createWcs(header);
    assert.equal(result.ok, false, name);
    assert.ok(result.reason.length > 10, name + " has a reason");
    assert.equal(result.wcs, undefined, name);
  }
});

test("a SIP-free header with SIP keywords applies no distortion and notes that", () => {
  const withKeys = createWcs({ ...base, CRVAL1: 10, CRVAL2: 10, CRPIX1: 1, CRPIX2: 1, CDELT1: -0.001, CDELT2: 0.001, A_ORDER: 2, B_ORDER: 2, A_2_0: 1e-3 });
  const without = createWcs({ ...base, CRVAL1: 10, CRVAL2: 10, CRPIX1: 1, CRPIX2: 1, CDELT1: -0.001, CDELT2: 0.001 });
  assert.equal(withKeys.wcs.notes.length, 1);
  assert.deepEqual(withKeys.wcs.pixelToSky(500, 500), without.wcs.pixelToSky(500, 500));
});

test("sky positions behind the tangent plane have no pixel", () => {
  const { wcs } = createWcs({ ...base, CRVAL1: 10, CRVAL2: 10, CRPIX1: 1, CRPIX2: 1, CDELT1: -0.001, CDELT2: 0.001 });
  assert.equal(wcs.skyToPixel(190, -10), null);
});

test("angular separation is a great-circle angle across 0/360 and at the pole", () => {
  assert.ok(Math.abs(angularSeparation(359.5, 0, 0.5, 0) - 1) < 1e-12);
  assert.ok(Math.abs(angularSeparation(10, 89.5, 190, 89.5) - 1) < 1e-12);
  assert.ok(Math.abs(angularSeparation(0, -90, 123, 90) - 180) < 1e-9);
  assert.equal(normalizeRa(-0.0), 0);
  assert.equal(normalizeRa(360), 0);
  assert.equal(normalizeRa(-1e-14), 0, "a value that rounds to 360 is shown as 0");
});

// ---- View geometry --------------------------------------------------------------------------------------------------
test("screen <-> FITS conversion flips Y and round-trips for different zoom, pan and panel sizes", () => {
  const view = { centerX: 20, centerY: 50, scale: 4, width: 400, height: 300 };
  assert.deepEqual(wcsLib.screenToFits(view, 200, 150), { x: 20, y: 50 });
  assert.ok(wcsLib.screenToFits(view, 200, 100).y > 50, "moving up on screen increases FITS y");
  assert.ok(wcsLib.screenToFits(view, 300, 150).x > 20, "moving right on screen increases FITS x");
  const views = [view, { centerX: 35.5, centerY: 35.5, scale: 12.5, width: 900, height: 500 }, { centerX: 3.25, centerY: 68, scale: 40, width: 320, height: 240 }];
  for (const v of views) {
    for (const [sx, sy] of [[0, 0], [v.width, v.height], [17.5, 201.25]]) {
      const fits = wcsLib.screenToFits(v, sx, sy);
      const screen = wcsLib.fitsToScreen(v, fits.x, fits.y);
      assert.ok(Math.abs(screen.x - sx) < 1e-9 && Math.abs(screen.y - sy) < 1e-9);
    }
  }
  assert.equal(wcsLib.fitScale(70, 70, 900, 500), 500 / 70);
});

test("the same sky point gives the same coordinates under two different zoom and pan states", () => {
  const { wcs } = createWcs(imageHdu.fields);
  const target = wcs.pixelToSky(48.4, 22.6);
  const pixel = wcs.skyToPixel(target.ra, target.dec);
  const viewA = { centerX: 35.5, centerY: 35.5, scale: 500 / 70, width: 900, height: 500 };
  const viewB = { centerX: 44.2, centerY: 18.9, scale: 31, width: 321, height: 733 };
  const results = [viewA, viewB].map((view) => {
    const screen = wcsLib.fitsToScreen(view, pixel.x, pixel.y);
    const fits = wcsLib.screenToFits(view, screen.x, screen.y);
    return wcs.pixelToSky(fits.x, fits.y);
  });
  assert.ok(separationArcsec(results[0], results[1]) < 1e-6);
  assert.ok(separationArcsec(results[0], target) < 1e-6);
});

test("array index and canvas row conventions: FITS (1,1) is the bottom-left pixel", async () => {
  assert.equal(wcsLib.pixelIndex(1, 1, 3, 2), 0);
  assert.equal(wcsLib.pixelIndex(3, 2, 3, 2), 5);
  assert.equal(wcsLib.pixelIndex(0.5, 0.5, 3, 2), 0);
  assert.equal(wcsLib.pixelIndex(3.49, 2.49, 3, 2), 5);
  assert.equal(wcsLib.pixelIndex(3.5, 2.5, 3, 2), -1, "the outer upper/right edge belongs to no pixel");
  assert.equal(wcsLib.pixelIndex(0.49, 1, 3, 2), -1);
  assert.equal(wcsLib.pixelIndex(1, 2.51, 3, 2), -1);
  assert.deepEqual(wcsLib.fitsToCanvas(1, 1, 2), { x: 0.5, y: 1.5 }); // Centre of the bottom-left pixel: canvas column 0, row 1.
  assert.deepEqual(wcsLib.fitsToCanvas(3, 2, 2), { x: 2.5, y: 0.5 }); // Top-right pixel centre: canvas column 2, row 0.

  // Check against the real drawFitsImage: FITS rows are stored bottom first and must appear flipped on the canvas.
  const bytes = buildFits({ width: 3, height: 2, bitpix: 8, pixels: (x, y) => [[10, 20, 30], [100, 110, 120]][y][x] });
  const file = new File([bytes], "tiny.fits");
  const [hdu] = await fitsLib.readFitsHdus(file);
  const data = await file.slice(hdu.dataStart, hdu.dataStart + hdu.byteLength).arrayBuffer();
  let captured;
  const canvas = { getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: (image) => { captured = image; } }) };
  fitsLib.drawFitsImage(canvas, data, hdu);
  const shade = (column, row) => captured.data[(row * 3 + column) * 4];
  const read = fitsLib.fitsPixelReader(data, hdu);
  assert.equal(read(wcsLib.pixelIndex(1, 1, 3, 2)), 10);
  assert.equal(read(wcsLib.pixelIndex(3, 2, 3, 2)), 120);
  const lowerLeft = wcsLib.fitsToCanvas(1, 1, 2);
  const upperRight = wcsLib.fitsToCanvas(3, 2, 2);
  assert.equal(shade(Math.floor(lowerLeft.x), Math.floor(lowerLeft.y)), 0, "value 10 (the minimum) sits in the bottom-left canvas pixel");
  assert.equal(shade(Math.floor(upperRight.x), Math.floor(upperRight.y)), 255, "value 120 sits in the top-right canvas pixel");
});

// ---- Field of view --------------------------------------------------------------------------------------------------
test("field of view equals the great-circle angle between boundary points and reports clipping", () => {
  const { wcs } = createWcs(imageHdu.fields);
  const reference = referenceWcs(exampleHeader);
  const refSeparation = (x1, y1, x2, y2) => {
    const a = reference.pixelToSky(x1, y1);
    const b = reference.pixelToSky(x2, y2);
    return angularSeparation(a.ra, a.dec, b.ra, b.dec);
  };
  // Fit view in a wide panel: the image fills the height, empty margins sit left and right.
  const fit = { centerX: 35.5, centerY: 35.5, scale: 500 / 70, width: 900, height: 500 };
  const fov = wcsLib.fieldOfView(wcs, fit, 70, 70);
  assert.equal(fov.horizontal.clipped, true);
  assert.equal(fov.vertical.clipped, false);
  assert.ok(Math.abs(fov.horizontal.degrees - refSeparation(0.5, 35.5, 70.5, 35.5)) < 1e-9);
  assert.ok(Math.abs(fov.vertical.degrees - refSeparation(35.5, 0.5, 35.5, 70.5)) < 1e-9);
  assert.ok(fov.horizontal.degrees > 0.1 && fov.horizontal.degrees < 0.14, "about the 0.12 deg cutout size: " + fov.horizontal.degrees);

  // Zoomed in, nothing clipped: 7 x 5 pixel field.
  const zoomed = { centerX: 20, centerY: 50, scale: 100, width: 700, height: 500 };
  const zoomedFov = wcsLib.fieldOfView(wcs, zoomed, 70, 70);
  assert.equal(zoomedFov.horizontal.clipped, false);
  assert.ok(Math.abs(zoomedFov.horizontal.degrees - refSeparation(16.5, 50, 23.5, 50)) < 1e-9);
  assert.ok(Math.abs(zoomedFov.vertical.degrees - refSeparation(20, 47.5, 20, 52.5)) < 1e-9);

  // Panned to the corner: part of the view is empty, so the measured part is clipped at the image edge.
  const corner = { centerX: 2, centerY: 3, scale: 20, width: 400, height: 400 };
  const cornerFov = wcsLib.fieldOfView(wcs, corner, 70, 70);
  assert.equal(cornerFov.horizontal.clipped, true);
  assert.ok(Math.abs(cornerFov.horizontal.degrees - refSeparation(0.5, 3, 12, 3)) < 1e-9);
  assert.ok(Math.abs(cornerFov.vertical.degrees - refSeparation(2, 0.5, 2, 13)) < 1e-9);
});

test("field of view across RA 0/360 and the pole uses sphere geometry", () => {
  const wrap = createWcs(syntheticCases["RA 0/360 wrap"]).wcs;
  const view = { centerX: 100.5, centerY: 100.5, scale: 1, width: 200, height: 200 };
  const fov = wcsLib.fieldOfView(wrap, view, 201, 201);
  const reference = referenceWcs(syntheticCases["RA 0/360 wrap"]);
  const a = reference.pixelToSky(0.5, 100.5);
  const b = reference.pixelToSky(200.5, 100.5);
  assert.ok(Math.abs(fov.horizontal.degrees - angularSeparation(a.ra, a.dec, b.ra, b.dec)) < 1e-9);
  assert.ok(fov.horizontal.degrees > 1.5 && fov.horizontal.degrees < 2.5, "about 200 px x 0.01 deg: " + fov.horizontal.degrees);
  // A naive RA difference would give almost 360 degrees across the wrap; verify the endpoints straddle it.
  const left = wrap.pixelToSky(0.5, 100.5);
  const right = wrap.pixelToSky(200.5, 100.5);
  assert.ok(Math.abs(left.ra - right.ra) > 180, "the endpoints are on opposite sides of RA = 0");

  const pole = createWcs(syntheticCases["pole crossing"]).wcs;
  const poleView = { centerX: 500, centerY: 500, scale: 1, width: 600, height: 600 }; // 0.6 deg across the pole at 89.99 deg
  const poleFov = wcsLib.fieldOfView(pole, poleView, 1001, 1001);
  const poleReference = referenceWcs(syntheticCases["pole crossing"]);
  const p1 = poleReference.pixelToSky(200, 500);
  const p2 = poleReference.pixelToSky(800, 500);
  assert.ok(Math.abs(poleFov.horizontal.degrees - angularSeparation(p1.ra, p1.dec, p2.ra, p2.dec)) < 1e-9);
});

test("field of view reports a status instead of a number when it cannot be measured", () => {
  const { wcs } = createWcs(imageHdu.fields);
  assert.equal(wcsLib.fieldOfView(null, { centerX: 1, centerY: 1, scale: 1, width: 10, height: 10 }, 70, 70).horizontal, null);
  const outside = wcsLib.fieldOfView(wcs, { centerX: 90, centerY: 35, scale: 5, width: 300, height: 300 }, 70, 70);
  assert.equal(outside.horizontal, null);
  assert.match(outside.status, /outside the image/i);
});
