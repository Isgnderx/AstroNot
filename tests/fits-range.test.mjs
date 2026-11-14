// Run with:  node --test tests/        (or: node tests/fits-range.test.mjs)
//
// Covers tools/fits-range.js, the FITS reader behind Forced Spectrophotometry: header parsing, byte sources (memory and HTTP Range),
// row reads of plain and RICE_1 tile-compressed images, and binary tables. It is a port of spxphot's fits.rs and archive.rs.
//   - The header test is fits.rs::parses_header_and_history.
//   - The Rice test uses tests/data/spxphot/rice_vectors.json: four real FLAGS rows decoded by astropy.
//   - The file tests use tests/data/spxphot/bd17-cutout.fits (an IRSA-format cutout, made by spxphot) and check pixels against a
//     direct big-endian decode of the same bytes.
//   - The compressed-rows test builds a tile-compressed HDU from the four Rice vectors, because the cutout's FLAGS are plain int32.
//   - The HTTP test starts a local node:http server (ephemeral port); nothing leaves the machine.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const Fits = require("../tools/fits-range.js");
const { BLOCK, parseHeader, decodeImage, riceDecompressI32, createBinTable, createMemorySource, createHttpSource, hduAt, readRows, readTableBytes, walkHdus } = Fits;

const fixture = new Uint8Array(readFileSync(root + "tests/data/spxphot/bd17-cutout.fits"));
const riceVectors = JSON.parse(readFileSync(root + "tests/data/spxphot/rice_vectors.json", "utf8"));

const card = (text) => text.padEnd(80, " ");
const headerBytes = (cards) => new TextEncoder().encode(cards.map(card).join(""));
const padBlocks = (bytes) => {
  const out = new Uint8Array(Math.ceil(bytes.length / BLOCK) * BLOCK);
  out.set(bytes);
  return out;
};

test("parseHeader: values, strings with '' escapes, HIERARCH, HISTORY calib ids, padded size", () => {
  const bytes = headerBytes([
    "SIMPLE  =                    T",
    "NAXIS   =                    2",
    "NAXIS1  =                   10",
    "NAXIS2  =                    3",
    "BITPIX  =                  -32",
    "BUNIT   = 'MJy / sr'           / unit",
    "OBJECT  = 'O''Brien  '         / escaped quote, trailing blanks",
    "BIGNUM  =              1.5D+03 / D exponent",
    "HIERARCH OMEGA_MEDIAN = 37.94 / [arcsec**2]",
    "HISTORY [CALIB] epsf 019f-aaaa",
    "HISTORY [CALIB] epsf 019f-bbbb",
    "HISTORY [CALIB] spectral_wcs 019f-cccc",
    "END"
  ]);
  const h = parseHeader(bytes);
  assert.equal(h.size, 2880);
  assert.equal(h.get("BUNIT"), "MJy / sr");
  assert.equal(h.str("OBJECT"), "O'Brien");
  assert.equal(h.cards.NAXIS1, "10"); // numbers stay strings, as in parse_value
  assert.equal(h.num("OMEGA_MEDIAN"), 37.94);
  assert.equal(h.num("BIGNUM"), 1500);
  assert.equal(h.num("MISSING", 7), 7);
  assert.equal(h.num("BUNIT", 9), 9); // not a number: the fallback
  assert.throws(() => h.num("MISSING"), /missing header key MISSING/);
  assert.throws(() => h.num("BUNIT"), /not a number/);
  assert.equal(h.int("NAXIS2"), 3);
  assert.equal(h.get("NOPE"), undefined);
  assert.equal(h.history.length, 3);
  assert.equal(h.calibId("epsf"), "019f-bbbb"); // the last matching line wins
  assert.equal(h.calibId("spectral_wcs"), "019f-cccc");
  assert.equal(h.calibId("zodi"), undefined);
  assert.equal(h.dataSize(), 2880); // 120 bytes padded
});

