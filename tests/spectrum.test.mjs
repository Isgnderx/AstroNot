// Run with:  node --test tests/        (or: node tests/spectrum.test.mjs)
//
// Covers tools/spectrum-csv.js, the model behind Spectrum Lab: reading CSV, the shared column contract, unit conversion,
// bad-row reporting, sources and observations, flag decoding, ranges, sorting and axes.
//   - Fixtures built in this file are SYNTHETIC test tables, not archive data.
//   - assets/tools/spectrum-example.js is the synthetic example the page loads. It is checked to follow the contract, and it is
//     not a SPHEREx archive result.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const S = require("../tools/spectrum-csv.js");

const contractUnits = { wavelength: "um", flux: "uJy" };

function load(text, units = contractUnits, readOptions = {}, buildOptions = {}) {
  const table = S.readTable(text, readOptions);
  assert.ok(table.ok, table.message);
  const columns = S.detectColumns(table.headers);
  return { table, columns, spectrum: S.buildSpectrum(table, columns.mapping, units, { decimalComma: false, ...buildOptions }) };
}

// ---- Units -----------------------------------------------------------------------------------------------------------
test("100 uJy is exactly 0.0001 Jy and 1.2 um is exactly 1.2e-6 m", () => {
  assert.equal(S.convert(100, "uJy", "Jy", "flux"), 0.0001);
  assert.equal(S.convert(100, "uJy", "mJy", "flux"), 0.1);
  assert.equal(S.convert(0.0001, "Jy", "uJy", "flux"), 100);
  assert.equal(S.convert(1.2, "um", "m", "wavelength"), 0.0000012);
  assert.equal(S.convert(1.2, "um", "nm", "wavelength"), 1200);
  assert.equal(S.convert(1.2, "um", "A", "wavelength"), 12000);
  assert.equal(S.convert(6563, "A", "um", "wavelength"), 0.6563);
  assert.equal(S.convert(-3.5, "uJy", "mJy", "flux"), -0.0035);
  assert.equal(S.convert(0, "uJy", "Jy", "flux"), 0);
});

test("unknown units are rejected, not ignored", () => {
  assert.throws(() => S.convert(1, "um", "parsec", "wavelength"), RangeError);
  assert.throws(() => S.convert(1, "Jy", "erg", "flux"), RangeError);
});

test("unit names are read with micro sign, Greek mu, Angstrom and plain spellings", () => {
  assert.equal(S.parseUnit("µm", "wavelength"), "um");
  assert.equal(S.parseUnit("μm", "wavelength"), "um");
  assert.equal(S.parseUnit("Å", "wavelength"), "A");
  assert.equal(S.parseUnit("Angstrom", "wavelength"), "A");
  assert.equal(S.parseUnit("µJy", "flux"), "uJy");
  assert.equal(S.parseUnit("microjansky", "flux"), "uJy");
  assert.equal(S.parseUnit("erg/s/cm2/A", "flux"), null);
  assert.equal(S.unitFromHeader("flux (µJy)", "flux"), "uJy");
  assert.equal(S.unitFromHeader("wavelength_nm", "wavelength"), "nm");
  assert.equal(S.unitFromHeader("wavelength", "wavelength"), null);
});

// ---- Contract --------------------------------------------------------------------------------------------------------
test("the shared contract is recognised case-insensitively with documented units, and extra columns are kept", () => {
  const csv = "WAVELENGTH,Flux,FLUX_ERR,lambda_width,flags,source_id,obs_id,mjd,RA,Dec,method,det_id\n" +
    "1.2,100,5,0.03,0,S1,O1,60800.5,150.1,2.2,spherex,3\n";
  const { columns, spectrum } = load(csv);
  assert.ok(columns.contract);
  assert.deepEqual([columns.units.wavelength, columns.units.flux], ["um", "uJy"]);
  assert.deepEqual(columns.units.source, { wavelength: "contract", flux: "contract" });
  assert.ok(spectrum.ok);
  const [point] = spectrum.points;
  assert.deepEqual(
    { w: point.wavelength, f: point.flux, e: point.fluxErr, width: point.width, flags: point.flags, mjd: point.mjd, ra: point.ra, dec: point.dec, method: point.method, source: point.source, obs: point.obs },
    { w: 1.2, f: 100, e: 5, width: 0.03, flags: 0, mjd: 60800.5, ra: "150.1", dec: "2.2", method: "spherex", source: "S1", obs: "O1" },
  );
  assert.deepEqual(point.extra, { det_id: "3" });
});

