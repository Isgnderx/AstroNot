// Run with:  node --test tests/        (or: node tests/time-sequence.test.mjs)
//
// Covers tools/time-sequence.js (the Time Machine's archive mode) and functions/api/sia.js (its search proxy).
//   - Search: angle parsing, query validation, the IRSA SIA request, and that the page's request and the proxy's request agree.
//     The proxy refuses anything but a SPHEREx collection, a position and a detector, and forwards nothing else.
//   - Sequences: frames from IRSA rows, grouping by day / visit / exposure, lazy scanning in time order.
//   - Grid and pixels: the north-up, east-left grid; the interpolated frame coordinates against exact Newton inversion; bilinear
//     resampling; a real SPHEREx cutout (tests/data/spxphot/bd17-cutout.fits) read through a memory byte source, with the
//     wavelength at the target equal to spxphot's (IRSA convention) value for that frame.
//   - With Python + astropy + reproject (ASTRONOT_PYTHON), the grid geometry and the resampled values are compared with astropy
//     and reproject_interp(order="bilinear"). ASTRONOT_LIVE=1 also searches IRSA and reads a real frame from S3.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { buildIrsaSiaUrl, handleSia, COLLECTIONS, MAX_RECORDS, DETECTOR_BAND_CENTRES_UM, detectorBand } from "../functions/api/sia.js";

const require = createRequire(import.meta.url);
const TS = require("../tools/time-sequence.js");
const Range = require("../tools/fits-range.js");
const ForcedPhot = require("../tools/forced-phot.js");

const root = fileURLToPath(new URL("..", import.meta.url));
const dataFile = (name) => join(root, "tests/data/spxphot", name);
const fixtureBytes = new Uint8Array(readFileSync(dataFile("bd17-cutout.fits")));
const sidecar = JSON.parse(readFileSync(dataFile("bd17-cutout.frame.json"), "utf8"));

// tools/observation-csv.js is a classic script with globals; run it in a sandbox as tests/observation.test.mjs does.
const sandbox = vm.createContext({ URL, URLSearchParams, Date, Number, Math });
vm.runInContext(readFileSync(join(root, "tools/observation-csv.js"), "utf8") + "\nthis.parseIrsaResults = parseIrsaResults;", sandbox);
const parseIrsaResults = sandbox.parseIrsaResults;

// ---- Search ---------------------------------------------------------------------------------------------------------------
test("angles: decimal degrees, RA in hh:mm:ss and Dec in ±dd:mm:ss", () => {
  assert.equal(TS.parseAngle("83.8221", "ra"), 83.8221);
  assert.ok(Math.abs(TS.parseAngle("05:35:17.3", "ra") - (5 + 35 / 60 + 17.3 / 3600) * 15) < 1e-12);
  assert.ok(Math.abs(TS.parseAngle("5h35m17.3s", "ra") - 83.82208333) < 1e-7);
  assert.ok(Math.abs(TS.parseAngle("-05:23:28", "dec") - -(5 + 23 / 60 + 28 / 3600)) < 1e-12);
  assert.ok(Math.abs(TS.parseAngle("+61 52 35.4", "dec") - (61 + 52 / 60 + 35.4 / 3600)) < 1e-12);
  for (const bad of ["", "abc", "12:61:00", "-05:35:17", "1e5"]) assert.ok(Number.isNaN(TS.parseAngle(bad, "ra")), bad);
});

test("query validation names the field that is wrong", () => {
  const ok = TS.parseQuery({ ra: "83.8221", dec: "-5.3911", release: "dr1", field: "0.25", detector: "2" });
  assert.ok(ok.ok);
  assert.deepEqual(ok.query, { ra: 83.8221, dec: -5.3911, release: "dr1", collection: "spherex_dr1", fieldDeg: 0.25, detector: 2 });
  assert.match(TS.parseQuery({ ra: "360", dec: "0", release: "dr1", field: "0.2" }).message, /RA/);
  assert.match(TS.parseQuery({ ra: "1", dec: "91", release: "dr1", field: "0.2" }).message, /Dec/);
  assert.match(TS.parseQuery({ ra: "1", dec: "1", release: "qr2", field: "0.2" }).message, /release/);
  assert.match(TS.parseQuery({ ra: "1", dec: "1", release: "dr1", field: "2" }).message, /field size/);
  assert.match(TS.parseQuery({ ra: "1", dec: "1", release: "dr1", field: "0.2", detector: "7" }).message, /detector/);
});

