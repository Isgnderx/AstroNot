// Run with:  node --test        (or: node --test tests/observation.test.mjs)
//
// Covers the Observation Search helpers: SIA query building (tools/observation.js) and IRSA CSV parsing,
// URL validation, cutout links and footprint checks (tools/observation-csv.js).
// All CSV text below is synthetic and only mimics the column layout IRSA returns. The optional live test at the
// end talks to the real archive when ASTRONOT_LIVE=1 is set.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const sandbox = vm.createContext({ URL, URLSearchParams, Date, Number, Math });
const lib = vm.runInContext(
  readFileSync(join(root, "tools/observation-csv.js"), "utf8") + "\n" +
  readFileSync(join(root, "tools/observation.js"), "utf8") +
  "\n({ parseCsv, parseIrsaResults, validateIrsaProductUrl, irsaCutoutUrl, irsaFootprint, irsaFootprintContains, irsaMjdToUtc, buildObservationQuery, irsaMaxRecords });",
  sandbox,
);

// Values built inside the vm context have other Array prototypes, so compare them as JSON.
const same = (actual, expected) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);

const product = "https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/2025W21_2C/l2b-v20-2025-250/2/level2_2025W21_2C_0280_1D2_spx_l2b-v20-2025-250.fits";
const header = "obs_id,access_url,access_format,energy_bandpassname,em_min,em_max,t_min,t_max,access_estsize,s_region,proposal_title";
const square = "POLYGON ICRS 10 -1 12 -1 12 1 10 1 10 -1";
const line = (id, url = product, format = "image/fits", extra = {}) =>
  [id, url, format, "SPHEREx-D2", "1.1033e-06", "1.6499e-06", "60819.183949", "60819.185282", "71635", extra.region ?? square, extra.title ?? "LVF"].join(",");

test("CSV parser handles quotes, commas, embedded newlines, CRLF, BOM and blank lines", () => {
  const text = '\uFEFFa,b,c\r\n1,"x, y",3\r\n\r\n"say ""hi""","line\nbreak",\r\n';
  same(lib.parseCsv(text), [["a", "b", "c"], ["1", "x, y", "3"], ['say "hi"', "line\nbreak", ""]]);
  same(lib.parseCsv("a,b\n1,2"), [["a", "b"], ["1", "2"]]);
  same(lib.parseCsv("a,b\r1,2\r"), [["a", "b"], ["1", "2"]]);
  assert.throws(() => lib.parseCsv('a,b\n1,"open'), /quoted field/);
});

test("IRSA results: comma and quote inside a field do not shift columns", () => {
  const csv = header + "\n" + line("2025W21_2C_0280_1", product, "image/fits", { title: '"Survey, ""LVF"" data"' }) + "\n";
  const parsed = lib.parseIrsaResults(csv);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.rows.length, 1);
  const row = parsed.rows[0];
  assert.equal(row.obsId, "2025W21_2C_0280_1");
  assert.equal(row.detector, 2);
  assert.equal(row.product.href, product);
  assert.equal(lib.irsaMjdToUtc(row.start), "2025-05-24 04:24:53 UTC");
  assert.equal(row.sizeKilobytes, 71635);
  assert.equal(row.footprint.length, 4);
});

test("IRSA results: unquoted JSON with commas (as IRSA writes cloud_access) does not shift columns", () => {
  const json = '{"aws": {"bucket_name": "nasa-irsa-spherex", "key":"qr2/level2/x.fits", "region": "us-east-1"}}';
  const csv = header + ",cloud_access,o_ucd,upload_row_id\n" + line("2025W21_2C_0280_1") + "," + json + ",,1\n";
  const parsed = lib.parseIrsaResults(csv);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.skipped.length, 0);
  // A row that is genuinely too long (no JSON to repair) is still rejected.
  const broken = lib.parseIrsaResults(header + "\n" + line("abc_1") + ",extra,extra\n");
  assert.equal(broken.rows.length, 0);
  assert.match(broken.skipped[0].reason, /fields/);
});

test("IRSA results: zero rows is a valid empty result, not an error", () => {
  for (const text of [header + "\n", header, "\uFEFF" + header + "\r\n"]) {
    const parsed = lib.parseIrsaResults(text);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.rows.length, 0);
    assert.equal(parsed.total, 0);
  }
});

test("IRSA results: missing file column, empty file, bad quote", () => {
  const missing = lib.parseIrsaResults("obs_id,s_ra\n2025W21_2C_0280_1,1\n");
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "missing-columns");
  assert.match(missing.message, /access_url/);
  assert.equal(lib.parseIrsaResults("").code, "empty-file");
  assert.equal(lib.parseIrsaResults("   \n").code, "empty-file");
  assert.equal(lib.parseIrsaResults(header + '\n"x,1\n').code, "bad-csv");
});