test("a generic table needs its units chosen; a unit in the header is suggested but marked as from the header", () => {
  const generic = load("lambda,fnu\n1,2\n", { wavelength: null, flux: null });
  assert.equal(generic.columns.contract, false);
  assert.equal(generic.spectrum.ok, false);
  assert.equal(generic.spectrum.code, "needs-units");
  const suffixed = S.detectColumns(["lambda_nm", "fnu_mJy", "sigma"]);
  assert.deepEqual([suffixed.mapping.wavelength, suffixed.mapping.flux, suffixed.mapping.flux_err], [0, 1, 2]);
  assert.deepEqual([suffixed.units.wavelength, suffixed.units.flux], ["nm", "mJy"]);
  const headed = S.detectColumns(["wavelength_nm", "flux (mJy)"]);
  assert.deepEqual([headed.units.wavelength, headed.units.flux], ["nm", "mJy"]);
  assert.deepEqual(headed.units.source, { wavelength: "header", flux: "header" });
});

test("a generic table converts with the units the reader chose", () => {
  const { spectrum } = load("wave,fnu,sigma\n6563,2.5,0.1\n", { wavelength: "A", flux: "mJy" });
  assert.ok(spectrum.ok);
  const shown = S.displayPoint(spectrum.points[0], spectrum.units, { wavelength: "um", flux: "uJy" });
  assert.equal(shown.wavelength, 0.6563);
  assert.equal(shown.flux, 2500);
  assert.equal(shown.fluxErr, 100);
});

test("the error is converted with the same factor as the flux of its own point", () => {
  const { spectrum } = load("wavelength,flux,flux_err,lambda_width\n1.2,100,5,0.03\n");
  const shown = S.displayPoint(spectrum.points[0], spectrum.units, { wavelength: "nm", flux: "Jy" });
  assert.equal(shown.flux, 0.0001);
  assert.equal(shown.fluxErr, 0.000005);
  assert.equal(shown.wavelength, 1200);
  assert.equal(shown.width, 30);
});

// ---- Values: negative, duplicates, empty error --------------------------------------------------------------------------
test("negative and zero flux are valid measurements and are kept", () => {
  const { spectrum } = load("wavelength,flux,flux_err\n1.0,-3.4,2\n1.1,0,2\n1.2,5,2\n");
  assert.ok(spectrum.ok);
  assert.deepEqual(spectrum.points.map((point) => point.flux), [-3.4, 0, 5]);
  assert.equal(spectrum.bad.length, 0);
});

test("two rows at one wavelength stay two points, kept apart by row and observation", () => {
  const { spectrum } = load("wavelength,flux,flux_err,obs_id\n2.0,10,1,A\n2.0,12,1,B\n");
  assert.equal(spectrum.points.length, 2);
  const chosen = S.selectPoints(spectrum, { source: "" });
  assert.deepEqual(chosen.map((point) => [point.wavelength, point.flux, point.obs, point.line]), [[2, 10, "A", 2], [2, 12, "B", 3]]);
  assert.deepEqual(S.selectPoints(spectrum, { source: "", obs: "B" }).map((point) => point.flux), [12]);
});

test("an empty flux_err is an unknown error, not zero; a NaN error is unknown too", () => {
  const { spectrum } = load("wavelength,flux,flux_err\n1,10,\n2,10,nan\n3,10,0\n");
  assert.deepEqual(spectrum.points.map((point) => point.fluxErr), [null, null, 0]);
  const shown = S.displayPoint(spectrum.points[0], spectrum.units, { wavelength: "um", flux: "Jy" });
  assert.equal(shown.fluxErr, null);
});

