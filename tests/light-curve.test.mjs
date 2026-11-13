// Run with:  node --test        (or: node --test tests/light-curve.test.mjs)
//
// Covers tools/timeseries.js, the DOM-free model behind Light Curve Analysis: JD/MJD/ISO times, exact UTC/TAI/TT
// conversion and refusal of everything else, flux and AB-magnitude conversion with error propagation, CSV profiles and
// column mapping, sorting with ties, negative flux and unknown errors, filters and their hidden-row counts, series
// statistics, and the export round trip.
//   - Fixtures built in this file are synthetic and are not archive data.
//   - The "real example" section reads assets/tools/light-curve-example.js: aperture photometry measured from IRSA SPHEREx
//     QR3 deep-field cutouts of one fixed position (see the provenance string in that file).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const T = require("../tools/timeseries.js");

const near = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, (message ?? "value") + ": expected " + expected + " got " + actual);

const uJy = T.normalizeUnit("uJy", "flux");
const mJy = T.normalizeUnit("mJy", "flux");
const ab = T.normalizeUnit("AB", "magnitude");
const utcView = { scale: "UTC", barycentric: false };
const wide = { mode: "width", width: 0.1, edges: [] };
const baseView = (overrides = {}) => ({
  binning: { mode: "column", width: 0.1, edges: [] }, seriesKeys: null, plotTime: utcView, display: uJy,
  timeFrom: null, timeTo: null, quality: "all", ignoreMask: 0, ...overrides,
});

function contractData(text) {
  const table = T.readTable(text);
  const profile = T.detectProfile(table.header);
  return { table, profile, dataset: T.buildDataset(table, profile.config) };
}
const contractHeader = "source_id,obs_id,mjd,ra,dec,wavelength,lambda_width,flux,flux_err,flags,method";
const contractLine = (source, obs, mjd, wave, flux, err, flags) =>
  [source, obs, mjd, "10", "-5", wave, "0.02", flux, err, flags, "aperture"].join(",");

// ---- Time -------------------------------------------------------------------------------------------------------------
test("MJD 60000 is JD 2460000.5 in the same scale, and back", () => {
  assert.equal(T.jdFromMjd(60000), 2460000.5);
  assert.equal(T.mjdFromJd(2460000.5), 60000);
  assert.equal(T.mjdToJd, 2400000.5);
  assert.equal(T.parseTimeValue("2460000.5", "jd").mjd, 60000);
  assert.equal(T.parseTimeValue("60000", "mjd").mjd, 60000);
  near(T.parseTimeValue("2023-02-25", "iso").mjd, 60000, 0); // 2023-02-25 is MJD 60000
});

test("ISO times are exact, and wrong formats are explained", () => {
  near(T.parseTimeValue("2025-05-24T04:24:53.232", "iso").mjd, 60819 + (4 * 3600 + 24 * 60 + 53.232) / 86400, 1e-9);
  assert.equal(T.parseTimeValue("2025-05-24 04:24:53Z", "iso").ok, true);
  assert.match(T.parseTimeValue("2025-02-30", "iso").reason, /does not exist/);
  assert.match(T.parseTimeValue("2016-12-31T23:59:60", "iso").reason, /leap second/);
  assert.match(T.parseTimeValue("24/05/2025", "iso").reason, /ISO 8601/);
  assert.match(T.parseTimeValue("2460000.5", "mjd").reason, /Julian Date/);
  assert.match(T.parseTimeValue("60000", "jd").reason, /MJD/);
  assert.match(T.parseTimeValue("", "mjd").reason, /empty/);
  assert.equal(T.parseTimeValue("abc", "jd").ok, false);
  assert.equal(T.mjdToIso(60000), "2023-02-25T00:00:00.000");
});

