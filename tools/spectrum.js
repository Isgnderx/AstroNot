// Spectrum Lab: opens a spectrum table (CSV) and shows wavelength against flux density with error bars, a sortable table,
// range inputs, unit conversion, log axes with a disclosure of what a log axis cannot show, and decoded archive flags.
//
// Reading, validation, unit conversion, flag decoding, selection, sorting and axis maths are in tools/spectrum-csv.js
// (global AstroNotSpectrum, tested in tests/spectrum.test.mjs). This file is the user interface only. Everything that comes
// from a file is written to the page with textContent, never as HTML.
(function () {
  "use strict";

  const Spectrum = AstroNotSpectrum;
  const query = (name, scope = document) => scope.querySelector("[data-sl-" + name + "]");
  const el = {};
  for (const name of [
    "file", "example", "clear", "status", "provenance", "max-size",
    "columns-panel", "columns-note", "mapping", "unit-wavelength", "unit-flux", "delimiter", "units-note",
    "import-panel", "notes", "facts", "bad", "bad-summary", "bad-reasons", "bad-caption", "bad-body",
    "selection-panel", "source", "observation", "flagfilter", "min", "max", "show-wavelength", "show-flux", "range-error",
    "reset-range", "selection-note",
    "plot-panel", "width", "width-wrap", "plot-title", "chart", "canvas", "empty", "legend", "lognote", "lognote-text",
    "lognote-list", "lognote-details", "live",
    "point-panel", "point-note", "readout", "readout-body", "point-clear",
    "table-panel", "table-note", "table-wrap", "table", "table-caption", "thead", "tbody", "more",
  ]) el[name.replace(/-(\w)/g, (_, letter) => letter.toUpperCase())] = query(name);
  const xScaleButtons = [...document.querySelectorAll("[data-sl-xscale]")];
  const yScaleButtons = [...document.querySelectorAll("[data-sl-yscale]")];

  // Field descriptions for the column picker. required fields cannot be left empty.
  const fieldInfo = [
    ["wavelength", "Wavelength", true], ["flux", "Flux density", true], ["flux_err", "Flux uncertainty", false],
    ["lambda_width", "Wavelength width", false], ["flags", "Flags (bitmask)", false], ["source_id", "Source ID", false],
    ["obs_id", "Observation ID", false], ["mjd", "Observation time (MJD)", false], ["ra", "RA (deg)", false],
    ["dec", "Dec (deg)", false], ["method", "Method", false],
  ];
  const palette = ["#7fb4ff", "#ffb454", "#6fd3a6", "#f08bc0", "#c3a6ff", "#e8e45f"];
  const shapes = ["circle", "square", "diamond", "triangle"];
  const glyphs = { circle: "●", square: "■", diamond: "◆", triangle: "▲" };
  const pageSize = 200;

  // ---- State -----------------------------------------------------------------------------------------------------------
  const state = {
    version: 0, fileName: "", example: false, text: "", encodingNote: "",
    table: null, detect: null, mapping: null, units: { wavelength: "", flux: "" }, result: null, spectrum: null,
    sourceKey: "", obs: null, flags: "all", show: { wavelength: "um", flux: "uJy" },
    xScale: "linear", yScale: "linear", showWidth: false,
    sort: { key: "wavelength", direction: "asc" }, limit: pageSize, selectedId: null,
    view: { points: [], rows: [], byId: new Map(), parsed: { ok: true, min: null, max: null } }, drawn: [], tableKey: "",
  };

  // ---- Helpers ---------------------------------------------------------------------------------------------------------
  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "text") node.textContent = value;
      else if (key === "class") node.className = value;
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children) if (child !== null && child !== undefined) node.append(child);
    return node;
  }

  const number = (value, digits = 6) => Spectrum.formatNumber(value, digits);
  const label = (kind, key) => Spectrum.unitLabel(key, kind);
  const plural = (count, word) => count.toLocaleString("en-US") + " " + word + (count === 1 ? "" : "s");

  function setStatus(message, error = false) {
    el.status.toggleAttribute("data-error", error);
    el.status.textContent = message;
  }

  let announceTimer = 0;
  function announce(message, delay = 0) {
    clearTimeout(announceTimer);
    if (!delay) { el.live.textContent = message; return; }
    announceTimer = setTimeout(() => { el.live.textContent = message; }, delay);
  }

  function mjdText(mjd) {
    if (mjd === null) return "Unavailable";
    const date = new Date(Math.round((mjd - 40587) * 86400000));
    const utc = Number.isNaN(date.getTime()) ? "" : " (" + date.toISOString().slice(0, 19).replace("T", " ") + " UTC)";
    return "MJD " + number(mjd, 10) + utc;
  }

  function fillOptions(select, options, value) {
    select.replaceChildren(...options.map(([optionValue, text]) => h("option", { value: optionValue, text })));
    if (value !== undefined) select.value = value;
  }

  const unitOptions = (kind) => Object.entries(kind === "flux" ? Spectrum.fluxUnits : Spectrum.wavelengthUnits)
    .map(([key, unit]) => [key, unit.label + " (" + unit.name + ")"]);

  // ---- Loading ---------------------------------------------------------------------------------------------------------
  function clearResult() {
    state.table = state.detect = state.mapping = state.result = state.spectrum = null;
    state.selectedId = null;
    state.drawn = [];
    state.tableKey = "";
    for (const panel of ["import-panel", "selection-panel", "plot-panel", "point-panel", "table-panel"]) el[panel.replace(/-(\w)/g, (_, c) => c.toUpperCase())].hidden = true;
    el.provenance.hidden = true;
    el.legend.replaceChildren();
    el.tbody.replaceChildren();
    el.thead.replaceChildren();
    announce("");
  }

  function clearAll() {
    state.version++;
    clearResult();
    el.columnsPanel.hidden = true;
    el.clear.hidden = true;
    el.file.value = "";
    state.text = "";
    setStatus("");
  }

  function failImport(message) {
    clearResult();
    el.columnsPanel.hidden = true;
    el.clear.hidden = false;
    setStatus(message, true);
  }

  async function loadFile(file) {
    const version = ++state.version;
    clearResult();
    el.columnsPanel.hidden = true;
    state.fileName = file.name;
    state.example = false;
    el.clear.hidden = false;
    if (file.size > Spectrum.limits.maxBytes) {
      return failImport(file.name + " is " + (file.size / 1048576).toFixed(1) + " MB. Spectrum Lab reads files up to " + Spectrum.limits.maxBytes / 1048576 + " MB; cut the table down to the source and wavelength range you need.");
    }
    setStatus("Reading " + file.name + "…");
    let buffer;
    try {
      buffer = await file.arrayBuffer();
    } catch {
      if (version === state.version) failImport("The file could not be read. Choose it again.");
      return;
    }
    if (version !== state.version) return;
    const decoded = Spectrum.decodeBytes(buffer);
    if (!decoded.ok) return failImport(decoded.message);
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (version !== state.version) return;
    ingest(decoded.text, file.name, false, decoded.note);
  }

  function loadExample() {
    if (typeof spectrumExampleCsv !== "string") return;
    state.version++;
    clearResult();
    el.clear.hidden = false;
    ingest(spectrumExampleCsv, "Example spectrum (synthetic)", true, "");
  }

  function ingest(text, name, example, note) {
    state.fileName = name;
    state.example = example;
    state.text = text;
    state.encodingNote = note;
    el.delimiter.value = "auto";
    parseTable();
  }

  function parseTable() {
    clearResult();
    const table = Spectrum.readTable(state.text, { delimiter: el.delimiter.value });
    if (!table.ok) {
      el.clear.hidden = false;
      setStatus(table.message, true);
      if (table.code === "no-delimiter" || table.code === "bad-csv" || el.delimiter.value !== "auto") {
        el.columnsPanel.hidden = false;
        el.mapping.replaceChildren();
        el.unitWavelength.disabled = el.unitFlux.disabled = true;
        el.columnsNote.textContent = "This file could not be read as a table. If it uses a delimiter other than the one tried, choose it here.";
        el.unitsNote.textContent = "";
      } else {
        el.columnsPanel.hidden = true;
      }
      return;
    }
    state.table = table;
    state.detect = Spectrum.detectColumns(table.headers);
    state.mapping = { ...state.detect.mapping };
    state.units = { wavelength: state.detect.units.wavelength ?? "", flux: state.detect.units.flux ?? "" };
    buildMappingUi();
    rebuild(true);
  }

  // ---- Columns and units -----------------------------------------------------------------------------------------------
  function buildMappingUi() {
    const { table, detect } = state;
    el.columnsPanel.hidden = false;
    el.unitWavelength.disabled = el.unitFlux.disabled = false;
    const columns = [["", "— none —"], ...table.headers.map((name, index) => [String(index), (name || "(no name)") + " — column " + (index + 1)])];
    el.mapping.replaceChildren(...fieldInfo.map(([field, text, required]) => {
      const select = h("select", { "data-sl-map": field });
      fillOptions(select, required ? [["", "Choose a column…"], ...columns.slice(1)] : columns, state.mapping[field] === null ? "" : String(state.mapping[field]));
      select.addEventListener("change", onMappingChange);
      return h("label", { text: text + (required ? " column" : " column (optional)") }, select);
    }));
    fillOptions(el.unitWavelength, [["", "Choose a unit…"], ...unitOptions("wavelength")], state.units.wavelength);
    fillOptions(el.unitFlux, [["", "Choose a unit…"], ...unitOptions("flux")], state.units.flux);
    el.columnsNote.textContent = detect.contract
      ? "These columns follow the AstroNot spectrum format (wavelength in µm, flux and flux_err in µJy), which is also how the IRSA SPHEREx Spectrophotometry Tool documents them. You can change any choice below."
      : "These column names are not the AstroNot spectrum format, so check each choice and set the units your file uses. A spectrum cannot be drawn until the wavelength and flux columns and both units are chosen.";
    updateUnitsNote();
  }

  function updateUnitsNote() {
    const { detect } = state;
    const parts = [];
    for (const kind of ["wavelength", "flux"]) {
      const source = detect?.units.source[kind];
      if (state.units[kind] && source === "contract") parts.push("The " + kind + " unit " + label(kind, state.units[kind]) + " is the documented unit of this format.");
      else if (state.units[kind] && source === "header") parts.push("The " + kind + " unit " + label(kind, state.units[kind]) + " was read from the column name; check it.");
    }
    el.unitsNote.textContent = parts.join(" ");
  }

  function onMappingChange() {
    const mapping = {};
    for (const select of el.mapping.querySelectorAll("select")) {
      mapping[select.getAttribute("data-sl-map")] = select.value === "" ? null : Number(select.value);
    }
    state.mapping = mapping;
    state.units = { wavelength: el.unitWavelength.value, flux: el.unitFlux.value };
    if (state.detect) {
      // A unit the reader has set by hand no longer counts as documented or read from the header.
      for (const kind of ["wavelength", "flux"]) if (state.units[kind] !== state.detect.units[kind]) state.detect.units.source[kind] = "you";
    }
    updateUnitsNote();
    rebuild(true);
  }

  // ---- Building the spectrum -------------------------------------------------------------------------------------------
  function rebuild(reset) {
    const { table } = state;
    const result = Spectrum.buildSpectrum(table, state.mapping, state.units, { decimalComma: table.delimiter !== "," });
    state.result = result;
    state.spectrum = result.ok ? result : null;
    state.selectedId = null;
    state.drawn = [];
    state.tableKey = "";
    renderImport();
    if (!result.ok) {
      for (const name of ["selectionPanel", "plotPanel", "pointPanel", "tablePanel"]) el[name].hidden = true;
      setStatus(result.message, true);
      announce("");
      return;
    }
    if (reset) {
      state.sourceKey = result.sources[0].key;
      state.obs = null;
      state.flags = "all";
      state.show = { ...result.units };
      state.xScale = state.yScale = "linear";
      state.showWidth = false;
      state.sort = { key: "wavelength", direction: "asc" };
      el.min.value = el.max.value = "";
      el.flagfilter.value = "all";
      el.width.checked = false;
    }
    state.limit = pageSize;
    setupSelection();
    for (const name of ["selectionPanel", "plotPanel", "pointPanel", "tablePanel"]) el[name].hidden = false;
    el.widthWrap.hidden = state.mapping.lambda_width === null;
    el.provenance.hidden = false;
    el.provenance.textContent = state.example
      ? "Synthetic example: generated for AstroNot to show the tool. It is not an archive result and not SPHEREx data; the sources, fluxes, flags and times are invented."
      : "Loaded from " + state.fileName + ". AstroNot reads the values as the file states them and cannot check where a file came from.";
    el.provenance.toggleAttribute("data-synthetic", state.example);
    const skipped = result.bad.length;
    setStatus("Showing " + plural(result.points.length, "measurement") + " from " + state.fileName + "." + (skipped ? " " + plural(skipped, "row") + " could not be used and " + (skipped === 1 ? "was" : "were") + " left out; see What was read." : ""));
    renderAll();
  }

  function setupSelection() {
    const { spectrum } = state;
    fillOptions(el.source, spectrum.sources.map((source) => [source.key, source.label + " — " + plural(source.count, "measurement")]), state.sourceKey);
    fillOptions(el.showWavelength, unitOptions("wavelength"), state.show.wavelength);
    fillOptions(el.showFlux, unitOptions("flux"), state.show.flux);
    el.source.disabled = spectrum.sources.length === 1;
    setupObservations();
    for (const button of xScaleButtons) button.setAttribute("aria-pressed", String(button.dataset.slXscale === state.xScale));
    for (const button of yScaleButtons) button.setAttribute("aria-pressed", String(button.dataset.slYscale === state.yScale));
  }

  function currentSource() {
    return state.spectrum.sources.find((source) => source.key === state.sourceKey);
  }

  function setupObservations() {
    const source = currentSource();
    const options = [["*", "All observations — " + plural(source.count, "measurement")]];
    source.observations.forEach((observation) => options.push(["o:" + observation.key, observation.label + " — " + plural(observation.count, "measurement")]));
    fillOptions(el.observation, options, state.obs === null ? "*" : "o:" + state.obs);
    el.observation.disabled = source.observations.length === 1;
  }

  // ---- What was read -----------------------------------------------------------------------------------------------------
  function renderImport() {
    const { table, result, mapping, units } = state;
    el.importPanel.hidden = false;
    const notes = [];
    const note = (kind, text) => notes.push(h("li", { class: "tm-notes__" + kind, text }));
    if (state.encodingNote) note("warning", state.encodingNote);
    if (table.comments) note("info", plural(table.comments, "comment line") + " starting with # " + (table.comments === 1 ? "was" : "were") + " skipped.");
    if (state.detect) for (const text of state.detect.notes) note("info", text);
    if (result.ok) {
      if (mapping.flux_err === null) note("warning", "There is no flux uncertainty column, so no error bars can be drawn. Uncertainty is Unavailable for every measurement.");
      else if (result.points.some((point) => point.fluxErr === null)) note("info", plural(result.points.filter((point) => point.fluxErr === null).length, "measurement") + " have an empty flux_err; their uncertainty is Unavailable and no bar is drawn.");
      if (result.decimalComma && result.points.length) note("info", "Numbers written with a decimal comma were read in this " + table.delimiterName + "-separated file.");
      const seen = new Set();
      const repeated = new Set();
      for (const point of result.points) {
        const key = Spectrum.sourceKey(point) + "\u0000" + point.wavelength;
        (seen.has(key) ? repeated : seen).add(key);
      }
      if (repeated.size) note("info", plural(repeated.size, "wavelength") + " " + (repeated.size === 1 ? "has" : "have") + " more than one measurement. Each is kept as its own point.");
      if (result.bad.length) note("warning", plural(result.bad.length, "row") + " could not be used and " + (result.bad.length === 1 ? "was" : "were") + " left out.");
    }
    el.notes.replaceChildren(...notes);
    el.notes.hidden = notes.length === 0;

    const facts = [
      ["File", state.fileName],
      ["Format", table.delimiterName + "-separated, header on line " + table.headerLine],
      ["Columns", table.headers.length + " (" + table.headers.filter((name, index) => !Object.values(mapping).includes(index)).length + " kept as extra columns)"],
      ["Rows read", table.records.length.toLocaleString("en-US")],
      ["Measurements used", result.ok ? result.points.length.toLocaleString("en-US") : "0"],
      ["Rows left out", result.bad ? result.bad.length.toLocaleString("en-US") : "0"],
      ["Units in the file", units.wavelength && units.flux ? label("wavelength", units.wavelength) + " and " + label("flux", units.flux) : "Not chosen yet"],
    ];
    if (result.ok) {
      facts.splice(5, 0, ["Sources", String(result.sources.length)], ["Observations", String(new Set(result.points.map((point) => Spectrum.sourceKey(point) + "\u0000" + point.obs)).size)]);
    }
    el.facts.replaceChildren(...facts.map(([name, value]) => h("div", {}, h("dt", { text: name }), h("dd", { text: value }))));

    const bad = result.bad ?? [];
    el.bad.hidden = bad.length === 0;
    if (bad.length) {
      el.badSummary.textContent = plural(bad.length, "row") + " left out — show the reasons";
      el.badReasons.replaceChildren(...result.badSummary.map((entry) => h("li", { text: plural(entry.count, "row") + ": " + entry.reason })));
      const shown = bad.slice(0, 50);
      el.badCaption.textContent = bad.length > shown.length ? "The first " + shown.length + " of " + bad.length.toLocaleString("en-US") + " rows left out" : "Rows left out";
      el.badBody.replaceChildren(...shown.map((row) => h("tr", {}, h("td", { text: String(row.line) }), h("td", { text: row.reason.charAt(0).toUpperCase() + row.reason.slice(1) }))));
      if (!result.ok) el.bad.open = true;
    }
  }

  // ---- View -------------------------------------------------------------------------------------------------------------
  function computeView() {
    let parsed = Spectrum.parseRange(el.min.value, el.max.value);
    if (parsed.ok) el.rangeError.textContent = "";
    else {
      // An invalid range never leaves the previous result on screen: the whole range is shown until the inputs are valid.
      el.rangeError.textContent = parsed.message + " The whole wavelength range is shown until the range is valid.";
      parsed = { ok: true, min: null, max: null };
    }
    const { spectrum } = state;
    const selection = { source: state.sourceKey, obs: state.obs, flags: state.flags, min: parsed.min, max: parsed.max, rangeUnit: state.show.wavelength };
    const points = Spectrum.selectPoints(spectrum, selection);
    const rows = points.map((point) => Spectrum.displayPoint(point, spectrum.units, state.show));
    state.view = { points, rows, byId: new Map(rows.map((row) => [row.point.id, row])), parsed };
    if (state.selectedId !== null && !state.view.byId.has(state.selectedId)) state.selectedId = null;
    return true;
  }

  function renderAll() {
    if (!state.spectrum) return;
    computeView();
    renderSelectionNote();
    renderPlot();
    renderTable();
    renderPoint();
  }

  function renderSelectionNote() {
    const { view, spectrum } = state;
    const total = currentSource().count;
    const range = view.parsed;
    const wavelength = label("wavelength", state.show.wavelength);
    const rangeText = range.min !== null || range.max !== null
      ? " between " + (range.min !== null ? number(range.min) : "the shortest") + " and " + (range.max !== null ? number(range.max) : "the longest") + " " + wavelength
      : "";
    el.selectionNote.textContent = "Showing " + view.rows.length.toLocaleString("en-US") + " of " + total.toLocaleString("en-US") + " measurements of " + currentSource().label +
      (state.obs !== null ? ", observation " + (state.obs || "Unspecified") : "") + rangeText + ". Other sources are not mixed in. Values are shown in " + wavelength + " and " + label("flux", state.show.flux) + "; the file uses " + label("wavelength", spectrum.units.wavelength) + " and " + label("flux", spectrum.units.flux) + ".";
  }

  // ---- Plot -------------------------------------------------------------------------------------------------------------
  const margin = { left: 74, right: 18, top: 16, bottom: 52 };
  const ink = "#dce0e8";
  const muted = "#a9b1be";

  function observationStyle(key) {
    const index = Math.max(0, currentSource().observations.findIndex((observation) => observation.key === key));
    return { color: palette[index % palette.length], shape: shapes[index % shapes.length] };
  }

  function markerPath(ctx, shape, x, y, r) {
    ctx.beginPath();
    if (shape === "circle") ctx.arc(x, y, r, 0, Math.PI * 2);
    else if (shape === "square") ctx.rect(x - r * 0.9, y - r * 0.9, r * 1.8, r * 1.8);
    else if (shape === "diamond") { ctx.moveTo(x, y - r * 1.25); ctx.lineTo(x + r * 1.25, y); ctx.lineTo(x, y + r * 1.25); ctx.lineTo(x - r * 1.25, y); ctx.closePath(); }
    else { ctx.moveTo(x, y - r * 1.15); ctx.lineTo(x + r * 1.1, y + r * 0.85); ctx.lineTo(x - r * 1.1, y + r * 0.85); ctx.closePath(); }
  }

  function renderPlot() {
    renderLegend();
    drawPlot();
  }

  function renderLegend() {
    const { rows } = state.view;
    const counts = new Map();
    for (const row of rows) counts.set(row.point.obs, (counts.get(row.point.obs) ?? 0) + 1);
    const items = currentSource().observations.filter((observation) => counts.has(observation.key)).map((observation) => {
      const style = observationStyle(observation.key);
      const mjd = observation.mjd === null ? "" : ", " + mjdText(observation.mjd).split(" (")[0];
      return h("li", {}, h("span", { class: "sl-swatch", "aria-hidden": "true", style: "color:" + style.color, text: glyphs[style.shape] }), h("span", { text: observation.label + " — " + plural(counts.get(observation.key), "point") + mjd }));
    });
    items.push(h("li", {}, h("span", { class: "sl-swatch", "aria-hidden": "true", text: "○" }), h("span", { text: "Hollow marker: a flag is set" })));
    el.legend.replaceChildren(...items);
  }

  function drawPlot() {
    const canvas = el.canvas;
    const width = el.chart.clientWidth;
    const height = el.chart.clientHeight;
    if (!width || !height) return;
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = "#060709";
    ctx.fillRect(0, 0, width, height);
    state.drawn = [];

    const { rows, parsed } = state.view;
    const unitW = label("wavelength", state.show.wavelength);
    const unitF = label("flux", state.show.flux);
    const sourceLabel = currentSource().label;
    el.plotTitle.textContent = sourceLabel + (state.obs !== null ? " · observation " + (state.obs || "unspecified") : "") + " · flux density in " + unitF + " against wavelength in " + unitW;
    el.empty.hidden = true;

    const alt = (extra) => { canvas.setAttribute("aria-label", "Spectrum of " + sourceLabel + ". " + extra + " Every value is in the table below the plot."); };
    if (rows.length === 0) {
      el.empty.hidden = false;
      el.empty.textContent = state.view.parsed.min !== null || state.view.parsed.max !== null || state.flags !== "all" || state.obs !== null
        ? "No measurements match the current range, observation and flag choices."
        : "This source has no measurements.";
      alt("No measurements are shown.");
      el.lognote.hidden = true;
      return;
    }

    const logY = state.yScale === "log";
    const logX = state.xScale === "log";
    const disclosure = Spectrum.logDisclosure(rows);
    const drawable = logY ? rows.filter((row) => row.flux > 0) : rows;
    renderLogNote(disclosure, logY);
    if (drawable.length === 0) {
      el.empty.hidden = false;
      el.empty.textContent = "None of these measurements has a positive flux, so none can be placed on a logarithmic flux axis. Switch the flux axis to linear to see them.";
      alt("No point can be drawn on the logarithmic flux axis.");
      return;
    }

    const waves = rows.map((row) => row.wavelength);
    const xLow = parsed.min ?? Math.min(...waves);
    const xHigh = parsed.max ?? Math.max(...waves);
    const xAxis = Spectrum.computeAxis(logX ? Math.max(xLow, Number.MIN_VALUE) : xLow, xHigh, state.xScale);
    let yLow = Infinity;
    let yHigh = -Infinity;
    for (const row of drawable) {
      const error = row.fluxErr ?? 0;
      const low = logY ? (row.flux - error > 0 ? row.flux - error : row.flux) : row.flux - error;
      yLow = Math.min(yLow, low);
      yHigh = Math.max(yHigh, row.flux + error);
    }
    const yAxis = Spectrum.computeAxis(yLow, yHigh, state.yScale);

    const plot = { x: margin.left, y: margin.top, w: Math.max(40, width - margin.left - margin.right), h: Math.max(40, height - margin.top - margin.bottom) };
    const sx = (value) => plot.x + (logX ? (Math.log(value) - Math.log(xAxis.min)) / (Math.log(xAxis.max) - Math.log(xAxis.min)) : (value - xAxis.min) / (xAxis.max - xAxis.min)) * plot.w;
    const sy = (value) => plot.y + plot.h - (logY ? (Math.log(value) - Math.log(yAxis.min)) / (Math.log(yAxis.max) - Math.log(yAxis.min)) : (value - yAxis.min) / (yAxis.max - yAxis.min)) * plot.h;
    const clampY = (value) => Math.min(plot.y + plot.h, Math.max(plot.y, value));

    ctx.font = "12px Inter, Arial, sans-serif";
    ctx.lineWidth = 1;
    ctx.fillStyle = muted;
    ctx.strokeStyle = "#252a32";
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    for (const tick of yAxis.ticks) {
      const y = Math.round(sy(tick.value)) + 0.5;
      if (y < plot.y - 1 || y > plot.y + plot.h + 1) continue;
      ctx.beginPath(); ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.w, y); ctx.stroke();
      ctx.fillText(tick.label, plot.x - 8, y);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    let lastRight = -Infinity;
    for (const tick of xAxis.ticks) {
      const x = Math.round(sx(tick.value)) + 0.5;
      if (x < plot.x - 1 || x > plot.x + plot.w + 1) continue;
      ctx.beginPath(); ctx.moveTo(x, plot.y); ctx.lineTo(x, plot.y + plot.h); ctx.stroke();
      const textWidth = ctx.measureText(tick.label).width;
      if (x - textWidth / 2 > lastRight + 6) { ctx.fillText(tick.label, x, plot.y + plot.h + 8); lastRight = x + textWidth / 2; }
    }
    ctx.strokeStyle = "#5b6270";
    ctx.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.w, plot.h);
    if (!logY && yAxis.min < 0 && yAxis.max > 0) {
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = "#8a93a3";
      const zero = Math.round(sy(0)) + 0.5;
      ctx.beginPath(); ctx.moveTo(plot.x, zero); ctx.lineTo(plot.x + plot.w, zero); ctx.stroke();
      ctx.restore();
    }
    ctx.fillStyle = ink;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText("Wavelength (" + unitW + ")" + (logX ? ", log scale" : ""), plot.x + plot.w / 2, height - 10);
    ctx.save();
    ctx.translate(16, plot.y + plot.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("Flux density (" + unitF + ")" + (logY ? ", log scale" : ""), 0, 0);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, plot.y, plot.w, plot.h);
    ctx.clip();
    if (state.showWidth && state.mapping.lambda_width !== null) {
      ctx.lineWidth = 1;
      for (const row of drawable) {
        if (row.width === null) continue;
        const style = observationStyle(row.point.obs);
        const y = sy(row.flux);
        const low = Math.max(row.wavelength - row.width / 2, logX ? xAxis.min : -Infinity);
        ctx.strokeStyle = style.color + "88";
        ctx.beginPath(); ctx.moveTo(sx(low), y); ctx.lineTo(sx(row.wavelength + row.width / 2), y); ctx.stroke();
      }
    }
    ctx.lineWidth = 1.4;
    for (const row of drawable) {
      if (row.fluxErr === null) continue;
      const style = observationStyle(row.point.obs);
      let low = row.flux - row.fluxErr;
      if (logY && low <= 0) low = yAxis.min;
      const x = sx(row.wavelength);
      const top = clampY(sy(row.flux + row.fluxErr));
      const bottom = clampY(sy(low));
      ctx.strokeStyle = style.color + "cc";
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom);
      ctx.moveTo(x - 3, top); ctx.lineTo(x + 3, top);
      if (!(logY && row.flux - row.fluxErr <= 0)) { ctx.moveTo(x - 3, bottom); ctx.lineTo(x + 3, bottom); }
      ctx.stroke();
    }
    for (const row of drawable) {
      const style = observationStyle(row.point.obs);
      const x = sx(row.wavelength);
      const y = sy(row.flux);
      state.drawn.push({ row, x, y });
      markerPath(ctx, style.shape, x, y, 3.6);
      if (row.point.flags) { ctx.fillStyle = "#060709"; ctx.fill(); ctx.lineWidth = 1.6; ctx.strokeStyle = style.color; ctx.stroke(); }
      else { ctx.fillStyle = style.color; ctx.fill(); }
    }
    const selected = state.drawn.find((entry) => entry.row.point.id === state.selectedId);
    if (selected) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#ffffff";
      ctx.beginPath(); ctx.arc(selected.x, selected.y, 9, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();

    const flux = drawable.map((row) => row.flux);
    alt(plural(rows.length, "measurement") + " from " + number(Math.min(...waves), 5) + " to " + number(Math.max(...waves), 5) + " " + unitW + ", flux from " + number(Math.min(...flux), 5) + " to " + number(Math.max(...flux), 5) + " " + unitF + ".");
  }

  function renderLogNote(disclosure, logY) {
    if (!logY || (disclosure.dropped.length === 0 && disclosure.clipped.length === 0)) {
      el.lognote.hidden = true;
      return;
    }
    const unitW = label("wavelength", state.show.wavelength);
    const unitF = label("flux", state.show.flux);
    const parts = [];
    if (disclosure.dropped.length) {
      const one = disclosure.dropped.length === 1;
      parts.push(disclosure.dropped.length.toLocaleString("en-US") + " of the " + state.view.rows.length.toLocaleString("en-US") + " measurements " + (one ? "has" : "have") + " a flux of zero or below, which a logarithmic axis cannot show. " + (one ? "It is" : "They are") + " not drawn, but " + (one ? "stays" : "stay") + " in the table. Switch the flux axis to Linear to see " + (one ? "it." : "them."));
    }
    if (disclosure.clipped.length) {
      parts.push(plural(disclosure.clipped.length, "error bar") + " reach" + (disclosure.clipped.length === 1 ? "es" : "") + " zero or below; the lower end is cut at the bottom of the plot and has no cap.");
    }
    el.lognoteText.textContent = parts.join(" ");
    el.lognoteDetails.hidden = disclosure.dropped.length === 0;
    const shown = disclosure.dropped.slice(0, 30);
    el.lognoteList.replaceChildren(...shown.map((row) => h("li", { text: "Line " + row.point.line + ": " + number(row.wavelength) + " " + unitW + ", flux " + number(row.flux) + " " + unitF })));
    if (disclosure.dropped.length > shown.length) el.lognoteList.append(h("li", { text: "… and " + (disclosure.dropped.length - shown.length) + " more (see the table)." }));
    el.lognote.hidden = false;
  }

  // ---- Selecting a measurement -----------------------------------------------------------------------------------------
  function select(id, { scroll = false } = {}) {
    state.selectedId = id;
    drawPlot();
    renderPoint();
    markTableSelection(scroll);
    const row = id === null ? null : state.view.byId.get(id);
    if (row) announce(describe(row), 50);
    else announce("Selection cleared.", 50);
  }

  function describe(row) {
    const unitW = label("wavelength", state.show.wavelength);
    const unitF = label("flux", state.show.flux);
    const error = row.fluxErr === null ? "uncertainty unavailable" : "± " + number(row.fluxErr, 4);
    return "Line " + row.point.line + ": " + number(row.wavelength, 6) + " " + unitW + ", flux " + number(row.flux, 6) + " " + unitF + ", " + error +
      (row.point.flags ? ", flags " + row.point.flags : "") + (row.point.obs ? ", observation " + row.point.obs : "") + ".";
  }

  function nearest(x, y) {
    let best = null;
    let bestDistance = 18 * 18;
    for (const entry of state.drawn) {
      const distance = (entry.x - x) ** 2 + (entry.y - y) ** 2;
      if (distance <= bestDistance) { best = entry; bestDistance = distance; }
    }
    return best;
  }

  function onCanvasClick(event) {
    const rect = el.canvas.getBoundingClientRect();
    const entry = nearest(event.clientX - rect.left, event.clientY - rect.top);
    if (entry) select(entry.row.point.id, { scroll: true });
    else if (state.selectedId !== null) select(null);
  }

  function onChartKey(event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const list = state.drawn;
    if (event.key === "Escape") { if (state.selectedId !== null) { event.preventDefault(); select(null); } return; }
    if (!list.length || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = list.findIndex((entry) => entry.row.point.id === state.selectedId);
    let next;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = list.length - 1;
    else {
      const step = (event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 1) * (event.shiftKey ? 10 : 1);
      next = current < 0 ? (step > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, current + step));
    }
    select(list[next].row.point.id, { scroll: true });
  }

  function renderPoint() {
    const row = state.selectedId === null ? null : state.view.byId.get(state.selectedId);
    el.pointClear.hidden = !row;
    el.readout.hidden = !row;
    if (!row) {
      el.pointNote.textContent = "Select a marker in the plot or a row in the table.";
      el.readoutBody.replaceChildren();
      return;
    }
    const point = row.point;
    const { mapping, spectrum } = state;
    const fileW = label("wavelength", spectrum.units.wavelength);
    const fileF = label("flux", spectrum.units.flux);
    const unitW = label("wavelength", state.show.wavelength);
    const unitF = label("flux", state.show.flux);
    const raw = (field) => (mapping[field] === null ? "" : point.cells[mapping[field]]);
    const flag = Spectrum.decodeFlags(point.flags);
    const rows = [
      ["Source", currentSource().label],
      ["Observation", point.obs || "Unavailable"],
      ["Input line", "Line " + point.line + " of the file (data row " + point.row + ")"],
      ["Wavelength", number(row.wavelength, 8) + " " + unitW],
      ["Flux density", number(row.flux, 8) + " " + unitF + (row.flux < 0 ? " (negative: a measurement below zero, kept)" : row.flux === 0 ? " (exactly zero, kept)" : "")],
      ["Flux uncertainty", row.fluxErr === null ? "Unavailable" : "± " + number(row.fluxErr, 8) + " " + unitF],
    ];
    if (mapping.lambda_width !== null) rows.push(["Wavelength width", row.width === null ? "Unavailable" : number(row.width, 8) + " " + unitW]);
    if (mapping.flags !== null) rows.push(["Flags", point.flags === null ? "Not reported" : flag.raw + (point.flags === 0 ? " (no flag set)" : " — " + flag.text)]);
    if (mapping.mjd !== null) rows.push(["Observation time", mjdText(point.mjd)]);
    if (mapping.ra !== null || mapping.dec !== null) rows.push(["Position (deg)", (raw("ra") || "Unavailable") + ", " + (raw("dec") || "Unavailable")]);
    if (mapping.method !== null) rows.push(["Method", point.method || "Unavailable"]);
    const written = ["wavelength = " + raw("wavelength") + " " + fileW, "flux = " + raw("flux") + " " + fileF];
    if (mapping.flux_err !== null) written.push("flux_err = " + (raw("flux_err") === "" ? "(empty)" : raw("flux_err") + " " + fileF));
    rows.push(["As written in the file", written.join("; ")]);
    const extras = Object.entries(point.extra);
    if (extras.length) rows.push(["Other columns", extras.map(([name, value]) => name + " = " + (value === "" ? "(empty)" : value)).join("; ")]);
    if (!state.drawn.some((entry) => entry.row.point.id === point.id)) rows.push(["Plot", "Not drawn on the current axes (zero or negative flux on a logarithmic axis)"]);
    el.pointNote.textContent = "Values are converted to the units shown; the original text of the row is listed so the two can be compared.";
    el.readoutBody.replaceChildren(...rows.map(([name, value]) => h("tr", {}, h("th", { scope: "row", text: name }), h("td", { text: value }))));
  }

  // ---- Table -------------------------------------------------------------------------------------------------------------
  function tableColumns() {
    const { mapping } = state;
    const unitW = label("wavelength", state.show.wavelength);
    const unitF = label("flux", state.show.flux);
    const columns = [
      { key: "line", label: "Input line" },
      { key: "wavelength", label: "Wavelength (" + unitW + ")", cell: (row) => number(row.wavelength) },
      { key: "flux", label: "Flux (" + unitF + ")", cell: (row) => number(row.flux) },
      { key: "fluxErr", label: "Flux error (" + unitF + ")", cell: (row) => (row.fluxErr === null ? null : number(row.fluxErr)) },
    ];
    if (mapping.lambda_width !== null) columns.push({ key: "width", label: "Width (" + unitW + ")", cell: (row) => (row.width === null ? null : number(row.width)) });
    if (mapping.flags !== null) columns.push({ key: "flags", label: "Flags", flags: true });
    if (mapping.obs_id !== null) columns.push({ key: "obs", label: "Observation", cell: (row) => row.point.obs || null });
    if (mapping.mjd !== null) columns.push({ key: "mjd", label: "MJD", cell: (row) => (row.point.mjd === null ? null : number(row.point.mjd, 10)) });
    return columns;
  }

  function renderTable() {
    const { view } = state;
    const columns = tableColumns();
    const signature = columns.map((column) => column.label).join("|");
    if (signature !== state.tableKey) {
      state.tableKey = signature;
      el.thead.replaceChildren(h("tr", {}, ...columns.map((column) => {
        const button = h("button", { class: "sl-sort", type: "button", "data-key": column.key, text: column.label });
        button.addEventListener("click", () => onSort(column.key));
        return h("th", { scope: "col", "aria-sort": "none" }, button);
      })));
    }
    [...el.thead.querySelectorAll("th")].forEach((th, index) => {
      const active = columns[index].key === state.sort.key;
      th.setAttribute("aria-sort", active ? (state.sort.direction === "asc" ? "ascending" : "descending") : "none");
    });
    const total = currentSource().count;
    el.tableCaption.textContent = currentSource().label + ": " + view.rows.length.toLocaleString("en-US") + " of " + total.toLocaleString("en-US") + " measurements, sorted by " +
      columns.find((column) => column.key === state.sort.key).label.replace(/ \(.*/, "").toLowerCase() + (state.sort.direction === "asc" ? " ascending" : " descending");

    const sorted = Spectrum.sortPoints(view.points, state.sort.key, state.sort.direction);
    const visible = sorted.slice(0, state.limit);
    el.tbody.replaceChildren(...visible.map((point) => {
      const row = view.byId.get(point.id);
      const cells = columns.map((column) => {
        if (column.key === "line") {
          const button = h("button", { class: "sl-row-button", type: "button", "data-id": String(point.id), "aria-pressed": "false", text: "Line " + point.line });
          button.addEventListener("click", () => select(point.id === state.selectedId ? null : point.id));
          return h("th", { scope: "row" }, button);
        }
        if (column.flags) {
          if (point.flags === null) return h("td", { class: "sl-unavailable", text: "Not reported" });
          const decoded = Spectrum.decodeFlags(point.flags);
          return h("td", {}, h("span", { text: decoded.raw }), point.flags ? h("span", { class: "sl-flagtext", text: decoded.text }) : null);
        }
        const text = column.cell(row);
        return h("td", { class: text === null ? "sl-unavailable" : "sl-number", text: text ?? "Unavailable" });
      });
      return h("tr", { "data-id": String(point.id) }, ...cells);
    }));
    el.more.hidden = sorted.length <= state.limit;
    if (sorted.length > state.limit) el.more.textContent = "Show " + Math.min(pageSize, sorted.length - state.limit) + " more rows (" + (sorted.length - state.limit).toLocaleString("en-US") + " not shown)";
    el.tableNote.textContent = view.rows.length === 0
      ? "No measurements match the current choices."
      : "Sort a column with its heading button. Press a Line button to select that measurement.";
    markTableSelection(false);
  }

  function markTableSelection(scroll) {
    for (const button of el.tbody.querySelectorAll(".sl-row-button")) {
      const on = Number(button.dataset.id) === state.selectedId;
      button.setAttribute("aria-pressed", String(on));
      button.closest("tr").toggleAttribute("data-selected", on);
      if (on && scroll) button.closest("tr").scrollIntoView({ block: "nearest" });
    }
  }

  function onSort(key) {
    state.sort = state.sort.key === key
      ? { key, direction: state.sort.direction === "asc" ? "desc" : "asc" }
      : { key, direction: "asc" };
    state.limit = pageSize;
    renderTable();
    announce("Sorted by " + key + ", " + (state.sort.direction === "asc" ? "ascending" : "descending") + ".");
    el.thead.querySelector('[data-key="' + key + '"]')?.focus();
  }

  // ---- Controls ----------------------------------------------------------------------------------------------------------
  function onSourceChange() {
    state.sourceKey = el.source.value;
    state.obs = null;
    state.selectedId = null;
    state.limit = pageSize;
    setupObservations();
    state.tableKey = "";
    renderAll();
    announce("Source " + currentSource().label + ": " + plural(currentSource().count, "measurement") + ".");
  }

  function onObservationChange() {
    state.obs = el.observation.value === "*" ? null : el.observation.value.slice(2);
    state.limit = pageSize;
    renderAll();
  }

  function onShowUnitChange() {
    const previous = state.show;
    state.show = { wavelength: el.showWavelength.value, flux: el.showFlux.value };
    // The range inputs hold numbers in the wavelength unit shown; convert them so they keep describing the same range.
    if (previous.wavelength !== state.show.wavelength) {
      for (const input of [el.min, el.max]) {
        const parsed = Spectrum.parseNumber(input.value);
        if (parsed.value !== undefined && parsed.value > 0) input.value = number(Spectrum.convert(parsed.value, previous.wavelength, state.show.wavelength, "wavelength"), 10);
      }
    }
    state.tableKey = "";
    renderAll();
    announce("Showing wavelength in " + label("wavelength", state.show.wavelength) + " and flux in " + label("flux", state.show.flux) + ".");
  }

  function onRangeInput() {
    state.limit = pageSize;
    if (!computeView()) return;
    renderSelectionNote();
    renderPlot();
    renderTable();
    renderPoint();
    announce(state.view.rows.length.toLocaleString("en-US") + " measurements in this range.", 600);
  }

  function setScale(axis, scale) {
    state[axis + "Scale"] = scale;
    for (const button of axis === "x" ? xScaleButtons : yScaleButtons) button.setAttribute("aria-pressed", String(button.dataset[axis === "x" ? "slXscale" : "slYscale"] === scale));
    drawPlot();
    renderPoint();
    announce((axis === "x" ? "Wavelength" : "Flux") + " axis is " + scale + ".");
  }

  // ---- Wiring ------------------------------------------------------------------------------------------------------------
  el.maxSize.textContent = String(Spectrum.limits.maxBytes / 1048576);
  el.example.disabled = typeof spectrumExampleCsv !== "string";
  el.file.addEventListener("change", () => {
    const [file] = el.file.files;
    el.file.value = "";
    if (file) loadFile(file);
  });
  el.example.addEventListener("click", loadExample);
  el.clear.addEventListener("click", clearAll);
  el.delimiter.addEventListener("change", () => { if (state.text) parseTable(); });
  el.unitWavelength.addEventListener("change", onMappingChange);
  el.unitFlux.addEventListener("change", onMappingChange);
  el.source.addEventListener("change", onSourceChange);
  el.observation.addEventListener("change", onObservationChange);
  el.flagfilter.addEventListener("change", () => { state.flags = el.flagfilter.value; state.limit = pageSize; renderAll(); });
  el.showWavelength.addEventListener("change", onShowUnitChange);
  el.showFlux.addEventListener("change", onShowUnitChange);
  el.min.addEventListener("input", onRangeInput);
  el.max.addEventListener("input", onRangeInput);
  el.resetRange.addEventListener("click", () => { el.min.value = el.max.value = ""; onRangeInput(); });
  el.width.addEventListener("change", () => { state.showWidth = el.width.checked; drawPlot(); });
  for (const button of xScaleButtons) button.addEventListener("click", () => setScale("x", button.dataset.slXscale));
  for (const button of yScaleButtons) button.addEventListener("click", () => setScale("y", button.dataset.slYscale));
  el.canvas.addEventListener("click", onCanvasClick);
  el.chart.addEventListener("keydown", onChartKey);
  el.pointClear.addEventListener("click", () => select(null));
  el.more.addEventListener("click", () => { state.limit += pageSize; renderTable(); });
  if (typeof ResizeObserver === "function") new ResizeObserver(() => { if (state.spectrum) drawPlot(); }).observe(el.chart);
  else window.addEventListener("resize", () => { if (state.spectrum) drawPlot(); });
})();