test("the page's IRSA request and the proxy's request are the same, for every collection and detector", () => {
  for (const [key, c] of Object.entries(TS.collections)) {
    assert.ok(COLLECTIONS.has(c.collection), key);
    for (const detector of [null, 1, 2, 3, 4, 5, 6]) {
      const q = { collection: c.collection, ra: 270.693, dec: 61.8765, detector };
      const proxyParams = new URL(TS.proxySiaUrl("https://example.org/api/sia", q)).searchParams;
      assert.equal(buildIrsaSiaUrl(proxyParams).url, TS.irsaSiaUrl(q));
    }
  }
  assert.equal(TS.MAX_SIA_RECORDS, MAX_RECORDS);
  assert.deepEqual(TS.detectorBandCentres, DETECTOR_BAND_CENTRES_UM);
  const url = new URL(TS.irsaSiaUrl({ collection: "spherex_dr1", ra: 83.8221, dec: -5.3911, detector: 2 }));
  assert.equal(url.origin + url.pathname, "https://irsa.ipac.caltech.edu/SIA");
  assert.equal(url.searchParams.get("POS"), "CIRCLE 83.8221 -5.3911 0.0003");
  assert.equal(url.searchParams.get("BAND"), detectorBand(2));
  assert.equal(url.searchParams.get("RESPONSEFORMAT"), "CSV");
});

test("a detector's BAND window lies inside that detector's band and no other", () => {
  for (const [d, [lo, hi]] of Object.entries(TS.detectorBands)) {
    const [a, b] = TS.detectorBand(Number(d)).split(" ").map((m) => Number(m) * 1e6);
    assert.ok(a > lo && b < hi, "detector " + d);
    for (const [other, [olo, ohi]] of Object.entries(TS.detectorBands)) {
      if (other !== d) assert.ok(b < olo || a > ohi, "detector " + d + " window overlaps detector " + other);
    }
  }
});

test("proxy: refuses anything but a SPHEREx collection, a position and a detector; forwards nothing else", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response("s_ra,s_dec,obs_id,access_url\n", { status: 200 });
  };
  const ask = (q) => handleSia(new Request("https://astronot.example/api/sia?" + q), fakeFetch);
  for (const [q, pattern] of [
    ["collection=spherex_qr2&ra=1&dec=1", /collection/],
    ["collection=../../etc&ra=1&dec=1", /collection/],
    ["collection=spherex_dr1&ra=360&dec=1", /ra/],
    ["collection=spherex_dr1&ra=1e2&dec=1", /ra/],
    ["collection=spherex_dr1&ra=1&dec=-91", /dec/],
    ["collection=spherex_dr1&ra=1&dec=1&detector=0", /detector/],
  ]) {
    const r = await ask(q);
    assert.equal(r.status, 400, q);
    assert.match(await r.text(), pattern, q);
  }
  assert.equal(calls.length, 0, "no request leaves for invalid input");
  const r = await ask("collection=spherex_dr1&ra=83.8221&dec=-5.3911&detector=2&url=http://evil.example&MAXREC=99&FORMAT=x");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/csv/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, TS.irsaSiaUrl({ collection: "spherex_dr1", ra: 83.8221, dec: -5.3911, detector: 2 }));
  assert.equal((await handleSia(new Request("https://a.example/api/sia?collection=spherex_dr1&ra=1&dec=1", { method: "POST" }), fakeFetch)).status, 405);
});