test("leap-second table equals the IERS list; UTC, TAI and TT convert exactly", () => {
  // IERS / NTP leap-seconds.list: NTP seconds since 1900 and TAI-UTC after that date.
  const ntp = [2272060800, 2287785600, 2303683200, 2335219200, 2366755200, 2398291200, 2429913600, 2461449600, 2492985600, 2524521600,
    2571782400, 2603318400, 2634854400, 2698012800, 2776982400, 2840140800, 2871676800, 2918937600, 2950473600, 2982009600, 3029443200,
    3076704000, 3124137600, 3345062400, 3439756800, 3550089600, 3644697600, 3692217600];
  assert.deepEqual(T.leapSecondTable.map(([mjd]) => mjd), ntp.map((seconds) => seconds / 86400 + 15020));
  assert.deepEqual(T.leapSecondTable.map(([, offset]) => offset), ntp.map((_, index) => 10 + index));

  assert.equal(T.taiMinusUtc(57754).seconds, 37);              // 2017-01-01
  assert.equal(T.taiMinusUtc(57753.999).seconds, 36);          // 2016-12-31
  near(T.convertTime(60000, "UTC", "TAI").mjd, 60000 + 37 / 86400, 1e-12);
  near(T.convertTime(60000, "UTC", "TT").mjd, 60000 + (37 + 32.184) / 86400, 1e-12);
  near(T.convertTime(60000 + 37 / 86400, "TAI", "UTC").mjd, 60000, 1e-12);
  near(T.convertTime(60000 + 69.184 / 86400, "TT", "UTC").mjd, 60000, 1e-12);
  near(T.convertTime(60000, "TT", "TAI").mjd, 60000 - 32.184 / 86400, 1e-12);
  for (const mjd of [41317.25, 50000.75, 57753.5, 57754.5, 61000.123456]) {
    const there = T.convertTime(mjd, "UTC", "TT");
    near(T.convertTime(there.mjd, "TT", "UTC").mjd, mjd, 2e-10, "round trip " + mjd);
  }
  // Across the 2017 leap second TAI keeps counting: 2016-12-31 23:59:59 and 2017-01-01 00:00:00 UTC are 2 s apart in TAI.
  near((T.convertTime(57754, "UTC", "TAI").mjd - T.convertTime(57754 - 1 / 86400, "UTC", "TAI").mjd) * 86400, 2, 1e-4);
});

test("conversions that are not exact are refused, never approximated", () => {
  for (const [from, to] of [["TDB", "UTC"], ["UTC", "TDB"], ["TDB", "TT"], ["unknown", "UTC"], ["UTC", "unknown"], ["TCB", "TDB"]]) {
    const result = T.convertTime(60000, from, to);
    assert.equal(result.ok, false, from + "->" + to);
    assert.match(result.reason, /No verified conversion/);
  }
  assert.match(T.convertTime(60000, "TDB", "TT").reason, /1\.7 ms/);
  assert.equal(T.convertTime(60000, "TDB", "TDB").ok, true);
  assert.equal(T.convertTime(60000, "unknown", "unknown").mjd, 60000);
  assert.match(T.convertTime(40000, "UTC", "TAI").reason, /1972/);
  assert.match(T.convertTime(61584, "UTC", "TAI").reason, /2027-06-28/);
  // The leap second 2016-12-31 23:59:60 UTC is the TAI interval 57754 + 36/86400 .. 57754 + 37/86400.
  assert.match(T.convertTime(57754 + 36.5 / 86400, "TAI", "UTC").reason, /leap second/);
  assert.equal(T.normalizeTimeScale("utc"), "UTC");
  assert.equal(T.normalizeTimeScale(""), "unknown");
  assert.equal(T.normalizeTimeScale("bad scale!"), null);
});

test("time labels: BJD only when declared", () => {
  assert.equal(T.timeLabel("mjd", "UTC"), "MJD (UTC)");
  assert.equal(T.timeLabel("jd", "TDB", true), "BJD_TDB");
  assert.equal(T.timeLabel("jd", "TDB", false), "JD (TDB)");
  assert.equal(T.timeLabel("iso", "unknown"), "ISO 8601 (scale unknown)");
  assert.equal(T.formatTime(60000.5, "jd"), "2460001.000000");
});