// ---- Bad rows --------------------------------------------------------------------------------------------------------
test("bad rows are counted with a reason and line, and the valid rows are kept", () => {
  const csv = [
    "wavelength,flux,flux_err,flags",
    "1.0,10,1,0",
    "0,10,1,0",           // wavelength not > 0
    "-2,10,1,0",          // negative wavelength
    "1.2,abc,1,0",        // flux not a number
    "1.3,,1,0",           // flux empty
    "1.4,nan,1,0",        // flux NaN
    "1.5,inf,1,0",        // flux infinite
    "1.6,10,-1,0",        // negative error
    "1.7,10,1,2.5",       // flags not an integer
    "1.8,10,1",           // too few fields
    "1.9,10,1,0,9",       // too many fields
    "x,10,1,0",           // wavelength not a number
    "2.0,20,2,0",
  ].join("\n");
  const { spectrum } = load(csv);
  assert.ok(spectrum.ok);
  assert.equal(spectrum.total, 13);
  assert.equal(spectrum.points.length, 2);
  assert.equal(spectrum.bad.length, 11);
  const reasonOf = (line) => spectrum.bad.find((row) => row.line === line).reason;
  assert.match(reasonOf(3), /wavelength must be greater than 0/);
  assert.match(reasonOf(4), /wavelength must be greater than 0/);
  assert.match(reasonOf(5), /flux is not a number \('abc'\)/);
  assert.match(reasonOf(6), /flux is empty/);
  assert.match(reasonOf(7), /flux is NaN/);
  assert.match(reasonOf(8), /flux is infinite/);
  assert.match(reasonOf(9), /flux_err is negative/);
  assert.match(reasonOf(10), /flags '2.5' is not a non-negative integer/);
  assert.match(reasonOf(11), /3 fields instead of 4/);
  assert.match(reasonOf(12), /5 fields instead of 4/);
  assert.match(reasonOf(13), /wavelength is not a number/);
  assert.equal(spectrum.badSummary.find((entry) => entry.reason === "the row has the wrong number of fields").count, 2);
  assert.equal(spectrum.badSummary.reduce((sum, entry) => sum + entry.count, 0), 11);
});

test("a file where no row is usable is an error that names the main problem", () => {
  const { spectrum } = load("wavelength,flux,flux_err\n0,1,1\n-1,1,1\nabc,1,1\n");
  assert.equal(spectrum.ok, false);
  assert.equal(spectrum.code, "no-valid-rows");
  assert.match(spectrum.message, /None of the 3 rows/);
  assert.equal(spectrum.bad.length, 3);
});

test("a header with no data rows is reported as empty, not as a blank plot", () => {
  const { spectrum } = load("wavelength,flux,flux_err\n");
  assert.equal(spectrum.ok, false);
  assert.equal(spectrum.code, "no-data-rows");
});

test("one column used for two fields is refused", () => {
  const table = S.readTable("a,b\n1,2\n");
  const result = S.buildSpectrum(table, { wavelength: 0, flux: 0 }, contractUnits);
  assert.equal(result.ok, false);
  assert.equal(result.code, "duplicate-columns");
});

// ---- Reading files ---------------------------------------------------------------------------------------------------
test("delimiter, BOM, quotes, comments and line endings are handled", () => {
  const semicolon = load("﻿wavelength;flux;flux_err\r\n1,5;10,5;0,5\r\n", contractUnits, {}, { decimalComma: true });
  assert.equal(semicolon.table.delimiter, ";");
  assert.deepEqual([semicolon.spectrum.points[0].wavelength, semicolon.spectrum.points[0].flux, semicolon.spectrum.points[0].fluxErr], [1.5, 10.5, 0.5]);
  assert.equal(S.readTable("wavelength\tflux\tflux_err\n1\t2\t3\n").delimiter, "\t");
  const quoted = load('# a comment line\nwavelength,flux,flux_err,note\n1,2,3,"has, comma and ""quote"""\n\n# trailing comment\n2,3,4,"two\nlines"\n');
  assert.equal(quoted.table.comments, 2);
  assert.equal(quoted.spectrum.points.length, 2);
  assert.equal(quoted.spectrum.points[0].extra.note, 'has, comma and "quote"');
  assert.equal(quoted.spectrum.points[1].extra.note, "two\nlines");
  assert.equal(quoted.spectrum.points[0].line, 3);
  assert.equal(quoted.spectrum.points[1].line, 6);
  assert.equal(load("wavelength,flux,flux_err\r1,2,3\r2,3,4").spectrum.points.length, 2);
});

test("decimal comma is only read in a file that is not comma-separated", () => {
  const comma = load("wavelength,flux,flux_err\n1,5,1\n", contractUnits, {}, { decimalComma: true });
  assert.deepEqual([comma.spectrum.points[0].wavelength, comma.spectrum.points[0].flux], [1, 5], "in a comma file the comma separates fields");
  assert.equal(S.parseNumber("1,5", true).value, 1.5);
  assert.ok(S.parseNumber("1,5", false).reason);
});