test("parseHeader: no END card is null; data size of a binary table includes PCOUNT", () => {
  assert.equal(parseHeader(headerBytes(["SIMPLE  =                    T", "NAXIS   =                    0"])), null);
  const h = parseHeader(headerBytes(["XTENSION= 'BINTABLE'", "BITPIX  =                    8", "NAXIS   =                    2", "NAXIS1  =                   16", "NAXIS2  =                  200", "PCOUNT  =                 5000", "GCOUNT  =                    1", "END"]));
  assert.equal(h.dataSize(), Math.ceil((16 * 200 + 5000) / 2880) * 2880);
  const empty = parseHeader(headerBytes(["SIMPLE  =                    T", "BITPIX  =                    8", "NAXIS   =                    0", "END"]));
  assert.equal(empty.dataSize(), 0);
});

test("decodeImage: -32, -64, 32, 16 big-endian; anything else throws", () => {
  const dv = new DataView(new ArrayBuffer(16));
  dv.setFloat32(0, 1.5);
  dv.setFloat32(4, -2.25);
  assert.deepEqual(Array.from(decodeImage(-32, new Uint8Array(dv.buffer, 0, 8))), [1.5, -2.25]);
  dv.setFloat64(0, Math.PI);
  assert.deepEqual(Array.from(decodeImage(-64, new Uint8Array(dv.buffer, 0, 8))), [Math.PI]);
  dv.setInt32(0, -123456);
  dv.setInt32(4, 7);
  assert.deepEqual(Array.from(decodeImage(32, new Uint8Array(dv.buffer, 0, 8))), [-123456, 7]);
  dv.setInt16(0, -2);
  dv.setInt16(2, 300);
  assert.deepEqual(Array.from(decodeImage(16, new Uint8Array(dv.buffer, 0, 4))), [-2, 300]);
  assert.throws(() => decodeImage(8, new Uint8Array(4)), /unsupported BITPIX 8/);
});

test("riceDecompressI32 matches astropy on the four real FLAGS rows", () => {
  assert.equal(riceVectors.length, 4);
  for (const c of riceVectors) {
    const got = riceDecompressI32(Uint8Array.from(c.raw), c.values.length, 32);
    assert.ok(got instanceof Int32Array);
    assert.deepEqual(Array.from(got), c.values, "row " + c.row);
  }
  assert.throws(() => riceDecompressI32(new Uint8Array(3), 8, 32), /too short/);
  assert.throws(() => riceDecompressI32(Uint8Array.from(riceVectors[0].raw.slice(0, 40)), 2040, 32), /truncated/);
});

test("hdu chain of the fixture cutout", async () => {
  const hdus = await walkHdus(createMemorySource(fixture));
  const names = hdus.map((h) => h.name);
  assert.deepEqual(names, ["PRIMARY", "IMAGE", "FLAGS", "VARIANCE", "ZODI", "EPSF", "WCS-WAVE"]);
  const image = hdus[1];
  const width = Math.round((0.06 * 3600) / 6.15);
  assert.ok(Math.abs(image.header.int("NAXIS1") - width) <= 1, "width " + image.header.int("NAXIS1"));
  for (const h of hdus) assert.equal(h.dataOffset % BLOCK, 0, h.name + " data is block aligned");
  for (let i = 1; i < hdus.length; i++) assert.ok(hdus[i].dataOffset > hdus[i - 1].end, hdus[i].name + " starts after " + hdus[i - 1].name);
  assert.equal(hdus[hdus.length - 1].end, fixture.length);
  const again = await hduAt(createMemorySource(fixture), hdus[0].end);
  assert.equal(again.name, "IMAGE");
  assert.equal(again.dataOffset, image.dataOffset);
  assert.equal(again.dataSize, image.dataSize);
  // until / max
  const upToFlags = await walkHdus(createMemorySource(fixture), { until: "FLAGS" });
  assert.deepEqual(upToFlags.map((h) => h.name), ["PRIMARY", "IMAGE", "FLAGS"]);
  const capped = await walkHdus(createMemorySource(fixture), { max: 2 });
  assert.equal(capped.length, 2);
});