// ---- Units ------------------------------------------------------------------------------------------------------------
test("flux units convert exactly and AB magnitude follows m = -2.5 log10(F / 3631 Jy)", () => {
  const jy = T.normalizeUnit("Jy", "flux");
  const njy = T.normalizeUnit("nJy", "flux");
  assert.equal(T.normalizeUnit("µJy", "flux").key, "uJy");
  assert.equal(T.normalizeUnit("MJy/sr", "flux").jansky, null);
  const a = T.convertMeasurement(2500, 50, uJy, mJy);
  near(a.value, 2.5, 1e-12);
  near(a.err, 0.05, 1e-12);
  near(T.convertMeasurement(1, 0.1, jy, njy).value, 1e9, 1e-3);

  near(T.convertMeasurement(3631e6, null, uJy, ab).value, 0, 1e-12);          // 3631 Jy is magnitude 0
  const m = T.convertMeasurement(1, 0.1, uJy, ab);                              // 1 uJy
  near(m.value, -2.5 * Math.log10(1e-6 / 3631), 1e-12);
  near(m.value, 23.9, 0.001);
  near(m.err, 1.0857362 * 0.1 / 1, 1e-6);                                       // sigma_m = 1.0857 sigma_F / F
  near(T.convertMeasurement(0.001, 0.0001, mJy, ab).err, m.err, 1e-12);        // the relative error is unit independent
  assert.equal(T.convertMeasurement(5, null, uJy, ab).err, null);

  // Back to flux: F = 3631 Jy 10^(-0.4 m), sigma_F = 0.9210 F sigma_m.
  const back = T.convertMeasurement(m.value, m.err, ab, uJy);
  near(back.value, 1, 1e-9);
  near(back.err, 0.1, 1e-9);
  near(T.convertMeasurement(20, 0.05, ab, uJy).err, 0.05 * Math.LN10 / 2.5 * T.convertMeasurement(20, null, ab, uJy).value, 1e-9);

  for (const flux of [0, -3]) {
    const bad = T.convertMeasurement(flux, 1, uJy, ab);
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "nonpositive");
  }
  assert.match(T.convertMeasurement(18, 0.1, T.normalizeUnit("Vega", "magnitude"), uJy).reason, /zero point/);
  assert.equal(T.convertMeasurement(5, 1, T.normalizeUnit("MJy/sr", "flux"), uJy).ok, false);
  assert.equal(T.convertMeasurement(5, 1, T.normalizeUnit("MJy/sr", "flux"), T.normalizeUnit("MJy/sr", "flux")).value, 5);
  assert.equal(T.convertMeasurement(null, null, uJy, ab).code, "missing");
});

// ---- CSV, profiles and records ------------------------------------------------------------------------------------------
test("CSV reader: quotes, BOM, CRLF, comments, tab and semicolon", () => {
  const table = T.readTable('﻿# comment\r\na,b,c\r\n1,"x, y",3\r\n\r\n"say ""hi""","line\nbreak",\r\n');
  assert.deepEqual(table.header, ["a", "b", "c"]);
  assert.deepEqual(table.rows, [["1", "x, y", "3"], ['say "hi"', "line\nbreak", ""]]);
  assert.deepEqual(T.readTable("a\tb\n1\t2").rows, [["1", "2"]]);
  assert.deepEqual(T.readTable("a;b\n1;2").rows, [["1", "2"]]);
  assert.throws(() => T.readTable('a,b\n1,"open'), /quoted field/);
  assert.throws(() => T.readTable(""), /no header/);
  assert.throws(() => T.readTable("onlyone\n1\n2"), /single column/);
});

test("Spectrophotometry contract: units, unsorted times, ties, negative flux, unknown error, missing value", () => {
  const text = [
    contractHeader,
    contractLine("A", "obs-c", "60003.5", "1.05", "30", "3", "0"),
    contractLine("A", "obs-a", "60001", "1.05", "10", "1", "0"),
    contractLine("A", "obs-b", "60002", "1.04", "-4", "2", "0"),        // negative flux
    contractLine("A", "obs-d", "60002", "1.06", "20", "", "4"),         // same time as obs-b, unknown error, flagged
    contractLine("A", "obs-e", "60004", "1.05", "", "1", "0"),          // no measurement
    contractLine("A", "obs-f", "60005", "1.05", "0", "1", ""),          // zero flux, no flag value
    contractLine("B", "obs-g", "60001.5", "2.5", "7", "0.7", "0"),
  ].join("\r\n");
  const { profile, dataset } = contractData(text);
  assert.equal(profile.profile, "spectrophotometry");
  assert.equal(profile.config.timeScale, "UTC");
  assert.equal(profile.config.unit, "uJy");
  assert.equal(dataset.records.length, 7);
  assert.deepEqual(dataset.rejected, []);
  const byObs = Object.fromEntries(dataset.records.map((record) => [record.obsId, record]));
  assert.equal(byObs["obs-a"].id, 2);                                   // original row numbers are kept
  assert.equal(byObs["obs-d"].err, null);
  assert.equal(byObs["obs-d"].errState, "unknown");
  assert.equal(byObs["obs-e"].value, null);
  assert.equal(byObs["obs-b"].value, -4);
  assert.equal(byObs["obs-f"].flags, null);

  const view = T.computeView(dataset.records, baseView({ binning: wide }));
  const a = view.series.find((series) => series.sourceId === "A" && series.band.label === "1–1.1 µm");
  assert.ok(a, "series A, 1.0-1.1 um");
  // Time order with the tie kept in row order: obs-a (row 2), obs-b (row 3), obs-d (row 4), obs-c, obs-e, obs-f.
  assert.deepEqual(a.rows.map((row) => row.record.obsId), ["obs-a", "obs-b", "obs-d", "obs-c", "obs-e", "obs-f"]);
  assert.deepEqual(a.rows.map((row) => row.record.id), [2, 3, 4, 1, 5, 6]);
  assert.equal(view.rows.length, 7);
  // Gaps: the model creates no point where there is no measurement.
  assert.equal(view.plottable.length, 6);
  assert.equal(view.plottable.some((row) => row.record.obsId === "obs-e"), false);
  // Zero and negative flux are plotted as flux; unknown error stays unknown.
  assert.equal(view.plottable.find((row) => row.record.obsId === "obs-b").y, -4);
  assert.equal(view.plottable.find((row) => row.record.obsId === "obs-d").yErr, null);
  assert.deepEqual(T.rowStatus(a.rows[1], uJy), ["Negative flux"]);
  assert.deepEqual(T.rowStatus(a.rows[2], uJy), ["Uncertainty unknown", "Flagged"]);
  assert.deepEqual(T.rowStatus(a.rows[4], uJy), ["No measurement"]);
  assert.deepEqual(T.rowStatus(a.rows[5], uJy), ["Zero flux", "Flags unavailable"]);
  // In magnitudes, flux <= 0 stays in the table but not in the plot.
  const mag = T.computeView(dataset.records, baseView({ binning: wide, display: ab }));
  assert.equal(mag.rows.length, 7);
  assert.equal(mag.plottable.length, 4);
  assert.match(T.rowStatus(mag.rows.find((row) => row.record.obsId === "obs-b"), ab)[0], /flux ≤ 0 has no magnitude/);
});