test("proxy: IRSA failures become 502/504 with a message; a VOTable error is passed on for the page's parser", async () => {
  const req = new Request("https://a.example/api/sia?collection=spherex_dr1&ra=1&dec=1");
  const down = await handleSia(req, async () => new Response("busy", { status: 503 }));
  assert.equal(down.status, 502);
  assert.match(await down.text(), /HTTP 503/);
  const lost = await handleSia(req, async () => {
    throw new TypeError("fetch failed");
  });
  assert.equal(lost.status, 504);
  const votable = '<?xml version="1.0"?><VOTABLE><RESOURCE><INFO name="QUERY_STATUS" value="ERROR">bad POS</INFO></RESOURCE></VOTABLE>';
  const err = await handleSia(req, async () => new Response(votable, { status: 200 }));
  assert.equal(err.status, 200);
  assert.match(err.headers.get("content-type"), /xml/);
  const parsed = parseIrsaResults(await err.text());
  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /bad POS/);
});

test("serve.mjs answers /api/sia with the same handler (400 for bad input, no network needed)", async () => {
  const child = spawn(process.execPath, ["serve.mjs"], { cwd: root, env: { ...process.env, ASTRONOT_PORT: "0" } });
  try {
    const origin = await new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        const match = /http:\/\/127\.0\.0\.1:\d+/.exec(String(chunk));
        if (match) resolve(match[0]);
      });
      child.on("error", reject);
      setTimeout(() => reject(new Error("server did not start")), 5000);
    });
    const r = await fetch(origin + "/api/sia?collection=nope&ra=1&dec=1");
    assert.equal(r.status, 400);
    assert.match(await r.text(), /collection must be one of/);
    assert.equal((await fetch(origin + "/api/other")).status, 404);
  } finally {
    child.kill();
  }
});

// ---- Frames and sequences ---------------------------------------------------------------------------------------------------
const row = (obsId, det, tMin, release = "dr1", collection = "spherex_dr1") => ({
  obsId,
  product: new URL("https://irsa.ipac.caltech.edu/ibe/data/spherex/" + release + "/level2/X/v/" + det + "/level2_" + obsId + "D" + det + "_spx.fits"),
  release,
  collection,
  detector: det,
  start: tMin,
  end: tMin + 0.0013,
});

test("frames from IRSA rows carry S3 URLs; rows that are not level-2 FITS on IRSA and repeats are dropped", () => {
  const rows = [row("A_1", 2, 60900.1), row("A_1", 2, 60900.1), { obsId: "x", product: "https://example.org/a.fits", collection: "spherex_dr1" }];
  const frames = TS.framesFromRows(rows);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].url, ForcedPhot.S3_BASE + "dr1/level2/X/v/2/level2_A_1D2_spx.fits");
  assert.equal(frames[0].detector, 2);
  assert.equal(frames[0].mjd, 60900.1);
  assert.deepEqual(TS.countByDetector([...frames, ...TS.framesFromRows([row("B_1", 5, 1)])]), { 2: 1, 5: 1 });
});

test("frames parsed from a real-shaped IRSA CSV (unquoted cloud_access JSON) become frames", () => {
  const csv = [
    "s_ra,s_dec,energy_bandpassname,obs_id,access_url,access_format,t_min,t_max,obs_collection,cloud_access",
    '83.8,-5.4,SPHEREx-D2,2025W37_1A_0365_1,https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/2025W37_1A/l2b-v27-2026-235/2/level2_2025W37_1A_0365_1D2_spx_l2b-v27-2026-235.fits,image/fits,60927.8333,60927.8346,spherex_dr1,{"aws": {"bucket_name": "nasa-irsa-spherex", "key":"dr1/level2/x.fits"}}',
  ].join("\n");
  const parsed = parseIrsaResults(csv);
  assert.ok(parsed.ok, parsed.message);
  const [f] = TS.framesFromRows(parsed.rows);
  assert.equal(f.url, "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/dr1/level2/2025W37_1A/l2b-v27-2026-235/2/level2_2025W37_1A_0365_1D2_spx_l2b-v27-2026-235.fits");
  assert.equal(f.detector, 2);
  assert.equal(f.collection, "spherex_dr1");
});

