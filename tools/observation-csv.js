// Pure helpers for IRSA SIA results and SPHEREx level 2 product links (DR1, QR3 and QR2).
// Loaded by Observation Search and FITS Viewer; also loaded by tests/observation.test.mjs.
//
// Archive facts checked against the live service (see README, "Observation Search to FITS Viewer"):
// - SIA answers with HTTP 200 even for errors. With RESPONSEFORMAT=CSV an error still arrives as a
//   VOTable whose INFO element has name="QUERY_STATUS" value="ERROR".
// - The CSV has one row per observation and detector. It has no overflow flag.
// - The cloud_access column holds JSON with commas and is NOT quoted, so a raw row has more fields than
//   the header. joinUnquotedJson() puts those fields back together.
// - Each SPHEREx release is its own SIA collection (spherex_dr1, spherex_qr3, spherex_qr2) with the same columns.
//   The deep fields are separate collections (spherex_dr1_deep, spherex_qr3_deep) whose files sit under the same
//   dr1/level2 or qr3/level2 paths, so the CSV's obs_collection column is what marks a row as a deep-field row.
//   On 2026-11-14 spherex_qr2 answered with the header only (0 rows) while DR1 and QR3 returned rows. The same
//   observation can appear in several releases with different processing versions in the file path.
// - Cutouts are requested by appending ?center=RA,Dec&size=<value><unit> to a product URL.

const irsaMaxRecords = 2000;
const irsaHost = "irsa.ipac.caltech.edu";
const irsaReleases = {
  dr1: { collection: "spherex_dr1", label: "SPHEREx DR1" },
  qr3: { collection: "spherex_qr3", label: "SPHEREx QR3" },
  qr2: { collection: "spherex_qr2", label: "SPHEREx QR2" },
  dr1_deep: { collection: "spherex_dr1_deep", label: "SPHEREx DR1 deep fields" },
  qr3_deep: { collection: "spherex_qr3_deep", label: "SPHEREx QR3 deep fields" },
};
const irsaDefaultRelease = "dr1";
const irsaProductPath = /^\/ibe\/data\/spherex\/(dr1|qr3|qr2)\/level2\/[A-Za-z0-9._/-]+\.fits$/;
const irsaObservationId = /^[A-Za-z0-9._-]{1,64}$/;
const irsaRequiredColumns = ["obs_id", "access_url"];

function irsaIsRelease(key) {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(irsaReleases, key);
}

// The release a validated product URL belongs to ("dr1", "qr3" or "qr2"), or null.
function irsaReleaseOfUrl(url) {
  const match = irsaProductPath.exec(url.pathname);
  return match ? match[1] : null;
}