test("rows that cannot be read are rejected with a reason, never dropped silently", () => {
  const text = [
    contractHeader,
    contractLine("A", "ok", "60001", "1", "5", "1", "0"),
    contractLine("A", "badtime", "notatime", "1", "5", "1", "0"),
    contractLine("A", "jdlike", "2460001.5", "1", "5", "1", "0"),
    "A,short,60002",
    contractLine("A", "badflux", "60003", "1", "abc", "1", "0"),
    contractLine("A", "negerr", "60004", "1", "5", "-1", "0"),
  ].join("\n");
  const { dataset } = contractData(text);
  assert.deepEqual(dataset.records.map((record) => record.obsId), ["ok", "badflux", "negerr"]);
  assert.equal(dataset.rejected.length, 3);
  assert.match(dataset.rejected[0].reason, /not a number/);
  assert.match(dataset.rejected[1].reason, /Julian Date/);
  assert.match(dataset.rejected[2].reason, /3 fields instead of 11/);
  assert.equal(dataset.records[1].value, null);
  assert.match(dataset.records[1].issues[0], /not a number/);
  assert.equal(dataset.records[2].err, null);
  assert.equal(dataset.records[2].errState, "invalid");
});

test("generic file: mapped columns, ISO times, magnitudes, band column", () => {
  const text = "date,filter,mag,mag_err,star\n2025-01-02T00:00:00,V,12.5,0.02,S1\n2025-01-01T12:00:00,V,12.6,,S1\n2025-01-03T00:00:00,R,12.0,0.01,S1\n";
  const table = T.readTable(text);
  const detected = T.detectProfile(table.header);
  assert.equal(detected.profile, "generic");
  assert.equal(detected.config.columns.time, "date");
  assert.equal(detected.config.columns.value, "mag");
  assert.equal(detected.config.columns.band, "filter");
  assert.equal(detected.config.columns.error, "mag_err");
  assert.equal(detected.config.timeScale, "unknown");   // nothing is assumed about the scale
  assert.equal(detected.config.kind, "magnitude");
  assert.throws(() => T.buildDataset(table, { ...detected.config, columns: { ...detected.config.columns, time: "" } }), /time column/);
  const dataset = T.buildDataset(table, { ...detected.config, timeScale: "UTC", unit: "Vega" });
  assert.equal(dataset.records.length, 3);
  const view = T.computeView(dataset.records, baseView({ display: dataset.records[0].unit }));
  assert.deepEqual(view.series.map((series) => series.band.label), ["R", "V"]);
  const v = view.series.find((series) => series.band.label === "V");
  assert.deepEqual(v.rows.map((row) => row.y), [12.6, 12.5]);          // sorted by time
  near(v.stats.mean, 12.55, 1e-12);
  // Vega magnitudes cannot be shown as flux.
  const asFlux = T.computeView(dataset.records, baseView({ display: uJy }));
  assert.equal(asFlux.plottable.length, 0);
  assert.match(asFlux.rows[0].valueIssue, /zero point/);
  const bjd = T.detectProfile(["bjd", "flux"]);
  assert.match(bjd.config.hint, /barycentric/);
  assert.equal(bjd.config.barycentric, false);
});

