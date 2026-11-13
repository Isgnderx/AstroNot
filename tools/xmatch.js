// Catalog cross-match model for the Catalog Cross-Match workspace.
//
// UI-independent: no DOM access. Loads as a classic browser script (global `AstroNotXmatch`) and as a CommonJS module.
// CSV text is split into cells by parseCsv() from tools/observation-csv.js (a classic script that defines a global
// function). Load that script first in the browser; in Node, pass the function to setCsvParser().
//
// WHAT IT DECIDES
//   - How coordinates are read: decimal degrees, or sexagesimal (RA in hours, Dec in degrees); what counts as invalid.
//   - Great-circle separation with the Vincenty formula (atan2 of the sine and cosine parts), stable from 0 to 180 degrees.
//   - Which catalog rows lie within a radius of a source: a declination-zone index with right-ascension windows that
//     wrap at 0/360 and open to all RA when the search circle contains a pole.
//   - Optional movement of catalog positions to one chosen epoch by proper motion (constant angular velocity along a
//     great circle; parallax and radial velocity are ignored).
//   - Statuses and ordering: no match, single candidate, multiple candidates, plus invalid coordinates for input rows.
//
// IDENTIFIERS are always strings taken from the CSV cell. A 19-digit Gaia source_id is above Number.MAX_SAFE_INTEGER and
// must never pass through Number().
//
// RULES STATED TO THE USER
//   - A catalog row is a candidate when its separation is <= the radius (inclusive). Floating-point rounding is covered
//     by a tolerance of 1e-9 arcsec.
//   - Candidates are sorted by separation. Two separations that agree within 1e-6 arcsec (0.001 mas) are a tie; ties are
//     ordered by catalog ID (digit-only IDs numerically, others by code point), then by catalog row. The first candidate
//     is the "Nearest candidate": a position match only, never a confirmed identification.
(function (root) {
  "use strict";

  const rad = Math.PI / 180;
  const masToRad = rad / 3.6e6;
  const boundaryToleranceArcsec = 1e-9;
  const tieResolutionArcsec = 1e-6;

  const limits = {
    radiusMinArcsec: 0.01,
    radiusMaxArcsec: 3600,
    defaultRadiusArcsec: 3,
    sourceRows: 250000,
    catalogRows: 1000000,
  };

  const status = { none: "no-match", single: "single-candidate", multiple: "multiple-candidates", invalid: "invalid-coordinates" };
  const statusLabel = {
    "no-match": "No match",
    "single-candidate": "Single candidate",
    "multiple-candidates": "Multiple candidates",
    "invalid-coordinates": "Invalid coordinates",
  };

  let csvParser = typeof root.parseCsv === "function" ? root.parseCsv : null;
  function setCsvParser(parser) {
    csvParser = parser;
  }

  // ---- Optional WebAssembly kernels ---------------------------------------------------------------------------------------
  // Both are accelerators only: every function below keeps its JavaScript implementation, which is the reference and the
  // fallback, and gives the same result (tests/xmatch-wasm.test.mjs and tests/csv-wasm.test.mjs compare them).
  //   useKernel(kernel)    the Rust matching kernel (rust/crates/xmatch, AstroNotWasm.load("xmatch")); crossMatch() calls it
  //                        when sources x catalog rows reach tuning.kernelMinWork (or options.engine is "wasm").
  //   useCsvKernel(api)    AstroNotCsv (tools/csv-kernel.js) with its Rust kernel loaded; readCsvTable() then tokenizes in
  //                        wasm for bytes, or for text of at least tuning.csvMinChars characters, and extractSources /
  //                        extractCatalog parse the numeric columns there without a JS string per cell.
  let kernel = null;
  let csv = null;
  const tuning = { kernelMinWork: 2e6, csvMinChars: 100000 };
  function useKernel(next) {
    kernel = next && next.exports && typeof next.exports.xm_build === "function" ? next : null;
    return kernel !== null;
  }
  function useCsvKernel(api) {
    csv = api && api.active ? api : null;
    return csv !== null;
  }
  const engines = () => ({ match: kernel ? "wasm" : "js", csv: csv ? "wasm" : "js" });

  // ---- Numbers and angles ---------------------------------------------------------------------------------------------
  const missingWords = new Set(["", "null", "nan", "na", "n/a", "none", "--", "-", "nil", "masked"]);
  const decimalPattern = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

  function isMissing(text) {
    return missingWords.has(String(text ?? "").trim().toLowerCase());
  }

  // Strict decimal text -> number, NaN for anything else (no hex, no "1,5", no "Infinity").
  function parseDecimal(text) {
    const value = String(text ?? "").trim().replace(/−/g, "-");
    if (!decimalPattern.test(value)) return NaN;
    const number = Number(value);
    return Number.isFinite(number) ? number : NaN;
  }

  // "10:24:22.4", "10 24 22.4", "10h24m22.4s", "-41:38:40.8", "-41d38m40.8s", "41°38′40.8″" -> { value (degrees) } or { error }.
  // axis "ra": the first field is hours; the result is in degrees. axis "dec": the first field is degrees.
  function parseSexagesimal(text, axis) {
    const clean = text.replace(/−/g, "-");
    if (!/^[+-]?[\d\s:hmsd°'′″".]+$/i.test(clean)) {
      return { error: "'" + text + "' is not sexagesimal. Use " + (axis === "ra" ? "hh:mm:ss.s" : "±dd:mm:ss.s") + "." };
    }
    const sign = clean.trim().startsWith("-") ? -1 : 1;
    const tokens = clean.replace(/^[\s+-]+/, "").replace(/[:hmsd°'′″"]/gi, " ").trim().split(/\s+/);
    if (tokens.length < 2 || tokens.length > 3 || tokens.some((token) => !/^\d+(?:\.\d*)?$/.test(token))) {
      return { error: "'" + text + "' needs two or three numeric fields such as " + (axis === "ra" ? "10:24:22.4" : "-41:38:40.8") + "." };
    }
    const [whole, minutes, seconds] = [Number(tokens[0]), Number(tokens[1]), tokens.length === 3 ? Number(tokens[2]) : 0];
    if (tokens.slice(0, tokens.length - 1).some((token) => token.includes("."))) {
      return { error: "'" + text + "' has a fraction before the last field." };
    }
    if (minutes >= 60 || seconds >= 60) return { error: "Minutes and seconds must be below 60 in '" + text + "'." };
    const total = whole + minutes / 60 + seconds / 3600;
    return { value: sign * (axis === "ra" ? total * 15 : total) };
  }

  // -> { value } in degrees (RA in [0, 360), Dec in [-90, 90]), or { error, missing? }.
  // unit "deg": decimal degrees. unit "sexagesimal": RA as hours, Dec as degrees. RA of exactly 360 is stored as 0.
  function parseAngle(text, axis, unit = "deg") {
    const raw = String(text ?? "").trim();
    if (isMissing(raw)) return { error: "the " + axis.toUpperCase() + " cell is empty", missing: true };
    let value;
    if (unit === "sexagesimal") {
      const parsed = parseSexagesimal(raw, axis);
      if (parsed.error) return { error: parsed.error };
      value = parsed.value;
    } else {
      value = parseDecimal(raw);
      if (!Number.isFinite(value)) return { error: "'" + raw + "' is not a decimal number of degrees" };
    }
    if (axis === "ra") {
      if (value < 0 || value > 360) return { error: "RA " + raw + " is outside 0 to 360 degrees" };
      return { value: value === 360 ? 0 : value };
    }
    if (value < -90 || value > 90) return { error: "Dec " + raw + " is outside -90 to +90 degrees" };
    return { value };
  }

  // ---- Great-circle separation ----------------------------------------------------------------------------------------
  // Vincenty's formula for a sphere. Inputs and the result are in degrees / arcsec. Right-ascension differences are
  // reduced to (-180, 180] first, so 359.9999 and 0.0001 are 0.0002 degrees apart.
  function separationArcsec(ra1, dec1, ra2, dec2) {
    let dRa = (ra2 - ra1) % 360;
    if (dRa > 180) dRa -= 360;
    else if (dRa <= -180) dRa += 360;
    const lambda = dRa * rad;
    const phi1 = dec1 * rad;
    const phi2 = dec2 * rad;
    const sinL = Math.sin(lambda);
    const cosL = Math.cos(lambda);
    const cos2 = Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * cos2 * cosL;
    const y = cos2 * sinL;
    const z = Math.sin(phi1) * Math.sin(phi2) + Math.cos(phi1) * cos2 * cosL;
    return Math.atan2(Math.hypot(x, y), z) / rad * 3600;
  }

  // ---- Epochs and proper motion ---------------------------------------------------------------------------------------
  const mjdMin = 15000;
  const mjdMax = 100000;
  function mjdToJulianYear(mjd) {
    return 2000 + (mjd - 51544.5) / 365.25;
  }
  function julianYearToMjd(year) {
    return 51544.5 + (year - 2000) * 365.25;
  }

  // text + unit ("jyear" | "mjd") -> Julian year, or NaN.
  function parseEpoch(text, unit = "jyear") {
    const value = parseDecimal(text);
    if (!Number.isFinite(value)) return NaN;
    if (unit === "mjd") return value >= mjdMin && value <= mjdMax ? mjdToJulianYear(value) : NaN;
    return value >= 1800 && value <= 2300 ? value : NaN;
  }

  // Moves one position along its proper motion for `years` (negative: back in time).
  //   pmra, pmdec in mas/yr. pmraIncludesCosDec true: pmra is mu_alpha* = mu_alpha cos(dec) (Gaia); false: pmra is
  //   d(alpha)/dt, multiplied by cos(dec) first. The motion is a constant angular velocity on the sky: the position is
  //   turned along its great circle by |mu| * years, so it is exact for any size and well defined at the poles.
  // Returns [ra, dec] in degrees. Parallax and radial velocity are not used.
  function propagatePosition(ra, dec, pmra, pmdec, years, pmraIncludesCosDec = true) {
    const alpha = ra * rad;
    const delta = dec * rad;
    const east = (pmraIncludesCosDec ? pmra : pmra * Math.cos(delta)) * masToRad * years;
    const north = pmdec * masToRad * years;
    const angle = Math.hypot(east, north);
    if (angle === 0) return [ra, dec];
    const [sa, ca, sd, cd] = [Math.sin(alpha), Math.cos(alpha), Math.sin(delta), Math.cos(delta)];
    const p = [cd * ca, cd * sa, sd];
    const e = [-sa, ca, 0];
    const n = [-sd * ca, -sd * sa, cd];
    const along = Math.sin(angle) / angle;
    const q = [0, 1, 2].map((k) => p[k] * Math.cos(angle) + (east * e[k] + north * n[k]) * along);
    let newRa = Math.atan2(q[1], q[0]) / rad;
    if (newRa < 0) newRa += 360;
    if (newRa >= 360) newRa -= 360;
    return [newRa, Math.atan2(q[2], Math.hypot(q[0], q[1])) / rad];
  }

  // ---- Spatial index ------------------------------------------------------------------------------------------------
  // Declination zones of equal height; inside a zone the rows are sorted by right ascension. A query visits only the
  // zones its circle touches and, per zone, one or two RA windows found by binary search.
  function buildIndex(ra, dec, valid, zoneHeightDeg) {
    const height = Math.min(Math.max(zoneHeightDeg, 0.002), 30);
    const zoneCount = Math.ceil(180 / height);
    const zoneOf = (value) => Math.min(zoneCount - 1, Math.max(0, Math.floor((value + 90) / height)));
    const ids = [];
    for (let i = 0; i < ra.length; i++) if (valid[i]) ids.push(i);
    const zone = new Int32Array(ra.length);
    for (const i of ids) zone[i] = zoneOf(dec[i]);
    ids.sort((a, b) => zone[a] - zone[b] || ra[a] - ra[b] || a - b);
    const sortedRa = new Float64Array(ids.length);
    const sortedIndex = new Int32Array(ids.length);
    const zoneStart = new Int32Array(zoneCount + 1);
    ids.forEach((id, position) => {
      sortedRa[position] = ra[id];
      sortedIndex[position] = id;
      zoneStart[zone[id] + 1]++;
    });
    for (let z = 0; z < zoneCount; z++) zoneStart[z + 1] += zoneStart[z];

    function lowerBound(from, to, value) {
      let lo = from;
      let hi = to;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (sortedRa[mid] < value) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    }

    // All indexed rows within radiusArcsec of (qRa, qDec), as [{ index, separation }] in no particular order.
    function query(qRa, qDec, radiusArcsec) {
      const found = [];
      const radiusDeg = radiusArcsec / 3600;
      const low = qDec - radiusDeg - 1e-9;
      const high = qDec + radiusDeg + 1e-9;
      const containsPole = high >= 90 || low <= -90;
      let windows;
      if (containsPole) {
        windows = [[0, 360]];
      } else {
        const half = Math.asin(Math.min(1, Math.sin(radiusDeg * rad) / Math.cos(qDec * rad))) / rad * (1 + 1e-9) + 1e-9;
        if (half >= 180) windows = [[0, 360]];
        else {
          const start = qRa - half;
          const end = qRa + half;
          if (start < 0) windows = [[start + 360, 360], [0, end]];
          else if (end >= 360) windows = [[start, 360], [0, end - 360]];
          else windows = [[start, end]];
        }
      }
      for (let z = zoneOf(Math.max(low, -90)); z <= zoneOf(Math.min(high, 90)); z++) {
        const from = zoneStart[z];
        const to = zoneStart[z + 1];
        if (from === to) continue;
        for (const [start, end] of windows) {
          for (let position = lowerBound(from, to, start); position < to && sortedRa[position] <= end; position++) {
            const index = sortedIndex[position];
            const separation = separationArcsec(qRa, qDec, ra[index], dec[index]);
            if (separation <= radiusArcsec + boundaryToleranceArcsec) found.push({ index, separation });
          }
        }
      }
      return found;
    }

    return { query, size: ids.length, zoneCount, zoneHeight: height };
  }

  // ---- Identifiers ----------------------------------------------------------------------------------------------------
  const digitsOnly = /^\d+$/;
  function compareIds(a, b) {
    if (digitsOnly.test(a) && digitsOnly.test(b)) {
      const x = a.replace(/^0+(?=\d)/, "");
      const y = b.replace(/^0+(?=\d)/, "");
      if (x.length !== y.length) return x.length - y.length;
      return x < y ? -1 : x > y ? 1 : 0;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  }

  // ---- CSV tables -----------------------------------------------------------------------------------------------------
  // Leading lines starting with "#" are file metadata: "# key: value" or "# key = value". The table starts after them.
  // Returns { ok, header, rows, meta, comments, malformed } or { ok: false, message }. `rows` are arrays of strings; a row
  // whose field count differs from the header is kept and listed in `malformed` ({ row, fields }).
  function readCsvTable(text) {
    const wanted = csvKernelWanted(text);
    if (wanted) {
      const table = readCsvTableKernel(text);
      if (table) return table;
    }
    if (typeof text !== "string" && isBytes(text)) text = new TextDecoder().decode(text.bytes ?? text);
    if (typeof text !== "string" || text.trim() === "") return { ok: false, message: "The file is empty. Choose a CSV file with a header row." };
    if (!csvParser) return { ok: false, message: "The CSV reader is not loaded." };
    let body = text.replace(/^﻿/, "");
    const comments = [];
    const meta = {};
    for (;;) {
      const end = body.search(/\r\n|\n|\r/);
      const line = end === -1 ? body : body.slice(0, end);
      if (!line.trim().startsWith("#")) break;
      comments.push(line);
      const pair = /^\s*#\s*([A-Za-z][\w .-]*?)\s*[:=]\s*(.*?)\s*$/.exec(line);
      if (pair) meta[pair[1].toLowerCase().replace(/[\s.-]+/g, "_")] = pair[2];
      if (end === -1) { body = ""; break; }
      body = body.slice(end).replace(/^(\r\n|\n|\r)/, "");
    }
    const firstLine = body.split(/\r\n|\n|\r/, 1)[0] ?? "";
    if (firstLine.trim() === "") return { ok: false, message: "The file has no header row." };
    if (!firstLine.includes(",") && (firstLine.includes("\t") || firstLine.includes(";"))) {
      return { ok: false, message: "This file is not comma-separated. Save it as CSV with commas between the columns." };
    }
    if (/^\s*</.test(firstLine)) return { ok: false, message: "This file is XML or HTML, not CSV." };
    let table;
    try {
      table = csvParser(body);
    } catch (error) {
      return { ok: false, message: error.message };
    }
    if (table.length === 0) return { ok: false, message: "The file has no header row." };
    const header = table[0].map((name) => name.trim());
    if (header.length < 3) return { ok: false, message: "The header has only " + header.length + " column(s). An ID, RA and Dec column are needed." };
    const rows = table.slice(1);
    const malformed = [];
    rows.forEach((cells, index) => {
      if (cells.length !== header.length) malformed.push({ row: index + 1, fields: cells.length });
    });
    return { ok: true, header, rows, meta, comments, malformed };
  }

  // ---- CSV tables read by the WebAssembly kernel ----------------------------------------------------------------------------
  // The table keeps the file bytes and the record index in wasm memory. `rows` behaves like an array of string arrays for
  // the few things callers do with it (length, slice, forEach, some), building a row only when it is asked for.
  function isBytes(value) {
    return value instanceof ArrayBuffer || ArrayBuffer.isView(value) || Boolean(csv && value instanceof csv.CsvSource);
  }

  function csvKernelWanted(input) {
    if (!csv) return false;
    if (typeof input === "string") return input.length >= tuning.csvMinChars;
    return isBytes(input);
  }

  class KernelRows {
    constructor(table, first) {
      this.table = table;
      this.first = first;
      this.length = table.rowCount - first;
    }

    get(index) {
      return this.table.row(index + this.first);
    }

    slice(from = 0, to = this.length) {
      const out = [];
      for (let i = Math.max(0, from); i < Math.min(to, this.length); i++) out.push(this.get(i));
      return out;
    }

    forEach(callback) {
      for (let i = 0; i < this.length; i++) callback(this.get(i), i, this);
    }

    some(callback) {
      for (let i = 0; i < this.length; i++) if (callback(this.get(i), i, this)) return true;
      return false;
    }

    // True when a trimmed cell of `column` has the shape of `pattern` (see CsvTable.anyShape); no strings are built.
    anyShape(column, pattern) {
      return this.table.anyShape(column, pattern, this.first);
    }

    [Symbol.iterator]() {
      let i = 0;
      return { next: () => (i < this.length ? { value: this.get(i++), done: false } : { value: undefined, done: true }) };
    }
  }

  // Same checks and messages as the JavaScript body of readCsvTable, on bytes. Returns null when the kernel is unusable.
  function readCsvTableKernel(input) {
    let held = input instanceof csv.CsvSource ? input : csv.source(input);
    if (!held) return null;
    const bytes = held.bytes;
    const fail = (message) => {
      held.dispose();
      return { ok: false, message };
    };
    let position = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF ? 3 : 0;
    if (csv.firstNonSpace(bytes, 0) === bytes.length) return fail("The file is empty. Choose a CSV file with a header row.");
    const comments = [];
    const meta = {};
    for (;;) {
      const { text: line, next, terminated } = csv.lineAt(bytes, position);
      if (!line.trim().startsWith("#")) break;
      comments.push(line);
      const pair = /^\s*#\s*([A-Za-z][\w .-]*?)\s*[:=]\s*(.*?)\s*$/.exec(line);
      if (pair) meta[pair[1].toLowerCase().replace(/[\s.-]+/g, "_")] = pair[2];
      if (!terminated) { position = bytes.length; break; }
      position = next;
    }
    const firstLine = csv.lineAt(bytes, position).text;
    if (firstLine.trim() === "") return fail("The file has no header row.");
    if (!firstLine.includes(",") && (firstLine.includes("\t") || firstLine.includes(";"))) {
      return fail("This file is not comma-separated. Save it as CSV with commas between the columns.");
    }
    if (/^\s*</.test(firstLine)) return fail("This file is XML or HTML, not CSV.");
    let table;
    try {
      table = held.open({ delimiter: ",", begin: position, skipBom: false, ownsSource: true });
    } catch {
      held.dispose();
      return null;
    }
    if (table.status === 1) {
      table.dispose();
      return { ok: false, message: "The CSV ends inside a quoted field." };
    }
    if (table.rowCount === 0) {
      table.dispose();
      return { ok: false, message: "The file has no header row." };
    }
    const header = table.row(0).map((name) => name.trim());
    if (header.length < 3) {
      table.dispose();
      return { ok: false, message: "The header has only " + header.length + " column(s). An ID, RA and Dec column are needed." };
    }
    const counts = table.fieldCounts;
    const malformed = [];
    for (let i = 1; i < table.rowCount; i++) if (counts[i] !== header.length) malformed.push({ row: i, fields: counts[i] });
    return { ok: true, header, rows: new KernelRows(table, 1), meta, comments, malformed, kernel: table };
  }

  // ---- Column detection ---------------------------------------------------------------------------------------------
  // Names are matched case-insensitively. Lists run from most to least specific. Gaia and IRSA AllWISE names were checked
  // against real IRSA TAP CSV files and the column documentation (see README of the workspace); the VizieR-style names
  // (RAJ2000, DEJ2000, RA_ICRS, DE_ICRS, pmRA, pmDE) come from their documentation and were not checked against a real export.
  const names = {
    sourceId: ["source_id", "id", "obj_id", "objid", "object_id", "name", "designation", "source"],
    catalogId: ["source_id", "designation", "cntr", "id", "objid", "obj_id", "name", "source", "allwise", "recno"],
    ra: ["ra", "ra_deg", "ra_icrs", "raj2000", "ra_j2000", "_raj2000", "ra2000", "alpha", "ra_pm"],
    dec: ["dec", "dec_deg", "dec_icrs", "dej2000", "decj2000", "dec_j2000", "_dej2000", "dec2000", "de_icrs", "delta", "dec_pm"],
    pmra: ["pmra", "pm_ra", "pmra_cosdec", "pmra*", "pmra_cos_dec"],
    pmdec: ["pmdec", "pmde", "pm_dec", "pmdec_", "pm_de"],
    epoch: ["ref_epoch", "epoch", "w1mjdmean", "mjd", "obs_epoch"],
  };

  function findColumn(header, candidates) {
    const lower = header.map((name) => name.trim().toLowerCase());
    for (const candidate of candidates) {
      const index = lower.indexOf(candidate);
      if (index !== -1) return index;
    }
    return -1;
  }

  // Header -> { id, ra, dec } indexes (-1 when not found). The Source Detection export (source_id, x_pixel, y_pixel, ra,
  // dec, ...) is read through the same names; x_pixel and y_pixel are never taken for a coordinate.
  function detectSourceColumns(header) {
    return { id: findColumn(header, names.sourceId), ra: findColumn(header, names.ra), dec: findColumn(header, names.dec) };
  }

  const allwiseDesignation = /^J\d{6}\.\d{2}[+-]\d{6}\.\d$/;

  // Header and first rows -> columns plus what the file looks like. `kind` is "gaia", "allwise" or null.
  function detectCatalogColumns(header, rows = []) {
    const lower = new Set(header.map((name) => name.trim().toLowerCase()));
    const columns = {
      id: findColumn(header, names.catalogId),
      ra: findColumn(header, names.ra),
      dec: findColumn(header, names.dec),
      pmra: findColumn(header, names.pmra),
      pmdec: findColumn(header, names.pmdec),
      epoch: findColumn(header, names.epoch),
    };
    let kind = null;
    if (lower.has("source_id") && lower.has("ref_epoch") && lower.has("pmra") && lower.has("pmdec")) kind = "gaia";
    const designation = findColumn(header, ["designation"]);
    if (designation !== -1 && (typeof rows.anyShape === "function"
      ? rows.anyShape(designation, "J######.##S######.#") // same test as allwiseDesignation, without building strings
      : rows.some((cells) => allwiseDesignation.test((cells[designation] ?? "").trim())))) kind = "allwise";
    const info = { kind };
    if (kind === "gaia") {
      Object.assign(info, {
        name: "Gaia", release: "", pmraIncludesCosDec: true, epochUnit: "jyear",
        note: "Columns match a Gaia source table (source_id, ref_epoch, pmra, pmdec). Gaia pmra is mu_alpha* = mu_alpha cos(dec), already including cos(dec).",
      });
    } else if (kind === "allwise") {
      columns.id = designation;
      if (columns.epoch !== -1 && /mjd/i.test(header[columns.epoch])) info.epochUnit = "mjd";
      Object.assign(info, {
        name: "AllWISE Source Catalog", release: "AllWISE", pmraIncludesCosDec: null, epochUnit: info.epochUnit ?? "mjd",
        note: "Designations match the AllWISE Source Catalog. ra and dec are from the non-moving fit, at the mean epoch of each source's exposures (w1mjdmean, MJD; there is no single catalog epoch); ra_pm and dec_pm are at MJD 55400.0 (the documentation quotes 2010.5589; as a Julian year MJD 55400.0 is 2010.5558). The AllWISE documentation does not say whether pmra includes cos(dec), so choose before moving positions by proper motion.",
      });
    }
    if (info.epochUnit === undefined && columns.epoch !== -1) info.epochUnit = /mjd/i.test(header[columns.epoch]) ? "mjd" : "jyear";
    return { columns, info };
  }

  // ---- Extracting positions -----------------------------------------------------------------------------------------
  function cell(cells, index) {
    return index >= 0 && index < cells.length ? cells[index] : "";
  }

  // mapping: { id, ra, dec, unit }. Returns arrays aligned with the table rows.
  //   ids  strings (the text of the ID cell, or "row N" when there is no ID column or the cell is empty)
  //   ra, dec  degrees; NaN where invalid. reason[i] is the explanation for an invalid row.
  function extractSources(table, mapping) {
    if (table.kernel && csv && mapping.unit !== "sexagesimal") return extractSourcesKernel(table, mapping);
    const count = table.rows.length;
    const ids = new Array(count);
    const ra = new Float64Array(count).fill(NaN);
    const dec = new Float64Array(count).fill(NaN);
    const reason = new Array(count).fill(null);
    let valid = 0;
    let emptyIds = 0;
    const seen = new Map();
    table.rows.forEach((cells, i) => {
      const idText = cell(cells, mapping.id).trim();
      if (idText === "") emptyIds++;
      ids[i] = idText === "" ? "row " + (i + 1) : idText;
      seen.set(ids[i], (seen.get(ids[i]) ?? 0) + 1);
      if (cells.length !== table.header.length) {
        reason[i] = "the row has " + cells.length + " fields, the header has " + table.header.length;
        return;
      }
      const a = parseAngle(cell(cells, mapping.ra), "ra", mapping.unit);
      const d = parseAngle(cell(cells, mapping.dec), "dec", mapping.unit);
      if (a.error || d.error) {
        reason[i] = [a.error, d.error].filter(Boolean).join("; ");
        return;
      }
      ra[i] = a.value;
      dec[i] = d.value;
      valid++;
    });
    let duplicateIds = 0;
    for (const times of seen.values()) if (times > 1) duplicateIds += times;
    return { ids, ra, dec, reason, count, valid, emptyIds, duplicateIds };
  }

  // mapping: { id, ra, dec, unit, pmra, pmdec, epoch, epochUnit, fixedEpoch (Julian year or NaN) }.
  // Proper motions in mas/yr; epoch[i] in Julian years (NaN when unknown); pmUsable[i] = both components are numbers.
  function extractCatalog(table, mapping) {
    if (table.kernel && csv && mapping.unit !== "sexagesimal") return extractCatalogKernel(table, mapping);
    const base = extractSources(table, mapping);
    const n = base.count;
    const pmra = new Float64Array(n).fill(NaN);
    const pmdec = new Float64Array(n).fill(NaN);
    const epoch = new Float64Array(n).fill(NaN);
    let pmUsable = 0;
    let epochKnown = 0;
    table.rows.forEach((cells, i) => {
      if (mapping.pmra >= 0 && mapping.pmdec >= 0) {
        const a = parseDecimal(cell(cells, mapping.pmra));
        const d = parseDecimal(cell(cells, mapping.pmdec));
        if (Number.isFinite(a) && Number.isFinite(d)) {
          pmra[i] = a;
          pmdec[i] = d;
          if (!Number.isNaN(base.ra[i])) pmUsable++;
        }
      }
      if (mapping.epoch >= 0) epoch[i] = parseEpoch(cell(cells, mapping.epoch), mapping.epochUnit);
      else if (Number.isFinite(mapping.fixedEpoch)) epoch[i] = mapping.fixedEpoch;
      if (Number.isFinite(epoch[i]) && !Number.isNaN(base.ra[i])) epochKnown++;
    });
    let epochMin = Infinity;
    let epochMax = -Infinity;
    for (let i = 0; i < n; i++) {
      if (!Number.isNaN(base.ra[i]) && Number.isFinite(epoch[i])) {
        epochMin = Math.min(epochMin, epoch[i]);
        epochMax = Math.max(epochMax, epoch[i]);
      }
    }
    return Object.assign(base, {
      pmra, pmdec, epoch, pmUsable, epochKnown,
      epochMin: epochKnown ? epochMin : NaN, epochMax: epochKnown ? epochMax : NaN,
    });
  }

  // ---- Extracting positions with the CSV kernel ---------------------------------------------------------------------------
  // Same results and messages as extractSources / extractCatalog; the numbers come from csv_extract (one pass over the
  // file) and a cell becomes a string only to explain a bad row or to show an ID.
  const kernelMissing = new Set([1, 2, 3, 7]); // empty, missing word, nan word, no such column

  function angleFromKernel(status, value, axis, rawOf) {
    if (kernelMissing.has(status)) return { error: "the " + axis.toUpperCase() + " cell is empty", missing: true };
    const raw = () => String(rawOf() ?? "").trim();
    if (status !== 0) return { error: "'" + raw() + "' is not a decimal number of degrees" };
    if (axis === "ra") {
      if (value < 0 || value > 360) return { error: "RA " + raw() + " is outside 0 to 360 degrees" };
      return { value: value === 360 ? 0 : value };
    }
    if (value < -90 || value > 90) return { error: "Dec " + raw() + " is outside -90 to +90 degrees" };
    return { value };
  }

  // Array-like of strings made on demand: ids[i] reads cell `column` of data row i.
  function lazyIds(table, column, count) {
    const idAt = (i) => {
      if (column < 0) return "row " + (i + 1);
      const text = (table.cell(i + 1, column) ?? "").trim();
      return text === "" ? "row " + (i + 1) : text;
    };
    return new Proxy({ length: count, toArray: () => Array.from({ length: count }, (_, i) => idAt(i)) }, {
      get(target, property) {
        if (typeof property === "string" && property !== "" && property.charCodeAt(0) >= 48 && property.charCodeAt(0) <= 57) {
          const i = Number(property);
          return i < count ? idAt(i) : undefined;
        }
        return Reflect.get(target, property);
      },
    });
  }

  function extractSourcesKernel(table, mapping) {
    const k = table.kernel;
    const count = table.rows.length;
    const width = table.header.length;
    const fieldCounts = k.fieldCounts.slice(1);
    const [raCol, decCol] = k.numeric([{ col: mapping.ra, profile: "xmatch" }, { col: mapping.dec, profile: "xmatch" }], { from: 1 });
    const ra = new Float64Array(count).fill(NaN);
    const dec = new Float64Array(count).fill(NaN);
    const reason = new Array(count).fill(null);
    let valid = 0;
    for (let i = 0; i < count; i++) {
      if (fieldCounts[i] !== width) {
        reason[i] = "the row has " + fieldCounts[i] + " fields, the header has " + width;
        continue;
      }
      const rs = raCol.status[i];
      const ds = decCol.status[i];
      const rv = raCol.values[i];
      const dv = decCol.values[i];
      if (rs === 0 && ds === 0 && rv >= 0 && rv <= 360 && dv >= -90 && dv <= 90) {
        ra[i] = rv === 360 ? 0 : rv;
        dec[i] = dv;
        valid++;
        continue;
      }
      const a = angleFromKernel(rs, rv, "ra", () => k.cell(i + 1, mapping.ra));
      const d = angleFromKernel(ds, dv, "dec", () => k.cell(i + 1, mapping.dec));
      if (a.error || d.error) {
        reason[i] = [a.error, d.error].filter(Boolean).join("; ");
        continue;
      }
      ra[i] = a.value;
      dec[i] = d.value;
      valid++;
    }
    let emptyIds = count;
    let duplicateIds = 0;
    if (mapping.id >= 0) {
      const stats = k.idStats(mapping.id, 1);
      emptyIds = stats.empty;
      duplicateIds = stats.duplicate;
    }
    return { ids: lazyIds(k, mapping.id, count), ra, dec, reason, count, valid, emptyIds, duplicateIds };
  }

  function extractCatalogKernel(table, mapping) {
    const base = extractSourcesKernel(table, mapping);
    const k = table.kernel;
    const n = base.count;
    const pmra = new Float64Array(n).fill(NaN);
    const pmdec = new Float64Array(n).fill(NaN);
    const epoch = new Float64Array(n).fill(NaN);
    const specs = [];
    const hasPm = mapping.pmra >= 0 && mapping.pmdec >= 0;
    if (hasPm) specs.push({ col: mapping.pmra, profile: "xmatch" }, { col: mapping.pmdec, profile: "xmatch" });
    if (mapping.epoch >= 0) specs.push({ col: mapping.epoch, profile: "xmatch" });
    const columns = specs.length ? k.numeric(specs, { from: 1 }) : [];
    let pmUsable = 0;
    let epochKnown = 0;
    for (let i = 0; i < n; i++) {
      if (hasPm) {
        const [a, d] = [columns[0], columns[1]];
        if (a.status[i] === 0 && d.status[i] === 0) {
          pmra[i] = a.values[i];
          pmdec[i] = d.values[i];
          if (!Number.isNaN(base.ra[i])) pmUsable++;
        }
      }
      if (mapping.epoch >= 0) {
        const column = columns[hasPm ? 2 : 0];
        if (column.status[i] === 0) {
          const value = column.values[i];
          if (mapping.epochUnit === "mjd") epoch[i] = value >= mjdMin && value <= mjdMax ? mjdToJulianYear(value) : NaN;
          else epoch[i] = value >= 1800 && value <= 2300 ? value : NaN;
        }
      } else if (Number.isFinite(mapping.fixedEpoch)) epoch[i] = mapping.fixedEpoch;
      if (Number.isFinite(epoch[i]) && !Number.isNaN(base.ra[i])) epochKnown++;
    }
    let epochMin = Infinity;
    let epochMax = -Infinity;
    for (let i = 0; i < n; i++) {
      if (!Number.isNaN(base.ra[i]) && Number.isFinite(epoch[i])) {
        epochMin = Math.min(epochMin, epoch[i]);
        epochMax = Math.max(epochMax, epoch[i]);
      }
    }
    return Object.assign(base, {
      pmra, pmdec, epoch, pmUsable, epochKnown,
      epochMin: epochKnown ? epochMin : NaN, epochMax: epochKnown ? epochMax : NaN,
    });
  }

  // ---- Matching -----------------------------------------------------------------------------------------------------
  // options:
  //   radiusArcsec            search radius (inclusive), 0.01 to 3600
  //   targetEpoch             Julian year to move catalog positions to, or null/undefined to use them as published
  //   pmraIncludesCosDec      true / false; required (not null) when targetEpoch is set
  //   coverage                optional { ra, dec, radiusArcsec } of the cone the extract was requested with
  //   rowLimit                optional row limit of the extract request
  // Returns { ok: true, ... } or { ok: false, message }.
  function crossMatch(sources, catalog, options) {
    const radius = Number(options.radiusArcsec);
    if (!Number.isFinite(radius) || radius < limits.radiusMinArcsec || radius > limits.radiusMaxArcsec) {
      return { ok: false, message: "The radius must be between " + limits.radiusMinArcsec + " and " + limits.radiusMaxArcsec + " arcsec." };
    }
    if (sources.valid === 0) return { ok: false, message: "None of your sources has a valid position." };
    if (catalog.valid === 0) return { ok: false, message: "None of the catalog rows has a valid position." };
    const targetEpoch = options.targetEpoch ?? null;
    if (targetEpoch !== null && !Number.isFinite(targetEpoch)) return { ok: false, message: "The epoch is not a valid number." };
    if (targetEpoch !== null && typeof options.pmraIncludesCosDec !== "boolean") {
      return { ok: false, message: "Choose whether the catalog pmra includes cos(Dec) before moving positions by proper motion." };
    }

    if (kernel && options.engine !== "js" && (options.engine === "wasm" || sources.valid * catalog.valid >= tuning.kernelMinWork)) {
      const matched = crossMatchKernel(sources, catalog, options, radius, targetEpoch);
      if (matched) return matched;
    }

    const catRa = Float64Array.from(catalog.ra);
    const catDec = Float64Array.from(catalog.dec);
    const catValid = new Uint8Array(catalog.count);
    for (let i = 0; i < catalog.count; i++) catValid[i] = Number.isNaN(catalog.ra[i]) ? 0 : 1;

    const motion = { requested: targetEpoch !== null, targetEpoch, moved: 0, noMotion: 0, noEpoch: 0, maxShiftArcsec: 0 };
    if (targetEpoch !== null) {
      for (let i = 0; i < catalog.count; i++) {
        if (!catValid[i]) continue;
        if (!Number.isFinite(catalog.epoch[i])) { motion.noEpoch++; continue; }
        if (!Number.isFinite(catalog.pmra[i]) || !Number.isFinite(catalog.pmdec[i])) { motion.noMotion++; continue; }
        const [newRa, newDec] = propagatePosition(catalog.ra[i], catalog.dec[i], catalog.pmra[i], catalog.pmdec[i], targetEpoch - catalog.epoch[i], options.pmraIncludesCosDec);
        const shift = separationArcsec(catalog.ra[i], catalog.dec[i], newRa, newDec);
        motion.maxShiftArcsec = Math.max(motion.maxShiftArcsec, shift);
        catRa[i] = newRa;
        catDec[i] = newDec;
        motion.moved++;
      }
    }

    const index = buildIndex(catRa, catDec, catValid, Math.max(radius / 3600, 0.01));
    const statusOf = new Array(sources.count);
    const candidates = new Array(sources.count).fill(null);
    const ties = new Uint8Array(sources.count);
    const counts = { [status.none]: 0, [status.single]: 0, [status.multiple]: 0, [status.invalid]: 0 };
    for (let i = 0; i < sources.count; i++) {
      if (Number.isNaN(sources.ra[i])) {
        statusOf[i] = status.invalid;
        counts[status.invalid]++;
        continue;
      }
      const found = index.query(sources.ra[i], sources.dec[i], radius);
      if (found.length === 0) {
        statusOf[i] = status.none;
        counts[status.none]++;
        continue;
      }
      for (const item of found) item.key = Math.round(item.separation / tieResolutionArcsec);
      found.sort((a, b) => a.key - b.key || compareIds(catalog.ids[a.index], catalog.ids[b.index]) || a.index - b.index);
      if (found.length > 1 && found[0].key === found[1].key) ties[i] = 1;
      candidates[i] = found.map((item) => ({ index: item.index, separationArcsec: item.separation, ra: catRa[item.index], dec: catDec[item.index] }));
      statusOf[i] = found.length === 1 ? status.single : status.multiple;
      counts[statusOf[i]]++;
    }

    // Coverage of each source by the requested extract: "covered" when the whole match circle lies inside the cone.
    const coverage = new Array(sources.count).fill("unknown");
    const truncated = Number.isFinite(options.rowLimit) && options.rowLimit > 0 && catalog.count >= options.rowLimit;
    let outsideCount = 0;
    const cone = options.coverage;
    const hasCone = cone && Number.isFinite(cone.ra) && Number.isFinite(cone.dec) && Number.isFinite(cone.radiusArcsec) && cone.radiusArcsec > 0;
    if (hasCone && !truncated) {
      for (let i = 0; i < sources.count; i++) {
        if (Number.isNaN(sources.ra[i])) continue;
        const inside = separationArcsec(cone.ra, cone.dec, sources.ra[i], sources.dec[i]) + radius <= cone.radiusArcsec;
        coverage[i] = inside ? "covered" : "not-covered";
        if (!inside) outsideCount++;
      }
    }

    return {
      ok: true, radiusArcsec: radius, status: statusOf, candidates, ties, counts, coverage, motion,
      coverageSummary: { given: Boolean(hasCone), truncated, outside: outsideCount },
      index: { zones: index.zoneCount, zoneHeightDeg: index.zoneHeight, rows: index.size },
      sourceCount: sources.count, catalogCount: catalog.count, engine: "js",
    };
  }

  // ---- Matching in the Rust kernel -------------------------------------------------------------------------------------------
  // Same result object as the JavaScript crossMatch. Only row indices cross into wasm; identifiers stay strings, so exact
  // ties (separations equal at the 1e-6 arcsec resolution) are re-ordered here by catalog ID after the kernel has sorted
  // by (separation key, catalog row). Sources are queried in chunks so wasm memory holds only one chunk of candidates.
  const queryChunk = 32768;
  tuning.lazyCandidatesFrom = 100000; // sources; at or above this the candidate lists are built when they are read

  function lazyCandidateLists(count, offsets, rows, seps, catRa, catDec) {
    const build = (i) => {
      const from = offsets[i];
      const to = offsets[i + 1];
      if (from === to) return null;
      const list = new Array(to - from);
      for (let p = from; p < to; p++) list[p - from] = { index: rows[p], separationArcsec: seps[p], ra: catRa[rows[p]], dec: catDec[rows[p]] };
      return list;
    };
    const everything = () => Array.from({ length: count }, (_, i) => build(i));
    return new Proxy([], {
      get(target, property) {
        if (property === "length") return count;
        if (typeof property === "string" && property !== "" && property.charCodeAt(0) >= 48 && property.charCodeAt(0) <= 57) {
          const i = Number(property);
          return i < count ? build(i) : undefined;
        }
        if (property === Symbol.iterator) return () => everything()[Symbol.iterator]();
        const all = everything();
        const member = all[property];
        return typeof member === "function" ? member.bind(all) : member;
      },
    });
  }

  function crossMatchKernel(sources, catalog, options, radius, targetEpoch) {
    const e = kernel.exports;
    const k = kernel;
    const held = [];
    const hold = (region) => { held.push(region); return region; };
    let index = 0;
    try {
      const n = catalog.count;
      const asDoubles = (array) => (array instanceof Float64Array ? array : Float64Array.from(array));
      const motion = { requested: targetEpoch !== null, targetEpoch, moved: 0, noMotion: 0, noEpoch: 0, maxShiftArcsec: 0 };
      let catRa = asDoubles(catalog.ra);
      let catDec = asDoubles(catalog.dec);
      let inRa = hold(k.put(catRa));
      let inDec = hold(k.put(catDec));
      if (targetEpoch !== null) {
        const pmra = hold(k.put(asDoubles(catalog.pmra)));
        const pmdec = hold(k.put(asDoubles(catalog.pmdec)));
        const epoch = hold(k.put(asDoubles(catalog.epoch)));
        const outRa = hold(k.alloc(Float64Array, n));
        const outDec = hold(k.alloc(Float64Array, n));
        const stats = hold(k.alloc(Float64Array, 4));
        e.xm_propagate(n, inRa.ptr, inDec.ptr, pmra.ptr, pmdec.ptr, epoch.ptr, targetEpoch, options.pmraIncludesCosDec ? 1 : 0, outRa.ptr, outDec.ptr, stats.ptr);
        const [moved, noMotion, noEpoch, maxShift] = k.read(stats);
        Object.assign(motion, { moved, noMotion, noEpoch, maxShiftArcsec: maxShift });
        catRa = k.read(outRa);
        catDec = k.read(outDec);
        inRa = outRa;
        inDec = outDec;
      }
      index = e.xm_build(n, inRa.ptr, inDec.ptr, Math.max(radius / 3600, 0.01));
      const indexInfo = { zones: e.xm_zone_count(index), zoneHeightDeg: e.xm_zone_height(index), rows: e.xm_index_size(index) };
      k.free(...held);
      held.length = 0;

      const count = sources.count;
      const srcRa = hold(k.put(asDoubles(sources.ra)));
      const srcDec = hold(k.put(asDoubles(sources.dec)));
      const offsets = new Uint32Array(count + 1);
      const parts = [];
      let base = 0;
      for (let from = 0; from < count; from += queryChunk) {
        const size = Math.min(queryChunk, count - from);
        const total = e.xm_query(index, srcRa.ptr + from * 8, srcDec.ptr + from * 8, size, radius);
        const local = new Uint32Array(e.memory.buffer, e.xm_res_offsets(index), size + 1);
        for (let j = 1; j <= size; j++) offsets[from + j] = base + local[j];
        parts.push({
          rows: new Uint32Array(e.memory.buffer, e.xm_res_rows(index), total).slice(),
          seps: new Float64Array(e.memory.buffer, e.xm_res_seps(index), total).slice(),
          keys: new Float64Array(e.memory.buffer, e.xm_res_keys(index), total).slice(),
        });
        base += total;
      }
      const join = (Type, name) => {
        const out = new Type(base);
        let at = 0;
        for (const part of parts) { out.set(part[name], at); at += part[name].length; part[name] = null; }
        return out;
      };
      const rows = join(Uint32Array, "rows");
      const seps = join(Float64Array, "seps");
      const keys = join(Float64Array, "keys");

      // Exact ties: the kernel ordered equal keys by catalog row; the rule says by catalog ID, then row.
      const byId = (a, b) => compareIds(catalog.ids[a.row], catalog.ids[b.row]) || a.row - b.row;
      for (let i = 0; i < count; i++) {
        const to = offsets[i + 1];
        for (let p = offsets[i]; p < to - 1;) {
          let q = p + 1;
          while (q < to && keys[q] === keys[p]) q++;
          if (q - p > 1) {
            const group = [];
            for (let r = p; r < q; r++) group.push({ row: rows[r], sep: seps[r] });
            group.sort(byId);
            for (let r = p; r < q; r++) { rows[r] = group[r - p].row; seps[r] = group[r - p].sep; }
          }
          p = q;
        }
      }

      const statusOf = new Array(count);
      const ties = new Uint8Array(count);
      const counts = { [status.none]: 0, [status.single]: 0, [status.multiple]: 0, [status.invalid]: 0 };
      for (let i = 0; i < count; i++) {
        if (Number.isNaN(sources.ra[i])) { statusOf[i] = status.invalid; counts[status.invalid]++; continue; }
        const found = offsets[i + 1] - offsets[i];
        if (found === 0) { statusOf[i] = status.none; counts[status.none]++; continue; }
        if (found > 1 && keys[offsets[i]] === keys[offsets[i] + 1]) ties[i] = 1;
        statusOf[i] = found === 1 ? status.single : status.multiple;
        counts[statusOf[i]]++;
      }
      let candidates;
      if (count >= tuning.lazyCandidatesFrom) {
        candidates = lazyCandidateLists(count, offsets, rows, seps, catRa, catDec);
      } else {
        candidates = new Array(count).fill(null);
        for (let i = 0; i < count; i++) {
          const from = offsets[i];
          const to = offsets[i + 1];
          if (from === to) continue;
          const list = new Array(to - from);
          for (let p = from; p < to; p++) list[p - from] = { index: rows[p], separationArcsec: seps[p], ra: catRa[rows[p]], dec: catDec[rows[p]] };
          candidates[i] = list;
        }
      }

      const coverage = new Array(count).fill("unknown");
      const truncated = Number.isFinite(options.rowLimit) && options.rowLimit > 0 && catalog.count >= options.rowLimit;
      let outsideCount = 0;
      const cone = options.coverage;
      const hasCone = cone && Number.isFinite(cone.ra) && Number.isFinite(cone.dec) && Number.isFinite(cone.radiusArcsec) && cone.radiusArcsec > 0;
      if (hasCone && !truncated) {
        const out = hold(k.alloc(Float64Array, count));
        e.xm_separation_batch(count, srcRa.ptr, srcDec.ptr, cone.ra, cone.dec, out.ptr);
        const toCone = k.read(out);
        for (let i = 0; i < count; i++) {
          if (Number.isNaN(sources.ra[i])) continue;
          const inside = toCone[i] + radius <= cone.radiusArcsec;
          coverage[i] = inside ? "covered" : "not-covered";
          if (!inside) outsideCount++;
        }
      }
      return {
        ok: true, radiusArcsec: radius, status: statusOf, candidates, ties, counts, coverage, motion,
        coverageSummary: { given: Boolean(hasCone), truncated, outside: outsideCount },
        index: indexInfo, sourceCount: count, catalogCount: catalog.count, engine: "wasm",
      };
    } catch (error) {
      kernel = null; // a trap can leave the wasm heap inconsistent: do not use this instance again
      return null;
    } finally {
      try {
        k.free(...held);
        if (index) e.xm_free(index);
      } catch { /* instance already unusable */ }
    }
  }

  // ---- IRSA extract link --------------------------------------------------------------------------------------------
  // IRSA TAP (checked on 2026-11-13): a GET to /TAP/sync with QUERY and FORMAT=csv returns the CSV straight away. The response
  // carries no Access-Control-Allow-Origin header, so a page cannot read it with fetch(); the link is opened as a normal
  // navigation and the saved CSV is imported here. TOP N keeps an arbitrary subset when the cone holds more rows, and the CSV
  // does not say so: the row limit is therefore part of the coverage the user is shown.
  const irsaTap = "https://irsa.ipac.caltech.edu/TAP/sync";
  const irsaTables = {
    gaia: {
      label: "Gaia DR3 (gaia_dr3_source)", table: "gaia_dr3_source", name: "Gaia", release: "DR3",
      columns: "source_id,ra,dec,pmra,pmdec,ref_epoch,parallax,phot_g_mean_mag",
    },
    allwise: {
      label: "AllWISE Source Catalog (allwise_p3as_psd)", table: "allwise_p3as_psd", name: "AllWISE Source Catalog", release: "AllWISE",
      columns: "designation,ra,dec,sigra,sigdec,ra_pm,dec_pm,pmra,pmdec,w1mpro,w1mjdmean,cntr",
    },
  };

  // options { table: "gaia" | "allwise", ra, dec (degrees), radiusArcsec, rowLimit } -> { url, adql, ... } or { error }.
  function irsaExtractQuery(options) {
    const entry = irsaTables[options.table];
    if (!entry) return { error: "Choose Gaia DR3 or AllWISE." };
    const { ra, dec, radiusArcsec, rowLimit } = options;
    if (![ra, dec, radiusArcsec, rowLimit].every(Number.isFinite)) return { error: "Enter numbers for RA, Dec, the radius and the row limit." };
    if (ra < 0 || ra > 360 || dec < -90 || dec > 90) return { error: "RA must be 0 to 360 and Dec -90 to +90 degrees." };
    if (radiusArcsec <= 0 || radiusArcsec > 3600) return { error: "The extract radius must be above 0 and at most 3600 arcsec." };
    if (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > 1000000) return { error: "The row limit must be a whole number from 1 to 1,000,000." };
    const adql = "SELECT TOP " + rowLimit + " " + entry.columns + " FROM " + entry.table +
      " WHERE CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS'," + Number(ra.toFixed(8)) + "," + Number(dec.toFixed(8)) + "," + Number((radiusArcsec / 3600).toFixed(8)) + "))=1";
    const url = irsaTap + "?" + new URLSearchParams({ QUERY: adql, FORMAT: "csv" }).toString();
    return { url, adql, name: entry.name, release: entry.release, ra, dec, radiusArcsec, rowLimit };
  }

  // Centre and radius of a circle around valid source positions: the mean direction, and the largest distance from it
  // plus `marginArcsec`. { ra, dec, radiusArcsec } or null when no position is valid.
  function enclosingCircle(sources, marginArcsec = 0) {
    let x = 0, y = 0, z = 0, n = 0;
    for (let i = 0; i < sources.count; i++) {
      if (Number.isNaN(sources.ra[i])) continue;
      const a = sources.ra[i] * rad, d = sources.dec[i] * rad;
      x += Math.cos(d) * Math.cos(a); y += Math.cos(d) * Math.sin(a); z += Math.sin(d); n++;
    }
    if (n === 0) return null;
    let ra = Math.atan2(y, x) / rad;
    if (ra < 0) ra += 360;
    const dec = Math.atan2(z, Math.hypot(x, y)) / rad;
    let farthest = 0;
    for (let i = 0; i < sources.count; i++) {
      if (!Number.isNaN(sources.ra[i])) farthest = Math.max(farthest, separationArcsec(ra, dec, sources.ra[i], sources.dec[i]));
    }
    return { ra, dec, radiusArcsec: farthest + marginArcsec };
  }

  // ---- Export -------------------------------------------------------------------------------------------------------
  // A cell the spreadsheet should show as text: ="5416565604120469376", quoted as CSV requires.
  class SpreadsheetText {
    constructor(text) { this.text = text; }
  }

  function csvField(value) {
    if (value instanceof SpreadsheetText) return '"=""' + value.text + '"""';
    let text = value === null || value === undefined ? "" : String(value);
    if (/^[=@\t\r]/.test(text)) text = "'" + text; // never let a cell start a spreadsheet formula
    return /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  const exportHeader = [
    "source_id", "source_row", "source_ra_deg", "source_dec_deg", "match_status", "candidate_count", "candidate_rank",
    "nearest_candidate", "tie_with_next", "catalog_id", "catalog_row", "catalog_ra_deg", "catalog_dec_deg",
    "catalog_ra_published_deg", "catalog_dec_published_deg", "catalog_epoch_published_jyear", "comparison_epoch_jyear",
    "catalog_position_moved", "separation_arcsec", "radius_arcsec", "coverage_by_extract", "catalog_name", "catalog_release",
    "source_epoch", "note",
  ];

  // context: { catalogName, catalogRelease, sourceEpoch (text), spreadsheetIds }.
  // One row per candidate (rank 1 is the nearest candidate); one row for each source without candidates or with invalid
  // coordinates. IDs are written as text; separations and radius are in arcsec; coordinates in degrees.
  function buildExportCsv(sources, catalog, result, context = {}) {
    const id = (value) => (context.spreadsheetIds && /^\d{12,}$/.test(value) ? new SpreadsheetText(value) : value);
    const deg = (value) => (Number.isFinite(value) ? value.toFixed(10) : "");
    const epochText = (value) => (Number.isFinite(value) ? value.toFixed(4) : "");
    const lines = [exportHeader.join(",")];
    const comparison = result.motion.requested ? result.motion.targetEpoch : null;
    const push = (fields) => lines.push(fields.map(csvField).join(","));
    for (let i = 0; i < sources.count; i++) {
      const statusName = result.status[i];
      const list = result.candidates[i];
      const common = [id(sources.ids[i]), i + 1, deg(sources.ra[i]), deg(sources.dec[i]), statusName, list ? list.length : 0];
      const tail = [result.radiusArcsec, result.coverage[i], context.catalogName ?? "", context.catalogRelease ?? "", context.sourceEpoch ?? ""];
      if (!list) {
        push([...common, "", "", "", "", "", "", "", "", "", "", comparison === null ? "" : epochText(comparison), "", "", ...tail,
          statusName === status.invalid ? "Not matched: " + sources.reason[i] : "No catalog row within the radius"]);
        continue;
      }
      list.forEach((candidate, rank) => {
        const c = candidate.index;
        const moved = comparison !== null && (candidate.ra !== catalog.ra[c] || candidate.dec !== catalog.dec[c]);
        const note = rank === 0 ? "Nearest candidate: position match only, not a confirmed identification" : "";
        push([...common, rank + 1, rank === 0 ? "yes" : "no", rank === 0 && result.ties[i] ? "yes" : "no", id(catalog.ids[c]), c + 1,
          deg(candidate.ra), deg(candidate.dec), deg(catalog.ra[c]), deg(catalog.dec[c]), epochText(catalog.epoch[c]),
          comparison === null ? "" : epochText(comparison), moved ? "yes" : "no", candidate.separationArcsec.toFixed(6), ...tail, note]);
      });
    }
    return lines.join("\r\n") + "\r\n";
  }

  const api = {
    limits, status, statusLabel, setCsvParser,
    isMissing, parseDecimal, parseSexagesimal, parseAngle, parseEpoch, mjdToJulianYear, julianYearToMjd,
    separationArcsec, propagatePosition, buildIndex, compareIds,
    readCsvTable, detectSourceColumns, detectCatalogColumns, extractSources, extractCatalog,
    crossMatch, buildExportCsv, exportHeader, irsaExtractQuery, enclosingCircle, irsaTables,
    useKernel, useCsvKernel, engines, tuning,
  };
  root.AstroNotXmatch = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);