test("IRSA results: a service error (HTTP 200 VOTable) is reported with its message", () => {
  const xml = '<?xml version="1.0"?><VOTABLE><RESOURCE type="results"><INFO name="QUERY_STATUS" value="ERROR">UsageFault: BAD_REQUEST: dec value 95 lies outside valid interval [-90, 90]</INFO></RESOURCE></VOTABLE>';
  const parsed = lib.parseIrsaResults(xml);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "service-error");
  assert.match(parsed.message, /dec value 95 lies outside/);
  assert.equal(lib.parseIrsaResults("<html><body>Not found</body></html>").code, "not-csv");
  assert.equal(lib.parseIrsaResults('<VOTABLE><INFO name="QUERY_STATUS" value="OK"/></VOTABLE>').code, "not-csv");
});

test("IRSA results: mismatched URLs and product types are skipped with a reason", () => {
  const rows = [
    line("good_1"),
    line("bad_host", "https://example.com/ibe/data/spherex/qr2/level2/a/b.fits"),
    line("http_url", product.replace("https:", "http:")),
    line("wrong_path", "https://irsa.ipac.caltech.edu/ibe/data/wise/x.fits"),
    line("query_url", product + "?center=1,2&size=0.1"),
    line("traversal", "https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/../../../etc/x.fits"),
    line("credentials", product.replace("https://", "https://user:pw@")),
    line("not_fits", product, "text/html"),
    line("", product),
    line("dup", product),
    "short_row,only_two",
  ].join("\n");
  const parsed = lib.parseIrsaResults(header + "\n" + rows + "\n");
  assert.equal(parsed.ok, true);
  same(parsed.rows.map((row) => row.obsId), ["good_1"]);
  assert.equal(parsed.total, 11);
  assert.equal(parsed.skipped.length, 10);
  assert.match(parsed.skipped.find((entry) => entry.obsId === "not_fits").reason, /text\/html/);
  assert.match(parsed.skipped.find((entry) => entry.obsId === "bad_host").reason, /SPHEREx QR2 product/);
  assert.match(parsed.skipped.find((entry) => entry.obsId === "dup").reason, /repeats/);
  assert.match(parsed.skipped.at(-1).reason, /2 fields/);
});

test("Optional columns may be missing or empty", () => {
  const parsed = lib.parseIrsaResults("obs_id,access_url\nabc_1," + product + "\n");
  assert.equal(parsed.ok, true);
  const [row] = parsed.rows;
  assert.equal(row.start, null);
  assert.equal(row.minMetres, null);
  assert.equal(row.footprint, null);
  assert.equal(row.format, "");
  assert.equal(lib.irsaMjdToUtc(row.start), "");
});

test("Cutout URLs keep the product path and use degrees", () => {
  const url = lib.irsaCutoutUrl(product, 156.09328159, -41.64466331, 0.12);
  assert.equal(url.origin + url.pathname, product);
  assert.equal(url.search, "?center=156.09328159,-41.64466331&size=0.12deg");
  assert.equal(lib.irsaCutoutUrl(product, 156, -41, 0), null);
  assert.equal(lib.irsaCutoutUrl(product, 156, -41, 2), null);
  assert.equal(lib.irsaCutoutUrl(product, 361, -41, 0.1), null);
  assert.equal(lib.irsaCutoutUrl(product, 1, -91, 0.1), null);
  assert.equal(lib.irsaCutoutUrl(product, NaN, 0, 0.1), null);
  assert.equal(lib.irsaCutoutUrl("https://evil.example/a.fits", 1, 1, 0.1), null);
});

test("Footprint test: inside, outside, wrap at RA 0, near the pole, unknown", () => {
  const box = lib.irsaFootprint(square);
  assert.equal(box.length, 4);
  assert.equal(lib.irsaFootprintContains(box, 11, 0), true);
  assert.equal(lib.irsaFootprintContains(box, 13, 0), false);
  assert.equal(lib.irsaFootprintContains(box, 11, 2), false);
  assert.equal(lib.irsaFootprintContains(box, 191, 0), false);
  const wrap = lib.irsaFootprint("POLYGON ICRS 359 -1 1 -1 1 1 359 1 359 -1");
  assert.equal(lib.irsaFootprintContains(wrap, 0, 0), true);
  assert.equal(lib.irsaFootprintContains(wrap, 358, 0), false);
  const pole = lib.irsaFootprint("POLYGON ICRS 0 88 90 88 180 88 270 88 0 88");
  assert.equal(lib.irsaFootprintContains(pole, 45, 89.5), true);
  assert.equal(lib.irsaFootprintContains(pole, 45, 80), false);
  assert.equal(lib.irsaFootprintContains(null, 1, 1), null);
  assert.equal(lib.irsaFootprint("CIRCLE ICRS 1 2 3"), null);
});