// ---- Time scales across rows ---------------------------------------------------------------------------------------------
test("different time scales are converted when verified and refused otherwise", () => {
  const text = "time,scale,flux,band\n" +
    "60000,UTC,1,x\n" +
    `${60000 + 37 / 86400 + 5 / 86400},TAI,2,x\n` +        // 5 s after the first, in TAI
    `${60000 + 69.184 / 86400 + 10 / 86400},TT,3,x\n` +    // 10 s after the first, in TT
    "60000.5,TDB,4,x\n" +
    "60001,unknown,5,x\n";
  const table = T.readTable(text);
  const config = { ...T.detectProfile(table.header).config, timeFormat: "mjd", timeScale: "UTC", unit: "uJy", kind: "flux" };
  config.columns = { ...config.columns, time: "time", value: "flux", band: "band", timeScale: "scale" };
  const dataset = T.buildDataset(table, config);
  assert.deepEqual(dataset.records.map((record) => record.scale), ["UTC", "TAI", "TT", "TDB", "unknown"]);
  assert.equal(T.suggestPlotTime(dataset.records).mixed, true);

  const view = T.computeView(dataset.records, baseView());
  assert.equal(view.rows.length, 3);                       // UTC, TAI, TT
  assert.equal(view.hidden.noTime, 2);                     // TDB and unknown cannot be put on UTC
  assert.match(view.firstTimeIssue, /TDB and UTC/);
  const seconds = view.rows.map((row) => (row.t - 60000) * 86400);
  near(seconds[0], 0, 1e-6);
  near(seconds[1], 5, 1e-4);
  near(seconds[2], 10, 1e-4);

  // On the TT scale the same rows are 69.184 s later.
  const tt = T.computeView(dataset.records, baseView({ plotTime: { scale: "TT", barycentric: false } }));
  near((tt.rows[0].t - 60000) * 86400, 69.184, 1e-4);
  assert.equal(tt.hidden.noTime, 2);
  // On TDB only the TDB row can be shown.
  const tdb = T.computeView(dataset.records, baseView({ plotTime: { scale: "TDB", barycentric: false } }));
  assert.deepEqual(tdb.rows.map((row) => row.record.scale), ["TDB"]);
  // Barycentric and topocentric times are never compared.
  const bary = T.computeView(dataset.records, baseView({ plotTime: { scale: "UTC", barycentric: true } }));
  assert.equal(bary.rows.length, 0);
  assert.match(bary.firstTimeIssue, /barycentric/);
});

test("a barycentric file is labeled BJD only when it declares the correction", () => {
  const table = T.readTable("bjd,flux\n2460000.5,1\n2460001.5,2\n");
  const config = { ...T.detectProfile(table.header).config, timeScale: "TDB", barycentric: true };
  const dataset = T.buildDataset(table, config);
  assert.equal(dataset.records[0].barycentric, true);
  assert.equal(T.suggestPlotTime(dataset.records).barycentric, true);
  assert.equal(T.timeLabel("jd", "TDB", true), "BJD_TDB");
  const plain = T.buildDataset(table, { ...config, barycentric: false });
  assert.equal(plain.records[0].barycentric, false);
});

// ---- Filters and counts --------------------------------------------------------------------------------------------------
function filterFixture() {
  const lines = [contractHeader];
  for (let index = 0; index < 10; index++) {
    // Source A, band 1.0-1.1: flags nonzero on rows 3 and 7; row 9 has no flag value.
    const flags = index === 3 || index === 7 ? "8" : index === 9 ? "" : "0";
    lines.push(contractLine("A", "a" + index, String(60000 + index), "1.05", String(100 + index), "1", flags));
  }
  lines.push(contractLine("A", "w0", "60002", "2.05", "50", "1", "0"), contractLine("A", "w1", "60006", "2.05", "51", "1", "2"));
  lines.push(contractLine("B", "b0", "60001", "1.05", "5", "1", "0"));
  return contractData(lines.join("\n")).dataset.records;
}