test("empty, binary, XML, VOTable, one-column, unclosed-quote and oversized inputs give clear errors", () => {
  assert.equal(S.readTable("").code, "empty-file");
  assert.equal(S.readTable("  \n \n").code, "empty-file");
  assert.equal(S.readTable("# only a comment\n").code, "empty-file");
  assert.match(S.readTable('<?xml version="1.0"?><VOTABLE></VOTABLE>').message, /VOTable/);
  assert.match(S.readTable("<html><body>no</body></html>").message, /HTML or XML/);
  assert.equal(S.readTable("wavelength\n1\n").code, "no-delimiter");
  assert.equal(S.readTable('wavelength,flux\n1,"2\n').code, "bad-csv");
  assert.equal(S.decodeBytes(new Uint8Array(0)).code, "empty-file");
  assert.match(S.decodeBytes(Uint8Array.from([0x50, 0x4b, 3, 4])).message, /zip/);
  assert.match(S.decodeBytes(new TextEncoder().encode("SIMPLE  =                    T")).message, /FITS/);
  assert.equal(S.decodeBytes(Uint8Array.from([65, 0, 66, 0, 0, 1])).code, "not-csv");
  const huge = { byteLength: S.limits.maxBytes + 1 };
  assert.equal(S.decodeBytes(new Uint8Array(S.limits.maxBytes + 1)).code, "too-large");
  assert.ok(huge.byteLength > S.limits.maxBytes);
});

test("encodings: UTF-8 with BOM, UTF-16 and a Latin file fall back with a note", () => {
  const utf8 = S.decodeBytes(Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("a,b\n1,2\n")]));
  assert.equal(utf8.encoding, "utf-8");
  assert.equal(S.readTable(utf8.text).headers[0], "a");
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("wavelength,flux\n1,2\n", "utf16le")]);
  const decoded = S.decodeBytes(utf16);
  assert.equal(decoded.encoding, "utf-16le");
  assert.equal(S.readTable(decoded.text).headers[1], "flux");
  const latin = S.decodeBytes(Uint8Array.from([0x6e, 0x6f, 0x74, 0x65, 0x3a, 0xb5, 0x6d, 0x0a]));
  assert.equal(latin.encoding, "windows-1252");
  assert.match(latin.note, /Windows-1252/);
});

test("a table over the row limit is refused instead of freezing the page", () => {
  const rows = ["wavelength,flux,flux_err"];
  for (let index = 0; index <= S.limits.maxRows; index++) rows.push("1,1,1");
  const result = S.readTable(rows.join("\n"));
  assert.equal(result.ok, false);
  assert.equal(result.code, "too-many-rows");
});

// ---- Re-import --------------------------------------------------------------------------------------------------------
test("importing a second file builds a new spectrum and does not mix in rows of the first", () => {
  const first = load("wavelength,flux,flux_err,source_id\n1,1,1,A\n2,2,1,A\n").spectrum;
  const second = load("wavelength,flux,flux_err,source_id\n3,3,1,B\n").spectrum;
  assert.equal(first.points.length, 2);
  assert.equal(second.points.length, 1);
  assert.deepEqual(second.sources.map((source) => source.key), ["B"]);
  assert.ok(!second.points.some((point) => point.source === "A"));
});

// ---- Sources, observations, selection -----------------------------------------------------------------------------------
test("several sources never share a spectrum; a missing source_id falls back to coordinates, then to unspecified", () => {
  const csv = "wavelength,flux,flux_err,source_id,obs_id,ra,dec\n1,10,1,A,O1,,\n2,11,1,A,O2,,\n1,20,1,B,O3,,\n1.5,30,1,,O4,150.5,2.5\n1.6,31,1,,O4,,\n";
  const { spectrum } = load(csv);
  assert.deepEqual(spectrum.sources.map((source) => [source.key, source.count]), [["A", 2], ["B", 1], ["RA 150.5, Dec 2.5", 1], ["", 1]]);
  assert.equal(spectrum.sources[3].label, "Unspecified source");
  assert.deepEqual(spectrum.sources[0].observations.map((observation) => observation.key), ["O1", "O2"]);
  assert.deepEqual(S.selectPoints(spectrum, { source: "A" }).map((point) => point.flux), [10, 11]);
  assert.deepEqual(S.selectPoints(spectrum, { source: "B" }).map((point) => point.flux), [20]);
});