test("grouping: one detector, time order, by UTC day, by visit (gap > 20 d) or every exposure; undated frames are counted", () => {
  const frames = TS.framesFromRows([
    row("c", 2, 60901.9), row("a", 2, 60900.2), row("b", 2, 60900.7), row("d", 2, 60930.0), row("e", 2, 60951.5),
    row("x", 3, 60900.3), Object.assign(row("u", 2, NaN), { start: NaN }),
  ]);
  const ids = (g) => g.groups.map((group) => group.frames.map((f) => f.obsId).join(""));
  assert.deepEqual(ids(TS.groupFrames(frames, { detector: 2, sampling: "day" })), ["ab", "c", "d", "e"]);
  assert.deepEqual(ids(TS.groupFrames(frames, { detector: 2, sampling: "visit" })), ["abc", "d", "e"]);
  assert.deepEqual(ids(TS.groupFrames(frames, { detector: 2, sampling: "all" })), ["a", "b", "c", "d", "e"]);
  assert.equal(TS.groupFrames(frames, { detector: 2 }).undated, 1);
  assert.deepEqual(ids(TS.groupFrames(frames, { detector: 3 })), ["x"]);
  assert.throws(() => TS.groupFrames(frames, { detector: 2, sampling: "week" }));
});

test("sequence: lazy, in time order, skipped groups counted, concurrent ensure calls serialised", async () => {
  const groups = Array.from({ length: 20 }, (_, i) => ({ frames: [{ obsId: "g" + i, mjd: i }] }));
  const asked = [];
  const choose = async (g) => {
    asked.push(g.frames[0].obsId);
    await new Promise((r) => setTimeout(r, Math.random() * 5));
    return Number(g.frames[0].obsId.slice(1)) % 3 === 2 ? null : { frame: g.frames[0], group: g };
  };
  const seq = TS.createSequence(groups, choose, { parallel: 3 });
  await Promise.all([seq.ensure(4), seq.ensure(7)]);
  assert.ok(seq.items.length >= 7);
  assert.ok(seq.scanned < groups.length, "only as many groups as needed are scanned");
  const order = seq.items.map((it) => Number(it.frame.obsId.slice(1)));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(order.every((i) => i % 3 !== 2));
  await seq.ensure(Infinity);
  assert.ok(seq.done);
  assert.equal(seq.items.length + seq.skipped, groups.length);
  assert.equal(TS.pageCount(seq), Math.ceil(seq.items.length / TS.PAGE_SIZE));
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await assert.rejects(TS.createSequence(groups, choose).ensure(5, { signal: controller.signal }), /stop/);
});

// ---- Grid and pixels ---------------------------------------------------------------------------------------------------------
test("grid: centred on the position, north up, east left, native scale, round trip", () => {
  const g = TS.createGrid({ ra: 270.693, dec: 61.8765, fieldDeg: 0.15 });
  assert.equal(g.width, Math.round((0.15 * 3600) / TS.GRID_SCALE_ARCSEC));
  const [r0, d0] = g.pixToWorld(g.center, g.center);
  assert.ok(Math.abs(r0 - 270.693) < 1e-12 && Math.abs(d0 - 61.8765) < 1e-12);
  assert.ok(g.pixToWorld(g.center, 0)[1] > d0, "row 0 is north");
  assert.ok(g.pixToWorld(0, g.center)[0] > r0, "column 0 is east (larger RA)");
  for (const [x, y] of [[0, 0], [g.width - 1, 3], [12.25, 70.5]]) {
    const [bx, by] = g.worldToPix(...g.pixToWorld(x, y));
    assert.ok(Math.abs(bx - x) < 1e-9 && Math.abs(by - y) < 1e-9);
  }
  // one pixel step is the grid scale on the sky
  const [ra1, de1] = g.pixToWorld(g.center, g.center + 1);
  assert.ok(Math.abs((d0 - de1) * 3600 - g.scaleArcsec) < 1e-6);
  assert.ok(Math.abs(ra1 - r0) < 1e-9);
  // RA wraps at 0/360
  const w = TS.createGrid({ ra: 0.001, dec: 10, fieldDeg: 0.1 });
  assert.ok(w.pixToWorld(w.width - 1, w.center)[0] > 359);
  assert.equal(TS.createGrid({ ra: 1, dec: 1, fieldDeg: 0.6 }).width, 351);
  assert.equal(TS.createGrid({ ra: 1, dec: 1, fieldDeg: 0.02 }).width, 16);
});