test("filters: series, time range and quality each report the rows they hide", () => {
  const records = filterFixture();
  const all = T.computeView(records, baseView({ binning: wide }));
  assert.equal(all.series.length, 3);
  assert.equal(all.counts.total, 13);
  assert.equal(all.rows.length, 13);
  assert.deepEqual(all.hidden, { notSelected: 0, noTime: 0, timeRange: 0, flagged: 0, noFlagInfo: 0 });

  const key = T.seriesKey("A", "1–1.1 µm");
  const one = T.computeView(records, baseView({ binning: wide, seriesKeys: new Set([key]) }));
  assert.equal(one.rows.length, 10);
  assert.equal(one.hidden.notSelected, 3);

  const ranged = T.computeView(records, baseView({ binning: wide, seriesKeys: new Set([key]), timeFrom: 60002, timeTo: 60005 }));
  assert.deepEqual(ranged.rows.map((row) => row.record.obsId), ["a2", "a3", "a4", "a5"]);   // both ends inclusive
  assert.equal(ranged.hidden.timeRange, 6);

  const good = T.computeView(records, baseView({ binning: wide, seriesKeys: new Set([key]), quality: "unflagged" }));
  assert.equal(good.hidden.flagged, 2);
  assert.equal(good.hidden.noFlagInfo, 1);
  assert.equal(good.rows.length, 7);

  const ignoring = T.computeView(records, baseView({ binning: wide, seriesKeys: new Set([key]), quality: "unflagged", ignoreMask: 8 }));
  assert.equal(ignoring.hidden.flagged, 0);
  assert.equal(ignoring.rows.length, 9);

  // Counts are taken over the rows the earlier filters left: a3 is outside the range, so it is not counted as flagged.
  const both = T.computeView(records, baseView({ binning: wide, seriesKeys: new Set([key]), quality: "unflagged", timeFrom: 60004 }));
  assert.equal(both.hidden.timeRange, 4);
  assert.equal(both.hidden.flagged, 1);                    // a7 only
  assert.equal(both.hidden.noFlagInfo, 1);
  assert.equal(both.rows.length, 4);
  // The table rows and the plotted rows are the same rows.
  assert.deepEqual(both.plottable.map((row) => row.record.id), both.rows.map((row) => row.record.id));

  const none = T.computeView(records, baseView({ binning: wide, timeFrom: 70000 }));
  assert.equal(none.rows.length, 0);
  assert.equal(none.hidden.timeRange, 13);
  const reversed = T.computeView(records, baseView({ binning: wide, timeFrom: 60005, timeTo: 60001 }));
  assert.equal(reversed.rows.length, 0);
});

test("wavelength bins: fixed width, custom edges, none", () => {
  const records = filterFixture();
  const edges = T.parseEdges("0.5, 1.5, 3");
  assert.deepEqual(edges.edges, [0.5, 1.5, 3]);
  assert.equal(T.parseEdges("1").ok, false);
  assert.equal(T.parseEdges("a, b").ok, false);
  const view = T.computeView(records, baseView({ binning: { mode: "edges", width: 0.1, edges: edges.edges } }));
  assert.deepEqual(view.series.map((series) => series.sourceId + ":" + series.band.label + ":" + series.total), ["A:0.5–1.5 µm:10", "A:1.5–3 µm:2", "B:0.5–1.5 µm:1"]);
  assert.equal(T.bandOf({ wavelength: 9 }, { mode: "edges", edges: [1, 2] }).defined, false);
  assert.equal(T.bandOf({ wavelength: 0.3 }, { mode: "width", width: 0.1 }).label, "0.3–0.4 µm");   // 0.3 / 0.1 is 2.9999 in floats
  assert.equal(T.bandOf({ wavelength: null }, { mode: "width", width: 0.1 }).label, "(no wavelength)");
});

// ---- Statistics --------------------------------------------------------------------------------------------------------------
test("series statistics: valid points, first/last time, mean and median only for one band and one unit", () => {
  const records = filterFixture();
  const key = T.seriesKey("A", "1–1.1 µm");
  const view = T.computeView(records, baseView({ binning: wide }));
  const a = view.series.find((series) => series.key === key).stats;
  assert.equal(a.rows, 10);
  assert.equal(a.valid, 10);
  assert.equal(a.first, 60000);
  assert.equal(a.last, 60009);
  near(a.mean, 104.5, 1e-12);
  near(a.median, 104.5, 1e-12);

  // Unbinned: no defined band, so no mean or median.
  const unbinned = T.computeView(records, baseView({ binning: { mode: "none" } }));
  const sourceA = unbinned.series.find((series) => series.sourceId === "A");
  assert.equal(sourceA.stats.mean, null);
  assert.match(sourceA.stats.summaryNote, /defined band/);
  assert.equal(sourceA.stats.valid, 12);

  // Same band, two original units: refused although the conversion would be exact.
  const table = T.readTable("t,f,u,band\n60000,1000,uJy,x\n60001,2,mJy,x\n60002,3000,uJy,x\n");
  const config = { ...T.detectProfile(table.header).config, timeFormat: "mjd", timeScale: "UTC" };
  config.columns = { ...config.columns, time: "t", value: "f", unit: "u", band: "band" };
  const dataset = T.buildDataset(table, config);
  const view2 = T.computeView(dataset.records, baseView({ display: uJy }));
  assert.equal(view2.series.length, 1);
  assert.equal(view2.series[0].stats.mean, null);
  assert.match(view2.series[0].stats.summaryNote, /different original units/);
  assert.equal(view2.series[0].stats.valid, 3);
  assert.deepEqual(view2.rows.map((row) => row.y), [1000, 2000, 3000]);   // plotted after exact conversion

  assert.equal(T.seriesStats({ rows: [], band: { defined: true } }, uJy).summaryNote, "No valid points.");
});