test("the wavelength range is read from numbers, converted once and applied to both ends inclusively", () => {
  assert.deepEqual(S.parseRange("", ""), { ok: true, min: null, max: null });
  assert.deepEqual(S.parseRange("1.5", "3"), { ok: true, min: 1.5, max: 3 });
  assert.equal(S.parseRange("3", "1.5").ok, false);
  assert.equal(S.parseRange("abc", "").ok, false);
  assert.equal(S.parseRange("-1", "").ok, false);
  const { spectrum } = load("wavelength,flux,flux_err\n1,1,1\n1.5,2,1\n2,3,1\n3,4,1\n4,5,1\n");
  assert.deepEqual(S.selectPoints(spectrum, { source: "", min: 1.5, max: 3, rangeUnit: "um" }).map((p) => p.wavelength), [1.5, 2, 3]);
  assert.deepEqual(S.selectPoints(spectrum, { source: "", min: 15000, max: 30000, rangeUnit: "A" }).map((p) => p.wavelength), [1.5, 2, 3]);
  assert.deepEqual(S.selectPoints(spectrum, { source: "", min: 5 }).map((p) => p.wavelength), []);
});

test("points come out sorted by wavelength whatever the file order, and gaps stay gaps", () => {
  const { spectrum } = load("wavelength,flux,flux_err\n3,1,1\n1,1,1\n1.1,1,1\n9,1,1\n");
  assert.deepEqual(S.selectPoints(spectrum, { source: "" }).map((point) => point.wavelength), [1, 1.1, 3, 9]);
});

test("the flag filter separates unflagged, flagged and not-reported rows", () => {
  const { spectrum } = load("wavelength,flux,flux_err,flags\n1,1,1,0\n2,1,1,4\n3,1,1,\n");
  assert.deepEqual(S.selectPoints(spectrum, { source: "", flags: "clean" }).map((p) => p.wavelength), [1, 3]);
  assert.deepEqual(S.selectPoints(spectrum, { source: "", flags: "flagged" }).map((p) => p.wavelength), [2]);
});

test("table sorting is stable, numeric, and puts empty values last in both directions", () => {
  const { spectrum } = load("wavelength,flux,flux_err,obs_id\n3,-1,,O10\n1,5,2,O2\n2,5,1,O1\n");
  const flux = (points) => points.map((point) => point.flux);
  assert.deepEqual(S.sortPoints(spectrum.points, "wavelength").map((p) => p.wavelength), [1, 2, 3]);
  assert.deepEqual(S.sortPoints(spectrum.points, "flux", "desc").map((p) => p.wavelength), [1, 2, 3]);
  assert.deepEqual(flux(S.sortPoints(spectrum.points, "flux")), [-1, 5, 5]);
  assert.deepEqual(S.sortPoints(spectrum.points, "fluxErr", "asc").map((p) => p.fluxErr), [1, 2, null]);
  assert.deepEqual(S.sortPoints(spectrum.points, "fluxErr", "desc").map((p) => p.fluxErr), [2, 1, null]);
  assert.deepEqual(S.sortPoints(spectrum.points, "obs").map((p) => p.obs), ["O1", "O2", "O10"]);
  assert.throws(() => S.sortPoints(spectrum.points, "bogus"), RangeError);
});

// ---- Flags ------------------------------------------------------------------------------------------------------------
test("documented SPHEREx flag bits are decoded and unknown bits keep their raw value", () => {
  assert.equal(S.decodeFlags(0).text, "none set");
  assert.deepEqual(S.decodeFlags(1).labels, ["TRANSIENT"]);
  assert.deepEqual(S.decodeFlags(2097152).labels, ["SOURCE"]);
  assert.deepEqual(S.decodeFlags(128).labels, ["DICHROIC"]);
  const example = S.decodeFlags(4297064449);
  assert.deepEqual(example.labels, ["TRANSIENT", "SOURCE", "CONTAINS_BAD_PIXEL"], "4297064449 = 2^32 + 2^21 + 2^0, the example value on the IRSA page");
  assert.deepEqual(example.unknown, []);
  const unknown = S.decodeFlags(8 + 1);
  assert.deepEqual(unknown.labels, ["TRANSIENT"]);
  assert.deepEqual(unknown.unknown, [{ bit: 3, value: "8" }]);
  assert.match(unknown.text, /unknown bit 3 \(8\)/);
  assert.equal(unknown.raw, "9");
  assert.deepEqual(S.decodeFlags(2 ** 33).labels, ["FIT_ERROR"], "bits above 31 are not truncated");
  assert.deepEqual(S.decodeFlags(2 ** 40).unknown, [{ bit: 40, value: "1099511627776" }]);
  assert.equal(S.decodeFlags(null).text, "");
});