const fixtureFrame = {
  ...ForcedPhot.frameFromImportRow({ obsId: sidecar.obs_id, product: new URL(sidecar.access_url), release: "dr1", collection: sidecar.obs_collection, detector: 1, start: Number(sidecar.t_min) }),
  obsId: sidecar.obs_id,
};
const memoryContext = () => TS.createContext({ sourceFor: () => Range.createMemorySource(fixtureBytes) });

async function fixtureImage() {
  const source = Range.createMemorySource(fixtureBytes);
  const primary = await Range.hduAt(source, 0);
  return Range.hduAt(source, primary.end);
}

test("frame coordinates: the default interpolated mesh equals exact Newton inversion to 5e-5 px (real TAN-SIP header)", async () => {
  const image = await fixtureImage();
  const wcs = ForcedPhot.createTanSip(image.header.cards);
  const grid = TS.createGrid({ ra: sidecar.target.ra, dec: sidecar.target.dec, fieldDeg: 0.05 });
  const { fx, fy } = TS.frameCoordinates(wcs, grid);
  let worst = 0;
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const [ex, ey] = wcs.worldToPix(...grid.pixToWorld(x, y));
      const k = y * grid.width + x;
      worst = Math.max(worst, Math.abs(fx[k] - ex), Math.abs(fy[k] - ey));
    }
  }
  assert.ok(worst < 5e-5, "worst " + worst + " px");
});

test("resample: bilinear inside, NaN outside the rows read, NaN where a needed pixel is not finite", () => {
  const width = 4;
  const data = new Float64Array([0, 1, 2, 3, 10, 11, 12, 13, 20, 21, 22, NaN]); // rows 5..7 of a 4-wide frame
  const block = { y0: 5, width, data };
  const at = (x, y) => TS.resample(block, 3, { fx: new Float64Array([x]), fy: new Float64Array([y]) }, width)[0];
  assert.equal(at(1, 5), 1);
  assert.equal(at(1.5, 5.5), 6.5); // (1 + 2 + 11 + 12) / 4
  assert.equal(at(0, 7), 20); // last row reached exactly
  assert.equal(at(3, 5), 3); // last column reached exactly
  assert.ok(Number.isNaN(at(1, 4.9)), "above the rows read");
  assert.ok(Number.isNaN(at(-0.1, 6)), "left of the frame");
  assert.ok(Number.isNaN(at(2.5, 6.5)), "a needed pixel is NaN");
  assert.ok(Number.isNaN(at(3.2, 6)), "right of the frame");
});

test("row window: only the rows under the grid (plus one each side), or null when the grid misses the frame", () => {
  const grid = TS.createGrid({ ra: 10, dec: 10, fieldDeg: 0.05 });
  const coords = { fx: new Float64Array([5.5, 20]), fy: new Float64Array([100.2, 140.8]) };
  assert.deepEqual(TS.rowWindow(coords, 2040, 2040), { y0: 99, n: 44 });
  assert.deepEqual(TS.rowWindow({ fx: new Float64Array([5]), fy: new Float64Array([0.2]) }, 2040, 2040), { y0: 0, n: 3 });
  assert.equal(TS.rowWindow({ fx: new Float64Array([2100]), fy: new Float64Array([5]) }, 2040, 2040), null);
  assert.ok(grid.width > 0);
});

