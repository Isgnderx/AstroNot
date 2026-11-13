// Spectrum model for Spectrum Lab: reading spectrum tables (CSV and friends), column and unit mapping, validation,
// unit conversion, flag decoding and the plain maths behind the axes.
//
// UI-independent: no DOM access. Loads as a classic browser script (global `AstroNotSpectrum`) and as a CommonJS module.
//
// SHARED CSV CONTRACT (Spectrum Lab reads it; Spectrophotometry and Light Curve write or read the same columns).
// Header names match case-insensitively; extra columns are kept.
//   wavelength   required  micrometres (um)
//   flux         required  microjansky (uJy), flux density per unit frequency
//   flux_err     required  microjansky; the cell may be empty
//   lambda_width optional  micrometres, effective bandpass width
//   flags        optional  non-negative integer bitmask (SPHEREx Spectrophotometry bits, see flagDefinitions)
//   source_id, obs_id, mjd (MJD, UTC), ra, dec (degrees, ICRS), method   optional
//
// Checked against the IRSA SPHEREx Spectrophotometry Tool page (irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/sp.html):
// wavelength is in um, flux and flux_err in uJy, lambda_width in um, flags is an integer bitmask. The page documents
// lvf_id, det_id, mjd, ra, dec, x_image, y_image, fit_ql, flux_bkg, deep_flg and data_collection as further columns, and
// no column named obs_id. The tool's own download is a VOTable; this file reads CSV only.
//
// VALUES STAY AS IMPORTED. A point keeps wavelength, flux and error in the units of the file (spectrum.units). Display
// units are applied by convert(), which shifts the decimal exponent, so 100 uJy is exactly 0.0001 Jy and 1.2 um is
// exactly 1.2e-6 m, with no binary rounding noise.
(function (root) {
  "use strict";

  const limits = { maxBytes: 25 * 1024 * 1024, maxRows: 250000 };

  // ---- Units -------------------------------------------------------------------------------------------------------------
  // exp is the power of ten of the unit relative to the base unit (metre, jansky).
  const wavelengthUnits = {
    um: { label: "µm", name: "micrometres", exp: -6 },
    nm: { label: "nm", name: "nanometres", exp: -9 },
    A: { label: "Å", name: "angstroms", exp: -10 },
    m: { label: "m", name: "metres", exp: 0 },
  };
  const fluxUnits = {
    uJy: { label: "µJy", name: "microjanskys", exp: -6 },
    mJy: { label: "mJy", name: "millijanskys", exp: -3 },
    Jy: { label: "Jy", name: "janskys", exp: 0 },
    nJy: { label: "nJy", name: "nanojanskys", exp: -9 },
  };

  const wavelengthNames = {
    um: "um", micron: "um", microns: "um", micrometer: "um", micrometers: "um", micrometre: "um", micrometres: "um",
    nm: "nm", nanometer: "nm", nanometers: "nm", nanometre: "nm", nanometres: "nm",
    a: "A", aa: "A", "å": "A", angstrom: "A", angstroms: "A", "ångström": "A",
    m: "m", meter: "m", meters: "m", metre: "m", metres: "m",
  };
  const fluxNames = {
    ujy: "uJy", microjansky: "uJy", microjanskys: "uJy", mjy: "mJy", millijansky: "mJy", millijanskys: "mJy",
    jy: "Jy", jansky: "Jy", janskys: "Jy", njy: "nJy", nanojansky: "nJy", nanojanskys: "nJy",
  };

  function normalizeUnitText(text) {
    return String(text).trim().toLowerCase().replace(/[µμ]/g, "u").replace(/\s+/g, "");
  }

  // "um", "µm", "Å", "uJy", "microns" ... -> unit key, or null. kind is "wavelength" or "flux".
  function parseUnit(text, kind) {
    const key = normalizeUnitText(text);
    return (kind === "flux" ? fluxNames : wavelengthNames)[key] ?? null;
  }

  function unitTable(kind) {
    return kind === "flux" ? fluxUnits : wavelengthUnits;
  }

  function unitLabel(key, kind) {
    return unitTable(kind)[key]?.label ?? "";
  }

  // Move the decimal exponent instead of multiplying by 1e-6: 100 * 1e-6 is not exactly 0.0001, but "1e2" -> "1e-4" is.
  function shiftExponent(value, shift) {
    if (shift === 0 || value === 0 || !Number.isFinite(value)) return value;
    const [mantissa, exponent] = value.toExponential().split("e");
    return Number(mantissa + "e" + (Number(exponent) + shift));
  }

  // Convert a value between two units of one kind. Unknown units throw: a silent identity would hide a unit error.
  function convert(value, from, to, kind) {
    const table = unitTable(kind);
    if (!table[from] || !table[to]) throw new RangeError("Unknown " + kind + " unit: " + from + " or " + to + ".");
    return shiftExponent(value, table[from].exp - table[to].exp);
  }

  // ---- Flags -------------------------------------------------------------------------------------------------------------
  // SPHEREx Spectrophotometry flag bits as listed on the IRSA page. meaning is null where the page gives no definition;
  // such a bit is still named, and the reader is told that no definition is published.
  const flagDefinitions = [
    [0, "TRANSIENT", "e.g., cosmic-ray hit"],
    [1, "OVERFLOW", "nearing saturation"],
    [2, "SUR_ERROR", "possible errors"],
    [6, "NONFUNC", "dead pixel"],
    [7, "DICHROIC", "unusable pixel (calibration not yet perfect)"],
    [9, "MISSING_DATA", "no data"],
    [10, "HOT", "noisy pixel"],
    [11, "COLD", "unresponsive pixel"],
    [12, "FULLSAMPLE", "full history available"],
    [14, "PHANMISS", "cannot be corrected"],
    [15, "NONLINEAR", "cannot be corrected"],
    [17, "PERSIST", "persistent charge"],
    [19, "OUTLIER", "flagged outlier"],
    [20, "CROSSTALK", null],
    [21, "SOURCE", "known source"],
    [22, "GHOST", null],
    [23, "GHOST_FPA", null],
    [24, "GHOST_EXT", null],
    [25, "STREAK", null],
    [26, "BLOOM", null],
    [27, "SNOWBALL", null],
    [28, "HALO", null],
    [29, "SATELLITE_HALO", null],
    [32, "CONTAINS_BAD_PIXEL", "a bad pixel is involved"],
    [33, "FIT_ERROR", "error in fitting (failure to converge)"],
  ].map(([bit, name, meaning]) => ({ bit, name, meaning, value: String(2n ** BigInt(bit)) }));

  const flagByBit = new Map(flagDefinitions.map((definition) => [definition.bit, definition]));
  const maxFlagValue = Number.MAX_SAFE_INTEGER;

  // flags may be a non-negative integer (number, bigint or digit string). Never uses 32-bit operators: SPHEREx has bits 32+.
  function decodeFlags(value) {
    if (value === null || value === undefined || value === "") return { raw: "", labels: [], known: [], unknown: [], text: "" };
    const number = typeof value === "bigint" ? value : BigInt(value);
    const known = [];
    const unknown = [];
    for (let bit = 0; bit < 64; bit++) {
      if (((number >> BigInt(bit)) & 1n) === 0n) continue;
      const definition = flagByBit.get(bit);
      if (definition) known.push(definition);
      else unknown.push({ bit, value: String(1n << BigInt(bit)) });
    }
    const labels = known.map((definition) => definition.name);
    const parts = labels.concat(unknown.map((entry) => "unknown bit " + entry.bit + " (" + entry.value + ")"));
    return { raw: String(number), labels, known, unknown, text: number === 0n ? "none set" : parts.join(", ") };
  }

  // ---- Reading bytes -----------------------------------------------------------------------------------------------------
  // Result: { ok: true, text, encoding, note } or { ok: false, code, message }.
  function decodeBytes(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length === 0) return { ok: false, code: "empty-file", message: "The file is empty." };
    if (bytes.length > limits.maxBytes) {
      return { ok: false, code: "too-large", message: "The file is " + (bytes.length / 1048576).toFixed(1) + " MB. Spectrum Lab reads files up to " + limits.maxBytes / 1048576 + " MB; cut the table down to the source and wavelength range you need." };
    }
    const starts = (text) => text.split("").every((character, index) => bytes[index] === character.charCodeAt(0));
    if (starts("PK")) return { ok: false, code: "not-csv", message: "This looks like a zip or spreadsheet file (xlsx). Save the table as CSV and choose that file." };
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) return { ok: false, code: "not-csv", message: "This file is gzip-compressed. Unpack it and choose the CSV inside." };
    if (starts("%PDF")) return { ok: false, code: "not-csv", message: "This is a PDF, not a CSV table." };
    if (starts("SIMPLE  =")) return { ok: false, code: "not-csv", message: "This is a FITS file. Spectrum Lab reads CSV tables; export the spectrum as CSV." };
    if (bytes[0] === 0x89 && bytes[1] === 0x50 || bytes[0] === 0xff && bytes[1] === 0xd8) return { ok: false, code: "not-csv", message: "This is an image, not a CSV table." };

    let encoding = "utf-8";
    if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
    else if (bytes.subarray(0, 4096).includes(0)) {
      return { ok: false, code: "not-csv", message: "This file contains binary data, so it is not a text CSV table." };
    }
    try {
      return { ok: true, text: new TextDecoder(encoding, { fatal: true }).decode(bytes), encoding, note: "" };
    } catch {
      return {
        ok: true, text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252",
        note: "The file is not valid UTF-8, so it was read as Windows-1252 (Latin). Check any non-ASCII characters.",
      };
    }
  }

  // ---- Reading the table -------------------------------------------------------------------------------------------------
  const delimiterNames = { ",": "comma", ";": "semicolon", "\t": "tab", "|": "pipe" };
  const delimiterOrder = [",", ";", "\t", "|"];

  function countDelimiters(line, delimiter) {
    let quoted = false;
    let count = 0;
    for (const character of line) {
      if (character === '"') quoted = !quoted;
      else if (!quoted && character === delimiter) count++;
    }
    return count;
  }

  function detectDelimiter(text) {
    const line = text.split(/\r\n|\n|\r/).find((candidate) => candidate.trim() !== "" && !candidate.startsWith("#")) ?? "";
    let best = ",";
    let bestCount = 0;
    for (const delimiter of delimiterOrder) {
      const count = countDelimiters(line, delimiter);
      if (count > bestCount) { best = delimiter; bestCount = count; }
    }
    return best;
  }

  // RFC-4180 style: quoted fields may hold the delimiter, doubled quotes and line breaks. Lines starting with # are
  // comments. Every record keeps the line number it starts on. Throws Error with .code on an unclosed quote.
  function parseDelimited(text, delimiter) {
    const records = [];
    let cells = [];
    let field = "";
    let quoted = false;
    let line = 1;
    let startLine = 1;
    let atStart = true;
    let comments = 0;
    const finish = () => {
      cells.push(field);
      if (!(cells.length === 1 && cells[0].trim() === "")) {
        records.push({ line: startLine, cells });
        if (records.length > limits.maxRows + 1) {
          const error = new Error("The file has more than " + limits.maxRows.toLocaleString("en-US") + " data rows.");
          error.code = "too-many-rows";
          throw error;
        }
      }
      cells = [];
      field = "";
    };
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (quoted) {
        if (character === '"') {
          if (text[index + 1] === '"') { field += '"'; index++; } else quoted = false;
        } else {
          if (character === "\n") line++;
          field += character;
        }
        continue;
      }
      if (atStart) {
        startLine = line;
        if (character === "#") {
          while (index < text.length && text[index] !== "\n" && text[index] !== "\r") index++;
          index--;
          comments++;
          atStart = false;
          field = "";
          cells = [];
          // the newline that ends the comment is handled as an empty record below
          continue;
        }
      }
      atStart = false;
      if (character === '"' && field === "") quoted = true;
      else if (character === delimiter) { cells.push(field); field = ""; }
      else if (character === "\n" || character === "\r") {
        if (character === "\r" && text[index + 1] === "\n") index++;
        line++;
        finish();
        atStart = true;
      } else field += character;
    }
    if (quoted) {
      const error = new Error("The file ends inside a quoted field that starts on line " + startLine + ". Check the quotation marks.");
      error.code = "bad-csv";
      throw error;
    }
    if (!atStart) { startLine = startLine || line; finish(); }
    return { records, comments };
  }

  // options.delimiter: a single character, or "auto" / undefined.
  // Result: { ok: true, delimiter, delimiterName, headers, records, comments, headerLine } or { ok: false, code, message }.
  function readTable(input, options = {}) {
    let text = String(input);
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    if (text.trim() === "") return { ok: false, code: "empty-file", message: "The file is empty. Choose a spectrum table saved as CSV." };
    const head = text.trimStart().slice(0, 200).toLowerCase();
    if (head.startsWith("<")) {
      const message = /<votable|<\?xml/.test(head)
        ? "This is a VOTable (XML). Spectrum Lab reads CSV. In the IRSA viewer convert the table to CSV and choose that file."
        : "This file is HTML or XML, not CSV. Save the table itself as CSV.";
      return { ok: false, code: "not-csv", message };
    }
    const delimiter = options.delimiter && options.delimiter !== "auto" ? options.delimiter : detectDelimiter(text);
    let parsed;
    try {
      parsed = parseDelimited(text, delimiter);
    } catch (error) {
      return { ok: false, code: error.code ?? "bad-csv", message: error.message };
    }
    if (parsed.records.length === 0) return { ok: false, code: "empty-file", message: "The file has no header row." };
    const [header, ...records] = parsed.records;
    if (header.cells.length < 2) {
      return {
        ok: false, code: "no-delimiter",
        message: "Only one column was found with the " + delimiterNames[delimiter] + " delimiter. Choose the delimiter below, or save the table as comma-separated CSV.",
      };
    }
    return {
      ok: true, delimiter, delimiterName: delimiterNames[delimiter] ?? "custom",
      headers: header.cells.map((name) => name.trim()), records, comments: parsed.comments, headerLine: header.line,
    };
  }

  // ---- Columns -----------------------------------------------------------------------------------------------------------
  const fieldNames = ["wavelength", "flux", "flux_err", "lambda_width", "flags", "source_id", "obs_id", "mjd", "ra", "dec", "method"];
  const requiredFields = ["wavelength", "flux"];
  const contractColumns = ["wavelength", "flux", "flux_err"];
  const contractUnits = { wavelength: "um", flux: "uJy" };

  const aliases = {
    wavelength: ["wavelength", "lambda", "wave", "wl", "wavelength_um", "wavelength_nm", "lambda_um", "lam"],
    flux: ["flux", "flux_density", "fnu", "f_nu", "flux_ujy", "flux_jy", "flux_mjy"],
    flux_err: ["flux_err", "flux_error", "fluxerr", "e_flux", "flux_unc", "flux_sigma", "err", "error", "sigma", "uncertainty", "unc"],
    lambda_width: ["lambda_width", "wavelength_width", "bandwidth", "dlambda", "width"],
    flags: ["flags", "flag", "quality", "qual"],
    source_id: ["source_id", "source", "object", "objid", "target", "obj_id"],
    obs_id: ["obs_id", "observation_id", "obsid", "obs", "lvf_id"],
    mjd: ["mjd", "mjd_obs"],
    ra: ["ra", "ra_deg"],
    dec: ["dec", "dec_deg"],
    method: ["method"],
  };

  // A unit written in a header: "wavelength (um)", "flux [uJy]", "flux_ujy", "wavelength_nm".
  function unitFromHeader(header, kind) {
    const bracket = /[([]\s*([^)\]]+?)\s*[)\]]/.exec(header);
    if (bracket) {
      const unit = parseUnit(bracket[1], kind);
      if (unit) return unit;
    }
    const suffix = /[_\s]([a-zA-Zµμ]+)$/.exec(header);
    return suffix ? parseUnit(suffix[1], kind) : null;
  }

  // Suggest which column holds which field. Case-insensitive. Returns
  // { mapping, units, contract, notes } where mapping[field] is a column index or null, units says where each unit came
  // from ("contract", "header" or null), and contract is true when wavelength, flux and flux_err are all present by name.
  function detectColumns(headers) {
    const lower = headers.map((header) => header.trim().toLowerCase());
    // "flux (uJy)" and "flux [mJy]" are matched by their name without the unit.
    const bare = lower.map((header) => {
      const name = header.replace(/\s*[([][^)\]]*[)\]]\s*$/, "").trim().replace(/\s+/g, "_");
      const suffix = /^(.+)_([a-zµμ]+)$/.exec(name);
      return suffix && (parseUnit(suffix[2], "wavelength") || parseUnit(suffix[2], "flux")) ? suffix[1] : name;
    });
    const mapping = {};
    const notes = [];
    for (const field of fieldNames) {
      let index = lower.indexOf(field);
      let alias = null;
      if (index < 0) index = bare.indexOf(field);
      if (index < 0) {
        for (const name of aliases[field]) {
          index = bare.indexOf(name);
          if (index >= 0) { alias = name; break; }
        }
      }
      mapping[field] = index >= 0 ? index : null;
      if (alias && field !== "lambda_width" && alias !== "width") notes.push("Column '" + headers[index] + "' was suggested for " + field + ".");
      if (alias === "lvf_id") notes.push("lvf_id is the IRSA exposure ID, so it is used here to tell observations apart.");
    }
    const contract = contractColumns.every((name) => lower.includes(name));
    const units = { wavelength: null, flux: null, source: { wavelength: null, flux: null } };
    if (contract) {
      units.wavelength = contractUnits.wavelength;
      units.flux = contractUnits.flux;
      units.source = { wavelength: "contract", flux: "contract" };
    } else {
      for (const kind of ["wavelength", "flux"]) {
        const found = mapping[kind] === null ? null : unitFromHeader(headers[mapping[kind]], kind);
        if (found) { units[kind] = found; units.source[kind] = "header"; }
      }
    }
    return { mapping, units, contract, notes };
  }

  // ---- Numbers -----------------------------------------------------------------------------------------------------------
  const missingTokens = new Set(["", "nan", "null", "none", "na", "n/a", "--", "-"]);
  const decimalPattern = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

  // -> { value } | { missing: true } | { reason }. Reasons read like "is not a number".
  function parseNumber(text, decimalComma = false) {
    let trimmed = String(text ?? "").trim();
    if (decimalComma && /^[+-]?\d+,\d+(?:[eE][+-]?\d+)?$/.test(trimmed)) trimmed = trimmed.replace(",", ".");
    if (missingTokens.has(trimmed.toLowerCase())) return { missing: true, nan: trimmed.toLowerCase() === "nan" };
    if (/^[+-]?(inf|infinity)$/i.test(trimmed)) return { reason: "is infinite" };
    if (!decimalPattern.test(trimmed)) return { reason: "is not a number ('" + shorten(trimmed) + "')" };
    const value = Number(trimmed);
    return Number.isFinite(value) ? { value } : { reason: "is too large to read" };
  }

  function shorten(text) {
    return text.length > 24 ? text.slice(0, 21) + "…" : text;
  }

  // ---- Building the spectrum ---------------------------------------------------------------------------------------------
  // mapping: field -> column index or null. units: { wavelength, flux } unit keys. options.decimalComma: bool.
  // Rows that cannot be used are counted with a reason and never enter the spectrum; the valid rows are kept.
  // Result: { ok: true, points, bad, badSummary, total, units, sources, mapping, decimalComma } or { ok: false, code, message }.
  function buildSpectrum(table, mapping, units, options = {}) {
    const missing = requiredFields.filter((field) => mapping[field] === null || mapping[field] === undefined);
    if (missing.length) {
      return { ok: false, code: "needs-columns", message: "Choose the column for " + missing.join(" and ") + " to plot this table." };
    }
    if (!wavelengthUnits[units.wavelength]) return { ok: false, code: "needs-units", message: "Choose the wavelength unit of this file. A spectrum cannot be plotted without it." };
    if (!fluxUnits[units.flux]) return { ok: false, code: "needs-units", message: "Choose the flux unit of this file. A spectrum cannot be plotted without it." };
    const used = fieldNames.map((field) => mapping[field]).filter((index) => index !== null && index !== undefined);
    if (new Set(used).size !== used.length) return { ok: false, code: "duplicate-columns", message: "One column is chosen for two fields. Give each field its own column." };
    if (table.records.length === 0) {
      return { ok: false, code: "no-data-rows", message: "The table has a header but no data rows, so there is nothing to plot." };
    }

    const decimalComma = Boolean(options.decimalComma) && table.delimiter !== ",";
    const width = table.headers.length;
    const points = [];
    const bad = [];
    const cell = (cells, field) => (mapping[field] === null || mapping[field] === undefined ? "" : (cells[mapping[field]] ?? "").trim());
    const mapped = new Set(used);

    table.records.forEach((record, order) => {
      const cells = record.cells;
      const fail = (reason) => bad.push({ line: record.line, row: order + 1, reason });
      if (cells.length !== width) return fail("the row has " + cells.length + " fields instead of " + width);

      const wavelength = parseNumber(cell(cells, "wavelength"), decimalComma);
      if (wavelength.missing) return fail("the wavelength is empty");
      if (wavelength.reason) return fail("the wavelength " + wavelength.reason);
      if (!(wavelength.value > 0)) return fail("the wavelength must be greater than 0");

      const flux = parseNumber(cell(cells, "flux"), decimalComma);
      if (flux.missing) return fail(flux.nan ? "the flux is NaN" : "the flux is empty");
      if (flux.reason) return fail("the flux " + flux.reason);

      let fluxErr = null;
      const error = parseNumber(cell(cells, "flux_err"), decimalComma);
      if (error.reason) return fail("flux_err " + error.reason);
      if (!error.missing) {
        if (error.value < 0) return fail("flux_err is negative");
        fluxErr = error.value;
      }

      let width_ = null;
      const bandWidth = parseNumber(cell(cells, "lambda_width"), decimalComma);
      if (bandWidth.reason) return fail("lambda_width " + bandWidth.reason);
      if (!bandWidth.missing) {
        if (!(bandWidth.value > 0)) return fail("lambda_width must be greater than 0");
        width_ = bandWidth.value;
      }

      let flags = null;
      const flagText = cell(cells, "flags");
      if (!missingTokens.has(flagText.toLowerCase())) {
        const parsed = parseNumber(flagText, false);
        if (parsed.reason || !Number.isInteger(parsed.value) || parsed.value < 0 || parsed.value > maxFlagValue) {
          return fail("flags '" + shorten(flagText) + "' is not a non-negative integer");
        }
        flags = parsed.value;
      }

      let mjd = null;
      const mjdValue = parseNumber(cell(cells, "mjd"), decimalComma);
      if (mjdValue.reason) return fail("mjd " + mjdValue.reason);
      if (!mjdValue.missing) mjd = mjdValue.value;

      const extra = {};
      table.headers.forEach((name, index) => { if (!mapped.has(index)) extra[name || "column " + (index + 1)] = cells[index].trim(); });
      points.push({
        id: points.length, line: record.line, row: order + 1,
        wavelength: wavelength.value, flux: flux.value, fluxErr, width: width_, flags,
        source: cell(cells, "source_id"), obs: cell(cells, "obs_id"), mjd,
        ra: cell(cells, "ra"), dec: cell(cells, "dec"), method: cell(cells, "method"),
        cells: cells.map((value) => value.trim()), extra,
      });
    });

    const summary = new Map();
    for (const row of bad) {
      const reason = row.reason.replace(/^the row has \d+ fields instead of \d+$/, "the row has the wrong number of fields");
      summary.set(reason, (summary.get(reason) ?? 0) + 1);
    }
    const badSummary = [...summary].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
    if (points.length === 0) {
      return {
        ok: false, code: "no-valid-rows", bad, badSummary,
        message: (table.records.length === 1 ? "The only row cannot" : "None of the " + table.records.length + " rows can") + " be used. Most common problem: " + badSummary[0].reason + " (" + badSummary[0].count + (badSummary[0].count === 1 ? " row)." : " rows).")
      };
    }
    return {
      ok: true, points, bad, badSummary, total: table.records.length, units: { wavelength: units.wavelength, flux: units.flux },
      sources: groupSources(points), mapping: { ...mapping }, decimalComma,
    };
  }

  function groupSources(points) {
    const sources = new Map();
    for (const point of points) {
      const key = sourceKey(point);
      if (!sources.has(key)) sources.set(key, { key, label: key || "Unspecified source", count: 0, observations: new Map() });
      const source = sources.get(key);
      source.count++;
      const observation = source.observations.get(point.obs) ?? { key: point.obs, label: point.obs || "Unspecified observation", count: 0, mjd: point.mjd };
      observation.count++;
      source.observations.set(point.obs, observation);
    }
    return [...sources.values()].map((source) => ({ ...source, observations: [...source.observations.values()] }));
  }

  // A source is identified by source_id; without one, by its coordinates; otherwise it is "Unspecified source".
  function sourceKey(point) {
    if (point.source) return point.source;
    if (point.ra !== "" && point.dec !== "") return "RA " + point.ra + ", Dec " + point.dec;
    return "";
  }

  // ---- Selecting and ordering --------------------------------------------------------------------------------------------
  // Parse the wavelength-range inputs. Empty means open-ended. Result { ok, min, max } in the given unit, or { ok:false, message }.
  function parseRange(minText, maxText, decimalComma = false) {
    const parse = (text, name) => {
      if (String(text ?? "").trim() === "") return { value: null };
      const parsed = parseNumber(text, decimalComma);
      if (parsed.missing || parsed.reason) return { error: "The " + name + " wavelength " + (parsed.reason ?? "is not a number") + "." };
      if (!(parsed.value > 0)) return { error: "The " + name + " wavelength must be greater than 0." };
      return { value: parsed.value };
    };
    const low = parse(minText, "minimum");
    if (low.error) return { ok: false, message: low.error };
    const high = parse(maxText, "maximum");
    if (high.error) return { ok: false, message: high.error };
    if (low.value !== null && high.value !== null && low.value >= high.value) {
      return { ok: false, message: "The minimum wavelength must be smaller than the maximum." };
    }
    return { ok: true, min: low.value, max: high.value };
  }

  // selection: { source: key, obs: key | null (all), flags: "all" | "clean" | "flagged", min, max, rangeUnit }.
  // The range is converted into the file unit once, so no point is compared in a rounded unit.
  function selectPoints(spectrum, selection) {
    const unit = spectrum.units.wavelength;
    const rangeUnit = selection.rangeUnit ?? unit;
    const min = selection.min === null || selection.min === undefined ? -Infinity : convert(selection.min, rangeUnit, unit, "wavelength");
    const max = selection.max === null || selection.max === undefined ? Infinity : convert(selection.max, rangeUnit, unit, "wavelength");
    const chosen = spectrum.points.filter((point) => {
      if (selection.source !== undefined && selection.source !== null && sourceKey(point) !== selection.source) return false;
      if (selection.obs !== undefined && selection.obs !== null && point.obs !== selection.obs) return false;
      if (point.wavelength < min || point.wavelength > max) return false;
      if (selection.flags === "clean" && point.flags) return false;
      if (selection.flags === "flagged" && !point.flags) return false;
      return true;
    });
    return chosen.sort((a, b) => a.wavelength - b.wavelength || a.line - b.line);
  }

  // The point in display units. Errors and widths are converted exactly like the value.
  function displayPoint(point, units, display) {
    const flux = (value) => (value === null ? null : convert(value, units.flux, display.flux, "flux"));
    const wave = (value) => (value === null ? null : convert(value, units.wavelength, display.wavelength, "wavelength"));
    return { point, wavelength: wave(point.wavelength), flux: flux(point.flux), fluxErr: flux(point.fluxErr), width: wave(point.width) };
  }

  const sortKeys = {
    line: (point) => point.line, wavelength: (point) => point.wavelength, flux: (point) => point.flux,
    fluxErr: (point) => point.fluxErr, width: (point) => point.width, flags: (point) => point.flags,
    source: (point) => point.source, obs: (point) => point.obs, mjd: (point) => point.mjd,
  };

  // Stable sort by a column; empty values always go last, in either direction.
  function sortPoints(points, key, direction = "asc") {
    const read = sortKeys[key];
    if (!read) throw new RangeError("Unknown sort column: " + key);
    const sign = direction === "desc" ? -1 : 1;
    const empty = (value) => value === null || value === undefined || value === "";
    return points.map((point, order) => ({ point, order, value: read(point) })).sort((a, b) => {
      if (empty(a.value) || empty(b.value)) return empty(a.value) === empty(b.value) ? a.order - b.order : empty(a.value) ? 1 : -1;
      const compare = typeof a.value === "string" ? a.value.localeCompare(b.value, "en", { numeric: true }) : a.value - b.value;
      return compare * sign || a.order - b.order;
    }).map((entry) => entry.point);
  }

  // ---- Axes --------------------------------------------------------------------------------------------------------------
  function formatNumber(value, digits = 6) {
    if (value === null || value === undefined || Number.isNaN(value)) return "";
    if (value === 0) return "0";
    const magnitude = Math.abs(value);
    if (magnitude >= 1e-3 && magnitude < 1e7) return String(Number(value.toPrecision(digits)));
    return Number(value.toPrecision(digits)).toExponential().replace("e+", "e");
  }

  function niceStep(span, count) {
    const rough = span / Math.max(1, count);
    const power = 10 ** Math.floor(Math.log10(rough));
    const fraction = rough / power;
    return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
  }

  // Axis for a data extent. scale "linear" or "log". Returns { min, max, scale, ticks: [{ value, label }] }.
  // Linear axes pad the extent by 4 % unless exact is set; log axes need min > 0.
  function computeAxis(low, high, scale, { count = 6, exact = false } = {}) {
    if (!Number.isFinite(low) || !Number.isFinite(high)) throw new RangeError("The axis extent must be finite.");
    if (scale === "log") {
      if (!(low > 0)) throw new RangeError("A logarithmic axis needs a positive minimum.");
      if (high <= low) { low /= 1.5; high *= 1.5; }
      else if (!exact) { const pad = (high / low) ** 0.04; low /= pad; high *= pad; }
      const ticks = [];
      const first = Math.floor(Math.log10(low));
      const last = Math.ceil(Math.log10(high));
      const decades = last - first;
      const multipliers = decades <= 1 ? [1, 2, 3, 4, 5, 6, 8] : decades <= 3 ? [1, 2, 5] : [1];
      for (let power = first; power <= last; power++) {
        for (const multiplier of multipliers) {
          const value = Number((multiplier + "e" + power));
          if (value >= low * 0.9999999 && value <= high * 1.0000001) ticks.push({ value, label: formatNumber(value, 3) });
        }
      }
      return { min: low, max: high, scale, ticks };
    }
    if (high <= low) {
      const pad = Math.abs(low) * 0.05 || 1;
      low -= pad; high += pad;
    } else if (!exact) {
      const pad = (high - low) * 0.04;
      low -= pad; high += pad;
    }
    const step = niceStep(high - low, count);
    const ticks = [];
    for (let value = Math.ceil(low / step) * step; value <= high + step * 1e-9; value += step) {
      const rounded = Number(value.toPrecision(12));
      ticks.push({ value: rounded, label: formatNumber(rounded, 6) });
    }
    return { min: low, max: high, scale, ticks };
  }

  // What the logarithmic flux axis cannot show. points are display points from displayPoint().
  function logDisclosure(rows) {
    const dropped = rows.filter((row) => !(row.flux > 0));
    const clipped = rows.filter((row) => row.flux > 0 && row.fluxErr !== null && row.flux - row.fluxErr <= 0);
    return { dropped, clipped, shown: rows.length - dropped.length };
  }

  const api = {
    limits, wavelengthUnits, fluxUnits, parseUnit, unitLabel, convert, shiftExponent,
    flagDefinitions, decodeFlags,
    decodeBytes, detectDelimiter, parseDelimited, readTable,
    fieldNames, contractColumns, contractUnits, detectColumns, unitFromHeader,
    parseNumber, buildSpectrum, sourceKey, parseRange, selectPoints, displayPoint, sortPoints,
    formatNumber, computeAxis, logDisclosure,
  };
  root.AstroNotSpectrum = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);