// Message for a search or file with no rows. It names the release and suggests the others.
function irsaEmptyMessage(release) {
  if (!irsaIsRelease(release)) {
    return "No observations in this file. Widen the radius, dates, or wavelength range, or choose another data release and prepare the search again.";
  }
  const others = Object.keys(irsaReleases).filter((key) => key !== release).map((key) => irsaReleases[key].label).join(" or ");
  return "No " + irsaReleases[release].label + " observations matched this search. " +
    (release === "qr2" ? "QR2 is archived and may return no rows. Try another data release (" + others + ")."
      : "Widen the radius, dates, or wavelength range, or try another data release (" + others + ").");
}

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character !== '"') field += character;
      else if (text[index + 1] === '"') { field += '"'; index++; }
      else quoted = false;
    } else if (character === '"' && field === "") {
      quoted = true;
    } else if (character === ",") {
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

function joinUnquotedJson(cells, width) {
  if (cells.length <= width) return cells;
  const joined = [];
  for (let index = 0; index < cells.length; index++) {
    let cell = cells[index];
    if (/^\s*[{[]/.test(cell)) {
      const depth = (text) => (text.match(/[{[]/g)?.length ?? 0) - (text.match(/[}\]]/g)?.length ?? 0);
      while (depth(cell) > 0 && index + 1 < cells.length) cell += "," + cells[++index];
    }
    joined.push(cell);
  }
  return joined;
}

function validateIrsaProductUrl(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    return null;
  }
  const clean = url.protocol === "https:" && url.hostname === irsaHost && !url.port &&
    !url.username && !url.password && !url.search && !url.hash;
  if (!clean || !irsaProductPath.test(url.pathname) || url.pathname.includes("//")) return null;
  return url;
}

function irsaDetector(url, bandpass) {
  const fromUrl = /D(\d)_spx_[^/]*\.fits$/.exec(url.pathname);
  const fromName = /D(\d)$/.exec(bandpass);
  const detector = Number((fromUrl ?? fromName)?.[1]);
  return detector >= 1 && detector <= 6 ? detector : null;
}

function irsaCutoutUrl(product, ra, dec, size) {
  const url = validateIrsaProductUrl(product);
  if (!url) return null;
  if (!Number.isFinite(ra) || ra < 0 || ra > 360 || !Number.isFinite(dec) || dec < -90 || dec > 90 ||
      !Number.isFinite(size) || size < 0.001 || size > 1) return null;
  const round = (value) => Number(value.toFixed(8));
  url.search = "?center=" + round(ra) + "," + round(dec) + "&size=" + round(size) + "deg";
  return url;
}

function irsaNumber(value) {
  if (value === undefined || value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function irsaFootprint(value) {
  const match = /^POLYGON\s+(?:ICRS\s+)?(.+)$/i.exec(value ?? "");
  if (!match) return null;
  const numbers = match[1].trim().split(/\s+/).map(Number);
  if (numbers.length < 6 || numbers.length % 2 || numbers.some((number) => !Number.isFinite(number))) return null;
  const points = [];
  for (let index = 0; index < numbers.length; index += 2) points.push([numbers[index], numbers[index + 1]]);
  const first = points[0];
  const last = points[points.length - 1];
  if (points.length > 3 && first[0] === last[0] && first[1] === last[1]) points.pop();
  return points.length >= 3 ? points : null;
}

// Returns true, false, or null when the footprint is unknown. Great-circle edges are straight
// lines in a gnomonic projection, so a ray test on the projected polygon is exact.
function irsaFootprintContains(polygon, ra, dec) {
  if (!polygon) return null;
  const radians = Math.PI / 180;
  const centre = polygon.reduce((sum, [x, y]) => {
    const longitude = x * radians;
    const latitude = y * radians;
    return [sum[0] + Math.cos(latitude) * Math.cos(longitude), sum[1] + Math.cos(latitude) * Math.sin(longitude), sum[2] + Math.sin(latitude)];
  }, [0, 0, 0]);
  const ra0 = Math.atan2(centre[1], centre[0]);
  const dec0 = Math.atan2(centre[2], Math.hypot(centre[0], centre[1]));
  const project = (x, y) => {
    const dRa = x * radians - ra0;
    const latitude = y * radians;
    const cosc = Math.sin(dec0) * Math.sin(latitude) + Math.cos(dec0) * Math.cos(latitude) * Math.cos(dRa);
    if (cosc <= 0) return null;
    return [
      Math.cos(latitude) * Math.sin(dRa) / cosc,
      (Math.cos(dec0) * Math.sin(latitude) - Math.sin(dec0) * Math.cos(latitude) * Math.cos(dRa)) / cosc,
    ];
  };
  const target = project(ra, dec);
  const shape = polygon.map(([x, y]) => project(x, y));
  if (!target || shape.includes(null)) return false;
  let inside = false;
  for (let index = 0, previous = shape.length - 1; index < shape.length; previous = index++) {
    const [x1, y1] = shape[index];
    const [x2, y2] = shape[previous];
    if ((y1 > target[1]) !== (y2 > target[1]) && target[0] < (x2 - x1) * (target[1] - y1) / (y2 - y1) + x1) {
      inside = !inside;
    }
  }
  return inside;
}

function irsaMjdToUtc(mjd) {
  if (!Number.isFinite(mjd)) return "";
  const date = new Date(Math.round((mjd - 40587) * 86400000));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 19).replace("T", " ") + " UTC";
}

function irsaMicrons(metres) {
  return Number.isFinite(metres) ? (metres * 1e6).toFixed(3) : null;
}

function decodeXmlText(text) {
  return text.replace(/&(lt|gt|quot|apos|amp);/g, (_, name) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[name]).trim();
}

// Result: { ok: true, rows, skipped, total } or { ok: false, code, message }.
function parseIrsaResults(text) {
  const body = text.replace(/^﻿/, "").trimStart();
  if (body === "") return { ok: false, code: "empty-file", message: "The file is empty. Save the archive results as CSV and import that file." };
  if (body.startsWith("<")) {
    const error = /<INFO\b[^>]*\bname\s*=\s*"QUERY_STATUS"[^>]*\bvalue\s*=\s*"ERROR"[^>]*>([^<]*)</i.exec(body);
    if (error) {
      const detail = decodeXmlText(error[1]);
      return { ok: false, code: "service-error", message: "IRSA reported an error" + (detail ? ": " + detail : ".") };
    }
    return { ok: false, code: "not-csv", message: "This file is XML or HTML, not CSV. Use the Open IRSA results (CSV) link and save that response." };
  }

  let table;
  try {
    table = parseCsv(body);
  } catch (error) {
    return { ok: false, code: "bad-csv", message: error.message };
  }
  if (table.length === 0) return { ok: false, code: "empty-file", message: "The file has no header row." };
  const header = table[0].map((name) => name.trim().toLowerCase());
  const missing = irsaRequiredColumns.filter((name) => !header.includes(name));
  if (missing.length) {
    return { ok: false, code: "missing-columns", message: "This CSV is missing the required " + (missing.length > 1 ? "columns " : "column ") + missing.join(", ") + ". It does not look like an IRSA SIA result." };
  }

  const rows = [];
  const skipped = [];
  const seen = new Set();
  table.slice(1).forEach((rawCells, index) => {
    const number = index + 1;
    const cells = joinUnquotedJson(rawCells, header.length);
    if (cells.length !== header.length) {
      skipped.push({ number, reason: "the row has " + cells.length + " fields instead of " + header.length });
      return;
    }
    const get = (name) => (cells[header.indexOf(name)] ?? "").trim();
    const obsId = get("obs_id");
    if (!irsaObservationId.test(obsId)) {
      skipped.push({ number, reason: obsId ? "the observation ID is not valid" : "the observation ID is empty" });
      return;
    }
    const format = get("access_format");
    if (format && format.toLowerCase() !== "image/fits") {
      skipped.push({ number, obsId, reason: "the product type is " + format + ", not FITS" });
      return;
    }
    const url = validateIrsaProductUrl(get("access_url"));
    if (!url) {
      skipped.push({ number, obsId, reason: get("access_url") ? "the file link is not a SPHEREx DR1, QR3 or QR2 level 2 product on " + irsaHost : "there is no file link" });
      return;
    }
    if (seen.has(url.href)) {
      skipped.push({ number, obsId, reason: "it repeats an earlier file link" });
      return;
    }
    seen.add(url.href);
    const release = irsaReleaseOfUrl(url);
    // Deep-field files sit under dr1/level2 or qr3/level2 like the wide survey, so only obs_collection tells them apart.
    const collection = get("obs_collection") || irsaReleases[release].collection;
    rows.push({
      obsId,
      product: url,
      release,
      collection,
      deep: collection.endsWith("_deep"),
      detector: irsaDetector(url, get("energy_bandpassname")),
      bandpass: get("energy_bandpassname"),
      format: format || "",
      start: irsaNumber(cells[header.indexOf("t_min")]),
      end: irsaNumber(cells[header.indexOf("t_max")]),
      minMetres: irsaNumber(cells[header.indexOf("em_min")]),
      maxMetres: irsaNumber(cells[header.indexOf("em_max")]),
      sizeKilobytes: irsaNumber(cells[header.indexOf("access_estsize")]),
      footprint: irsaFootprint(get("s_region")),
    });
  });
  return { ok: true, rows, skipped, total: table.length - 1 };
}