test("real cutout: frame read onto the grid, wavelength at the target equal to spxphot's IRSA-convention value", async () => {
  const ctx = memoryContext();
  const grid = TS.createGrid({ ra: sidecar.target.ra, dec: sidecar.target.dec, fieldDeg: 0.04 });
  const r = await TS.loadFrame(ctx, { frame: fixtureFrame }, grid);
  assert.equal(r.meta.obsId, sidecar.obs_id);
  assert.equal(r.meta.detector, 1);
  assert.equal(r.meta.unit, "MJy / sr");
  assert.ok(r.coverage > 0.95, "coverage " + r.coverage);
  // The oracle row of this frame (lvf_id 202521203032111, detector 1) in spxphot's output.
  const oracle = readFileSync(dataFile("bd17_spxphot.csv"), "utf8").split(/\r?\n/).find((l) => l.includes("," + sidecar.lvf_id + ",1,"));
  const [lambda, width] = oracle.split(",").slice(3, 5).map(Number);
  assert.ok(Math.abs(r.wavelength - lambda) < 1e-12, r.wavelength + " vs " + lambda);
  assert.ok(Math.abs(r.bandwidth - width) < 1e-12);
  // The grid's centre pixel is the bilinear value of the frame at the target's frame position.
  const image = await fixtureImage();
  const [tx, ty] = ForcedPhot.createTanSip(image.header.cards).worldToPix(sidecar.target.ra, sidecar.target.dec);
  const rows = await Range.readRows(Range.createMemorySource(fixtureBytes), image, Math.floor(ty), 2);
  const ix = Math.floor(tx);
  const fx = tx - ix;
  const fy = ty - Math.floor(ty);
  const expected = rows.at(ix, Math.floor(ty)) * (1 - fx) * (1 - fy) + rows.at(ix + 1, Math.floor(ty)) * fx * (1 - fy) +
    rows.at(ix, Math.floor(ty) + 1) * (1 - fx) * fy + rows.at(ix + 1, Math.floor(ty) + 1) * fx * fy;
  assert.ok(Math.abs(r.values[grid.center * grid.width + grid.center] - expected) <= 1e-4 * Math.abs(expected));
  // Off the frame: no rows are read and nothing is covered.
  const far = await TS.loadFrame(ctx, { frame: fixtureFrame }, TS.createGrid({ ra: sidecar.target.ra + 1, dec: sidecar.target.dec, fieldDeg: 0.04 }));
  assert.equal(far.coverage, 0);
  assert.equal(far.bytes, 0);
});

test("chooser: 'any' reads nothing; 'wavelength' keeps frames within the tolerance and calibrates its reference", async () => {
  const ctx = memoryContext();
  const target = sidecar.target;
  const group = (n) => ({ frames: Array.from({ length: n }, (_, i) => ({ ...fixtureFrame, uri: fixtureFrame.uri + "#" + n + "-" + i })) });
  const any = TS.createChooser(ctx, target, { mode: "any" });
  const g = group(2);
  assert.equal((await any(g)).frame, g.frames[0]);
  assert.equal(ctx.headers.size, 0);

  const groups = [group(1), group(2), group(1)];
  const hold = TS.createChooser(ctx, target, { mode: "wavelength", groups, calibrate: 3 });
  const picked = await hold(groups[0]);
  assert.ok(Math.abs(hold.state.reference - 0.9952273651679209) < 1e-12, "reference calibrated on the window");
  assert.equal(picked.frame, groups[0].frames[0]);
  assert.ok(Math.abs(picked.wavelength - hold.state.reference) < 1e-12);

  const far = TS.createChooser(ctx, target, { mode: "wavelength", reference: 1.5, groups });
  assert.equal(await far(groups[1]), null, "no frame within one channel of 1.5 µm");
  const wide = TS.createChooser(ctx, target, { mode: "wavelength", reference: 1.02, tolerance: 2, groups });
  assert.ok(await wide(groups[1]), "within two channels (2 × 0.026 µm) of 1.02 µm");
  const offFrame = TS.createChooser(ctx, { ra: target.ra + 1, dec: target.dec }, { mode: "wavelength", groups });
  assert.equal(await offFrame(groups[0]), null, "a frame that does not contain the position is not a candidate");
});

