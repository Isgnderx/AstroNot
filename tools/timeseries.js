// Time-series model for Light Curve Analysis.
//
// UI-independent: no DOM access. Loads as a classic browser script (global `AstroNotTimeSeries`) and as a CommonJS module.
//
// WHAT IT DECIDES
//   - How a CSV becomes observation records: the shared Spectrophotometry CSV contract, an AstroNot export, or a generic
//     file whose columns the user maps. Every record keeps its original row number ("row id"), observation ID, time,
//     time scale, measurement kind and unit exactly as read.
//   - Time: ISO 8601, JD and MJD are read; JD = MJD + 2400000.5 inside one time scale. UTC, TAI and TT are converted
//     exactly (see "Time scales"). Every other pair of scales is refused, never approximated.
//   - Measurements: flux densities in Jy, mJy, uJy, nJy convert exactly. Flux density <-> AB magnitude uses
//     m = -2.5 log10(F / 3631 Jy) and sigma_m = (2.5 / ln 10) sigma_F / F. Vega and other magnitudes are never converted.
//   - Series = (source, band). A band is a file-supplied label, a wavelength bin, or undefined. Mean and median are given
//     only when the band is defined and every value has the same original unit.
//   - Filters (series, time range, quality) and the counts of rows each one hides; sorted rows (ties kept in row order).
//
// TIME SCALES
//   TAI = UTC + (TAI-UTC) with the integer leap-second table from the IERS / NTP leap-seconds.list (valid from 1972-01-01;
//   verified to the file's own expiry, 2027-06-28), and TT = TAI + 32.184 s. A UTC time is written as a Modified Julian Date
//   in the plain archive convention MJD = day number + seconds-of-day / 86400 (23:59:60 is not representable and is refused).
//   UTC before 1972 (a different definition), UTC after the table's expiry, and a TAI/TT instant inside a leap second are
//   refused. TDB differs from TT by periodic terms of about 1.7 ms that depend on the observer, so TDB is only compared with
//   TDB. "unknown" is only compared with "unknown". A time that is barycentric (BJD) is only compared with another one.
(function (root) {
  "use strict";

  const mjdToJd = 2400000.5;
  const secondsPerDay = 86400;
  const ttMinusTai = 32.184;
  const abZeroJansky = 3631;
  const magnitudePerFluxRatio = 2.5 / Math.LN10; // sigma_m = 1.0857... * sigma_F / F
  const maxRows = 200000;

  // IERS / NTP leap-seconds.list, https://hpiers.obspm.fr/iers/bul/bulc/ntp/leap-seconds.list (list expires 2027-06-28).
  // Each entry: MJD (UTC) on which the offset TAI-UTC takes effect, and the offset in seconds.
  const leapSecondTable = [
    [41317, 10], [41499, 11], [41683, 12], [42048, 13], [42413, 14], [42778, 15], [43144, 16], [43509, 17],
    [43874, 18], [44239, 19], [44786, 20], [45151, 21], [45516, 22], [46247, 23], [47161, 24], [47892, 25],
    [48257, 26], [48804, 27], [49169, 28], [49534, 29], [50083, 30], [50630, 31], [51179, 32], [53736, 33],
    [54832, 34], [56109, 35], [57204, 36], [57754, 37],
  ];
  const leapSecondTableExpiresMjd = 61584; // 2027-06-28

  const timeScaleNames = ["UTC", "TAI", "TT", "TDB", "unknown"];
  const exactScales = new Set(["UTC", "TAI", "TT"]);

  const fluxUnits = [
    { key: "Jy", label: "Jy", jansky: 1, exponent: 0 },
    { key: "mJy", label: "mJy", jansky: 1e-3, exponent: -3 },
    { key: "uJy", label: "µJy", jansky: 1e-6, exponent: -6 },
    { key: "nJy", label: "nJy", jansky: 1e-9, exponent: -9 },
  ];
  const magnitudeUnits = [
    { key: "AB", label: "AB mag" },
    { key: "Vega", label: "Vega mag" },
  ];

  function isNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  // ---- Time ----------------------------------------------------------------------------------------------------------
  function normalizeTimeScale(text) {
    const name = String(text ?? "").trim().toUpperCase();
    if (name === "" || name === "UNKNOWN" || name === "?" || name === "NONE") return "unknown";
    return /^[A-Z][A-Z0-9_]{0,7}$/.test(name) ? name : null;
  }

  function taiMinusUtc(mjdUtc) {
    if (!isNumber(mjdUtc)) return { ok: false, reason: "The time is not a number." };
    if (mjdUtc < leapSecondTable[0][0]) {
      return { ok: false, reason: "UTC before 1972-01-01 used a different definition, so no exact conversion is applied." };
    }
    if (mjdUtc >= leapSecondTableExpiresMjd) {
      return { ok: false, reason: "The leap-second table was verified only to 2027-06-28; later UTC times cannot be converted exactly." };
    }
    let seconds = leapSecondTable[0][1];
    for (const [start, offset] of leapSecondTable) if (mjdUtc >= start) seconds = offset;
    return { ok: true, seconds };
  }

  function utcToTai(mjdUtc) {
    const offset = taiMinusUtc(mjdUtc);
    return offset.ok ? { ok: true, mjd: mjdUtc + offset.seconds / secondsPerDay } : offset;
  }

  function taiToUtc(mjdTai) {
    if (!isNumber(mjdTai)) return { ok: false, reason: "The time is not a number." };
    if (mjdTai >= leapSecondTableExpiresMjd + 37 / secondsPerDay) {
      return { ok: false, reason: "The leap-second table was verified only to 2027-06-28; later times cannot be converted exactly." };
    }
    for (let index = leapSecondTable.length - 1; index >= 0; index--) {
      const [start, offset] = leapSecondTable[index];
      if (mjdTai >= start + offset / secondsPerDay) return { ok: true, mjd: mjdTai - offset / secondsPerDay };
      if (index > 0 && mjdTai >= start + leapSecondTable[index - 1][1] / secondsPerDay) {
        return { ok: false, reason: "This instant falls inside a leap second (23:59:60 UTC), which has no plain MJD." };
      }
    }
    return { ok: false, reason: "TAI before 1972-01-01 cannot be converted to UTC exactly." };
  }

  // Convert a Modified Julian Date between time scales. Returns { ok: true, mjd } or { ok: false, reason }.
  function convertTime(mjd, from, to) {
    if (!isNumber(mjd)) return { ok: false, reason: "The time is not a number." };
    if (from === to) return { ok: true, mjd };
    if (!exactScales.has(from) || !exactScales.has(to)) {
      const detail = from === "TDB" || to === "TDB"
        ? " TDB differs from TT by periodic terms of about 1.7 ms that depend on the observer's position."
        : "";
      return { ok: false, reason: "No verified conversion between " + from + " and " + to + "." + detail };
    }
    let tai;
    if (from === "UTC") {
      const result = utcToTai(mjd);
      if (!result.ok) return result;
      tai = result.mjd;
    } else {
      tai = from === "TAI" ? mjd : mjd - ttMinusTai / secondsPerDay;
    }
    if (to === "TAI") return { ok: true, mjd: tai };
    if (to === "TT") return { ok: true, mjd: tai + ttMinusTai / secondsPerDay };
    return taiToUtc(tai);
  }

  function mjdFromJd(jd) {
    return jd - mjdToJd;
  }
  function jdFromMjd(mjd) {
    return mjd + mjdToJd;
  }

  const isoPattern = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?\s*(Z|UTC)?$/;

  function parseIsoTime(text) {
    const match = isoPattern.exec(String(text).trim());
    if (!match) return { ok: false, reason: "not an ISO 8601 date such as 2025-05-24T04:24:53.232" };
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const hour = match[4] === undefined ? 0 : Number(match[4]);
    const minute = match[5] === undefined ? 0 : Number(match[5]);
    const second = match[6] === undefined ? 0 : Number(match[6]);
    const fraction = match[7] === undefined ? 0 : Number(match[7]);
    if (year < 1800) return { ok: false, reason: "the year is before 1800" };
    const stamp = Date.UTC(year, month - 1, day);
    const date = new Date(stamp);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      return { ok: false, reason: "the calendar date does not exist" };
    }
    if (hour > 23 || minute > 59) return { ok: false, reason: "the clock time is out of range" };
    if (second > 59) return { ok: false, reason: second === 60 ? "a leap second (23:59:60) has no plain MJD" : "the seconds are out of range" };
    const seconds = hour * 3600 + minute * 60 + second + fraction;
    return { ok: true, mjd: stamp / (secondsPerDay * 1000) + 40587 + seconds / secondsPerDay };
  }

  function parseNumber(text) {
    const source = String(text ?? "").trim();
    if (source === "") return { state: "empty" };
    if (/^(nan|null|none|na|n\/a|--|-|\?)$/i.test(source)) return { state: "missing" };
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eEdD][+-]?\d+)?$/.test(source)) return { state: "invalid" };
    const value = Number(source.replace(/[dD]/, "e"));
    return Number.isFinite(value) ? { state: "ok", value } : { state: "invalid" };
  }

  // format is "iso", "jd" or "mjd". Returns { ok: true, mjd } or { ok: false, reason }. The scale is not interpreted here.
  function parseTimeValue(text, format) {
    if (format === "iso") return parseIsoTime(text);
    const parsed = parseNumber(text);
    if (parsed.state !== "ok") return { ok: false, reason: parsed.state === "empty" ? "the time is empty" : "the time is not a number" };
    const value = parsed.value;
    if (format === "mjd") {
      if (Math.abs(value) > 1e6) return { ok: false, reason: "this looks like a Julian Date, not an MJD; choose JD" };
      return { ok: true, mjd: value };
    }
    if (format === "jd") {
      if (value < 1e6) return { ok: false, reason: "this looks like an MJD, not a Julian Date; choose MJD" };
      if (value > 1e7) return { ok: false, reason: "the Julian Date is out of range" };
      return { ok: true, mjd: mjdFromJd(value) };
    }
    return { ok: false, reason: "unknown time format " + format };
  }

  function mjdToIso(mjd) {
    if (!isNumber(mjd)) return "";
    const date = new Date(Math.round((mjd - 40587) * secondsPerDay * 1000));
    return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 23);
  }

  function trimZeros(text) {
    return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
  }

  // The label of a time axis or column: format, scale and whether it is barycentric.
  function timeLabel(format, scale, barycentric = false) {
    const suffix = scale === "unknown" ? "scale unknown" : scale;
    if (barycentric) {
      if (format === "jd") return "BJD_" + scale;
      if (format === "mjd") return "BJD_" + scale + " − 2400000.5";
      return "ISO 8601, barycentric " + suffix;
    }
    if (format === "jd") return "JD (" + suffix + ")";
    if (format === "mjd") return "MJD (" + suffix + ")";
    return "ISO 8601 (" + suffix + ")";
  }

  function formatTime(mjd, format, span = Infinity) {
    if (!isNumber(mjd)) return "";
    if (format === "jd") return jdFromMjd(mjd).toFixed(6);
    if (format === "mjd") return mjd.toFixed(6);
    const iso = mjdToIso(mjd);
    if (span >= 2) return iso.slice(0, 10);
    return span >= 1 / 24 ? iso.slice(0, 16).replace("T", " ") : iso.replace("T", " ");
  }

  // ---- Units and conversions -----------------------------------------------------------------------------------------
  // Returns { kind, key, label, jansky?, system? }. Units that are not recognised keep their text and never convert.
  function normalizeUnit(text, kind) {
    const source = String(text ?? "").trim();
    if (kind === "magnitude") {
      const lower = source.toLowerCase().replace(/\s+/g, "");
      if (lower === "ab" || lower === "abmag" || lower === "mag_ab" || lower === "abmagnitude") return { kind, key: "AB", label: "AB mag", system: "AB" };
      if (lower === "vega" || lower === "vegamag") return { kind, key: "Vega", label: "Vega mag", system: "Vega" };
      return { kind, key: source || "mag", label: source || "mag", system: null };
    }
    const flat = source.replace(/\s+/g, "");
    const microSigns = /^[uµμ]jy$/i;
    if (flat === "Jy" || /^jansky(s)?$/i.test(flat) || flat === "jy") return { kind, ...fluxUnits[0] };
    if (flat === "mJy" || /^millijansky(s)?$/i.test(flat)) return { kind, ...fluxUnits[1] };
    if (microSigns.test(flat) || /^microjansky(s)?$/i.test(flat)) return { kind, ...fluxUnits[2] };
    if (/^nJy$/i.test(flat) || /^nanojansky(s)?$/i.test(flat)) return { kind, ...fluxUnits[3] };
    return { kind, key: source || "unspecified", label: source || "unspecified", jansky: null };
  }

  function isFluxDensity(unit) {
    return unit.kind === "flux" && isNumber(unit.jansky);
  }

  function sameUnit(a, b) {
    return a.kind === b.kind && a.key === b.key;
  }

  // Convert a value and its 1-sigma error between units. err may be null. Returns { ok, value, err } or { ok: false, reason, code }.
  function convertMeasurement(value, err, from, to) {
    if (!isNumber(value)) return { ok: false, code: "missing", reason: "no measurement" };
    if (sameUnit(from, to)) return { ok: true, value, err };
    if (isFluxDensity(from) && isFluxDensity(to)) {
      // The prefixes are powers of ten, so scale by an integer power of ten and avoid a rounded ratio such as 1e-3 / 1e-6.
      const power = from.exponent - to.exponent;
      const scale = (number) => (power >= 0 ? number * Math.pow(10, power) : number / Math.pow(10, -power));
      return { ok: true, value: scale(value), err: err === null ? null : scale(err) };
    }
    if (isFluxDensity(from) && to.kind === "magnitude" && to.system === "AB") {
      const jansky = value * from.jansky;
      if (!(jansky > 0)) return { ok: false, code: "nonpositive", reason: "flux ≤ 0 has no magnitude" };
      const magnitude = -2.5 * Math.log10(jansky / abZeroJansky);
      return { ok: true, value: magnitude, err: err === null ? null : magnitudePerFluxRatio * err / value };
    }
    if (from.kind === "magnitude" && from.system === "AB" && isFluxDensity(to)) {
      const jansky = abZeroJansky * Math.pow(10, -0.4 * value);
      const converted = jansky / to.jansky;
      return { ok: true, value: converted, err: err === null ? null : converted * err / magnitudePerFluxRatio };
    }
    if (from.kind === "magnitude" && from.system === "Vega" || to.system === "Vega") {
      return { ok: false, code: "no-conversion", reason: "Vega magnitudes need a band-specific zero point, so they are not converted" };
    }
    return { ok: false, code: "no-conversion", reason: "no verified conversion from " + from.label + " to " + to.label };
  }

  // ---- CSV -----------------------------------------------------------------------------------------------------------
  // Same quoting rules as the Observation Search CSV reader (tools/observation-csv.js): quotes, doubled quotes, commas
  // and newlines inside quotes, CRLF, BOM and blank lines.
  function parseDelimited(text, delimiter = ",") {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (quoted) {
        if (character !== '"') field += character;
        else if (text[index + 1] === '"') { field += '"'; index++; } else quoted = false;
      } else if (character === '"' && field === "") {
        quoted = true;
      } else if (character === delimiter) {
        row.push(field);
        field = "";
      } else if (character === "\n" || character === "\r") {
        if (character === "\r" && text[index + 1] === "\n") index++;
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += character;
      }
    }
    if (quoted) throw new Error("The CSV ends inside a quoted field.");
    if (field !== "" || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows.filter((cells) => cells.length > 1 || cells[0].trim() !== "");
  }

  // Reads a CSV (comma, tab or semicolon) into { header, rows, delimiter }. Lines that start with "#" before the header are comments.
  function readTable(text) {
    let body = String(text ?? "");
    if (body.charCodeAt(0) === 0xFEFF) body = body.slice(1);
    const lines = body.split(/\r\n|\r|\n/);
    let skip = 0;
    while (skip < lines.length && (lines[skip].trim() === "" || lines[skip].startsWith("#"))) skip++;
    if (skip >= lines.length) throw new Error("The file has no header row.");
    body = lines.slice(skip).join("\n");
    const first = lines[skip];
    const counts = [",", "\t", ";"].map((delimiter) => first.split(delimiter).length - 1);
    const delimiter = [",", "\t", ";"][counts.indexOf(Math.max(...counts))];
    const table = parseDelimited(body, counts.every((count) => count === 0) ? "," : delimiter);
    if (table.length === 0) throw new Error("The file has no header row.");
    if (table.length - 1 > maxRows) throw new Error("The file has more than " + maxRows.toLocaleString("en-US") + " rows.");
    const header = table[0].map((name) => name.trim());
    if (header.length < 2) throw new Error("The header has a single column. Use a comma-, tab- or semicolon-separated table.");
    return { header, rows: table.slice(1), delimiter };
  }

  function findColumn(header, name) {
    if (name === undefined || name === null || name === "") return -1;
    const wanted = String(name).trim().toLowerCase();
    return header.findIndex((entry) => entry.toLowerCase() === wanted);
  }

  const contractColumns = ["source_id", "obs_id", "mjd", "ra", "dec", "wavelength", "lambda_width", "flux", "flux_err", "flags", "method"];
  const exportColumns = ["source_id", "obs_id", "row_id", "band", "time_original", "time_mjd", "time_scale", "time_reference",
    "kind", "value", "value_err", "unit", "flags", "wavelength_um", "lambda_width_um"];

  function emptyColumns() {
    return { time: "", value: "", error: "", source: "", band: "", obsId: "", flags: "", wavelength: "", lambdaWidth: "", rowId: "", timeScale: "", timeReference: "", kind: "", unit: "", timeOriginal: "" };
  }

  // Chooses a reading of the header: "spectrophotometry" (the shared CSV contract), "export" (a file this tool wrote),
  // or "generic" (column names are only guesses and the user must confirm them). Returns { profile, config, note }.
  function detectProfile(header) {
    const has = (name) => findColumn(header, name) >= 0;
    const lower = header.map((name) => name.toLowerCase());
    const guess = (pattern) => header[lower.findIndex((name) => pattern.test(name))] ?? "";

    if (exportColumns.every(has)) {
      return {
        profile: "export",
        note: "AstroNot light-curve export: time scale, reference, kind and unit are read from each row.",
        config: {
          columns: { ...emptyColumns(), time: "time_mjd", value: "value", error: "value_err", source: "source_id", band: "band", obsId: "obs_id",
            flags: "flags", wavelength: "wavelength_um", lambdaWidth: "lambda_width_um", rowId: "row_id", timeOriginal: "time_original", timeScale: "time_scale",
            timeReference: "time_reference", kind: "kind", unit: "unit" },
          timeFormat: "mjd", timeScale: "unknown", barycentric: false, kind: "flux", unit: "uJy", defaultSource: "", defaultBand: "",
          binning: { mode: "column", width: 0.1, edges: [] },
        },
      };
    }
    const contractRequired = ["source_id", "obs_id", "mjd", "wavelength", "flux"];
    if (contractRequired.every(has)) {
      return {
        profile: "spectrophotometry",
        note: "Shared Spectrophotometry CSV contract: mjd is MJD in UTC, wavelength in µm, flux and flux_err in µJy, flags an integer bitmask (0 = no flag). The band comes from the wavelength.",
        config: {
          columns: { ...emptyColumns(), time: "mjd", value: "flux", error: has("flux_err") ? "flux_err" : "", source: "source_id", obsId: "obs_id",
            flags: has("flags") ? "flags" : "", wavelength: "wavelength", lambdaWidth: has("lambda_width") ? "lambda_width" : "" },
          timeFormat: "mjd", timeScale: "UTC", barycentric: false, kind: "flux", unit: "uJy", defaultSource: "", defaultBand: "",
          binning: { mode: "width", width: 0.1, edges: [] },
        },
      };
    }
    const time = guess(/^(mjd|jd|bjd|hjd|time|t|date|date[-_]?obs|obs[-_]?date|epoch|datetime|timestamp)(?![a-z])/) ||
      guess(/mjd|jd|time|date|epoch/);
    const value = guess(/^(flux|mag|magnitude|value|f_?nu|brightness|counts|rate)(?![a-z])/) || guess(/flux|mag|value/);
    const timeName = time.toLowerCase();
    return {
      profile: "generic",
      note: "Generic table: check the columns, time format, time scale and unit below, then press Apply. Nothing is assumed about the time scale.",
      config: {
        columns: { ...emptyColumns(), time, value, error: guess(/err|sigma|unc|e_/), source: guess(/^(source|source_id|object|target|name|id)$/) || guess(/source|object|target/),
          band: guess(/^(band|filter|passband|bandpass)$/) || guess(/band|filter/), obsId: guess(/^(obs_?id|obsid|observation|exposure|expid)$/) || guess(/obs/),
          timeScale: guess(/^(time_?scale|timesys|scale)$/), flags: guess(/^(flags?|quality|qual|dq)$/), wavelength: guess(/wave|lambda|wl/), lambdaWidth: guess(/width|bandwidth/) },
        timeFormat: /mjd/.test(timeName) ? "mjd" : /jd/.test(timeName) ? "jd" : "iso",
        timeScale: "unknown", barycentric: false, kind: /mag/.test(value.toLowerCase()) ? "magnitude" : "flux",
        unit: /mag/.test(value.toLowerCase()) ? "AB" : "uJy", defaultSource: "", defaultBand: "",
        binning: { mode: "none", width: 0.1, edges: [] },
        hint: /bjd/.test(timeName) ? "The time column is named BJD. Tick the barycentric box only if the file documents that correction." : "",
      },
    };
  }

  // Turns a table into observation records with the user's column mapping. Never drops a row without saying why.
  // config: { columns, timeFormat, timeScale, barycentric, kind, unit, defaultSource, defaultBand }
  // Returns { records, rejected: [{ row, reason }], rowCount }.
  function buildDataset(table, config) {
    const { header, rows } = table;
    const index = {};
    for (const name of Object.keys(config.columns)) index[name] = findColumn(header, config.columns[name]);
    if (index.time < 0) throw new Error("Choose the time column.");
    if (index.value < 0) throw new Error("Choose the measurement column.");
    if (!["iso", "jd", "mjd"].includes(config.timeFormat)) throw new Error("Choose a time format.");
    const fileScale = normalizeTimeScale(config.timeScale);
    if (fileScale === null) throw new Error("Choose a time scale.");
    if (config.kind !== "flux" && config.kind !== "magnitude") throw new Error("Choose the measurement kind.");

    const cell = (cells, name) => (index[name] >= 0 ? String(cells[index[name]] ?? "").trim() : "");
    const records = [];
    const rejected = [];
    const usedIds = new Set();
    rows.forEach((cells, position) => {
      const row = position + 1;
      if (cells.length !== header.length) {
        rejected.push({ row, reason: "the row has " + cells.length + " fields instead of " + header.length });
        return;
      }
      const issues = [];
      let scale = fileScale;
      if (index.timeScale >= 0) {
        scale = normalizeTimeScale(cell(cells, "timeScale"));
        if (scale === null) {
          rejected.push({ row, reason: "the time scale " + JSON.stringify(cell(cells, "timeScale")) + " is not valid" });
          return;
        }
      }
      let barycentric = Boolean(config.barycentric);
      if (index.timeReference >= 0) barycentric = /bary/i.test(cell(cells, "timeReference"));
      const timeText = cell(cells, "time");
      const time = parseTimeValue(timeText, config.timeFormat);
      if (!time.ok) {
        rejected.push({ row, reason: "time " + JSON.stringify(timeText) + ": " + time.reason });
        return;
      }

      let kind = config.kind;
      if (index.kind >= 0) {
        const text = cell(cells, "kind").toLowerCase();
        kind = /^mag/.test(text) ? "magnitude" : /^flux/.test(text) ? "flux" : null;
        if (!kind) {
          rejected.push({ row, reason: "the measurement kind " + JSON.stringify(cell(cells, "kind")) + " is not flux or magnitude" });
          return;
        }
      }
      const unit = normalizeUnit(index.unit >= 0 ? cell(cells, "unit") : config.unit, kind);

      let value = null;
      const valueText = cell(cells, "value");
      const measured = parseNumber(valueText);
      if (measured.state === "ok") value = measured.value;
      else issues.push(measured.state === "invalid" ? "The measurement " + JSON.stringify(valueText) + " is not a number." : "No measurement in this row.");

      let err = null;
      let errState = "unknown";
      if (index.error >= 0) {
        const errText = cell(cells, "error");
        const parsed = parseNumber(errText);
        if (parsed.state === "ok") {
          if (parsed.value < 0) { errState = "invalid"; issues.push("Negative uncertainty ignored."); } else { err = parsed.value; errState = "known"; }
        } else if (parsed.state === "invalid") {
          errState = "invalid";
          issues.push("The uncertainty " + JSON.stringify(errText) + " is not a number.");
        }
      }

      let flags = null;
      if (index.flags >= 0) {
        const flagText = cell(cells, "flags");
        if (/^\d+$/.test(flagText) && Number.isSafeInteger(Number(flagText))) flags = Number(flagText);
        else if (/^0x[0-9a-f]+$/i.test(flagText)) flags = parseInt(flagText, 16);
        else if (flagText !== "") issues.push("The flags value " + JSON.stringify(flagText) + " is not an integer bitmask.");
      }

      const wavelength = index.wavelength >= 0 ? parseNumber(cell(cells, "wavelength")) : { state: "empty" };
      const width = index.lambdaWidth >= 0 ? parseNumber(cell(cells, "lambdaWidth")) : { state: "empty" };
      let id = row;
      if (index.rowId >= 0 && /^\d+$/.test(cell(cells, "rowId")) && !usedIds.has(Number(cell(cells, "rowId")))) id = Number(cell(cells, "rowId"));
      usedIds.add(id);

      records.push({
        id,
        obsId: cell(cells, "obsId"),
        sourceId: cell(cells, "source") || String(config.defaultSource ?? "").trim() || "(unnamed source)",
        bandLabel: cell(cells, "band") || String(config.defaultBand ?? "").trim() || null,
        wavelength: wavelength.state === "ok" && wavelength.value > 0 ? wavelength.value : null,
        lambdaWidth: width.state === "ok" && width.value > 0 ? width.value : null,
        timeText: cell(cells, "timeOriginal") || timeText,
        mjd: time.mjd,
        scale,
        barycentric,
        kind,
        unit,
        value,
        err,
        errState,
        flags,
        issues,
      });
    });
    return { records, rejected, rowCount: rows.length };
  }

  // ---- Bands and series ----------------------------------------------------------------------------------------------
  function formatWavelength(value) {
    return trimZeros(value.toFixed(4));
  }

  function parseEdges(text) {
    const parts = String(text ?? "").split(/[\s,;]+/).filter(Boolean).map(Number);
    if (parts.length < 2 || parts.some((entry) => !Number.isFinite(entry) || entry <= 0)) {
      return { ok: false, reason: "Enter at least two increasing wavelengths in µm, separated by commas." };
    }
    const sorted = [...new Set(parts)].sort((a, b) => a - b);
    if (sorted.length < 2) return { ok: false, reason: "The band edges must differ." };
    return { ok: true, edges: sorted };
  }

  // binning: { mode: "column" | "width" | "edges" | "none", width, edges }.
  function bandOf(record, binning) {
    const none = { label: "(no band)", defined: false };
    if (binning.mode === "column") {
      return record.bandLabel ? { label: record.bandLabel, defined: true } : none;
    }
    if (binning.mode === "none") return { label: "all wavelengths (not binned)", defined: false };
    const wavelength = record.wavelength;
    if (!isNumber(wavelength)) return { label: "(no wavelength)", defined: false };
    if (binning.mode === "width") {
      const width = binning.width;
      const low = Math.floor(wavelength / width + 1e-9) * width;
      return { label: formatWavelength(low) + "–" + formatWavelength(low + width) + " µm", defined: true, low, high: low + width };
    }
    const edges = binning.edges;
    for (let at = 0; at < edges.length - 1; at++) {
      if (wavelength >= edges[at] && wavelength < edges[at + 1]) {
        return { label: formatWavelength(edges[at]) + "–" + formatWavelength(edges[at + 1]) + " µm", defined: true, low: edges[at], high: edges[at + 1] };
      }
    }
    return { label: "(outside the band edges)", defined: false };
  }

  function checkBinning(binning) {
    if (binning.mode === "width" && !(binning.width > 0)) return { ok: false, reason: "Enter a band width greater than zero." };
    if (binning.mode === "edges" && (!Array.isArray(binning.edges) || binning.edges.length < 2)) return { ok: false, reason: "Enter the band edges." };
    return { ok: true };
  }

  function seriesKey(sourceId, bandLabel) {
    return sourceId + "\u0000" + bandLabel;
  }

  function compareRows(a, b) {
    return a.t - b.t || a.record.id - b.record.id;
  }

  // ---- The view: series, filters, counts, statistics ------------------------------------------------------------------
  // Chooses the time scale and reference the plot starts with: the one all records share, otherwise UTC when every scale can be
  // converted to it, otherwise the most common one.
  function suggestPlotTime(records) {
    const counts = new Map();
    for (const record of records) {
      const key = record.scale + "|" + (record.barycentric ? "b" : "g");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const keys = [...counts.keys()];
    if (keys.length === 0) return { scale: "UTC", barycentric: false, mixed: false };
    if (keys.length === 1) {
      const [scale, ref] = keys[0].split("|");
      return { scale, barycentric: ref === "b", mixed: false };
    }
    const scales = new Set(records.map((record) => record.scale));
    const refs = new Set(records.map((record) => record.barycentric));
    if (refs.size === 1 && [...scales].every((scale) => exactScales.has(scale))) {
      return { scale: "UTC", barycentric: [...refs][0], mixed: true };
    }
    const top = keys.sort((a, b) => counts.get(b) - counts.get(a))[0].split("|");
    return { scale: top[0], barycentric: top[1] === "b", mixed: true };
  }

  // The unit the display starts in: the shared original unit of the records when there is one.
  function suggestDisplayUnit(records) {
    const first = records.find((record) => record.value !== null) ?? records[0];
    if (!first) return { kind: "flux", key: "uJy", label: "µJy", jansky: 1e-6, exponent: -6 };
    return first.unit;
  }

  // view: { binning, seriesKeys (Set or null for all), plotTime: { scale, barycentric }, display (a normalized unit),
  //         timeFrom, timeTo (MJD in the plot scale or null), quality: "all" | "unflagged", ignoreMask (integer) }
  function computeView(records, view) {
    const plot = view.plotTime;
    const ignore = Number.isInteger(view.ignoreMask) && view.ignoreMask > 0 ? view.ignoreMask : 0;
    const hidden = { notSelected: 0, noTime: 0, timeRange: 0, flagged: 0, noFlagInfo: 0 };
    let firstTimeIssue = "";
    const byKey = new Map();
    const rows = [];

    for (const record of records) {
      const band = bandOf(record, view.binning);
      const key = seriesKey(record.sourceId, band.label);
      let series = byKey.get(key);
      if (!series) {
        series = { key, sourceId: record.sourceId, band, total: 0, measured: 0, good: 0, units: new Map(), rows: [], selected: view.seriesKeys ? view.seriesKeys.has(key) : true };
        byKey.set(key, series);
      }
      series.total++;
      if (record.value !== null) {
        series.measured++;
        if (record.flags === null || record.flags === 0) series.good++;
      }
      series.units.set(record.unit.kind + "|" + record.unit.key, record.unit);

      const row = { record, key, t: null, timeIssue: "", y: null, yErr: null, valueIssue: "", flagState: "ok" };
      if (record.barycentric !== plot.barycentric) {
        row.timeIssue = record.barycentric ? "barycentric time cannot be compared with the plot's non-barycentric time" : "non-barycentric time cannot be compared with the plot's barycentric time";
      } else {
        const converted = convertTime(record.mjd, record.scale, plot.scale);
        if (converted.ok) row.t = converted.mjd;
        else row.timeIssue = converted.reason;
      }
      if (record.value !== null) {
        const converted = convertMeasurement(record.value, record.err, record.unit, view.display);
        if (converted.ok) { row.y = converted.value; row.yErr = converted.err; } else row.valueIssue = converted.reason;
      } else {
        row.valueIssue = "no measurement";
      }
      if (record.flags === null) row.flagState = "unknown";
      else row.flagState = (record.flags & ~ignore) === 0 ? "ok" : "flagged";
      row.series = series;

      if (!series.selected) { hidden.notSelected++; continue; }
      if (row.t === null) { hidden.noTime++; firstTimeIssue = firstTimeIssue || row.timeIssue; series.excludedForTime = (series.excludedForTime ?? 0) + 1; continue; }
      if ((isNumber(view.timeFrom) && row.t < view.timeFrom) || (isNumber(view.timeTo) && row.t > view.timeTo)) { hidden.timeRange++; continue; }
      if (view.quality === "unflagged") {
        if (row.flagState === "flagged") { hidden.flagged++; continue; }
        if (row.flagState === "unknown") { hidden.noFlagInfo++; continue; }
      }
      series.rows.push(row);
      rows.push(row);
    }

    const series = [...byKey.values()];
    for (const entry of series) {
      entry.rows.sort(compareRows);
      entry.stats = seriesStats(entry, view.display);
    }
    rows.sort(compareRows);
    series.sort((a, b) => a.sourceId.localeCompare(b.sourceId, "en", { numeric: true }) ||
      (a.band.low ?? Infinity) - (b.band.low ?? Infinity) || a.band.label.localeCompare(b.band.label, "en", { numeric: true }));
    const plottable = rows.filter(isPlottable);
    return {
      series,
      rows,
      plottable,
      hidden,
      firstTimeIssue,
      counts: { total: records.length, visible: rows.length, plottable: plottable.length },
    };
  }

  function isPlottable(row) {
    return row.t !== null && row.y !== null;
  }

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  // Valid points, first and last time, and mean and median only when the band is defined and every value has one original unit.
  function seriesStats(series, display) {
    const valid = series.rows.filter(isPlottable);
    const stats = {
      rows: series.rows.length,
      valid: valid.length,
      first: valid.length ? valid[0].t : null,
      last: valid.length ? valid[valid.length - 1].t : null,
      mean: null,
      median: null,
      summaryNote: "",
      unit: display,
    };
    if (valid.length === 0) {
      stats.summaryNote = "No valid points.";
      return stats;
    }
    const units = new Set(series.rows.filter((row) => row.record.value !== null).map((row) => row.record.unit.kind + "|" + row.record.unit.key));
    if (!series.band.defined) stats.summaryNote = "Mean and median need a defined band; this series is " + series.band.label + ".";
    else if (units.size > 1) stats.summaryNote = "Values are in different original units, so no mean or median is given.";
    else {
      const values = valid.map((row) => row.y);
      stats.mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      stats.median = median(values);
      const dropped = series.rows.filter((row) => row.record.value !== null && row.y === null).length;
      if (dropped) stats.summaryNote = dropped + " value" + (dropped > 1 ? "s" : "") + " cannot be shown in " + display.label + " and " + (dropped > 1 ? "are" : "is") + " left out.";
    }
    return stats;
  }

  // ---- Axes ----------------------------------------------------------------------------------------------------------
  function niceTicks(min, max, target = 6) {
    if (!isNumber(min) || !isNumber(max)) return [];
    if (!(max > min)) return [min];
    const raw = (max - min) / Math.max(1, target);
    const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
    const normal = raw / magnitude;
    const step = (normal < 1.5 ? 1 : normal < 3 ? 2 : normal < 7 ? 5 : 10) * magnitude;
    const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
    const ticks = [];
    for (let tick = Math.ceil(min / step - 1e-9) * step; tick <= max + step * 1e-9; tick += step) ticks.push(Number(tick.toFixed(decimals)));
    return ticks;
  }

  // Extent of the plotted values including error bars, with padding. Flux axes include zero when any value is not positive.
  function valueExtent(rows, display) {
    let low = Infinity;
    let high = -Infinity;
    for (const row of rows) {
      if (!isPlottable(row)) continue;
      const spread = row.yErr ?? 0;
      low = Math.min(low, row.y - spread);
      high = Math.max(high, row.y + spread);
    }
    if (!isNumber(low)) return null;
    if (display.kind === "flux" && low <= 0) high = Math.max(high, 0);
    let pad = (high - low) * 0.08;
    if (pad === 0) pad = Math.abs(high) * 0.05 || 1;
    return { low: low - pad, high: high + pad };
  }

  function timeExtent(rows) {
    let low = Infinity;
    let high = -Infinity;
    for (const row of rows) {
      if (!isPlottable(row)) continue;
      low = Math.min(low, row.t);
      high = Math.max(high, row.t);
    }
    if (!isNumber(low)) return null;
    let pad = (high - low) * 0.04;
    if (pad === 0) pad = 0.5;
    return { low: low - pad, high: high + pad };
  }

  function formatNumber(value, digits = 6) {
    if (!isNumber(value)) return "";
    if (value === 0) return "0";
    const abs = Math.abs(value);
    if (abs >= 1e7 || abs < 1e-4) return value.toExponential(digits - 1).replace(/\.?0+e/, "e");
    return trimZeros(value.toPrecision(digits));
  }

  // ---- Export --------------------------------------------------------------------------------------------------------
  function csvField(value) {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
  }

  // Writes the rows as a CSV that keeps every original value: observation ID, row id, original time text, MJD, time scale and
  // reference, kind, value, error, unit and flags, plus the band the row belongs to. Values are never converted.
  function exportCsv(rows, binning) {
    const lines = [exportColumns.join(",")];
    for (const row of rows) {
      const record = row.record;
      const band = row.series ? row.series.band.label : bandOf(record, binning).label;
      lines.push([
        record.sourceId, record.obsId, record.id, band, record.timeText, String(record.mjd), record.scale,
        record.barycentric ? "barycentric" : "geocentric or topocentric", record.kind,
        record.value === null ? "" : String(record.value), record.err === null ? "" : String(record.err),
        record.unit.key,
        record.flags === null ? "" : String(record.flags),
        record.wavelength === null ? "" : String(record.wavelength), record.lambdaWidth === null ? "" : String(record.lambdaWidth),
      ].map(csvField).join(","));
    }
    return lines.join("\r\n") + "\r\n";
  }

  // Describes a row for the table and the detail panel.
  function rowStatus(row, display) {
    const notes = [];
    const record = row.record;
    if (record.value === null) notes.push("No measurement");
    else if (row.y === null) notes.push("Not shown in " + display.label + ": " + row.valueIssue);
    if (record.value !== null && record.kind === "flux" && record.value <= 0) notes.push(record.value === 0 ? "Zero flux" : "Negative flux");
    if (record.value !== null && record.err === null) notes.push(record.errState === "invalid" ? "Uncertainty invalid" : "Uncertainty unknown");
    if (row.flagState === "flagged") notes.push("Flagged");
    if (row.flagState === "unknown") notes.push("Flags unavailable");
    return notes;
  }

  const api = {
    mjdToJd, abZeroJansky, leapSecondTable, leapSecondTableExpiresMjd, timeScaleNames, fluxUnits, magnitudeUnits,
    normalizeTimeScale, taiMinusUtc, utcToTai, taiToUtc, convertTime, mjdFromJd, jdFromMjd,
    parseIsoTime, parseNumber, parseTimeValue, mjdToIso, timeLabel, formatTime,
    normalizeUnit, convertMeasurement, sameUnit, isFluxDensity,
    parseDelimited, readTable, detectProfile, buildDataset, exportColumns, contractColumns,
    parseEdges, bandOf, checkBinning, seriesKey,
    suggestPlotTime, suggestDisplayUnit, computeView, isPlottable, seriesStats,
    niceTicks, valueExtent, timeExtent, formatNumber, exportCsv, rowStatus,
  };
  root.AstroNotTimeSeries = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);