test("readRows of IMAGE equals a direct big-endian decode", async () => {
  const source = createMemorySource(fixture);
  const hdus = await walkHdus(source);
  const image = hdus.find((h) => h.name === "IMAGE");
  const width = image.header.int("NAXIS1");
  assert.equal(image.header.int("BITPIX"), -32);
  const block = await readRows(source, image, 10, 5);
  assert.equal(block.y0, 10);
  assert.equal(block.width, width);
  assert.equal(block.data.length, 5 * width);
  assert.ok(block.data instanceof Float64Array);
  const dv = new DataView(fixture.buffer, fixture.byteOffset, fixture.byteLength);
  let seed = 12345;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let checked = 0;
  let finite = 0;
  for (let k = 0; k < 50; k++) {
    const x = Math.floor(next() * width);
    const y = 10 + Math.floor(next() * 5);
    const want = dv.getFloat32(image.dataOffset + (y * width + x) * 4);
    const got = block.at(x, y);
    assert.ok(Object.is(got, want) || got === want, "pixel " + x + "," + y);
    checked++;
    if (Number.isFinite(got)) finite++;
  }
  assert.equal(checked, 50);
  assert.ok(finite > 30, "most pixels are finite");
  // the FLAGS HDU is plain int32 in the cutout
  const flags = hdus.find((h) => h.name === "FLAGS");
  const fb = await readRows(source, flags, 3, 2);
  assert.equal(fb.at(4, 4), dv.getInt32(flags.dataOffset + (4 * width + 4) * 4));
});

test("readRows applies BZERO and BSCALE", async () => {
  const header = headerBytes(["SIMPLE  =                    T", "BITPIX  =                   16", "NAXIS   =                    2", "NAXIS1  =                    3", "NAXIS2  =                    2", "BZERO   =                 32768", "BSCALE  =                  2.0", "END"]);
  const data = new Uint8Array(12);
  const dv = new DataView(data.buffer);
  [0, 1, -1, 100, -100, 7].forEach((v, i) => dv.setInt16(i * 2, v));
  const bytes = new Uint8Array(BLOCK * 2);
  bytes.set(header);
  bytes.set(data, BLOCK);
  const source = createMemorySource(bytes);
  const hdu = await hduAt(source, 0);
  assert.equal(hdu.dataOffset, BLOCK);
  const block = await readRows(source, hdu, 1, 1);
  assert.deepEqual(Array.from(block.data), [100 * 2 + 32768, -100 * 2 + 32768, 7 * 2 + 32768]);
  assert.equal(block.at(2, 1), 7 * 2 + 32768);
});