test("display: median, shared range with offsets, stretches and RGBA (NaN in blue-grey)", () => {
  const a = new Float32Array([1, 2, 3, NaN, 5]);
  assert.equal(TS.median(a), 2.5);
  assert.ok(Number.isNaN(TS.median(new Float32Array([NaN]))));
  assert.deepEqual(TS.sharedRange([a], 0, 100), [1, 5]);
  assert.deepEqual(TS.sharedRange([a, new Float32Array([101, 102])], 0, 100, 1000, [0, 100]), [1, 5]);
  assert.equal(TS.sharedRange([new Float32Array([NaN])]), null);
  assert.deepEqual(TS.sharedRange([new Float32Array([7, 7])]), [7, 8]);
  for (const mode of ["linear", "sqrt", "asinh"]) {
    assert.equal(TS.stretch(0, 0, 1, mode), 0);
    assert.equal(TS.stretch(1, 0, 1, mode), 1);
    assert.equal(TS.stretch(-5, 0, 1, mode), 0);
    assert.ok(TS.stretch(0.25, 0, 1, mode) >= 0.25);
  }
  const rgba = TS.toRgba(new Float32Array([0, 1, NaN, 3]), [1, 3], "linear", undefined, 0);
  assert.deepEqual([...rgba], [0, 0, 0, 255, 0, 0, 0, 255, 34, 38, 52, 255, 255, 255, 255, 255]);
  assert.deepEqual([...TS.toRgba(new Float32Array([3]), [1, 3], "linear", undefined, 2)].slice(0, 3), [0, 0, 0]);
  assert.equal(TS.mjdToIso(60927.833964523), "2025-09-09T20:00:54Z");
  assert.equal(TS.formatElapsed(177.74), "177 days 17 h");
  assert.equal(TS.formatElapsed(0.25), "6 hours 0 min");
  assert.equal(TS.formatElapsed(-0.002), "−3 minutes");
  assert.equal(TS.formatElapsed(1.05), "1 day 1 h");
  assert.equal(TS.formatElapsed(1 / 24 + 2 / 1440), "1 hour 2 min");
  assert.equal(TS.formatElapsed(1 / 1440), "1 minute");
});