test("magnitude display: mean magnitude, nonpositive rows are counted as lost", () => {
  const { dataset } = contractData([
    contractHeader,
    contractLine("A", "m1", "60001", "1.05", "100", "10", "0"),
    contractLine("A", "m2", "60002", "1.05", "-5", "10", "0"),
    contractLine("A", "m3", "60003", "1.05", "400", "10", "0"),
  ].join("\n"));
  const view = T.computeView(dataset.records, baseView({ binning: wide, display: ab }));
  const series = view.series[0];
  assert.equal(series.stats.valid, 2);
  const m1 = -2.5 * Math.log10(100e-6 / 3631);
  const m3 = -2.5 * Math.log10(400e-6 / 3631);
  near(series.stats.mean, (m1 + m3) / 2, 1e-12);
  assert.match(series.stats.summaryNote, /1 value cannot be shown in AB mag/);
  near(view.plottable[0].yErr, 1.0857362 * 10 / 100, 1e-6);
  near(view.plottable[1].yErr, 1.0857362 * 10 / 400, 1e-6);
  assert.ok(m3 < m1);                                      // brighter (400 uJy) means the smaller magnitude
  const extent = T.valueExtent(view.plottable, ab);
  assert.ok(extent.low < m3 && extent.high > m1);
});

// ---- Axes --------------------------------------------------------------------------------------------------------------------
test("axis helpers: nice ticks and number formatting", () => {
  assert.deepEqual(T.niceTicks(0, 10, 5), [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(T.niceTicks(60000, 60010, 5), [60000, 60002, 60004, 60006, 60008, 60010]);
  assert.deepEqual(T.niceTicks(3, 3), [3]);
  assert.equal(T.formatNumber(0.00001234, 4), "1.234e-5");
  assert.equal(T.formatNumber(123456, 6), "123456");
  assert.equal(T.formatNumber(1.5, 6), "1.5");
});

// ---- Export round trip ------------------------------------------------------------------------------------------------------------
test("export keeps obs IDs, row ids, time scale, reference, units and flags, and re-imports identically", () => {
  const text = [
    "time,ref,obs,flux,err,flag,src",
    "2025-05-24T04:24:53.232,geo,\"obs,1\",10.5,0.5,0,S1",
    "2025-05-24T04:24:53.232,geo,obs2,-3,,4,S1",
    "2025-05-25T00:00:00,geo,obs3,,,0,S1",
  ].join("\n");
  const table = T.readTable(text);
  const config = { ...T.detectProfile(table.header).config, timeFormat: "iso", timeScale: "UTC", kind: "flux", unit: "mJy" };
  config.columns = { ...config.columns, time: "time", value: "flux", error: "err", obsId: "obs", flags: "flag", source: "src", band: "" };
  const original = T.buildDataset(table, config);
  const display = T.normalizeUnit("mJy", "flux");
  const view = T.computeView(original.records, baseView({ binning: { mode: "none" }, display }));
  const subset = view.rows.filter((row) => row.record.obsId !== "obs3");
  const csv = T.exportCsv(subset, { mode: "none" });
  assert.ok(csv.startsWith(T.exportColumns.join(",") + "\r\n"));
  assert.match(csv, /"obs,1"/);
  assert.match(csv, /,UTC,geocentric or topocentric,flux,10\.5,0\.5,mJy,0,/);

  const again = contractData(csv);
  assert.equal(again.profile.profile, "export");
  assert.equal(again.dataset.records.length, 2);
  again.dataset.records.forEach((back, index) => {
    const first = original.records[index];
    assert.equal(back.id, first.id);
    assert.equal(back.obsId, first.obsId);
    assert.equal(back.sourceId, first.sourceId);
    assert.equal(back.mjd, first.mjd);                    // exact, not rounded
    assert.equal(back.scale, first.scale);
    assert.equal(back.barycentric, first.barycentric);
    assert.equal(back.kind, first.kind);
    assert.equal(back.unit.key, "mJy");
    assert.equal(back.value, first.value);
    assert.equal(back.err, first.err);
    assert.equal(back.flags, first.flags);
    assert.equal(back.timeText, first.timeText);
  });
  assert.equal(again.dataset.records[1].err, null);        // an unknown error stays unknown
  // Exporting the re-import gives the same bytes (the band label travels in the band column).
  const view2 = T.computeView(again.dataset.records, baseView({ binning: { mode: "column", width: 0.1, edges: [] }, display }));
  const second = T.exportCsv(view2.rows, { mode: "column" });
  assert.equal(second.replaceAll("all wavelengths (not binned)", "B"), csv.replaceAll("all wavelengths (not binned)", "B"));
});

test("export of a filtered selection holds exactly the shown rows, in original scale and unit", () => {
  const table = T.readTable("time,scale,flux\n60000,TAI,1\n60001,TT,2\n60002,UTC,3\n");
  const config = { ...T.detectProfile(table.header).config, timeFormat: "mjd", timeScale: "UTC", unit: "uJy" };
  config.columns = { ...config.columns, time: "time", value: "flux", timeScale: "scale", band: "" };
  const dataset = T.buildDataset(table, config);
  const view = T.computeView(dataset.records, baseView({ binning: { mode: "none" }, display: mJy, timeFrom: 60000.5 }));
  const reread = contractData(T.exportCsv(view.rows, { mode: "none" })).dataset.records;
  assert.deepEqual(reread.map((record) => [record.id, record.scale, record.unit.key, record.value]), [[2, "TT", "uJy", 2], [3, "UTC", "uJy", 3]]);
  near(view.rows[0].y, 0.002, 1e-15);                      // the display unit (mJy) did not leak into the export
});

// ---- Real example -------------------------------------------------------------------------------------------------------------------
const example = vm.runInContext(readFileSync(join(root, "assets/tools/light-curve-example.js"), "utf8") + "\nlightCurveExample;", vm.createContext({}));

test("real example: SPHEREx QR3 deep-field series reads in the contract format and matches its raw rows", () => {
  assert.match(example.provenance, /spherex_qr3_deep/);
  assert.match(example.provenance, /not an official IRSA/);
  const rawLines = example.csv.trim().split("\n");
  assert.equal(rawLines[0], contractHeader);
  const { profile, dataset } = contractData(example.csv);
  assert.equal(profile.profile, "spectrophotometry");
  assert.equal(dataset.records.length, rawLines.length - 1);
  assert.deepEqual(dataset.rejected, []);
  assert.ok(dataset.records.length >= 100);

  const view = T.computeView(dataset.records, baseView({ binning: { mode: "width", width: example.binningWidth, edges: [] } }));
  // A band with at least five unflagged real measurements, compared with the original lines of the file.
  const series = view.series.find((entry) => entry.good >= 5 && entry.band.defined);
  assert.ok(series, "a band with five or more unflagged measurements");
  const rows = series.rows.filter((row) => row.record.flags === 0);
  assert.ok(rows.length >= 3);
  for (const row of rows.slice(0, 3)) {
    const raw = rawLines[row.record.id].split(",");           // row id is the data row number, the header is line 0
    assert.equal(raw[1], row.record.obsId);
    assert.equal(Number(raw[2]), row.record.mjd);
    assert.equal(Number(raw[7]), row.record.value);
    assert.equal(Number(raw[8]), row.record.err);
    assert.equal(Number(raw[5]), row.record.wavelength);
    assert.equal(row.y, row.record.value);                    // µJy shown as µJy
    assert.equal(row.t, row.record.mjd);
  }
  // Real data have flagged rows, ties (two detectors of one exposure share a time) and a measurement gap.
  assert.ok(dataset.records.some((record) => record.flags > 0));
  assert.ok(dataset.records.some((record) => record.value === null));
  const times = new Map();
  for (const record of dataset.records) times.set(record.mjd, (times.get(record.mjd) ?? 0) + 1);
  assert.ok([...times.values()].some((count) => count >= 2));
  const good = T.computeView(dataset.records, baseView({ binning: { mode: "none" }, quality: "unflagged" }));
  assert.equal(good.hidden.flagged + good.rows.length + good.hidden.noFlagInfo, dataset.records.length);
  assert.ok(good.hidden.flagged > 0);
});
