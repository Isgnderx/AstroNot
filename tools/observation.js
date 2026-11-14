function buildObservationQuery(fields) {
  const read = (name, label, min, max) => {
    const text = String(fields[name] ?? "").trim();
    const value = Number(text);
    if (text === "" || !Number.isFinite(value) || value < min || value > max) {
      throw new Error("Enter " + label + " between " + min + " and " + max + ".");
    }
    return value;
  };
  const ra = read("ra", "an RA in degrees", 0, 360) % 360;
  const dec = read("dec", "a Dec in degrees", -90, 90);
  const radius = read("radius", "a radius in degrees", 0.0001, 5);
  const release = fields.release === undefined || fields.release === "" ? irsaDefaultRelease : String(fields.release);
  if (!irsaIsRelease(release)) throw new Error("Choose a data release: SPHEREx DR1, QR3, or QR2.");
  const url = new URL("https://irsa.ipac.caltech.edu/SIA");
  url.searchParams.set("COLLECTION", irsaReleases[release].collection);
  url.searchParams.set("POS", "CIRCLE " + ra + " " + dec + " " + radius);
  url.searchParams.set("MAXREC", String(irsaMaxRecords));
  url.searchParams.set("RESPONSEFORMAT", "CSV");

  if (fields.dateStart || fields.dateEnd) {
    // The SIA TIME parameter takes Modified Julian Dates. A date input covers the whole UTC day.
    const mjd = (date, time) => {
      const stamp = Date.parse(date + "T" + time + "Z");
      const valid = /^\d{4}-\d\d-\d\d$/.test(date) && !Number.isNaN(stamp) && new Date(stamp).toISOString().startsWith(date);
      return valid ? stamp / 86400000 + 40587 : NaN;
    };
    const start = fields.dateStart ? mjd(fields.dateStart, "00:00:00.000") : -Infinity;
    const end = fields.dateEnd ? mjd(fields.dateEnd, "23:59:59.999") : Infinity;
    if (Number.isNaN(start) || Number.isNaN(end)) throw new Error("Enter valid UTC dates.");
    if (start > end) throw new Error("The end date must be on or after the start date.");
    url.searchParams.set("TIME", (fields.dateStart ? start.toFixed(8) : "-Inf") + " " + (fields.dateEnd ? end.toFixed(8) : "+Inf"));
  }

  if (fields.bandStart || fields.bandEnd) {
    const start = fields.bandStart ? Number(fields.bandStart) : -Infinity;
    const end = fields.bandEnd ? Number(fields.bandEnd) : Infinity;
    if (Number.isNaN(start) || Number.isNaN(end) || start <= 0 || end <= 0) throw new Error("Enter wavelengths greater than zero.");
    if (start > end) throw new Error("The maximum wavelength must be at least the minimum wavelength.");
    const metres = (microns) => (microns / 1000000).toExponential();
    url.searchParams.set("BAND", (fields.bandStart ? metres(start) : "-Inf") + " " + (fields.bandEnd ? metres(end) : "+Inf"));
  }

  return { url, ra, dec, radius, release };
}

function observationViewerUrl(row, center) {
  const url = new URL(sitePage("/tools/fits-viewer"));
  url.searchParams.set("obs", row.obsId);
  url.searchParams.set("product", row.product.href);
  if (row.detector) url.searchParams.set("det", String(row.detector));
  if (center) {
    url.searchParams.set("ra", String(center.ra));
    url.searchParams.set("dec", String(center.dec));
    url.searchParams.set("size", String(center.size));
  }
  return url.href;
}

// "SPHEREx DR1 deep fields" for a deep-field row, "SPHEREx DR1" for a wide-survey one. Named by collection, not by URL.
function observationCollectionLabel(row) {
  return Object.values(irsaReleases).find((entry) => entry.collection === row.collection)?.label ?? row.collection;
}

// Link to Forced Spectrophotometry, which takes the imported frame list and the position to measure.
function observationForcedPhotometryUrl(position) {
  const url = new URL(sitePage("/tools/forced-spectrophotometry"));
  url.searchParams.set("ra", String(position.ra));
  url.searchParams.set("dec", String(position.dec));
  return url.href;
}