// ---- Cross-check with astropy + reproject (optional) --------------------------------------------------------------------------
function runReference(request) {
  const python = process.env.ASTRONOT_PYTHON ?? "python";
  const result = spawnSync(python, ["-I", join(root, "tests/time-sequence-reference.py")], { input: JSON.stringify(request), encoding: "utf8", maxBuffer: 1 << 26 });
  if (result.error || result.status !== 0) return { unavailable: (result.error?.message ?? result.stderr ?? "").trim().split("\n").pop() };
  return JSON.parse(result.stdout);
}
const scratch = mkdtempSync(join(tmpdir(), "astronot-seq-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
writeFileSync(join(scratch, "bd17.fits"), fixtureBytes);
const refGrid = TS.createGrid({ ra: sidecar.target.ra, dec: sidecar.target.dec, fieldDeg: 0.04 });
const reference = runReference({ fits: join(scratch, "bd17.fits"), ra: refGrid.ra, dec: refGrid.dec, n: refGrid.width, scale_deg: refGrid.scaleDeg });
const skipReference = reference.unavailable ? "astropy or reproject is not available (" + reference.unavailable + "). Set ASTRONOT_PYTHON to a Python with astropy and reproject." : false;

test("grid geometry equals astropy's gnomonic WCS of the same grid to 1e-9 arcsec", { skip: skipReference }, () => {
  reference.probe.forEach(([x, y], i) => {
    const [ra, dec] = refGrid.pixToWorld(x, y);
    const [era, edec] = reference.sky[i];
    let dra = ra - era;
    if (dra > 180) dra -= 360;
    if (dra < -180) dra += 360;
    assert.ok(Math.abs(dra * Math.cos((dec * Math.PI) / 180)) * 3600 < 1e-9 && Math.abs(dec - edec) * 3600 < 1e-9, "pixel " + x + "," + y);
  });
});

// Compare the resampled cutout with one set of reference values (null = no data there).
async function compareWithReference(values, meshStep) {
  const r = await TS.loadFrame(memoryContext(), { frame: fixtureFrame }, refGrid, { meshStep });
  const rel = [];
  for (let k = 0; k < r.values.length; k++) {
    const theirs = values[k];
    if (!Number.isFinite(r.values[k]) || theirs === null) continue;
    rel.push(Math.abs(r.values[k] - theirs) / Math.max(1, Math.abs(theirs)));
  }
  rel.sort((a, b) => a - b);
  return { compared: rel.length, total: r.values.length, median: rel[rel.length >> 1], worst: rel[rel.length - 1] };
}

test("resampled real cutout equals astropy (exact SIP inversion) + scipy bilinear to float32 precision", { skip: skipReference }, async (t) => {
  const c = await compareWithReference(reference.exact, 1);
  t.diagnostic(JSON.stringify(c));
  assert.ok(c.compared > 0.9 * c.total, "compared " + c.compared + " of " + c.total);
  assert.ok(c.worst < 2e-6, "worst relative difference " + c.worst);
  // the default 4-pixel mesh stays within 2e-4 of the value even on the bright star's core
  const d = await compareWithReference(reference.exact);
  t.diagnostic("default mesh: " + JSON.stringify(d));
  assert.ok(d.worst < 2e-4, "default mesh worst " + d.worst);
});

test("resampled real cutout equals reproject_interp(order='bilinear') with exact inversion, and within 2e-4 with the default mesh", { skip: skipReference }, async (t) => {
  const exact = await compareWithReference(reference.values, 1);
  t.diagnostic(JSON.stringify(exact));
  assert.ok(exact.compared > 0.9 * exact.total, "compared " + exact.compared + " of " + exact.total);
  assert.ok(exact.worst < 2e-6, "worst relative difference " + exact.worst);
  const mesh = await compareWithReference(reference.values);
  assert.ok(mesh.worst < 2e-4, "default mesh worst " + mesh.worst);
});

// ---- Live (ASTRONOT_LIVE=1): IRSA search + one frame from S3 -----------------------------------------------------------------
test("LIVE: search Orion (DR1, detector 2) on IRSA and read the first frame's rows from S3", { skip: process.env.ASTRONOT_LIVE !== "1" && "set ASTRONOT_LIVE=1" }, async () => {
  const q = { collection: "spherex_dr1", ra: 83.8221, dec: -5.3911, detector: 2 };
  const parsed = parseIrsaResults(await (await fetch(TS.irsaSiaUrl(q))).text());
  assert.ok(parsed.ok, parsed.message);
  const frames = TS.framesFromRows(parsed.rows);
  assert.ok(frames.length > 10 && frames.every((f) => f.detector === 2), "detector-2 frames only");
  const { groups } = TS.groupFrames(frames, { detector: 2, sampling: "day" });
  const grid = TS.createGrid({ ra: q.ra, dec: q.dec, fieldDeg: 0.1 });
  const r = await TS.loadFrame(TS.createContext(), { frame: groups[0].frames[0] }, grid);
  assert.ok(r.coverage > 0.9 && r.bytes < 2e6, "coverage " + r.coverage + ", bytes " + r.bytes);
  assert.ok(r.wavelength > 1.1 && r.wavelength < 1.65, "wavelength " + r.wavelength);
});