test("readRows of a RICE_1 row-tiled image (P and Q descriptors, THEAP)", async () => {
  const width = riceVectors[0].values.length;
  const nrows = riceVectors.length;
  for (const wide of [false, true]) {
    const desc = wide ? 16 : 8;
    const heapGap = wide ? 40 : 0; // the Q variant puts a gap between the descriptor table and the heap, so THEAP matters
    const theap = nrows * desc + heapGap;
    const table = new Uint8Array(nrows * desc);
    const tdv = new DataView(table.buffer);
    let heapLength = 0;
    riceVectors.forEach((c, r) => {
      if (wide) {
        tdv.setBigInt64(r * 16, BigInt(c.raw.length));
        tdv.setBigInt64(r * 16 + 8, BigInt(heapLength));
      } else {
        tdv.setInt32(r * 8, c.raw.length);
        tdv.setInt32(r * 8 + 4, heapLength);
      }
      heapLength += c.raw.length;
    });
    const heap = new Uint8Array(heapLength);
    let at = 0;
    for (const c of riceVectors) {
      heap.set(c.raw, at);
      at += c.raw.length;
    }
    const cards = [
      "XTENSION= 'BINTABLE'",
      "BITPIX  =                    8",
      "NAXIS   =                    2",
      "NAXIS1  =                " + String(desc).padStart(4, " "),
      "NAXIS2  =                    " + nrows,
      "PCOUNT  =                " + String(heapGap + heapLength).padStart(4, " "),
      "GCOUNT  =                    1",
      "TFIELDS =                    1",
      "TTYPE1  = 'COMPRESSED_DATA'",
      "TFORM1  = '1" + (wide ? "Q" : "P") + "B(6000)'",
      "THEAP   =                " + String(theap).padStart(4, " "),
      "ZIMAGE  =                    T",
      "ZCMPTYPE= 'RICE_1  '",
      "ZBITPIX =                   32",
      "ZNAXIS  =                    2",
      "ZNAXIS1 =                " + String(width).padStart(4, " "),
      "ZNAXIS2 =                " + String(nrows).padStart(4, " "),
      "ZTILE1  =                " + String(width).padStart(4, " "),
      "ZTILE2  =                    1",
      "ZNAME1  = 'BLOCKSIZE'",
      "ZVAL1   =                   32",
      "ZNAME2  = 'BYTEPIX '",
      "ZVAL2   =                    4",
      "END"
    ];
    const hb = padBlocks(headerBytes(cards));
    const dataBytes = new Uint8Array(theap + heapLength);
    dataBytes.set(table);
    dataBytes.set(heap, theap);
    const file = new Uint8Array(hb.length + Math.ceil(dataBytes.length / BLOCK) * BLOCK);
    file.set(hb);
    file.set(dataBytes, hb.length);
    const source = createMemorySource(file);
    const hdu = await hduAt(source, 0);
    assert.equal(hdu.dataOffset, hb.length);
    const block = await readRows(source, hdu, 1, 2);
    assert.equal(block.y0, 1);
    assert.equal(block.width, width);
    assert.deepEqual(Array.from(block.data), riceVectors[1].values.concat(riceVectors[2].values), wide ? "Q" : "P");
    assert.equal(block.at(5, 2), riceVectors[2].values[5]);
    const bad = parseHeader(headerBytes(cards.map((c) => (c.startsWith("ZTILE2") ? "ZTILE2  =                    2" : c))));
    await assert.rejects(readRows(source, { ...hdu, header: bad }, 0, 1), /only row-tiled/);
  }
});

test("createBinTable reads EPSF zones and the WCS-WAVE table", async () => {
  const source = createMemorySource(fixture);
  const hdus = await walkHdus(source);
  const epsfHdu = hdus.find((h) => h.name === "EPSF");
  const epsf = createBinTable(epsfHdu.header, await readTableBytes(source, epsfHdu));
  assert.equal(epsf.rows, 441);
  assert.equal(epsf.rowLength, epsfHdu.header.int("NAXIS1"));
  assert.ok(Number.isFinite(epsf.scalar(0, "XCENTER")));
  const tdim = epsfHdu.header.str("TDIM" + (epsf.columns.findIndex((c) => c.name === "EPSF") + 1));
  const product = tdim ? tdim.replace(/[()\s]/g, "").split(",").map(Number).reduce((a, b) => a * b, 1) : 1089;
  assert.equal(epsf.get(0, "EPSF").length, product);
  assert.equal(epsf.get(0, "EPSF").length, 33 * 33);
  assert.equal(epsf.get(0, "epsf").length, 33 * 33); // names are case-insensitive
  assert.equal(epsf.columns.find((c) => c.name === "EPSF").repeat, 1089);
  assert.equal(epsf.columns[0].offset, 0);
  assert.throws(() => epsf.get(0, "NOPE"), /no column NOPE/);
  // the OVSMPX keyword of the real file
  assert.equal(epsfHdu.header.int("OVSMPX"), 5);

  const waveHdu = hdus.find((h) => h.name === "WCS-WAVE");
  const wave = createBinTable(waveHdu.header, await readTableBytes(source, waveHdu));
  assert.equal(wave.rows, 1);
  const xs = wave.get(0, "X");
  const ys = wave.get(0, "Y");
  const values = wave.get(0, "VALUES");
  assert.ok(xs.length > 1 && ys.length > 1);
  assert.equal(values.length, 2 * xs.length * ys.length);
  assert.ok(values.every(Number.isFinite));
  assert.ok(xs[1] > xs[0]);

  assert.throws(() => createBinTable(waveHdu.header, new Uint8Array(10)), /truncated/);
});

