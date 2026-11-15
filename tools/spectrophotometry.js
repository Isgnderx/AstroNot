// Spectrophotometry: aperture flux density of one sky position in calibrated SPHEREx images, and a CSV that Spectrum Lab opens.
// FITS structure and calibrated pixel values come from tools/fits.js (shared with FITS Viewer), coordinates from tools/wcs.js, the
// per-pixel wavelength and observation time from tools/pair.js, and ALL measurement and CSV logic from tools/photometry.js.
// This file is the user interface only. Display ranges, zoom and colors never feed into a measurement.
(function () {
  "use strict";

  const Pair = AstroNotPair;
  const Phot = AstroNotPhotometry;
  const { createWcs } = AstroNotWcs;

  const maxFiles = 24;
  const maxTotalPixels = 16000000;
  const query = (name, scope = document) => scope.querySelector("[data-sp-" + name + "]");

  const el = {
    file: query("file"), examplePair: query("example-pair"), exampleSingle: query("example-single"), clear: query("clear"), status: query("status"),
    listWrap: query("list-wrap"), list: query("list"),
    form: query("form"), measure: query("measure"), stale: query("stale"), formStatus: query("form-status"),
    verdict: query("verdict"), notes: query("notes"), resultsWrap: query("results-wrap"), results: query("results"),
    download: query("download"), lab: query("lab"), exportStatus: query("export-status"),
    detail: query("detail"), detailSelect: query("detail-select"), canvas: query("canvas"), canvasCaption: query("canvas-caption"),
    facts: query("facts"), conversions: query("conversions"), pixels: query("pixels"),
  };
  const fields = {};
  for (const input of document.querySelectorAll("[data-sp-field]")) fields[input.dataset.spField] = input;

  const state = { observations: [], nextId: 1, batch: 0, result: null, selected: 0, exampleScripts: {} };

  // ---- Small helpers --------------------------------------------------------------------------------------------------------------
  const minus = "−";

  function significant(value, digits = 5) {
    if (!Number.isFinite(value)) return "Unavailable";
    return Number(value.toPrecision(digits)).toString().replaceAll("-", minus);
  }

  function setStatus(message, error = false) {
    el.status.toggleAttribute("data-error", error);
    el.status.textContent = message;
  }

  function setFormStatus(message, error = false) {
    el.formStatus.toggleAttribute("data-error", error);
    el.formStatus.textContent = message;
  }

  function setDisabled(button, disabled) {
    button.setAttribute("aria-disabled", String(disabled));
  }

  function cell(tag, content, attributes = {}) {
    const node = document.createElement(tag);
    if (content instanceof Node) node.append(content);
    else node.textContent = content;
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  }

  function plural(count, word) {
    return count + " " + word + (count === 1 ? "" : "s");
  }

  // ---- Reading files ---------------------------------------------------------------------------------------------------------------
  async function readValues(file, hdu, Type = Float64Array) {
    const bytes = await file.slice(hdu.dataStart, hdu.dataStart + hdu.byteLength).arrayBuffer();
    const read = fitsPixelReader(bytes, hdu); // BSCALE and BZERO are applied here, once; BLANK becomes NaN.
    const values = new Type(hdu.pixels);
    for (let index = 0; index < values.length; index++) values[index] = read(index);
    return values;
  }

  function companionIndex(hdus, hdu, name) {
    return hdus.findIndex((entry) => entry !== hdu && String(entry.fields.EXTNAME ?? "").trim().toUpperCase() === name);
  }

  async function readObservation(file, name, example) {
    const hdus = await readFitsHdus(file);
    const choices = hdus.map((hdu, index) => ({ hdu, index })).filter(({ hdu }) => hdu.renderable);
    if (!choices.length) throw new Error("This file has no uncompressed two-dimensional image HDU that can be read.");
    const preferred = choices.find(({ hdu }) => String(hdu.fields.EXTNAME ?? "").trim().toUpperCase() === "IMAGE") ?? choices[0];
    const { hdu, index } = preferred;
    const [width, height] = hdu.axes;
    const values = await readValues(file, hdu);
    const unit = typeof hdu.fields.BUNIT === "string" ? hdu.fields.BUNIT.trim() : "";
    const created = createWcs(hdu.fields);

    const companions = [];
    const notes = [];
    // VARIANCE
    let variance;
    let varianceUnit;
    const varianceAt = companionIndex(hdus, hdu, "VARIANCE");
    if (varianceAt >= 0) {
      const candidate = hdus[varianceAt];
      if (candidate.renderable && candidate.axes[0] === width && candidate.axes[1] === height) {
        variance = await readValues(file, candidate);
        varianceUnit = typeof candidate.fields.BUNIT === "string" ? candidate.fields.BUNIT.trim() : undefined;
        companions.push("VARIANCE");
      } else notes.push("VARIANCE ignored: it cannot be read or its size differs");
    }
    // FLAGS
    let flags;
    let flagDefinitions;
    const flagsAt = companionIndex(hdus, hdu, "FLAGS");
    if (flagsAt >= 0) {
      const candidate = hdus[flagsAt];
      if (candidate.renderable && candidate.bitpix > 0 && candidate.axes[0] === width && candidate.axes[1] === height) {
        flags = await readValues(file, candidate, Uint32Array);
        flagDefinitions = Phot.flagDefinitions(candidate.cards).definitions;
        companions.push("FLAGS");
      } else notes.push("FLAGS ignored: it is not an integer image of the same size");
    }
    // WCS-WAVE
    let waveTable = null;
    const waveName = String(hdu.fields.PS1_0W ?? "WCS-WAVE").trim();
    const waveHdu = hdus.find((entry) => entry.fields.XTENSION === "BINTABLE" && entry.fields.EXTNAME === waveName);
    if (waveHdu && waveHdu.byteLength <= 1 << 20) {
      const bytes = await file.slice(waveHdu.dataStart, waveHdu.dataStart + waveHdu.byteLength).arrayBuffer();
      waveTable = Pair.parseWaveTable(bytes, waveHdu.fields, hdu.fields);
      if (waveTable) companions.push("WCS-WAVE");
      else notes.push("WCS-WAVE could not be read");
    }

    const epoch = Phot.observationEpoch(hdu.fields);
    return {
      id: state.nextId++, name, file, example, hdu, hduIndex: index, width, height, values, unit,
      wcs: created.ok ? created.wcs : null, wcsReason: created.ok ? "" : created.reason, wcsSummary: created.ok ? created.wcs.summary : created.reason,
      fields: hdu.fields, cards: hdu.cards, variance, varianceUnit, flags, flagDefinitions, waveTable, companions, notes, epoch,
      obsId: typeof hdu.fields.OBSID === "string" && hdu.fields.OBSID.trim() ? hdu.fields.OBSID.trim() : "",
      detector: Number.isFinite(hdu.fields.DETECTOR) ? hdu.fields.DETECTOR : "",
      fingerprint: Pair.fingerprintValues(values),
    };
  }

  async function addFiles(sources) {
    const batch = ++state.batch;
    const messages = [];
    let added = 0;
    setStatus("Reading FITS files…");
    for (const { file, name, example } of sources) {
      if (state.observations.length >= maxFiles) {
        messages.push(name + " was not loaded: at most " + maxFiles + " images can be open.");
        continue;
      }
      try {
        const observation = await readObservation(await file, name, example);
        const total = state.observations.reduce((sum, entry) => sum + entry.width * entry.height, 0) + observation.width * observation.height;
        if (total > maxTotalPixels) throw new Error("The open images would hold more than " + maxTotalPixels.toLocaleString("en-US") + " pixels. Remove an image first.");
        const twin = state.observations.find((entry) => entry.fingerprint === observation.fingerprint);
        if (twin) throw new Error("It holds exactly the same pixel values as " + twin.name + ", so it is the same observation and is not added twice.");
        state.observations.push(observation);
        added++;
      } catch (error) {
        messages.push(name + " could not be opened. " + error.message);
      }
    }
    if (batch !== state.batch) return;
    renderList();
    invalidate();
    const head = added ? plural(added, "image") + " loaded. " : "";
    setStatus((head + messages.join(" ")).trim() || "No file was chosen.", messages.length > 0);
  }

  function loadScript(key, path) {
    if (!state.exampleScripts[key]) {
      state.exampleScripts[key] = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = siteAsset(path);
        script.addEventListener("load", resolve, { once: true });
        script.addEventListener("error", () => reject(new Error("The example file could not be loaded.")), { once: true });
        document.head.append(script);
      }).catch((error) => {
        state.exampleScripts[key] = undefined;
        throw error;
      });
    }
    return state.exampleScripts[key];
  }

  const decode = (text) => Uint8Array.from(atob(text), (character) => character.charCodeAt(0));

  // Position of the brightest compact, unflagged source in the bundled cutouts (the centroid of the 5 x 5 pixels around the peak
  // of observation 2025W21_2C_0280_1, measured once with the same WCS). It is a position in the example, not a catalog entry.
  const exampleTarget = { sourceId: "example-source", ra: "156.02411", dec: "-41.66916" };

  function setExampleTarget() {
    fields.sourceId.value = exampleTarget.sourceId;
    fields.ra.value = exampleTarget.ra;
    fields.dec.value = exampleTarget.dec;
  }

  async function loadExamplePair() {
    try {
      await loadScript("pair", "assets/tools/spherex-time-machine-example.js");
    } catch (error) {
      setStatus(error.message, true);
      return;
    }
    removeExamples();
    setExampleTarget();
    await addFiles([
      { file: new File([decode(spherexTimeMachineExample.reference)], "SPHEREx-QR2-2025W21_2C_0280_1-D2.fits"), name: "SPHEREx-QR2-2025W21_2C_0280_1-D2.fits", example: true },
      { file: new File([decode(spherexTimeMachineExample.comparison)], "SPHEREx-QR2-2025W24_1A_0514_1-D2.fits"), name: "SPHEREx-QR2-2025W24_1A_0514_1-D2.fits", example: true },
    ]);
  }

  async function loadExampleSingle() {
    try {
      await loadScript("single", "assets/tools/spherex-example.js");
    } catch (error) {
      setStatus(error.message, true);
      return;
    }
    removeExamples();
    setExampleTarget();
    await addFiles([{ file: new File([decode(spherexExampleData)], "SPHEREx-QR2-D2.fits"), name: "SPHEREx-QR2-D2.fits", example: true }]);
  }

  function removeExamples() {
    state.observations = state.observations.filter((entry) => !entry.example);
  }

  // ---- Loaded-image table -----------------------------------------------------------------------------------------------------------
  function companionText(observation) {
    const have = observation.companions.length ? observation.companions.join(", ") : "none";
    const missing = [];
    if (!observation.variance) missing.push("no VARIANCE: uncertainty empty");
    if (!observation.flags) missing.push("no FLAGS: no pixel masking");
    if (!observation.waveTable) missing.push("no WCS-WAVE: no wavelength");
    return have + (missing.length ? " (" + missing.join("; ") + ")" : "") + (observation.notes.length ? ". " + observation.notes.join("; ") : "");
  }

  function observedText(observation) {
    if (observation.epoch.mjd === null) return "Unavailable";
    return Pair.formatMjd(observation.epoch.mjd) + (observation.epoch.source === "MJD-AVG" ? " (mid-exposure)" : " (start)");
  }

  function renderList() {
    el.listWrap.hidden = !state.observations.length;
    setDisabled(el.clear, !state.observations.length);
    el.list.replaceChildren(...state.observations.map((observation) => {
      const row = document.createElement("tr");
      const remove = cell("button", "Remove", { type: "button", class: "workspace-button", "aria-label": "Remove " + observation.name });
      remove.addEventListener("click", () => {
        state.observations = state.observations.filter((entry) => entry.id !== observation.id);
        renderList();
        invalidate();
        setStatus(observation.name + " removed. " + plural(state.observations.length, "image") + " open.");
        (el.list.querySelector("button") ?? el.file).focus();
      });
      row.append(
        cell("th", observation.name + (observation.example ? " (bundled example)" : ""), { scope: "row" }),
        cell("td", observation.obsId || "Unavailable"),
        cell("td", observation.hduIndex + " · " + observation.hdu.name),
        cell("td", observation.width + " × " + observation.height),
        cell("td", observation.unit || "Unavailable"),
        cell("td", observedText(observation)),
        cell("td", companionText(observation)),
        cell("td", observation.wcs ? observation.wcsSummary : "Unavailable: " + observation.wcsSummary),
        cell("td", remove),
      );
      return row;
    }));
  }

  // ---- Form --------------------------------------------------------------------------------------------------------------------------
  function readForm() {
    const problems = [];
    const text = (key) => fields[key].value;
    const sourceId = text("sourceId").replace(/[\u0000-\u001f]/g, " ").trim();
    if (!sourceId) problems.push("Source ID is empty.");
    else if (sourceId.length > 80) problems.push("Source ID is longer than 80 characters.");
    const ra = Phot.parseCoordinate(text("ra"), "ra");
    const dec = Phot.parseCoordinate(text("dec"), "dec");
    if (!ra.ok) problems.push(ra.reason);
    if (!dec.ok) problems.push(dec.reason);
    const params = { radiusUnit: text("radiusUnit"), background: text("background"), maskFlags: fields.maskFlags.checked, excludeSourceFromAnnulus: fields.excludeSource.checked };
    const unitLabel = params.radiusUnit === "arcsec" ? " (arcsec)" : " (pixels)";
    const radius = Phot.parsePositive(text("radius"), "The aperture radius" + unitLabel);
    if (!radius.ok) problems.push(radius.reason);
    else params.radius = radius.value;
    if (params.background !== "none") {
      const inner = Phot.parsePositive(text("innerRadius"), "The annulus inner radius" + unitLabel);
      const outer = Phot.parsePositive(text("outerRadius"), "The annulus outer radius" + unitLabel);
      if (!inner.ok) problems.push(inner.reason);
      if (!outer.ok) problems.push(outer.reason);
      if (inner.ok && outer.ok) {
        params.innerRadius = inner.value;
        params.outerRadius = outer.value;
      }
    }
    const coverage = Phot.parsePositive(text("minCoverage"), "The minimum coverage (%)", { max: 100 });
    if (!coverage.ok) problems.push(coverage.reason);
    else params.minCoverage = coverage.value / 100;
    const minimum = Phot.parsePositive(text("minAnnulusPixels"), "The minimum annulus pixel count");
    if (!minimum.ok || !Number.isInteger(minimum.value)) problems.push("The minimum annulus pixel count must be a whole number, at least 1.");
    else params.minAnnulusPixels = minimum.value;
    if (!problems.length) {
      const check = Phot.checkParams(params);
      problems.push(...check.reasons);
    }
    return { ok: problems.length === 0, problems, sourceId, target: ra.ok && dec.ok ? { ra: ra.value, dec: dec.value } : null, params };
  }

  function syncBackgroundFields() {
    const none = fields.background.value === "none";
    for (const key of ["innerRadius", "outerRadius", "minAnnulusPixels", "excludeSource"]) fields[key].disabled = none;
  }

  // ---- Measurement ------------------------------------------------------------------------------------------------------------------------
  function measureAll(form) {
    return state.observations.map((observation) => {
      const measurement = Phot.measureAperture(observation, form.target, form.params);
      const context = { sourceId: form.sourceId, obsId: observation.obsId, detector: observation.detector, fileName: observation.name };
      return { observation, measurement, row: Phot.csvRow(measurement, context) };
    });
  }

  function statusLabel(measurement) {
    const labels = {
      ok: "Measured", "partial-aperture": "Measured, partial aperture", "off-image": "Not measured: target off the image",
      "insufficient-coverage": "Not measured: too little valid aperture", "insufficient-background": "Not measured: annulus too small",
      "unit-unsupported": "Not measured: unit not supported", "no-wcs": "Not measured: no usable WCS", "invalid-parameters": "Not measured: invalid settings",
    };
    return labels[measurement.status] ?? measurement.status;
  }

  function percent(value) {
    return Number.isFinite(value) ? (value * 100).toFixed(1) + "%" : "Unavailable";
  }

  function flagsText(measurement) {
    if (!measurement.measured && !measurement.aperture) return "—";
    if (!measurement.flags) return "0";
    return measurement.flags + " (" + measurement.flagNames.map((entry) => entry.name).join(", ") + ")";
  }

  function spectrumText(item) {
    const m = item.measurement;
    if (item.row) return "Yes";
    if (!m.measured) return "No: not measured";
    return "No: no wavelength calibration";
  }

  function renderResults() {
    const result = state.result;
    el.resultsWrap.hidden = !result;
    el.notes.hidden = true;
    el.notes.replaceChildren();
    el.results.replaceChildren();
    el.detail.hidden = !result;
    setDisabled(el.download, !(result && result.csvRows.length));
    if (!result) return;

    const measured = result.items.filter((item) => item.measurement.measured);
    const points = result.csvRows.length;
    const total = result.items.length;
    const missingUncertainty = measured.filter((item) => item.measurement.fluxErrMicroJy === null).length;
    el.verdict.textContent = measured.length + " of " + plural(total, "image") + " measured. " + plural(points, "spectrum point") + "." +
      (missingUncertainty ? " Uncertainty unavailable for " + plural(missingUncertainty, "measurement") + "." : "");

    const notes = [];
    for (const item of result.items) {
      const m = item.measurement;
      const label = item.observation.name;
      if (!m.measured) notes.push(["error", label + ": " + m.reasons.join(" ")]);
      else {
        if (m.status === "partial-aperture") notes.push(["warning", label + ": " + m.reasons.join(" ")]);
        if (!m.spectrumPoint) notes.push(["warning", label + ": " + m.notSpectrumReason]);
        if (m.omega && m.omega.ratioToHeader && Math.abs(m.omega.ratioToHeader - 1) > 0.05) notes.push(["warning", label + ": the pixel solid angle from the WCS differs from the header OMEGA_MEDIAN by " + percent(m.omega.ratioToHeader - 1) + "."]);
        if (item.observation.epoch.mjd === null) notes.push(["info", label + ": no UTC observation time (" + item.observation.epoch.reason + "), so the mjd column is empty."]);
      }
    }
    const shown = notes.slice(0, 12);
    if (notes.length > shown.length) shown.push(["info", plural(notes.length - shown.length, "more note") + " are listed in the measurement detail below."]);
    el.notes.hidden = !shown.length;
    el.notes.replaceChildren(...shown.map(([kind, message]) => cell("li", message, { class: "tm-notes__" + kind })));

    result.items.forEach((item, index) => {
      const m = item.measurement;
      const row = document.createElement("tr");
      row.dataset.state = m.measured ? "measured" : "refused";
      const pick = cell("button", item.observation.name, { type: "button", class: "workspace-button", "aria-label": "Show detail for " + item.observation.name });
      pick.addEventListener("click", () => selectDetail(index, true));
      const dash = () => cell("td", "—", { "data-empty": "" });
      const unavailable = () => cell("td", "Unavailable", { "data-empty": "" });
      row.append(
        cell("th", pick, { scope: "row" }),
        cell("td", statusLabel(m)),
        m.wavelength ? cell("td", m.wavelength.micron.toFixed(5)) : m.measured ? unavailable() : dash(),
        m.wavelength ? cell("td", m.wavelength.bandwidth.toFixed(5)) : m.measured ? unavailable() : dash(),
        m.measured ? cell("td", significant(m.flux.microJy, 6)) : dash(),
        m.measured ? (m.fluxErrMicroJy !== null ? cell("td", significant(m.fluxErrMicroJy, 3)) : unavailable()) : dash(),
        m.measured ? cell("td", significant(m.background.value * m.flux.imageUnitFactor, 4)) : dash(),
        m.aperture ? cell("td", percent(m.aperture.coverage)) : dash(),
        m.aperture ? cell("td", percent(m.aperture.maskedShare)) : dash(),
        cell("td", flagsText(m)),
        cell("td", spectrumText(item)),
      );
      el.results.append(row);
    });

    el.detailSelect.replaceChildren(...result.items.map((item, index) => new Option(item.observation.name, index)));
    state.selected = Math.min(state.selected, result.items.length - 1);
    selectDetail(state.selected, false);

    el.exportStatus.textContent = "";
  }

  function fact(label, value) {
    const row = document.createElement("div");
    row.append(cell("dt", label), cell("dd", value));
    return row;
  }

  function selectDetail(index, focus) {
    const result = state.result;
    if (!result) return;
    state.selected = index;
    el.detailSelect.value = String(index);
    for (const [position, row] of [...el.results.children].entries()) row.toggleAttribute("data-selected", position === index);
    const item = result.items[index];
    const m = item.measurement;
    const rows = [];
    rows.push(["Image", item.observation.name + (item.observation.obsId ? " · " + item.observation.obsId : "")]);
    rows.push(["Status", statusLabel(m)]);
    if (m.position) rows.push(["Target pixel (FITS x, y)", significant(m.position.x, 6) + ", " + significant(m.position.y, 6) + (m.inImage ? "" : " (outside the image)")]);
    if (m.pixelScaleArcsec) rows.push(["Pixel scale at the target", significant(m.pixelScaleArcsec, 5) + " arcsec"]);
    if (m.aperture) {
      const a = m.aperture;
      rows.push(["Aperture radius", significant(a.radiusPixels, 5) + " px" + (a.radiusArcsec ? " (" + significant(a.radiusArcsec, 5) + " arcsec)" : "")]);
      rows.push(["Aperture coverage (minimum " + percent(a.minCoverage) + ")", percent(a.coverage)]);
      rows.push(["Masked share (NaN " + percent(a.nanShare) + ", flagged " + percent(a.flagShare) + ")", percent(a.maskedShare)]);
      rows.push(["Share off the image", percent(a.offImageShare)]);
    }
    if (m.annulus) {
      const n = m.annulus;
      rows.push(["Annulus (pixels)", significant(n.innerPixels, 4) + " to " + significant(n.outerPixels, 4)]);
      rows.push(["Annulus pixels", n.pixelCount + " in the image, " + n.validCount + " valid, " + n.usedCount + " used after clipping (" + n.clippedCount + " clipped)"]);
    }
    if (m.background) {
      rows.push(["Background b", (m.measured ? significant(m.background.value * m.flux.imageUnitFactor, 5) + " MJy/sr" : "—") + " · " + m.background.method]);
      if (m.background.scatter !== null) rows.push(["Annulus scatter / error of b", significant(m.background.scatter * (m.flux ? m.flux.imageUnitFactor : 1), 3) + " / " + significant(m.background.standardError * (m.flux ? m.flux.imageUnitFactor : 1), 3) + " MJy/sr"]);
    }
    if (m.measured) {
      rows.push(["Aperture flux density", significant(m.flux.microJy, 7) + " μJy (" + significant(m.flux.jy, 7) + " Jy)"]);
      rows.push(["Uncertainty", m.fluxErrMicroJy !== null ? significant(m.fluxErrMicroJy, 4) + " μJy" : "Unavailable"]);
      rows.push(["Uncertainty note", m.fluxErrReason]);
      rows.push(["Pixel solid angle (median)", significant(m.omega.medianSr, 6) + " sr" + (m.omega.ratioToHeader ? " · WCS/header OMEGA_MEDIAN = " + significant(m.omega.ratioToHeader, 5) : "")]);
      rows.push(["Wavelength at the target pixel", m.wavelength ? significant(m.wavelength.micron, 7) + " μm (bandwidth " + significant(m.wavelength.bandwidth, 4) + " μm; " + significant(m.wavelength.rangeMin, 6) + " to " + significant(m.wavelength.rangeMax, 6) + " μm across the aperture)" : "Unavailable. " + m.wavelengthReason]);
      rows.push(["Flags", m.flags ? m.flags + ": " + m.flagNames.map((entry) => entry.name).join(", ") : "0 (no flagged pixel in the aperture)"]);
      rows.push(["mjd (UTC)", m.epoch.mjd !== null ? significant(m.epoch.mjd, 12) + " · " + (m.epoch.source === "MJD-AVG" ? "mid-exposure" : "exposure start") : "Unavailable"]);
      rows.push(["Method", Phot.methodLabel + " (" + Phot.method + ")"]);
    } else {
      rows.push(["Reason", m.reasons.join(" ")]);
    }
    el.facts.replaceChildren(...rows.map(([label, value]) => fact(label, value)));
    el.conversions.textContent = m.conversions.length ? "Conversions: " + m.conversions.join(" ") : "";

    el.pixels.replaceChildren(...m.pixels.map((pixel) => {
      const used = pixel.status === "valid";
      const row = document.createElement("tr");
      row.append(
        cell("td", String(pixel.x)), cell("td", String(pixel.y)), cell("td", pixel.w.toFixed(4)),
        cell("td", Number.isFinite(pixel.value) ? significant(pixel.value, 6) : "NaN"),
        cell("td", Number.isFinite(pixel.omega) ? significant(pixel.omega, 6) : "—"),
        cell("td", item.observation.flags ? String(pixel.flags) : "No FLAGS image"),
        cell("td", used ? "Yes" : "Left out: " + (pixel.status === "nan" ? "NaN or BLANK" : pixel.status === "flag" ? "bad FLAGS bit" : "no solid angle"), used ? {} : { "data-state": "left-out" }),
      );
      return row;
    }));
    drawCutout(item);
    if (focus) el.canvas.scrollIntoView({ block: "nearest" });
  }

  // ---- Picture (display only) ----------------------------------------------------------------------------------------------------------
  function drawCutout(item) {
    const { observation, measurement: m } = item;
    const canvas = el.canvas;
    if (!m.position || !m.inImage) {
      canvas.width = canvas.height = 1;
      canvas.hidden = true;
      el.canvasCaption.textContent = "The target is outside this image, so there is no cutout to show.";
      return;
    }
    canvas.hidden = false;
    const reach = Math.max(m.aperture.radiusPixels, m.annulus ? m.annulus.outerPixels : 0) + 5;
    const half = Math.max(10, Math.ceil(reach));
    const { width, height, values } = observation;
    const columnLow = Math.max(0, Math.floor(m.position.x - 0.5 - half));
    const columnHigh = Math.min(width - 1, Math.ceil(m.position.x - 0.5 + half));
    const rowLow = Math.max(0, Math.floor(m.position.y - 0.5 - half));
    const rowHigh = Math.min(height - 1, Math.ceil(m.position.y - 0.5 + half));
    const cutWidth = columnHigh - columnLow + 1;
    const cutHeight = rowHigh - rowLow + 1;
    const scale = Math.max(1, Math.floor(480 / Math.max(cutWidth, cutHeight)));
    canvas.width = cutWidth * scale;
    canvas.height = cutHeight * scale;
    const context = canvas.getContext("2d");
    if (!context) return;
    const picture = document.createElement("canvas");
    picture.width = cutWidth;
    picture.height = cutHeight;
    const pictureContext = picture.getContext("2d");
    const data = pictureContext.createImageData(cutWidth, cutHeight);
    const cut = new Float64Array(cutWidth * cutHeight);
    for (let row = 0; row < cutHeight; row++) for (let column = 0; column < cutWidth; column++) cut[row * cutWidth + column] = values[(rowLow + row) * width + columnLow + column];
    const range = Pair.displayRange([cut], 0.02, 0.995);
    const span = range ? range.high - range.low : 0;
    for (let row = 0; row < cutHeight; row++) {
      for (let column = 0; column < cutWidth; column++) {
        const value = cut[row * cutWidth + column];
        const at = ((cutHeight - 1 - row) * cutWidth + column) * 4; // FITS row 0 is the bottom.
        const shade = Number.isFinite(value) && span > 0 ? Math.max(0, Math.min(255, 255 * Math.sqrt(Math.max(0, (value - range.low) / span)))) : 0;
        data.data[at] = data.data[at + 1] = data.data[at + 2] = shade;
        data.data[at + 3] = 255;
        if (!Number.isFinite(value)) { data.data[at] = 70; data.data[at + 1] = 20; data.data[at + 2] = 70; }
      }
    }
    pictureContext.putImageData(data, 0, 0);
    context.imageSmoothingEnabled = false;
    context.drawImage(picture, 0, 0, canvas.width, canvas.height);

    const toX = (x) => (x - 0.5 - columnLow) * scale;
    const toY = (y) => (rowHigh + 1.5 - y) * scale;
    const circle = (radius, color, dash) => {
      context.beginPath();
      context.setLineDash(dash);
      context.strokeStyle = color;
      context.lineWidth = 2;
      context.arc(toX(m.position.x), toY(m.position.y), radius * scale, 0, 2 * Math.PI);
      context.stroke();
    };
    context.save();
    for (const pixel of m.pixels) {
      if (pixel.status === "valid") continue;
      context.strokeStyle = "#ff7ad9";
      context.lineWidth = 2;
      context.strokeRect(toX(pixel.x - 0.5) + 1, toY(pixel.y + 0.5) + 1, scale - 2, scale - 2);
    }
    circle(m.aperture.radiusPixels, "#ffe27a", []);
    if (m.annulus) {
      circle(m.annulus.innerPixels, "#7ad7ff", [6, 4]);
      circle(m.annulus.outerPixels, "#7ad7ff", [6, 4]);
    }
    context.setLineDash([]);
    context.strokeStyle = "#ffffff";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(toX(m.position.x) - 6, toY(m.position.y));
    context.lineTo(toX(m.position.x) + 6, toY(m.position.y));
    context.moveTo(toX(m.position.x), toY(m.position.y) - 6);
    context.lineTo(toX(m.position.x), toY(m.position.y) + 6);
    context.stroke();
    context.restore();

    canvas.setAttribute("aria-label", "Cutout of " + observation.name + " around the target at pixel " + significant(m.position.x, 5) + ", " + significant(m.position.y, 5) + ". The yellow circle is the aperture" + (m.annulus ? ", the dashed blue circles bound the background annulus" : "") + ".");
    el.canvasCaption.textContent = "Display only (square-root stretch of the " + cutWidth + " × " + cutHeight + " pixel window, " + (range ? "range " + significant(range.low, 3) + " to " + significant(range.high, 3) + " " + (observation.unit || "") : "no finite pixel") + "). Yellow: aperture. Dashed blue: annulus. Pink squares: aperture pixels left out. The measurement never reads these colors.";
  }

  // ---- Results life cycle -----------------------------------------------------------------------------------------------------------------
  function invalidate() {
    const had = Boolean(state.result);
    state.result = null;
    renderResults();
    el.verdict.textContent = state.observations.length ? "Enter a target and press Measure." : "Load images and enter a target to measure.";
    el.exportStatus.textContent = "";
    el.stale.textContent = had ? "Inputs changed: the previous results were cleared. Measure again to update." : "";
    setFormStatus("");
  }

  function run(event) {
    event.preventDefault();
    const form = readForm();
    if (!form.ok) {
      setFormStatus(form.problems.join(" "), true);
      el.stale.textContent = "";
      return;
    }
    if (!state.observations.length) {
      setFormStatus("Load at least one calibrated FITS image first.", true);
      return;
    }
    const items = measureAll(form);
    const csvRows = items.map((item) => item.row).filter(Boolean);
    state.result = { form, items, csvRows, csv: csvRows.length ? Phot.toCsv(csvRows) : "" };
    window.AstroNotLatestSpectrophotometry = state.result; // The reusable result, for tests and other tools.
    el.stale.textContent = "";
    setFormStatus("Measurement complete.");
    renderResults();
  }

  function download() {
    const result = state.result;
    if (!result || !result.csvRows.length) {
      el.exportStatus.textContent = "There is no spectrum point to download.";
      return;
    }
    const name = "spectrophotometry-" + (result.form.sourceId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "source") + ".csv";
    const url = URL.createObjectURL(new Blob([result.csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    el.exportStatus.textContent = name + " downloaded with " + plural(result.csvRows.length, "row") + ". Open Spectrum Lab and choose this file there.";
  }

  // ---- Wiring ---------------------------------------------------------------------------------------------------------------------------------
  el.file.addEventListener("change", () => {
    const chosen = [...el.file.files];
    el.file.value = "";
    if (chosen.length) addFiles(chosen.map((file) => ({ file, name: file.name, example: false })));
  });
  el.examplePair.addEventListener("click", () => { loadExamplePair(); });
  el.exampleSingle.addEventListener("click", () => { loadExampleSingle(); });
  el.clear.addEventListener("click", () => {
    if (el.clear.getAttribute("aria-disabled") === "true") return;
    state.observations = [];
    renderList();
    invalidate();
    setStatus("All images removed.");
    el.file.focus();
  });
  el.form.addEventListener("submit", run);
  el.form.addEventListener("input", () => { syncBackgroundFields(); if (state.result) invalidate(); });
  el.form.addEventListener("change", () => { syncBackgroundFields(); if (state.result) invalidate(); });
  el.download.addEventListener("click", () => {
    if (el.download.getAttribute("aria-disabled") === "true") {
      el.exportStatus.textContent = "Measure first: a CSV needs at least one spectrum point.";
      return;
    }
    download();
  });
  el.detailSelect.addEventListener("change", () => selectDetail(Number(el.detailSelect.value), false));

  syncBackgroundFields();
  renderList();
  el.file.disabled = false;
  el.examplePair.disabled = false;
  el.exampleSingle.disabled = false;
  setDisabled(el.download, true);
})();
