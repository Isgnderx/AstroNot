// Observation-pair model for Time Machine (and, later, Image Differencing).
//
// UI-independent: no DOM access. Loads as a classic browser script (global `AstroNotPair`) and as a CommonJS module.
// It needs tools/wcs.js (global `AstroNotWcs`, or require("./wcs.js")) for every sky and pixel computation.
//
// WHAT IT DECIDES
//   - Observation time from DATE-OBS, MJD-OBS and TIMESYS (parseObservationTime), kept apart from DATE, the HDU
//     creation time. A hand-typed time is a separate source (manualObservationTime).
//   - Whether two images cover the same sky (skyOverlap) and whether they lie on the same pixel grid (gridCompatibility).
//     Equal array sizes alone never make a common grid: the sky position of every sample pixel must agree.
//   - Which comparison features are allowed: a shared pan/zoom view and Blink need a verified common grid and
//     must never be offered for a copy of one observation presented as two (duplicate detection).
//   - Comparison conditions (units, wavelength, exposure, pixel scale ...) that a reader needs before interpreting
//     differences between the two images.
//
// Roles are "reference" and "comparison". The comparison is later in time than the reference only when the times say so.
//
// PIXEL CONVENTION: the FITS convention of wcs.js. Continuous, 1-based coordinates; the centre of the first array element
// is (1, 1); the image covers x in [0.5, width + 0.5].
(function (root) {
  "use strict";

  const wcsLib = typeof module === "object" && module.exports ? require("./wcs.js") : root.AstroNotWcs;
  const { angularSeparation, fitScale, insideImage } = wcsLib;

  const secondsPerDay = 86400;

  function isNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  // ---- Observation time ----------------------------------------------------------------------------------------------
  const timeScales = { UTC: "UTC", TAI: "TAI", IAT: "TAI", TT: "TT", TDT: "TT", ET: "TT", TDB: "TDB", TCG: "TCG", TCB: "TCB", GPS: "GPS", UT1: "UT1" };
  const mjdMin = 10000; // 1886
  const mjdMax = 100000; // 2132

  function pad(value, length = 2) {
    return String(value).padStart(length, "0");
  }

  // "YYYY-MM-DD" or "YYYY-MM-DDThh:mm:ss[.fff]" (a space may replace T) -> { mjd, precision } or { error }.
  function parseIsoDate(text) {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?$/.exec(String(text).trim());
    if (!match) return { error: "'" + String(text).trim() + "' is not an ISO-8601 date such as 2025-05-24T04:24:53.232." };
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const hasTime = match[4] !== undefined;
    const hour = hasTime ? Number(match[4]) : 0;
    const minute = hasTime ? Number(match[5]) : 0;
    const second = match[6] !== undefined ? Number(match[6]) : 0;
    if (year < 1900 || year > 2200) return { error: "The year " + year + " is outside the supported range 1900 to 2200." };
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
      return { error: "'" + match[1] + "-" + match[2] + "-" + match[3] + "' is not a calendar date." };
    }
    if (hour > 23 || minute > 59 || second >= 60) return { error: "The time of day in '" + String(text).trim() + "' is out of range." };
    const ms = Date.UTC(year, month - 1, day, hour, minute, 0) + Math.round(second * 1000);
    return { mjd: ms / 86400000 + 40587, precision: hasTime && match[6] !== undefined ? "second" : hasTime ? "minute" : "day" };
  }

  // MJD -> "YYYY-MM-DD hh:mm:ss.fff" (no time-scale suffix). The fraction is left out for day precision.
  function formatMjd(mjd, precision = "second") {
    const date = new Date(Math.round((mjd - 40587) * 86400000));
    const day = date.getUTCFullYear() + "-" + pad(date.getUTCMonth() + 1) + "-" + pad(date.getUTCDate());
    if (precision === "day") return day;
    const clock = pad(date.getUTCHours()) + ":" + pad(date.getUTCMinutes());
    if (precision === "minute") return day + " " + clock;
    return day + " " + clock + ":" + pad(date.getUTCSeconds());
  }

  function timeResult(mjd, scale, source, sourceLabel, precision, issues, processed, manual = false) {
    return {
      valid: true, mjd, scale, source, sourceLabel, precision, issues, processed, manual,
      display: formatMjd(mjd, precision), // e.g. 2025-05-24 04:24:53
      iso: new Date(Math.round((mjd - 40587) * 86400000)).toISOString().replace("Z", ""),
    };
  }

  function timeFailure(reason, issues, processed) {
    return { valid: false, reason, issues, processed, scale: null, source: null, sourceLabel: null };
  }

  // Observation time of an HDU header (fields as produced by readFitsHdus). `DATE` (file or HDU creation time) is
  // returned as `processed` only; it is never used as the observation time.
  function parseObservationTime(fields) {
    const header = fields || {};
    const issues = [];
    const processed = typeof header.DATE === "string" && header.DATE.trim() ? header.DATE.trim() : null;

    let scale = "UTC";
    if (header.TIMESYS !== undefined) {
      const key = String(header.TIMESYS).trim().toUpperCase();
      if (!timeScales[key]) return timeFailure("Observation time unavailable", ["TIMESYS is '" + String(header.TIMESYS).trim() + "', which is not a time scale this tool can compare."], processed);
      scale = timeScales[key];
    } else {
      issues.push("TIMESYS is missing, so UTC is assumed (the FITS default).");
    }

    let fromDate = null;
    if (header["DATE-OBS"] !== undefined && String(header["DATE-OBS"]).trim() !== "") {
      const parsed = parseIsoDate(header["DATE-OBS"]);
      if (parsed.error) issues.push("DATE-OBS ignored: " + parsed.error);
      else fromDate = parsed;
    }
    let fromMjd = null;
    if (header["MJD-OBS"] !== undefined) {
      const value = header["MJD-OBS"];
      if (!isNumber(value) || value < mjdMin || value > mjdMax) issues.push("MJD-OBS ignored: '" + String(value) + "' is not a plausible Modified Julian Date.");
      else fromMjd = value;
    }

    if (fromDate && fromMjd !== null) {
      const difference = Math.abs(fromDate.mjd - fromMjd) * secondsPerDay;
      const tolerance = fromDate.precision === "day" ? secondsPerDay : fromDate.precision === "minute" ? 60 : 1;
      if (difference > tolerance) {
        return timeFailure("Observation time unavailable", issues.concat("DATE-OBS and MJD-OBS disagree by " + (difference >= 3600 ? (difference / 3600).toFixed(2) + " hours" : difference.toFixed(1) + " seconds") + ", so neither is trusted."), processed);
      }
      // The more precise value wins; MJD-OBS is a number and keeps its full precision.
      return timeResult(fromMjd, scale, "DATE-OBS+MJD-OBS", "DATE-OBS and MJD-OBS", Number.isInteger(fromMjd) ? "day" : "second", issues, processed);
    }
    if (fromDate) {
      if (fromDate.precision === "day") issues.push("DATE-OBS has no time of day.");
      return timeResult(fromDate.mjd, scale, "DATE-OBS", "DATE-OBS", fromDate.precision, issues, processed);
    }
    if (fromMjd !== null) return timeResult(fromMjd, scale, "MJD-OBS", "MJD-OBS", "second", issues, processed);
    return timeFailure("Observation time unavailable", issues.concat(header["DATE-OBS"] === undefined && header["MJD-OBS"] === undefined ? ["The header has neither DATE-OBS nor MJD-OBS."] : []), processed);
  }

  // A time typed by the user. It is UTC and is always labelled as entered manually.
  function manualObservationTime(text, processed = null) {
    const parsed = parseIsoDate(text);
    if (parsed.error) return { valid: false, reason: parsed.error, issues: [], processed, scale: null, source: null, sourceLabel: null };
    return timeResult(parsed.mjd, "UTC", "manual", "Entered manually", parsed.precision, [], processed, true);
  }

  function formatDuration(days) {
    const seconds = Math.round(Math.abs(days) * secondsPerDay);
    if (seconds < 60) return seconds + " s";
    const wholeDays = Math.floor(seconds / secondsPerDay);
    const hours = Math.floor((seconds % secondsPerDay) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (wholeDays > 0) return wholeDays + " d " + hours + " h";
    return hours > 0 ? hours + " h " + minutes + " min" : minutes + " min";
  }

  // Order of two observation times. Both must be valid and on the same time scale.
  function compareTimes(reference, comparison) {
    if (!reference || !reference.valid || !comparison || !comparison.valid) {
      const missing = [!reference || !reference.valid ? "reference" : "", !comparison || !comparison.valid ? "comparison" : ""].filter(Boolean).join(" and ");
      return { state: "unavailable", reason: "Observation time unavailable for the " + missing + "." };
    }
    if (reference.scale !== comparison.scale) {
      return { state: "unavailable", reason: "The time scales differ (" + reference.scale + " and " + comparison.scale + "), so the times are not ordered." };
    }
    const deltaDays = comparison.mjd - reference.mjd;
    const coarse = reference.precision === "day" || comparison.precision === "day";
    const same = coarse ? Math.floor(reference.mjd) === Math.floor(comparison.mjd) : Math.abs(deltaDays) * secondsPerDay < 1;
    if (same) return { state: "same", deltaDays: 0, text: coarse ? "Same date" : "Same time" };
    const later = deltaDays > 0;
    return {
      state: "ordered", deltaDays, earlier: later ? "reference" : "comparison",
      text: formatDuration(deltaDays) + (later ? " after the reference" : " before the reference"),
    };
  }

  // Timeline of two observations, ordered by time. Fractions run from 0 (earliest) to 1 (latest); null when either
  // time is unusable or the scales differ.
  function timelineModel(reference, comparison) {
    const order = compareTimes(reference, comparison);
    if (order.state === "unavailable") return null;
    const items = [
      { role: "reference", time: reference },
      { role: "comparison", time: comparison },
    ].sort((a, b) => a.time.mjd - b.time.mjd || (a.role === "reference" ? -1 : 1));
    const span = items[1].time.mjd - items[0].time.mjd;
    return {
      state: order.state, spanDays: span, text: order.text,
      items: items.map((item, index) => ({ role: item.role, time: item.time, fraction: order.state === "same" ? 0.5 : index })),
    };
  }

  // ---- Per-pixel wavelength (SPHEREx WCS-WAVE, a -TAB lookup) -------------------------------------------------------
  const tableTypes = { L: 1, X: 1, B: 1, I: 2, J: 4, K: 8, A: 1, E: 4, D: 8, C: 8, M: 16, P: 8, Q: 16 };

  function tableColumns(fields) {
    const count = fields.TFIELDS;
    if (!Number.isInteger(count) || count < 1 || count > 999) throw new Error("The table has no valid TFIELDS.");
    const columns = [];
    let offset = 0;
    for (let index = 1; index <= count; index++) {
      const form = /^\s*(\d*)([A-Z])/.exec(String(fields["TFORM" + index] ?? ""));
      if (!form || !tableTypes[form[2]]) throw new Error("TFORM" + index + " is not supported.");
      const repeat = form[1] === "" ? 1 : Number(form[1]);
      const size = repeat * tableTypes[form[2]];
      columns.push({ name: String(fields["TTYPE" + index] ?? "").trim().toUpperCase(), type: form[2], repeat, offset, size });
      offset += size;
    }
    return { columns, rowLength: offset };
  }

  function readColumn(view, rowOffset, column) {
    const out = new Float64Array(column.repeat);
    for (let index = 0; index < column.repeat; index++) {
      const at = rowOffset + column.offset + index * tableTypes[column.type];
      out[index] = column.type === "E" ? view.getFloat32(at, false)
        : column.type === "D" ? view.getFloat64(at, false)
          : column.type === "J" ? view.getInt32(at, false)
            : column.type === "I" ? view.getInt16(at, false)
              : column.type === "B" ? view.getUint8(at)
                : NaN;
    }
    return out;
  }

  // Reads the lookup table that the image header names with PSi_0W (default EXTNAME 'WCS-WAVE') from the bytes of its
  // BINTABLE data. Returns { x, y, wave, bandwidth } with the control points and 2 x nx x ny values, or null.
  function parseWaveTable(bytes, tableFields, imageFields) {
    try {
      const names = {
        values: String(imageFields.PS1_1W ?? "VALUES").trim().toUpperCase(),
        x: String(imageFields.PS1_2W ?? "X").trim().toUpperCase(),
        y: String(imageFields.PS2_2W ?? "Y").trim().toUpperCase(),
      };
      const { columns, rowLength } = tableColumns(tableFields);
      if (tableFields.NAXIS1 !== rowLength || tableFields.NAXIS2 !== 1) return null; // One row holds the whole table.
      const view = new DataView(bytes instanceof ArrayBuffer ? bytes : bytes.buffer, bytes.byteOffset ?? 0, bytes.byteLength);
      const pick = (name) => columns.find((column) => column.name === name);
      const [xColumn, yColumn, valueColumn] = [pick(names.x), pick(names.y), pick(names.values)];
      if (!xColumn || !yColumn || !valueColumn) return null;
      const x = readColumn(view, 0, xColumn);
      const y = readColumn(view, 0, yColumn);
      const values = readColumn(view, 0, valueColumn);
      if (values.length !== 2 * x.length * y.length) return null;
      const waveIndex = (imageFields.PV1_3W ?? 1) - 1;
      const bandIndex = (imageFields.PV2_3W ?? 2) - 1;
      if (waveIndex !== 0 || bandIndex !== 1) return null;
      return { x, y, values };
    } catch {
      return null;
    }
  }

  function bracket(axis, position) {
    const last = axis.length - 1;
    if (!(position >= axis[0] && position <= axis[last])) return null;
    let low = 0;
    while (low < last - 1 && axis[low + 1] <= position) low++;
    const span = axis[low + 1] - axis[low];
    return { low, fraction: span > 0 ? (position - axis[low]) / span : 0 };
  }

  // Wavelength and bandwidth (micron) at a FITS pixel of the image, by bilinear lookup. `fields` is the image header
  // (CRPIXiW, CRVALiW, CDELTiW). Null when the lookup does not cover the pixel or the header uses PCiW.
  function wavelengthAt(table, fields, x, y) {
    if (!table || !fields) return null;
    for (const key of ["CRPIX1W", "CRPIX2W", "CRVAL1W", "CRVAL2W", "CDELT1W", "CDELT2W"]) if (!isNumber(fields[key])) return null;
    if (["PC1_1W", "PC1_2W", "PC2_1W", "PC2_2W"].some((key) => fields[key] !== undefined)) return null;
    const unit1 = String(fields.CUNIT1W ?? "um").trim().toLowerCase();
    if (unit1 !== "um" || String(fields.CUNIT2W ?? "um").trim().toLowerCase() !== "um") return null;
    const psi1 = fields.CRVAL1W + fields.CDELT1W * (x - fields.CRPIX1W);
    const psi2 = fields.CRVAL2W + fields.CDELT2W * (y - fields.CRPIX2W);
    const a = bracket(table.x, psi1);
    const b = bracket(table.y, psi2);
    if (!a || !b) return null;
    const nx = table.x.length;
    const at = (ix, iy, k) => table.values[k + 2 * (ix + nx * iy)];
    const blend = (k) => (1 - b.fraction) * ((1 - a.fraction) * at(a.low, b.low, k) + a.fraction * at(a.low + 1, b.low, k)) +
      b.fraction * ((1 - a.fraction) * at(a.low, b.low + 1, k) + a.fraction * at(a.low + 1, b.low + 1, k));
    const micron = blend(0);
    const bandwidth = blend(1);
    return isNumber(micron) && isNumber(bandwidth) ? { micron, bandwidth } : null;
  }

  // Wavelength at the image centre with the range over the four corners: { center, min, max } or null.
  function wavelengthSummary(table, fields, width, height) {
    const center = wavelengthAt(table, fields, (width + 1) / 2, (height + 1) / 2);
    if (!center) return null;
    const corners = [[0.5, 0.5], [width + 0.5, 0.5], [0.5, height + 0.5], [width + 0.5, height + 0.5]]
      .map(([x, y]) => wavelengthAt(table, fields, x, y)).filter(Boolean);
    const all = corners.map((entry) => entry.micron).concat(center.micron);
    return { center, min: Math.min(...all), max: Math.max(...all) };
  }

  // ---- Observation metadata -----------------------------------------------------------------------------------------
  function text(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  // Everything Time Machine shows about one image HDU. `options.wavelength` comes from wavelengthSummary();
  // `options.manualTime` is a time the user typed when the header has none.
  function describeObservation(hdu, hduIndex, options = {}) {
    const fields = hdu.fields;
    let time = parseObservationTime(fields);
    if (!time.valid && options.manualTime) time = Object.assign(options.manualTime, { processed: time.processed, headerIssues: time.issues });
    const exposure = [fields.XPOSURE, fields.EXPTIME, fields.EXPOSURE].find(isNumber);
    return {
      obsId: text(fields.OBSID),
      hduIndex,
      hduName: hdu.name,
      width: hdu.axes[0],
      height: hdu.axes[1],
      unit: text(fields.BUNIT),
      frame: text(fields.RADESYS),
      detector: isNumber(fields.DETECTOR) ? fields.DETECTOR : null,
      instrument: text(fields.INSTRUME) ?? text(fields.TELESCOP),
      filter: text(fields.FILTER) ?? text(fields.BAND),
      exposureSeconds: exposure ?? null,
      time,
      processed: time.processed,
      wavelength: options.wavelength ?? null,
    };
  }

  // ---- Units, fingerprints ------------------------------------------------------------------------------------------
  // Whitespace is normalised, case is kept: FITS units are case-sensitive and "mJy/sr" and "MJy/sr" differ by 10^9.
  // Same canonical form as canonicalUnit() in difference.js.
  function normalizeUnit(unit) {
    if (typeof unit !== "string") return null;
    const clean = unit.trim().replace(/\s*(\*\*|[/*^])\s*/g, (match, operator) => operator === "**" ? "^" : operator).replace(/\s+/g, " ");
    return clean || null;
  }

  // 64-bit-wide FNV-1a style hash (two 32-bit lanes) of the calibrated values. Used only to detect identical data.
  function fingerprintValues(values) {
    const words = new Uint32Array(values.buffer, values.byteOffset, values.length * 2);
    let a = 0x811c9dc5;
    let b = 0x01000193 ^ words.length;
    for (let index = 0; index < words.length; index++) {
      a = Math.imul(a ^ words[index], 0x01000193) >>> 0;
      b = Math.imul(b ^ words[index] ^ (a >>> 7), 0x85ebca6b) >>> 0;
    }
    return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0") + ":" + values.length;
  }

  // ---- Footprint overlap and grid check -----------------------------------------------------------------------------
  function pixelScaleArcsec(wcs, width, height) {
    if (!wcs) return null;
    const cx = (width + 1) / 2;
    const cy = (height + 1) / 2;
    const origin = wcs.pixelToSky(cx, cy);
    const east = wcs.pixelToSky(cx + 1, cy);
    const north = wcs.pixelToSky(cx, cy + 1);
    if (!origin || !east || !north) return null;
    const along = angularSeparation(origin.ra, origin.dec, east.ra, east.dec) * 3600;
    const up = angularSeparation(origin.ra, origin.dec, north.ra, north.dec) * 3600;
    return Math.sqrt(along * up);
  }

  function fractionInside(from, to, samples) {
    let inside = 0;
    for (let row = 0; row < samples; row++) {
      for (let column = 0; column < samples; column++) {
        const x = 0.5 + (column + 0.5) / samples * from.width;
        const y = 0.5 + (row + 0.5) / samples * from.height;
        const sky = from.wcs.pixelToSky(x, y);
        const pixel = sky && to.wcs.skyToPixel(sky.ra, sky.dec);
        if (pixel && insideImage(pixel.x, pixel.y, to.width, to.height)) inside++;
      }
    }
    return inside / (samples * samples);
  }

  // Overlap of two images on the sky, estimated on a regular sample of pixel centres of each image mapped through
  // both WCS. Each image is an object { width, height, wcs }; the result needs no common grid.
  // state: "full" (one image lies inside the other), "substantial" (at least half of one image is covered), "partial",
  // "none", or "unavailable" (a WCS is missing). Fractions are shares of each image that the other one covers.
  function skyOverlap(reference, comparison, samples = 41) {
    if (!reference || !comparison || !reference.wcs || !comparison.wcs) {
      return { state: "unavailable", reason: "Sky overlap needs a usable WCS in both images.", referenceCovered: null, comparisonCovered: null, centerSeparationDegrees: null };
    }
    const referenceCovered = fractionInside(reference, comparison, samples);
    const comparisonCovered = fractionInside(comparison, reference, samples);
    const best = Math.max(referenceCovered, comparisonCovered);
    const centerA = reference.wcs.pixelToSky((reference.width + 1) / 2, (reference.height + 1) / 2);
    const centerB = comparison.wcs.pixelToSky((comparison.width + 1) / 2, (comparison.height + 1) / 2);
    return {
      state: best >= 0.98 ? "full" : best >= 0.5 ? "substantial" : best > 0 ? "partial" : "none",
      referenceCovered, comparisonCovered,
      centerSeparationDegrees: centerA && centerB ? angularSeparation(centerA.ra, centerA.dec, centerB.ra, centerB.dec) : null,
    };
  }

  // Whether two images share one pixel grid on the sky. The arrays must have the same size AND every sample pixel
  // (a 9 x 9 lattice that includes the corners and the centre) must fall on the same sky position within
  // `tolerancePixels` of the other image. state: "same-grid", "different-size", "different-wcs" or "no-wcs".
  function gridCompatibility(reference, comparison, tolerancePixels = 0.05) {
    if (!reference || !comparison) return { state: "no-wcs", ok: false, reason: "Both images are needed to check the pixel grid." };
    if (!reference.wcs || !comparison.wcs) {
      return { state: "no-wcs", ok: false, reason: "A grid check needs a usable WCS in both images." };
    }
    if (reference.width !== comparison.width || reference.height !== comparison.height) {
      return {
        state: "different-size", ok: false,
        reason: "The images have different sizes (" + reference.width + " × " + reference.height + " and " + comparison.width + " × " + comparison.height + " pixels).",
      };
    }
    const steps = 9;
    let maxPixels = 0;
    let maxArcsec = 0;
    for (let row = 0; row < steps; row++) {
      for (let column = 0; column < steps; column++) {
        const x = 0.5 + column / (steps - 1) * reference.width;
        const y = 0.5 + row / (steps - 1) * reference.height;
        const sky = reference.wcs.pixelToSky(x, y);
        const other = comparison.wcs.pixelToSky(x, y);
        const back = sky && comparison.wcs.skyToPixel(sky.ra, sky.dec);
        if (!sky || !other || !back) {
          return { state: "different-wcs", ok: false, maxOffsetPixels: null, maxOffsetArcsec: null, reason: "A sample position of the reference image does not map onto the comparison image." };
        }
        maxPixels = Math.max(maxPixels, Math.hypot(back.x - x, back.y - y));
        maxArcsec = Math.max(maxArcsec, angularSeparation(sky.ra, sky.dec, other.ra, other.dec) * 3600);
      }
    }
    if (maxPixels <= tolerancePixels) {
      return { state: "same-grid", ok: true, maxOffsetPixels: maxPixels, maxOffsetArcsec: maxArcsec, reason: "" };
    }
    return {
      state: "different-wcs", ok: false, maxOffsetPixels: maxPixels, maxOffsetArcsec: maxArcsec,
      reason: "The images have the same size, but their sky coordinates differ by up to " + Number(maxPixels.toPrecision(3)) + " pixels (" + Number(maxArcsec.toPrecision(3)) + " arcsec).",
    };
  }

  // ---- The pair -----------------------------------------------------------------------------------------------------
  function significant(value, digits = 4) {
    return Number(value.toPrecision(digits));
  }

  function wavelengthText(summary) {
    if (!summary) return null;
    return significant(summary.center.micron) + " μm (bandwidth " + significant(summary.center.bandwidth, 3) + " μm)";
  }

  function condition(key, label, referenceText, comparisonText, status, note = "") {
    return { key, label, reference: referenceText ?? "Unavailable", comparison: comparisonText ?? "Unavailable", status, note };
  }

  function sameOrUnknown(a, b) {
    return a === null || a === undefined || b === null || b === undefined ? "unknown" : a === b ? "same" : "different";
  }

  // Compares two loaded observations. Each is
  //   { name, meta: describeObservation(...), width, height, wcs (wcs.js object or null), wcsReason, fingerprint }
  // and the result says what the pair is, what may be linked, and why not.
  function compareObservations(reference, comparison) {
    const rm = reference.meta;
    const cm = comparison.meta;
    const time = compareTimes(rm.time, cm.time);
    const overlap = skyOverlap(reference, comparison);
    const grid = gridCompatibility(reference, comparison);

    // A copy of one observation must never pass for two epochs.
    let duplicate = null;
    if (reference.fingerprint && reference.fingerprint === comparison.fingerprint) {
      duplicate = "Both images contain identical pixel values, so they are the same observation. Choose a different observation for the comparison.";
    } else if (rm.obsId && rm.obsId === cm.obsId && rm.detector === cm.detector && time.state === "same" && rm.hduName === cm.hduName) {
      duplicate = "Both images have observation ID " + rm.obsId + " and the same time, so they are the same observation.";
    }

    const units = sameOrUnknown(normalizeUnit(rm.unit), normalizeUnit(cm.unit));
    const scaleA = pixelScaleArcsec(reference.wcs, reference.width, reference.height);
    const scaleB = pixelScaleArcsec(comparison.wcs, comparison.width, comparison.height);
    const conditions = [];
    conditions.push(condition("unit", "Units (BUNIT)", rm.unit, cm.unit, units, units === "different" ? "Pixel values are in different units, so brightness is not directly comparable." : ""));
    conditions.push(condition("detector", "Detector", rm.detector === null ? null : "D" + rm.detector, cm.detector === null ? null : "D" + cm.detector, sameOrUnknown(rm.detector, cm.detector)));

    let bandStatus = "unknown";
    let bandNote = "";
    if (rm.wavelength && cm.wavelength) {
      const gap = Math.abs(rm.wavelength.center.micron - cm.wavelength.center.micron);
      const limit = Math.max(rm.wavelength.center.bandwidth, cm.wavelength.center.bandwidth);
      bandStatus = gap <= limit ? "same" : "different";
      bandNote = gap <= limit
        ? "The center wavelengths differ by " + significant(gap, 2) + " μm, within one bandwidth."
        : "The center wavelengths differ by " + significant(gap, 2) + " μm, more than one bandwidth. Brightness differences may reflect the band, not time.";
    }
    conditions.push(condition("wavelength", "Wavelength at image center", wavelengthText(rm.wavelength), wavelengthText(cm.wavelength), bandStatus, bandNote));

    const exposureText = (seconds) => seconds === null ? null : significant(seconds, 5) + " s";
    let exposureStatus = "unknown";
    if (rm.exposureSeconds !== null && cm.exposureSeconds !== null) {
      exposureStatus = Math.abs(rm.exposureSeconds - cm.exposureSeconds) <= 0.05 * Math.max(rm.exposureSeconds, cm.exposureSeconds) ? "same" : "different";
    }
    conditions.push(condition("exposure", "Exposure time", exposureText(rm.exposureSeconds), exposureText(cm.exposureSeconds), exposureStatus, exposureStatus === "different" ? "Different exposure times change the noise level and the depth." : ""));

    let scaleStatus = "unknown";
    if (scaleA !== null && scaleB !== null) scaleStatus = Math.abs(scaleA - scaleB) <= 0.01 * Math.max(scaleA, scaleB) ? "same" : "different";
    conditions.push(condition("scale", "Pixel scale", scaleA === null ? null : significant(scaleA, 4) + " arcsec", scaleB === null ? null : significant(scaleB, 4) + " arcsec", scaleStatus));
    conditions.push(condition("size", "Image size", rm.width + " × " + rm.height + " pixels", cm.width + " × " + cm.height + " pixels", rm.width === cm.width && rm.height === cm.height ? "same" : "different"));
    conditions.push(condition("frame", "Coordinate frame (RADESYS)", rm.frame, cm.frame, sameOrUnknown(rm.frame, cm.frame)));

    const warnings = [];
    if (duplicate) warnings.push({ code: "duplicate", severity: "error", text: duplicate });
    if (overlap.state === "none") warnings.push({ code: "no-overlap", severity: "error", text: "The images do not overlap on the sky, so they are not observations of the same field." });
    else if (overlap.state === "partial") warnings.push({ code: "partial-overlap", severity: "warning", text: "The images overlap only slightly (" + Math.round(Math.max(overlap.referenceCovered, overlap.comparisonCovered) * 100) + "% of the better covered image)." });
    else if (overlap.state === "unavailable") warnings.push({ code: "overlap-unavailable", severity: "warning", text: overlap.reason });
    if (time.state === "same" && !duplicate) warnings.push({ code: "same-time", severity: "warning", text: "Both observations have the same time, so the pair shows no change over time." });
    if (time.state === "unavailable") warnings.push({ code: "time-unavailable", severity: "info", text: time.reason });
    if (units === "different") warnings.push({ code: "unit", severity: "warning", text: conditions[0].note });
    if (bandStatus === "different") warnings.push({ code: "band", severity: "warning", text: bandNote });
    if (exposureStatus === "different") warnings.push({ code: "exposure", severity: "info", text: conditions.find((item) => item.key === "exposure").note });

    const linked = linkedViewDecision(grid, overlap, duplicate);
    return {
      reference, comparison, time, overlap, grid, duplicate, units, conditions, warnings,
      timeline: timelineModel(rm.time, cm.time),
      linkedView: linked,
      blink: linked.allowed ? { allowed: true, reason: "" } : { allowed: false, reason: linked.reason },
      sharedContrast: units === "same"
        ? { allowed: true, reason: "" }
        : { allowed: false, reason: units === "different" ? "The images use different units (" + rm.unit + " and " + cm.unit + ")." : "A unit is missing in one of the images, so they are not known to match." },
    };
  }

  function linkedViewDecision(grid, overlap, duplicate) {
    if (duplicate) return { allowed: false, reason: "The two images are the same observation." };
    if (overlap.state === "none") return { allowed: false, reason: "The images do not overlap on the sky." };
    if (!grid.ok) return { allowed: false, reason: grid.reason || "The images are not on a common pixel grid." };
    return { allowed: true, reason: "" };
  }

  // Display-only alignment: copies, for every pixel of the target grid, the value of the source pixel that covers the same
  // sky position (nearest neighbour, no interpolation, so values are never blended). Target pixels outside the source are
  // NaN. The result lies on the target grid by construction: its WCS is the target WCS. This is a resampling for viewing
  // and blinking, not a calibrated reprojection. source = { width, height, wcs, values }, target = { width, height, wcs }.
  function resampleOntoGrid(source, target) {
    if (!source.wcs || !target.wcs) return null;
    const values = new Float64Array(target.width * target.height).fill(NaN);
    let covered = 0;
    for (let row = 0; row < target.height; row++) {
      for (let column = 0; column < target.width; column++) {
        const sky = target.wcs.pixelToSky(column + 1, row + 1);
        const pixel = sky && source.wcs.skyToPixel(sky.ra, sky.dec);
        const index = pixel ? wcsLib.pixelIndex(pixel.x, pixel.y, source.width, source.height) : -1;
        if (index >= 0) {
          values[row * target.width + column] = source.values[index];
          covered++;
        }
      }
    }
    return { width: target.width, height: target.height, wcs: target.wcs, values, coveredFraction: covered / values.length };
  }

  // The same observations in swapped roles.
  function swapRoles(pair) {
    return compareObservations(pair.comparison, pair.reference);
  }

  // ---- Shared pan and zoom ------------------------------------------------------------------------------------------
  // A view state is { zoom, centerX, centerY }: zoom 1 shows the whole image in the panel, and the centre is a FITS
  // position. When the two panels show one common grid, the SAME state describes both, so the same pixel (and
  // therefore the same sky position) is under the same place of both panels. `fit` is the panel size that sets
  // zoom 1; for linked panels pass the smaller of the two so both get one scale.
  function createView(width, height) {
    return { zoom: 1, centerX: (width + 1) / 2, centerY: (height + 1) / 2 };
  }

  function viewGeometry(state, width, height, panel, fit = panel) {
    return { centerX: state.centerX, centerY: state.centerY, scale: fitScale(width, height, fit.width, fit.height) * state.zoom, width: panel.width, height: panel.height };
  }

  function zoomLimit(width, height, fit) {
    const base = fitScale(width, height, fit.width, fit.height);
    return Math.max(1, Math.max(64, base * 16) / base);
  }

  function clampView(state, width, height, fit) {
    state.zoom = Math.min(zoomLimit(width, height, fit), Math.max(1, state.zoom));
    state.centerX = Math.min(width + 0.5, Math.max(0.5, state.centerX));
    state.centerY = Math.min(height + 0.5, Math.max(0.5, state.centerY));
    return state;
  }

  // Zoom by `factor` keeping the FITS position under panel point (sx, sy) fixed.
  function zoomViewAt(state, factor, width, height, panel, fit, sx = panel.width / 2, sy = panel.height / 2) {
    const before = wcsLib.screenToFits(viewGeometry(state, width, height, panel, fit), sx, sy);
    state.zoom = Math.min(zoomLimit(width, height, fit), Math.max(1, state.zoom * factor));
    const scale = viewGeometry(state, width, height, panel, fit).scale;
    state.centerX = before.x - (sx - panel.width / 2) / scale;
    state.centerY = before.y + (sy - panel.height / 2) / scale;
    if (state.zoom === 1 && factor < 1 && sx === panel.width / 2 && sy === panel.height / 2) {
      state.centerX = (width + 1) / 2;
      state.centerY = (height + 1) / 2;
    }
    return clampView(state, width, height, fit);
  }

  function panViewByScreen(state, dx, dy, width, height, panel, fit) {
    const scale = viewGeometry(state, width, height, panel, fit).scale;
    state.centerX -= dx / scale;
    state.centerY += dy / scale;
    return clampView(state, width, height, fit);
  }

  // ---- Display range ------------------------------------------------------------------------------------------------
  // Percentile display range of calibrated values (NaN and infinities skipped). It is for display only; measurements
  // read `values` directly. Returns { low, high } or null when no finite value exists.
  function sampleFinite(values, limit = 65536) {
    const stride = Math.max(1, Math.ceil(values.length / limit));
    const samples = [];
    for (let index = 0; index < values.length; index += stride) if (Number.isFinite(values[index])) samples.push(values[index]);
    if (!samples.length && stride > 1) {
      for (let index = 0; index < values.length && samples.length < limit; index++) if (Number.isFinite(values[index])) samples.push(values[index]);
    }
    return samples;
  }

  function rangeOfSamples(samples, lowFraction, highFraction) {
    if (!samples.length) return null;
    samples.sort((a, b) => a - b);
    const last = samples.length - 1;
    let low = samples[Math.floor(last * lowFraction)];
    let high = samples[Math.ceil(last * highFraction)];
    if (low === high) {
      low = samples[0];
      high = samples[last];
    }
    return { low, high };
  }

  function displayRange(valuesList, lowFraction = 0.01, highFraction = 0.99) {
    const samples = [];
    for (const values of valuesList) for (const value of sampleFinite(values)) samples.push(value);
    return rangeOfSamples(samples, lowFraction, highFraction);
  }

  // ---- Blink --------------------------------------------------------------------------------------------------------
  const blinkSpeeds = [0.5, 1, 2]; // frames shown per second; at most 2, so a full on-off cycle stays at 1 Hz or slower
  const defaultBlinkSpeed = 1;

  // Allowed speeds. With reduced motion preferred only the two slowest remain.
  function blinkSpeedOptions(reducedMotion) {
    return reducedMotion ? blinkSpeeds.filter((speed) => speed <= 1) : blinkSpeeds.slice();
  }

  function clampBlinkSpeed(speed, reducedMotion) {
    const options = blinkSpeedOptions(reducedMotion);
    if (options.includes(speed)) return speed;
    return options.reduce((best, option) => Math.abs(option - speed) < Math.abs(best - speed) ? option : best, options[options.length - 1]);
  }

  function otherFrame(frame) {
    return frame === "reference" ? "comparison" : "reference";
  }

  // The blink state before the user starts it: stopped, showing the reference, never running by default.
  function createBlinkState(reducedMotion = false) {
    return { running: false, frame: "reference", speed: clampBlinkSpeed(defaultBlinkSpeed, reducedMotion) };
  }

  const api = {
    parseObservationTime, manualObservationTime, formatMjd, formatDuration, compareTimes, timelineModel,
    parseWaveTable, wavelengthAt, wavelengthSummary,
    describeObservation, normalizeUnit, fingerprintValues,
    pixelScaleArcsec, skyOverlap, gridCompatibility, compareObservations, linkedViewDecision, resampleOntoGrid, swapRoles,
    createView, viewGeometry, zoomLimit, clampView, zoomViewAt, panViewByScreen,
    displayRange, blinkSpeedOptions, clampBlinkSpeed, otherFrame, createBlinkState,
  };
  root.AstroNotPair = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);