// ---- HTTP -----------------------------------------------------------------------------------------------------------------
function startServer() {
  let flakyCalls = 0;
  const server = createServer((req, res) => {
    const total = fixture.length;
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || "");
    if (req.url === "/ignores-range") {
      res.writeHead(200, { "Content-Length": 100 });
      res.end(Buffer.from(fixture.subarray(0, 100)));
      return;
    }
    if (req.url === "/flaky" && flakyCalls++ < 2) {
      res.writeHead(500);
      res.end("try later");
      return;
    }
    if (!range) {
      res.writeHead(200);
      res.end(Buffer.from(fixture));
      return;
    }
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), total - 1);
    res.writeHead(206, { "Content-Range": "bytes " + start + "-" + end + "/" + total, "Content-Length": end - start + 1 });
    res.end(Buffer.from(fixture.subarray(start, end + 1)));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("HttpSource: range reads, 206 required, retry then success", async () => {
  const server = await startServer();
  try {
    const base = "http://127.0.0.1:" + server.address().port;
    const calls = [];
    const counting = (url, init) => {
      calls.push({ url, range: init.headers.Range });
      return fetch(url, init);
    };

    const ok = createHttpSource(base + "/frame.fits", { fetch: counting, retries: 4, firstDelayMs: 1 });
    assert.equal(ok.kind, "http");
    const bytes = await ok.read(2880, 160);
    assert.deepEqual(Array.from(bytes), Array.from(fixture.subarray(2880, 3040)));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].range, "bytes=2880-3039");

    // the same HDU walk over HTTP as over memory
    const overHttp = await walkHdus(ok);
    const overMemory = await walkHdus(createMemorySource(fixture));
    assert.deepEqual(overHttp.map((h) => [h.name, h.dataOffset, h.dataSize]), overMemory.map((h) => [h.name, h.dataOffset, h.dataSize]));
    const image = overHttp.find((h) => h.name === "IMAGE");
    const a = await readRows(ok, image, 20, 3);
    const b = await readRows(createMemorySource(fixture), image, 20, 3);
    assert.deepEqual(Array.from(a.data), Array.from(b.data));

    calls.length = 0;
    const flaky = createHttpSource(base + "/flaky", { fetch: counting, retries: 5, firstDelayMs: 1 });
    const got = await flaky.read(0, 80);
    assert.equal(calls.length, 3, "500, 500, then 206");
    assert.deepEqual(Array.from(got), Array.from(fixture.subarray(0, 80)));

    calls.length = 0;
    const deaf = createHttpSource(base + "/ignores-range", { fetch: counting, retries: 3, firstDelayMs: 1 });
    await assert.rejects(deaf.read(0, 80), /ignored Range/);
    assert.equal(calls.length, 3, "retried `retries` times in all");

    const failing = createHttpSource(base + "/x", { fetch: () => Promise.reject(new Error("offline")), retries: 2, firstDelayMs: 1 });
    await assert.rejects(failing.read(0, 10), /offline/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("MemorySource: clamps to the end, throws past it", async () => {
  const source = createMemorySource(new Uint8Array([1, 2, 3, 4, 5]));
  assert.equal(source.kind, "memory");
  assert.deepEqual(Array.from(await source.read(3, 10)), [4, 5]);
  assert.deepEqual(Array.from(await source.read(0, 2)), [1, 2]);
  await assert.rejects(source.read(5, 1), /read past end of buffer/);
});