test("SIA query uses degrees, MJD, and metres", () => {
  const { url, ra, dec, radius } = lib.buildObservationQuery({
    ra: "156.09328159", dec: "-41.64466331", radius: "0.02",
    dateStart: "2025-05-24", dateEnd: "2025-05-24", bandStart: "1.2", bandEnd: "1.4",
  });
  assert.equal(url.origin + url.pathname, "https://irsa.ipac.caltech.edu/SIA");
  assert.equal(url.searchParams.get("COLLECTION"), "spherex_qr2");
  assert.equal(url.searchParams.get("POS"), "CIRCLE 156.09328159 -41.64466331 0.02");
  assert.equal(url.searchParams.get("TIME"), "60819.00000000 60819.99999999");
  assert.equal(url.searchParams.get("BAND"), "1.2e-6 1.4e-6");
  assert.equal(url.searchParams.get("MAXREC"), String(lib.irsaMaxRecords));
  assert.equal(url.searchParams.get("RESPONSEFORMAT"), "CSV");
  same([ra, dec, radius], [156.09328159, -41.64466331, 0.02]);
});

test("SIA query: open-ended dates and bands, and invalid input", () => {
  const base = { ra: "10", dec: "-5", radius: "0.1" };
  assert.equal(lib.buildObservationQuery({ ...base, dateStart: "2025-05-24" }).url.searchParams.get("TIME"), "60819.00000000 +Inf");
  assert.equal(lib.buildObservationQuery({ ...base, dateEnd: "2025-05-24" }).url.searchParams.get("TIME"), "-Inf 60819.99999999");
  assert.equal(lib.buildObservationQuery({ ...base, bandStart: "1.2" }).url.searchParams.get("BAND"), "1.2e-6 +Inf");
  assert.equal(lib.buildObservationQuery({ ...base, ra: "360" }).ra, 0);
  assert.throws(() => lib.buildObservationQuery({ ...base, dateStart: "2025-05-25", dateEnd: "2025-05-24" }), /end date/);
  assert.throws(() => lib.buildObservationQuery({ ...base, dateStart: "2025-02-30" }), /valid UTC dates/);
  assert.throws(() => lib.buildObservationQuery({ ...base, dateStart: "not-a-date" }), /valid UTC dates/);
  assert.throws(() => lib.buildObservationQuery({ ...base, bandStart: "2", bandEnd: "1" }), /maximum wavelength/);
  assert.throws(() => lib.buildObservationQuery({ ...base, bandStart: "-1" }), /greater than zero/);
  assert.throws(() => lib.buildObservationQuery({ ...base, dec: "95" }), /Dec/);
  assert.throws(() => lib.buildObservationQuery({ ...base, ra: "" }), /RA/);
  assert.throws(() => lib.buildObservationQuery({ ...base, radius: "6" }), /radius/);
});

test("Two consecutive searches build independent queries", () => {
  const first = lib.buildObservationQuery({ ra: "1", dec: "1", radius: "0.1" });
  const second = lib.buildObservationQuery({ ra: "2", dec: "2", radius: "0.2" });
  assert.notEqual(first.url.href, second.url.href);
  assert.equal(first.url.searchParams.get("POS"), "CIRCLE 1 1 0.1");
});

// ---- Live archive test (real IRSA service). Run: ASTRONOT_LIVE=1 node --test tests/observation.test.mjs ---------------
test("LIVE: SIA CSV -> parsed row -> cutout whose header OBSID matches", { skip: !process.env.ASTRONOT_LIVE }, async () => {
  const { url } = lib.buildObservationQuery({
    ra: "156.09328159", dec: "-41.64466331", radius: "0.02",
    dateStart: "2025-05-24", dateEnd: "2025-05-24", bandStart: "1.2", bandEnd: "1.4",
  });
  const response = await fetch(url.href);
  assert.equal(response.status, 200);
  const parsed = lib.parseIrsaResults(await response.text());
  assert.equal(parsed.ok, true);
  assert.ok(parsed.rows.length > 0, "the archive returned no rows for the SPHEREx example");
  const row = parsed.rows.find((candidate) => lib.irsaFootprintContains(candidate.footprint, 156.09328159, -41.64466331));
  assert.ok(row, "no returned footprint contains the search position");
  const cutout = lib.irsaCutoutUrl(row.product.href, 156.09328159, -41.64466331, 0.12);
  const file = Buffer.from(await (await fetch(cutout.href)).arrayBuffer());
  assert.equal(file.subarray(0, 9).toString("ascii"), "SIMPLE  =");
  assert.match(file.toString("latin1"), new RegExp("OBSID   = '" + row.obsId + "'"));
});