function setupObservationSearch() {
  const form = document.querySelector("[data-observation-form]");
  const submit = form.querySelector("[data-observation-submit]");
  const example = form.querySelector("[data-observation-example]");
  const status = form.querySelector("[data-observation-status]");
  const empty = document.querySelector("[data-query-empty]");
  const result = document.querySelector("[data-query-result]");
  const summary = result.querySelector("[data-query-summary]");
  const link = result.querySelector("[data-query-link]");
  const releaseSelect = form.elements.release;
  const collectionLabel = document.querySelector("[data-query-collection]");
  const importInput = document.querySelector("[data-observation-import]");
  const importStatus = document.querySelector("[data-import-status]");
  const results = document.querySelector("[data-results]");
  const resultsStatus = results.querySelector("[data-results-status]");
  const resultsNotes = results.querySelector("[data-results-notes]");
  const skippedBox = results.querySelector("[data-results-skipped]");
  const skippedList = results.querySelector("[data-results-skipped-list]");
  const cutoutBox = results.querySelector("[data-cutout]");
  const cutout = {
    ra: cutoutBox.querySelector("[name=cutoutRa]"),
    dec: cutoutBox.querySelector("[name=cutoutDec]"),
    size: cutoutBox.querySelector("[name=cutoutSize]"),
  };
  const list = results.querySelector("[data-results-list]");
  const handoff = results.querySelector("[data-results-handoff]");
  const maxImportBytes = 20 * 1024 * 1024;
  let importVersion = 0;
  let rowViews = [];
  let preparedRelease = null;
  let preparedPosition = null;

  function setImportStatus(message, error = false) {
    importStatus.toggleAttribute("data-error", error);
    importStatus.textContent = message;
  }

  function clearResults() {
    importVersion++;
    rowViews = [];
    preparedRelease = null;
    preparedPosition = null;
    results.hidden = true;
    handoff.hidden = true;
    handoff.removeAttribute("href");
    list.replaceChildren();
    resultsNotes.replaceChildren();
    skippedList.replaceChildren();
    skippedBox.hidden = true;
    importInput.value = "";
    setImportStatus("");
    cutout.ra.value = cutout.dec.value = "";
    cutout.size.value = "0.12";
  }

  function showCollection() {
    const release = irsaIsRelease(releaseSelect.value) ? releaseSelect.value : irsaDefaultRelease;
    collectionLabel.textContent = irsaReleases[release].label + " (" + irsaReleases[release].collection + ")";
  }

  function resetQuery() {
    showCollection();
    result.hidden = true;
    empty.hidden = false;
    link.removeAttribute("href");
    status.textContent = "";
    status.removeAttribute("data-error");
    clearResults();
  }

  function cutoutParameters() {
    const read = (input) => (input.value.trim() === "" ? NaN : Number(input.value));
    return { ra: read(cutout.ra), dec: read(cutout.dec), size: read(cutout.size) };
  }

  function text(tag, content, className) {
    const element = document.createElement(tag);
    element.textContent = content;
    if (className) element.className = className;
    return element;
  }

  function setLink(anchor, href) {
    anchor.toggleAttribute("aria-disabled", !href);
    if (href) anchor.href = href;
    else anchor.removeAttribute("href");
  }

  // Cutout links depend on the cutout fields, so they are recalculated whenever those change.
  function refreshRow(view) {
    const { row, download, viewer, footprint, note } = view;
    const center = cutoutParameters();
    const url = irsaCutoutUrl(row.product.href, center.ra, center.dec, center.size);
    const inside = url ? irsaFootprintContains(row.footprint, center.ra, center.dec) : null;
    const ready = Boolean(url) && inside !== false;
    footprint.textContent = !url ? "Enter a valid cutout center and size"
      : inside === true ? "Cutout center is inside this footprint"
      : inside === false ? "Cutout center is outside this footprint"
      : "Footprint unavailable";
    setLink(download, ready ? url.href : "");
    setLink(viewer, observationViewerUrl(row, url && inside !== false ? center : null));
    note.textContent = ready ? "" : inside === false
      ? "IRSA cannot cut an image outside the observation footprint. Change the cutout center or download the full file."
      : "A cutout needs an RA from 0° to 360°, a Dec from −90° to 90°, and a size from 0.001° to 1°.";
  }

  function fact(label, value) {
    const row = document.createElement("div");
    row.append(text("dt", label), text("dd", value || "Unavailable"));
    return row;
  }

  function renderRow(row) {
    const item = document.createElement("li");
    item.className = "observation-row";
    const details = document.createElement("details");
    const heading = document.createElement("summary");
    const wavelength = Number.isFinite(row.minMetres) && Number.isFinite(row.maxMetres)
      ? irsaMicrons(row.minMetres) + "–" + irsaMicrons(row.maxMetres) + " μm" : "";
    const start = irsaMjdToUtc(row.start);
    heading.append(
      text("span", row.obsId, "observation-row__id"),
      text("span", row.detector ? "Detector " + row.detector : row.bandpass || "Detector unavailable"),
      text("span", start ? start.slice(0, 16) + " UTC" : "Date unavailable"),
      text("span", wavelength || "Wavelength unavailable"),
    );

    const body = document.createElement("div");
    body.className = "observation-row__body";
    const facts = document.createElement("dl");
    facts.className = "workspace-facts";
    const size = row.sizeKilobytes ? (row.sizeKilobytes / 1000).toFixed(1) + " MB" : "";
    const releaseLabel = observationCollectionLabel(row);
    const footprint = text("dd", "");
    const footprintRow = document.createElement("div");
    footprintRow.append(text("dt", "Cutout footprint check"), footprint);
    facts.append(
      fact("Observation ID", row.obsId),
      fact("Data release", releaseLabel),
      fact("Detector", row.detector ? String(row.detector) : ""),
      fact("Start", start),
      fact("End", irsaMjdToUtc(row.end)),
      fact("Wavelength coverage", wavelength),
      fact("Product", row.format ? row.format + (size ? " · full file " + size : "") : ""),
      footprintRow,
    );

    const actions = document.createElement("div");
    actions.className = "workspace-actions";
    const download = text("a", "Download FITS cutout", "workspace-button workspace-button--primary");
    download.target = "_blank";
    download.rel = "noopener";
    const viewer = text("a", "Open in FITS Viewer", "workspace-button");
    const full = text("a", "Download full FITS file" + (size ? " (" + size + ")" : ""), "workspace-source");
    full.href = row.product.href;
    full.target = "_blank";
    full.rel = "noopener";
    actions.append(download, viewer);
    const note = text("p", "", "workspace-help");
    const rowStatus = text("p", "", "workspace-status");
    rowStatus.setAttribute("role", "status");
    download.addEventListener("click", (event) => {
      if (download.hasAttribute("aria-disabled")) {
        event.preventDefault();
        return;
      }
      const { ra, dec, size: width } = cutoutParameters();
      rowStatus.textContent = "Cutout of " + row.obsId + " (" + observationCollectionLabel(row) + ")" + " requested from IRSA (center " + ra + "°, " + dec + "°, size " + width +
        "°). Your browser saves the file. Then choose it in FITS Viewer.";
    });
    full.addEventListener("click", () => {
      rowStatus.textContent = "The full file of " + row.obsId + " was requested from IRSA. It can take a while to finish. Then choose it in FITS Viewer.";
    });
    body.append(facts, actions, full, note, rowStatus);
    details.append(heading, body);
    item.append(details);
    const view = { row, download, viewer, footprint, note };
    refreshRow(view);
    return { item, view };
  }

  function showResults(parsed, fileName) {
    const { rows, skipped, total } = parsed;
    const built = rows.map(renderRow);
    rowViews = built.map((entry) => entry.view);
    list.replaceChildren(...built.map((entry) => entry.item));
    resultsNotes.replaceChildren();
    skippedList.replaceChildren(...skipped.map((entry) =>
      text("li", "Row " + entry.number + (entry.obsId ? " (" + entry.obsId + ")" : "") + " was skipped because " + entry.reason + ".")));
    skippedBox.hidden = skipped.length === 0;
    cutoutBox.hidden = rows.length === 0;
    skippedBox.querySelector("summary").textContent = skipped.length + (skipped.length === 1 ? " row skipped" : " rows skipped");

    if (rows.length === 0) {
      resultsStatus.textContent = total === 0
        ? irsaEmptyMessage(preparedRelease)
        : "No usable observations in " + fileName + ". Every row was skipped.";
    } else {
      // Name the collection, not the release in the URL, so a deep-field file does not read as a wide-survey one.
      const labels = [...new Set(rows.map(observationCollectionLabel))].join(", ");
      resultsStatus.textContent = rows.length + (rows.length === 1 ? " observation" : " observations") + " from " + fileName +
        " (" + labels + "). Open a row to download its FITS file.";
    }
    if (total >= irsaMaxRecords) {
      resultsNotes.append(text("p", "The generated search asks IRSA for at most " + irsaMaxRecords +
        " records and this file has " + total + ". More observations may exist. Narrow the position, dates, or wavelengths.", "workspace-help"));
    }
    // The hand-off only makes sense when there are frames to measure.
    const offerHandoff = Boolean(preparedPosition) && rows.length > 0;
    if (offerHandoff) handoff.href = observationForcedPhotometryUrl(preparedPosition);
    else handoff.removeAttribute("href");
    handoff.hidden = !offerHandoff;
    results.hidden = false;
  }

  async function importResults(file) {
    const version = ++importVersion;
    results.hidden = true;
    setImportStatus("Reading " + file.name + "…");
    if (file.size > maxImportBytes) {
      setImportStatus("This file is larger than 20 MB, so it is not an IRSA search result. Search with a smaller area.", true);
      return;
    }
    let content;
    try {
      content = await file.text();
    } catch {
      if (version === importVersion) setImportStatus("The browser could not read " + file.name + ". Save the archive results again and retry.", true);
      return;
    }
    if (version !== importVersion) return;

    const parsed = parseIrsaResults(content);
    if (!parsed.ok) {
      importInput.value = "";
      setImportStatus(parsed.message, true);
      return;
    }
    showResults(parsed, file.name);
    setImportStatus(parsed.rows.length === 0 ? "Import finished with no usable observations." : "Imported " + parsed.rows.length + " of " + parsed.total + " rows.");
  }

  form.addEventListener("input", resetQuery);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    resetQuery();
    try {
      const fields = Object.fromEntries(new FormData(form));
      const { url, ra, dec, radius, release } = buildObservationQuery(fields);
      preparedRelease = release;
      preparedPosition = { ra, dec };
      summary.textContent = irsaReleases[release].label + " · ICRS " + ra + "°, " + dec + "° · " + radius + "° search radius";
      link.href = url.href;
      cutout.ra.value = ra;
      cutout.dec.value = dec;
      empty.hidden = true;
      result.hidden = false;
      status.textContent = "Search prepared. Open the archive link, save the CSV, then import it below.";
    } catch (error) {
      status.setAttribute("data-error", "");
      status.textContent = error.message;
    }
  });

  importInput.addEventListener("change", () => {
    if (importInput.files[0]) importResults(importInput.files[0]);
  });
  cutoutBox.addEventListener("input", () => rowViews.forEach(refreshRow));

  example.addEventListener("click", () => {
    form.reset();
    // DR1 holds this observation (2025W21_2C_0280_1) and returns rows for the example filters. QR3 returns none for that date.
    releaseSelect.value = irsaDefaultRelease;
    form.elements.ra.value = "156.09328159";
    form.elements.dec.value = "-41.64466331";
    form.elements.dateStart.value = "2025-05-24";
    form.elements.dateEnd.value = "2025-05-24";
    form.elements.bandStart.value = "1.2";
    form.elements.bandEnd.value = "1.4";
    resetQuery();
    status.textContent = "Example coordinates, filters, and " + irsaReleases[irsaDefaultRelease].label + " loaded.";
  });

  showCollection();
  submit.disabled = false;
  example.disabled = false;
  importInput.disabled = false;
}

if (typeof document !== "undefined") setupObservationSearch();