test("flag definitions match the documented IRSA bit table", () => {
  const byName = Object.fromEntries(S.flagDefinitions.map((definition) => [definition.name, definition]));
  assert.equal(S.flagDefinitions.length, 25);
  assert.equal(byName.TRANSIENT.value, "1");
  assert.equal(byName.OVERFLOW.value, "2");
  assert.equal(byName.NONFUNC.value, "64");
  assert.equal(byName.HOT.value, "1024");
  assert.equal(byName.OUTLIER.value, "524288");
  assert.equal(byName.SOURCE.value, "2097152");
  assert.equal(byName.CONTAINS_BAD_PIXEL.value, "4294967296");
  assert.equal(byName.FIT_ERROR.value, "8589934592");
  assert.equal(byName.CROSSTALK.meaning, null, "the page gives no definition for CROSSTALK");
});

// ---- Axes and log disclosure ------------------------------------------------------------------------------------------
test("linear and logarithmic axes cover their extent and use round ticks", () => {
  const linear = S.computeAxis(0.75, 5, "linear");
  assert.ok(linear.min < 0.75 && linear.max > 5);
  assert.ok(linear.ticks.every((tick) => tick.value >= linear.min && tick.value <= linear.max));
  assert.deepEqual(S.computeAxis(0, 10, "linear", { exact: true }).ticks.map((tick) => tick.value), [0, 2, 4, 6, 8, 10]);
  const log = S.computeAxis(3, 800, "log");
  assert.ok(log.min < 3 && log.max > 800);
  assert.ok(log.ticks.some((tick) => tick.value === 10) && log.ticks.some((tick) => tick.value === 100));
  assert.throws(() => S.computeAxis(0, 5, "log"), RangeError);
  assert.ok(S.computeAxis(5, 5, "linear").max > 5);
});

test("the log view discloses non-positive points and error bars that reach zero", () => {
  const { spectrum } = load("wavelength,flux,flux_err\n1,10,1\n2,-3,1\n3,0,1\n4,2,5\n5,4,\n");
  const rows = S.selectPoints(spectrum, { source: "" }).map((point) => S.displayPoint(point, spectrum.units, spectrum.units));
  const disclosure = S.logDisclosure(rows);
  assert.deepEqual(disclosure.dropped.map((row) => row.flux), [-3, 0]);
  assert.deepEqual(disclosure.clipped.map((row) => row.flux), [2]);
  assert.equal(disclosure.shown, 3);
});

// ---- Example file -------------------------------------------------------------------------------------------------------
test("the bundled example is a clean, synthetic table that follows the contract", () => {
  const source = readFileSync(root + "assets/tools/spectrum-example.js", "utf8");
  assert.match(source, /SYNTHETIC/);
  assert.match(source, /NOT an archive result/);
  const context = vm.createContext({});
  vm.runInContext(source + "\nthis.csv = spectrumExampleCsv;", context);
  const { columns, spectrum, table } = load(context.csv);
  assert.ok(columns.contract);
  assert.deepEqual(table.headers, ["wavelength", "flux", "flux_err", "lambda_width", "flags", "source_id", "obs_id", "mjd", "method"]);
  assert.ok(spectrum.ok);
  assert.equal(spectrum.bad.length, 0);
  assert.deepEqual(spectrum.sources.map((source) => source.key), ["SYNTHETIC-A", "SYNTHETIC-B"]);
  assert.deepEqual(spectrum.sources[0].observations.map((observation) => observation.key), ["SYN-OBS-1", "SYN-OBS-2"]);
  assert.ok(spectrum.points.every((point) => point.method === "synthetic"));
  assert.ok(spectrum.points.some((point) => point.flux < 0), "contains a negative flux");
  assert.ok(spectrum.points.some((point) => point.fluxErr === null), "contains an empty flux_err");
  assert.ok(spectrum.points.some((point) => S.decodeFlags(point.flags).unknown.length), "contains an unknown flag bit");
  const a = S.selectPoints(spectrum, { source: "SYNTHETIC-A" });
  const duplicate = a.some((point, index) => index > 0 && point.wavelength === a[index - 1].wavelength);
  assert.ok(duplicate, "two observations share a wavelength");
  const waves = a.map((point) => point.wavelength);
  assert.ok(waves.some((wavelength, index) => index > 0 && wavelength - waves[index - 1] > 0.3), "contains a wavelength gap");
});
