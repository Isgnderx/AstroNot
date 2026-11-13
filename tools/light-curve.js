// Light Curve Analysis workspace: file loading, column mapping, filters, SVG plot, tables, selection and export.
// All science lives in tools/timeseries.js (no DOM). This file only reads the page, calls that model and draws the result.
(function () {
  "use strict";

  const T = window.AstroNotTimeSeries;
  const fileInput = document.querySelector("[data-lc-file]");
  if (!T || !fileInput) return;

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const svgNs = "http://www.w3.org/2000/svg";

  const palette = ["#6cb6ff", "#f2a65a", "#7fd18b", "#e58bd0", "#e9d86a", "#9aa4ff", "#ff8a80", "#5fd1c9"];
  const shapes = ["circle", "square", "diamond", "triangle"];
  const maxFileBytes = 30 * 1024 * 1024;
  const initialRowLimit = 500;

  const nodes = {
    example: $("[data-lc-example]"),
    status: $("[data-lc-status]"),
    facts: $("[data-lc-facts]"),
    rejected: $("[data-lc-rejected]"),
    rejectedSummary: $("[data-lc-rejected-summary]"),
    rejectedList: $("[data-lc-rejected-list]"),
    columnsPanel: $("[data-lc-columns]"),
    profileNote: $("[data-lc-profile-note]"),
    timeFormat: $("[data-lc-time-format]"),
    timeScale: $("[data-lc-time-scale]"),
    barycentric: $("[data-lc-barycentric]"),
    kind: $("[data-lc-kind]"),
    unit: $("[data-lc-unit]"),
    unitCustomWrap: $("[data-lc-unit-custom-wrap]"),
    unitCustom: $("[data-lc-unit-custom]"),
    defaultSource: $("[data-lc-default-source]"),
    defaultBand: $("[data-lc-default-band]"),
    apply: $("[data-lc-apply]"),
    applyStatus: $("[data-lc-apply-status]"),
    filtersPanel: $("[data-lc-filters]"),
    source: $("[data-lc-source]"),
    binning: $("[data-lc-binning]"),
    widthWrap: $("[data-lc-width-wrap]"),
    width: $("[data-lc-width]"),
    edgesWrap: $("[data-lc-edges-wrap]"),
    edges: $("[data-lc-edges]"),
    from: $("[data-lc-from]"),
    to: $("[data-lc-to]"),
    rangeReset: $("[data-lc-range-reset]"),
    quality: $("[data-lc-quality]"),
    ignore: $("[data-lc-ignore]"),
    qualityNote: $("[data-lc-quality-note]"),
    display: $("[data-lc-display]"),
    axisFormat: $("[data-lc-axis-format]"),
    plotScale: $("[data-lc-plot-scale]"),
    plotRef: $("[data-lc-plot-ref]"),
    seriesList: $("[data-lc-series-list]"),
    seriesAll: $("[data-lc-series-all]"),
    seriesNone: $("[data-lc-series-none]"),
    filterStatus: $("[data-lc-filter-status]"),
    notes: $("[data-lc-notes]"),
    plotPanel: $("[data-lc-plot-panel]"),
    connect: $("[data-lc-connect]"),
    legend: $("[data-lc-legend]"),
    chart: $("[data-lc-chart]"),
    svg: $("[data-lc-svg]"),
    axisNote: $("[data-lc-axis-note]"),
    live: $("[data-lc-live]"),
    summaryPanel: $("[data-lc-summary-panel]"),
    summaryBody: $("[data-lc-summary-body]"),
    summaryCaption: $("[data-lc-summary-caption]"),
    heads: { first: $("[data-lc-first-head]"), last: $("[data-lc-last-head]"), mean: $("[data-lc-mean-head]"), median: $("[data-lc-median-head]") },
    tablePanel: $("[data-lc-table-panel]"),
    tableScroll: $("[data-lc-table-scroll]"),
    tableCaption: $("[data-lc-table-caption]"),
    tableHead: $("[data-lc-table-head]"),
    tableBody: $("[data-lc-table-body]"),
    tableNote: $("[data-lc-table-note]"),
    showAll: $("[data-lc-show-all]"),
    detailPanel: $("[data-lc-detail-panel]"),
    detailEmpty: $("[data-lc-detail-empty]"),
    detail: $("[data-lc-detail]"),
    exportPanel: $("[data-lc-export-panel]"),
    exportButton: $("[data-lc-export]"),
    exportStatus: $("[data-lc-export-status]"),
  };

  const state = {
    table: null,
    fileName: "",
    provenance: "",
    profile: null,
    config: null,
    records: [],
    rejected: [],
    binning: { mode: "none", width: 0.1, edges: [] },
    sourceFilter: "",
    seriesKeys: new Set(),
    plotTime: { scale: "UTC", barycentric: false },
    display: null,
    axisFormat: "mjd",
    timeFrom: null,
    timeTo: null,
    quality: "all",
    ignoreMask: 0,
    connect: false,
    selectedId: null,
    rowLimit: initialRowLimit,
    view: null,
    plotPoints: [],
    loadToken: 0,
  };

  // ---- Small helpers -------------------------------------------------------------------------------------------------
  function say(node, text, error = false) {
    node.textContent = text;
    if (error) node.setAttribute("data-error", ""); else node.removeAttribute("data-error");
  }

  function make(tag, properties = {}, children = []) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(properties)) {
      if (name === "text") node.textContent = value;
      else if (name === "class") node.className = value;
      else if (value === true) node.setAttribute(name, "");
      else if (value !== false && value !== null && value !== undefined) node.setAttribute(name, value);
    }
    for (const child of [].concat(children)) node.append(child);
    return node;
  }

  function svgMake(tag, attributes = {}, text) {
    const node = document.createElementNS(svgNs, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function plural(count, word) {
    return count.toLocaleString("en-US") + " " + word + (count === 1 ? "" : "s");
  }

  function unitOption(unit) {
    return unit.kind + "|" + unit.key;
  }

  function hexFlags(value) {
    return value === null ? "unavailable" : value + " (0x" + value.toString(16) + ")";
  }

  // ---- Reset and loading ---------------------------------------------------------------------------------------------
  function hideResults() {
    for (const node of [nodes.columnsPanel, nodes.filtersPanel, nodes.plotPanel, nodes.summaryPanel, nodes.tablePanel, nodes.detailPanel, nodes.exportPanel]) node.hidden = true;
    nodes.facts.hidden = true;
    nodes.rejected.hidden = true;
    say(nodes.applyStatus, "");
    say(nodes.exportStatus, "");
    state.records = [];
    state.view = null;
    state.selectedId = null;
    state.plotPoints = [];
  }

  async function loadFile(file) {
    const token = ++state.loadToken;
    hideResults();
    if (file.size > maxFileBytes) {
      say(nodes.status, "This file is " + (file.size / 1048576).toFixed(1) + " MB. The limit is " + (maxFileBytes / 1048576) + " MB.", true);
      return;
    }
    say(nodes.status, "Reading " + file.name + " …");
    let text;
    try {
      text = await file.text();
    } catch {
      if (token === state.loadToken) say(nodes.status, "The file could not be read.", true);
      return;
    }
    if (token !== state.loadToken) return;
    loadText(text, file.name, "Your file. No provenance is recorded; the time scale, unit and band are what you choose below.");
  }

  function loadText(text, name, provenance, options = {}) {
    hideResults();
    let table;
    try {
      table = T.readTable(text);
    } catch (error) {
      say(nodes.status, name + ": " + error.message, true);
      return;
    }
    state.table = table;
    state.fileName = name;
    state.provenance = provenance;
    const detected = T.detectProfile(table.header);
    state.profile = detected.profile;
    state.config = detected.config;
    if (options.binningWidth) state.config.binning = { ...state.config.binning, width: options.binningWidth };
    fillColumnForm(table.header, detected);
    nodes.columnsPanel.hidden = false;
    say(nodes.status, "Read " + plural(table.rows.length, "row") + " from " + name + ".");
    if (detected.profile === "generic") {
      nodes.columnsPanel.querySelector("select").focus({ preventScroll: false });
      say(nodes.applyStatus, "Check the columns, time format, time scale and unit, then press Apply columns and units.");
    } else {
      applyColumns();
    }
  }

  // ---- Column form ---------------------------------------------------------------------------------------------------
  const unitChoices = {
    flux: [["Jy", "Jy"], ["mJy", "mJy"], ["uJy", "µJy"], ["nJy", "nJy"], ["__other", "Other (type below)"]],
    magnitude: [["AB", "AB mag"], ["Vega", "Vega mag"], ["mag", "mag (system not stated)"], ["__other", "Other (type below)"]],
  };

  function fillUnitSelect(kind, unitKey) {
    nodes.unit.replaceChildren();
    for (const [value, label] of unitChoices[kind]) nodes.unit.append(make("option", { value, text: label }));
    const known = unitChoices[kind].some(([value]) => value === unitKey);
    nodes.unit.value = known ? unitKey : "__other";
    nodes.unitCustom.value = known ? "" : unitKey;
    nodes.unitCustomWrap.hidden = nodes.unit.value !== "__other";
  }

  function fillColumnForm(header, detected) {
    const config = detected.config;
    for (const select of $$("[data-lc-col]")) {
      const name = select.dataset.lcCol;
      const required = name === "time" || name === "value";
      select.replaceChildren();
      if (!required) select.append(make("option", { value: "", text: "(none)" }));
      for (const column of header) select.append(make("option", { value: column, text: column }));
      const wanted = config.columns[name] ?? "";
      select.value = header.includes(wanted) ? wanted : (required ? header[0] : "");
    }
    nodes.timeFormat.value = config.timeFormat;
    nodes.timeScale.value = config.timeScale;
    nodes.barycentric.checked = config.barycentric;
    nodes.kind.value = config.kind;
    fillUnitSelect(config.kind, config.unit);
    nodes.defaultSource.value = config.defaultSource;
    nodes.defaultBand.value = config.defaultBand;
    const perRow = detected.profile === "export";
    for (const control of [nodes.timeScale, nodes.barycentric, nodes.kind, nodes.unit, nodes.unitCustom]) control.disabled = perRow;
    nodes.profileNote.textContent = detected.note + (config.hint ? " " + config.hint : "");
  }

  function readColumnForm() {
    const columns = { ...state.config.columns };
    for (const select of $$("[data-lc-col]")) columns[select.dataset.lcCol] = select.value;
    let unit = nodes.unit.value;
    if (unit === "__other") unit = nodes.unitCustom.value.trim() || "unspecified";
    return {
      columns,
      timeFormat: nodes.timeFormat.value,
      timeScale: nodes.timeScale.value,
      barycentric: nodes.barycentric.checked,
      kind: nodes.kind.value,
      unit,
      defaultSource: nodes.defaultSource.value,
      defaultBand: nodes.defaultBand.value,
      binning: state.config.binning,
    };
  }

  nodes.kind.addEventListener("change", () => fillUnitSelect(nodes.kind.value, nodes.kind.value === "magnitude" ? "AB" : "uJy"));
  nodes.unit.addEventListener("change", () => { nodes.unitCustomWrap.hidden = nodes.unit.value !== "__other"; });

  function applyColumns() {
    const config = readColumnForm();
    let dataset;
    try {
      dataset = T.buildDataset(state.table, config);
    } catch (error) {
      say(nodes.applyStatus, error.message, true);
      return;
    }
    state.config = { ...state.config, ...config };
    state.records = dataset.records;
    state.rejected = dataset.rejected;
    state.selectedId = null;
    state.rowLimit = initialRowLimit;
    if (dataset.records.length === 0) {
      hideResultsKeepForm();
      say(nodes.applyStatus, "None of the " + plural(dataset.rowCount, "row") + " could be read with these settings. " + (dataset.rejected[0] ? "First problem, row " + dataset.rejected[0].row + ": " + dataset.rejected[0].reason + "." : ""), true);
      showRejected();
      return;
    }
    say(nodes.applyStatus, "Applied: " + plural(dataset.records.length, "row") + " read" + (dataset.rejected.length ? ", " + plural(dataset.rejected.length, "row") + " rejected" : "") + ".");

    // Band definition and the first view of the data.
    const hasBand = dataset.records.some((record) => record.bandLabel);
    const hasWavelength = dataset.records.some((record) => record.wavelength !== null);
    let binning = { ...config.binning };
    if (hasBand) binning = { ...binning, mode: "column" };
    else if (!hasWavelength) binning = { ...binning, mode: "none" };
    else if (binning.mode === "column" || binning.mode === "none") binning = { ...binning, mode: "width" };
    state.binning = binning;
    nodes.binning.value = binning.mode;
    nodes.width.value = String(binning.width);
    nodes.edges.value = binning.edges.join(", ");
    for (const option of nodes.binning.options) {
      option.disabled = (option.value === "column" && !hasBand) || ((option.value === "width" || option.value === "edges") && !hasWavelength);
    }
    syncBinningFields();

    const plotTime = T.suggestPlotTime(dataset.records);
    state.plotTime = { scale: plotTime.scale, barycentric: plotTime.barycentric };
    state.timeFrom = null;
    state.timeTo = null;
    state.axisFormat = config.timeFormat;
    state.display = T.suggestDisplayUnit(dataset.records);
    state.quality = "all";
    state.ignoreMask = 0;
    nodes.quality.value = "all";
    nodes.ignore.value = "0";
    nodes.axisFormat.value = state.axisFormat;
    fillDisplayOptions();
    fillScaleOptions();

    // Default series: the source with the most measurements, up to four of its best-sampled series.
    const overview = T.computeView(state.records, viewParameters({ seriesKeys: null }));
    const bySource = new Map();
    for (const series of overview.series) bySource.set(series.sourceId, (bySource.get(series.sourceId) ?? 0) + series.measured);
    const best = [...bySource.entries()].sort((a, b) => b[1] - a[1])[0][0];
    state.sourceFilter = best;
    fillSourceSelect(overview.series);
    chooseDefaultSeries(overview.series);
    showResults();
    refresh();
    showFacts();
    showRejected();
  }

  function hideResultsKeepForm() {
    for (const node of [nodes.filtersPanel, nodes.plotPanel, nodes.summaryPanel, nodes.tablePanel, nodes.detailPanel, nodes.exportPanel]) node.hidden = true;
    state.records = [];
    state.view = null;
  }

  function showResults() {
    for (const node of [nodes.filtersPanel, nodes.plotPanel, nodes.summaryPanel, nodes.tablePanel, nodes.detailPanel, nodes.exportPanel]) node.hidden = false;
  }

  nodes.apply.addEventListener("click", applyColumns);

  function chooseDefaultSeries(allSeries) {
    const listed = allSeries.filter((series) => !state.sourceFilter || series.sourceId === state.sourceFilter);
    const ranked = [...listed].sort((a, b) => b.good - a.good || b.measured - a.measured).filter((series) => series.measured > 0);
    state.seriesKeys = new Set((listed.length <= 6 ? listed : ranked.slice(0, 4)).map((series) => series.key));
  }

  function showFacts() {
    const sources = new Set(state.records.map((record) => record.sourceId));
    const seriesCount = state.view ? state.view.series.length : 0;
    nodes.facts.hidden = false;
    $("[data-lc-fact='file']").textContent = state.fileName;
    $("[data-lc-fact='profile']").textContent = { spectrophotometry: "Spectrophotometry CSV contract", export: "AstroNot light-curve export", generic: "Generic table, columns chosen by you" }[state.profile];
    $("[data-lc-fact='rows']").textContent = plural(state.records.length, "row") + " read" + (state.rejected.length ? ", " + state.rejected.length.toLocaleString("en-US") + " rejected" : "");
    $("[data-lc-fact='series']").textContent = plural(sources.size, "source") + ", " + plural(seriesCount, "series");
    $("[data-lc-fact='provenance']").textContent = state.provenance || "Unavailable";
  }

  function showRejected() {
    nodes.rejected.hidden = state.rejected.length === 0;
    if (state.rejected.length === 0) return;
    nodes.rejectedSummary.textContent = plural(state.rejected.length, "row") + " could not be read (they are not in the plot, table or export)";
    nodes.rejectedList.replaceChildren(...state.rejected.slice(0, 50).map((entry) => make("li", { text: "Row " + entry.row + ": " + entry.reason + "." })));
    if (state.rejected.length > 50) nodes.rejectedList.append(make("li", { text: "… and " + (state.rejected.length - 50).toLocaleString("en-US") + " more." }));
  }

  // ---- Controls that feed the view -------------------------------------------------------------------------------------
  function fillDisplayOptions() {
    nodes.display.replaceChildren();
    const options = new Map();
    const add = (unit) => options.set(unitOption(unit), unit);
    for (const entry of T.fluxUnits) add({ kind: "flux", ...entry });
    add({ kind: "magnitude", key: "AB", label: "AB mag", system: "AB" });
    for (const record of state.records) add(record.unit);
    for (const [value, unit] of options) nodes.display.append(make("option", { value, text: (unit.kind === "magnitude" ? "Magnitude: " : "Flux: ") + unit.label }));
    nodes.display.value = unitOption(state.display);
    state.displayOptions = options;
  }

  function fillScaleOptions() {
    nodes.plotScale.replaceChildren(...T.timeScaleNames.map((name) => make("option", { value: name, text: name === "unknown" ? "Unknown" : name })));
    nodes.plotScale.value = state.plotTime.scale;
    nodes.plotRef.value = state.plotTime.barycentric ? "bary" : "geo";
  }

  function fillSourceSelect(allSeries) {
    const sources = [...new Set(allSeries.map((series) => series.sourceId))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    nodes.source.replaceChildren(make("option", { value: "", text: "All sources (" + sources.length + ")" }), ...sources.map((name) => make("option", { value: name, text: name })));
    nodes.source.value = state.sourceFilter;
  }

  function syncBinningFields() {
    nodes.widthWrap.hidden = state.binning.mode !== "width";
    nodes.edgesWrap.hidden = state.binning.mode !== "edges";
  }

  function viewParameters(overrides = {}) {
    return {
      binning: state.binning,
      seriesKeys: state.seriesKeys,
      plotTime: state.plotTime,
      display: state.display,
      timeFrom: state.timeFrom,
      timeTo: state.timeTo,
      quality: state.quality,
      ignoreMask: state.ignoreMask,
      ...overrides,
    };
  }

  function rangeText(mjd) {
    return mjd === null ? "" : T.formatTime(mjd, state.axisFormat, 0);
  }

  function syncRangeInputs() {
    nodes.from.value = rangeText(state.timeFrom);
    nodes.to.value = rangeText(state.timeTo);
    const hint = state.axisFormat === "iso" ? "e.g. 2026-05-17T06:30:00" : state.axisFormat === "jd" ? "JD, e.g. 2461177.5" : "MJD, e.g. 61177.5";
    nodes.from.placeholder = "Start, " + hint;
    nodes.to.placeholder = "End, " + hint;
  }

  function readRange() {
    const result = {};
    for (const [name, input] of [["timeFrom", nodes.from], ["timeTo", nodes.to]]) {
      const text = input.value.trim();
      input.removeAttribute("aria-invalid");
      if (text === "") { result[name] = null; continue; }
      const parsed = T.parseTimeValue(text, state.axisFormat);
      if (!parsed.ok) {
        input.setAttribute("aria-invalid", "true");
        say(nodes.filterStatus, (name === "timeFrom" ? "Start" : "End") + " of the time range: " + parsed.reason + ".", true);
        return null;
      }
      result[name] = parsed.mjd;
    }
    return result;
  }

  function onRangeChange() {
    const range = readRange();
    if (!range) return;
    state.timeFrom = range.timeFrom;
    state.timeTo = range.timeTo;
    refresh();
  }
  nodes.from.addEventListener("change", onRangeChange);
  nodes.to.addEventListener("change", onRangeChange);
  for (const input of [nodes.from, nodes.to]) input.addEventListener("keydown", (event) => { if (event.key === "Enter") onRangeChange(); });
  nodes.rangeReset.addEventListener("click", () => {
    state.timeFrom = null;
    state.timeTo = null;
    for (const input of [nodes.from, nodes.to]) input.removeAttribute("aria-invalid");
    refresh();
  });

  nodes.axisFormat.addEventListener("change", () => {
    const range = readRange();
    if (range) { state.timeFrom = range.timeFrom; state.timeTo = range.timeTo; }
    state.axisFormat = nodes.axisFormat.value;
    refresh();
  });

  nodes.plotScale.addEventListener("change", () => {
    state.plotTime = { ...state.plotTime, scale: nodes.plotScale.value };
    state.timeFrom = null;
    state.timeTo = null;
    refresh();
  });
  nodes.plotRef.addEventListener("change", () => {
    state.plotTime = { ...state.plotTime, barycentric: nodes.plotRef.value === "bary" };
    refresh();
  });
  nodes.display.addEventListener("change", () => {
    state.display = state.displayOptions.get(nodes.display.value);
    refresh();
  });
  nodes.quality.addEventListener("change", () => { state.quality = nodes.quality.value; refresh(); });
  nodes.ignore.addEventListener("change", () => {
    const text = nodes.ignore.value.trim();
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) > 0x7fffffff) {
      nodes.ignore.setAttribute("aria-invalid", "true");
      say(nodes.filterStatus, "Enter the flag bits to ignore as a whole number from 0 to 2147483647.", true);
      return;
    }
    nodes.ignore.removeAttribute("aria-invalid");
    state.ignoreMask = Number(text);
    refresh();
  });
  nodes.source.addEventListener("change", () => {
    state.sourceFilter = nodes.source.value;
    const overview = T.computeView(state.records, viewParameters({ seriesKeys: null }));
    chooseDefaultSeries(overview.series);
    refresh();
  });

  function onBinningChange() {
    const mode = nodes.binning.value;
    const next = { ...state.binning, mode };
    if (mode === "width") {
      const width = Number(nodes.width.value);
      if (!(width > 0) || !Number.isFinite(width)) {
        nodes.width.setAttribute("aria-invalid", "true");
        say(nodes.filterStatus, "Enter a bin width greater than zero, in µm.", true);
        state.binning = next;
        syncBinningFields();
        return;
      }
      nodes.width.removeAttribute("aria-invalid");
      next.width = width;
    }
    if (mode === "edges") {
      const parsed = T.parseEdges(nodes.edges.value);
      if (!parsed.ok) {
        nodes.edges.setAttribute("aria-invalid", "true");
        say(nodes.filterStatus, parsed.reason, true);
        state.binning = { ...next, edges: [] };
        syncBinningFields();
        return;
      }
      nodes.edges.removeAttribute("aria-invalid");
      next.edges = parsed.edges;
    }
    state.binning = next;
    syncBinningFields();
    const overview = T.computeView(state.records, viewParameters({ seriesKeys: null }));
    chooseDefaultSeries(overview.series);
    refresh();
  }
  nodes.binning.addEventListener("change", onBinningChange);
  nodes.width.addEventListener("change", onBinningChange);
  nodes.edges.addEventListener("change", onBinningChange);

  nodes.seriesList.addEventListener("change", (event) => {
    const box = event.target.closest("input[data-key]");
    if (!box) return;
    if (box.checked) state.seriesKeys.add(box.dataset.key); else state.seriesKeys.delete(box.dataset.key);
    refresh();
  });
  nodes.seriesAll.addEventListener("click", () => {
    for (const series of listedSeries()) state.seriesKeys.add(series.key);
    refresh();
  });
  nodes.seriesNone.addEventListener("click", () => {
    for (const series of listedSeries()) state.seriesKeys.delete(series.key);
    refresh();
  });
  nodes.connect.addEventListener("change", () => { state.connect = nodes.connect.checked; drawPlot(); });

  function listedSeries() {
    return state.view ? state.view.series.filter((series) => !state.sourceFilter || series.sourceId === state.sourceFilter) : [];
  }

  // ---- Refresh: model, then every display ------------------------------------------------------------------------------
  function refresh() {
    if (state.records.length === 0) return;
    // A series that belongs to a source that is not listed can never stay selected.
    state.view = T.computeView(state.records, viewParameters());
    const view = state.view;
    if (state.selectedId !== null && !view.rows.some((row) => row.record.id === state.selectedId)) {
      const wasSelected = state.selectedId;
      state.selectedId = null;
      nodes.live.textContent = "Row " + wasSelected + " is hidden by the current filters, so it is no longer selected.";
    }
    syncRangeInputs();
    renderSeriesList();
    renderFilterStatus();
    renderNotes();
    renderLegend();
    drawPlot();
    renderSummary();
    renderTable();
    renderDetail();
    nodes.exportButton.disabled = view.rows.length === 0;
    say(nodes.exportStatus, "");
    nodes.qualityNote.textContent = "Flag 0 means no flag. Rows without a flag value are hidden by “Only rows with flags = 0” and counted separately.";
    showFacts();
  }

  // Colour and marker follow the rank among the selected series, so every plotted series differs from the others.
  function seriesIndex(series) {
    const pool = series.selected ? state.view.series.filter((entry) => entry.selected) : state.view.series;
    return pool.indexOf(series);
  }

  function markerPath(shape, x, y, size) {
    const r = size;
    if (shape === "square") return "M" + (x - r) + " " + (y - r) + "h" + 2 * r + "v" + 2 * r + "h" + (-2 * r) + "z";
    if (shape === "diamond") return "M" + x + " " + (y - r * 1.3) + "L" + (x + r * 1.3) + " " + y + "L" + x + " " + (y + r * 1.3) + "L" + (x - r * 1.3) + " " + y + "z";
    if (shape === "triangle") return "M" + x + " " + (y - r * 1.25) + "L" + (x + r * 1.2) + " " + (y + r) + "L" + (x - r * 1.2) + " " + (y + r) + "z";
    return "M" + (x - r) + " " + y + "a" + r + " " + r + " 0 1 0 " + 2 * r + " 0a" + r + " " + r + " 0 1 0 " + (-2 * r) + " 0z";
  }

  function shapeFor(index) {
    return shapes[(index + Math.floor(index / palette.length)) % shapes.length];
  }

  function swatch(index) {
    const svg = svgMake("svg", { width: 18, height: 18, viewBox: "0 0 18 18", "aria-hidden": "true", focusable: "false" });
    svg.append(svgMake("path", { d: markerPath(shapeFor(index), 9, 9, 5), fill: palette[index % palette.length], stroke: "#0b0d10", "stroke-width": 1 }));
    return svg;
  }

  function renderSeriesList() {
    const items = listedSeries().map((series) => {
      const key = series.key;
      const box = make("input", { type: "checkbox", "data-key": key });
      box.checked = state.seriesKeys.has(key);
      const text = make("span", { class: "lc-series-item__text" }, [
        make("span", { text: series.sourceId + " · " + series.band.label }),
        make("small", { text: plural(series.total, "row") + ", " + series.measured.toLocaleString("en-US") + " with a measurement" }),
      ]);
      return make("label", { class: "tm-check lc-series-item" }, [box, swatch(seriesIndex(series)), text]);
    });
    nodes.seriesList.replaceChildren(...items);
    if (items.length === 0) nodes.seriesList.append(make("p", { class: "workspace-help", text: "No series for this source." }));
  }

  function renderFilterStatus() {
    const { hidden, counts } = state.view;
    const parts = [];
    if (hidden.timeRange) parts.push(plural(hidden.timeRange, "row") + " outside the time range");
    if (hidden.flagged) parts.push(plural(hidden.flagged, "row") + " hidden by the quality filter (flagged)");
    if (hidden.noFlagInfo) parts.push(plural(hidden.noFlagInfo, "row") + " hidden by the quality filter (no flag value)");
    if (hidden.noTime) parts.push(plural(hidden.noTime, "row") + " whose time cannot be put on " + T.timeLabel("mjd", state.plotTime.scale, state.plotTime.barycentric));
    if (hidden.notSelected) parts.push(plural(hidden.notSelected, "row") + " in series that are not selected");
    const sentence = counts.visible + " of " + counts.total.toLocaleString("en-US") + " rows shown, " + counts.plottable.toLocaleString("en-US") + " of them plotted" + (parts.length ? ". Hidden: " + parts.join("; ") : "") + ".";
    const empty = counts.visible === 0;
    const rangeError = state.timeFrom !== null && state.timeTo !== null && state.timeFrom > state.timeTo;
    say(nodes.filterStatus, (rangeError ? "The time range ends before it starts, so no row matches. " : empty ? "The filters hide every row. " : "") + sentence, empty);
  }

  function renderNotes() {
    const view = state.view;
    const notes = [];
    const add = (type, text) => notes.push({ type, text });
    const display = state.display;
    if (state.plotTime.scale === "unknown") add("warning", "The time scale is unknown. The times are drawn as given, but they cannot be compared with, or converted to, UTC, TAI, TT or TDB.");
    const scales = new Set(state.records.map((record) => record.scale));
    if (scales.size > 1) add("info", "The file mixes time scales (" + [...scales].join(", ") + "). Times are converted exactly to " + state.plotTime.scale + " where a verified conversion exists; other rows are left out and counted.");
    if (view.hidden.noTime) add("warning", plural(view.hidden.noTime, "row") + " could not be put on the " + state.plotTime.scale + " time scale" + (state.plotTime.barycentric ? " (barycentric)" : "") + " and " + (view.hidden.noTime === 1 ? "is" : "are") + " left out of the plot, table and export. " + (view.firstTimeIssue ? view.firstTimeIssue + "." : ""));
    if (display.kind === "magnitude") {
      add("info", "Magnitude axis: smaller numbers are brighter, so the axis is inverted and brighter values are at the top. Error bars use σₘ = 1.0857 · σ_F / F (first order).");
      const lost = view.rows.filter((row) => row.record.value !== null && row.y === null).length;
      if (lost) add("warning", plural(lost, "row") + " shown in the table cannot be plotted as magnitudes (flux of zero or less, or no verified conversion).");
    }
    const nonPositive = view.rows.filter((row) => row.record.kind === "flux" && row.record.value !== null && row.record.value <= 0).length;
    if (nonPositive && display.kind === "flux") add("info", plural(nonPositive, "row") + " " + (nonPositive === 1 ? "has" : "have") + " zero or negative flux. They are real measurements below the noise and stay in the plot and table.");
    const unknownErr = view.plottable.filter((row) => row.yErr === null).length;
    if (unknownErr) add("info", plural(unknownErr, "plotted point") + " " + (unknownErr === 1 ? "has" : "have") + " no known uncertainty and no error bar.");
    const wide = view.series.filter((series) => series.selected && state.binning.mode === "none" && series.stats.valid > 1);
    if (wide.length) add("warning", "Bands are not defined, so each series mixes all wavelengths. Differences between points may come from the spectrum, not from time. Choose wavelength bins for a meaningful comparison.");
    nodes.notes.hidden = notes.length === 0;
    nodes.notes.replaceChildren(...notes.map((note) => make("li", { class: "tm-notes__" + note.type, text: note.text })));
  }

  function renderLegend() {
    const items = state.view.series.filter((series) => series.selected && series.rows.length).map((series) => {
      const index = seriesIndex(series);
      return make("li", {}, [swatch(index), make("span", { text: series.sourceId + " · " + series.band.label + " (" + series.stats.valid + " plotted)" })]);
    });
    nodes.legend.replaceChildren(...items);
    nodes.legend.hidden = items.length === 0;
  }

  // ---- Plot ------------------------------------------------------------------------------------------------------------
  function axisTicks(extent, format) {
    if (format === "jd") {
      const low = T.jdFromMjd(extent.low);
      const high = T.jdFromMjd(extent.high);
      return T.niceTicks(low, high, 6).map((tick) => ({ mjd: T.mjdFromJd(tick), label: tickText(tick, high - low) }));
    }
    const span = extent.high - extent.low;
    return T.niceTicks(extent.low, extent.high, 6).map((tick) => ({
      mjd: tick,
      label: format === "mjd" ? tickText(tick, span) : T.formatTime(tick, "iso", span),
    }));
  }

  function tickText(value, span) {
    const decimals = span >= 5 ? 0 : span >= 0.5 ? 1 : span >= 0.05 ? 3 : 5;
    return value.toFixed(decimals);
  }

  function drawPlot() {
    const view = state.view;
    const svg = nodes.svg;
    svg.replaceChildren();
    state.plotPoints = [];
    const width = Math.max(280, Math.floor(nodes.chart.clientWidth || 800));
    const height = Math.round(Math.min(480, Math.max(300, width * 0.5)));
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    const display = state.display;
    const margin = { left: width < 520 ? 62 : 78, right: 14, top: 14, bottom: 58 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const timeAxis = T.timeLabel(state.axisFormat, state.plotTime.scale, state.plotTime.barycentric);
    const inverted = display.kind === "magnitude";
    nodes.axisNote.textContent = inverted
      ? "Vertical axis: " + display.label + ". The axis is inverted: smaller numbers mean a brighter source and are drawn higher. Horizontal axis: " + timeAxis + "."
      : "Vertical axis: flux density in " + display.label + ". Horizontal axis: " + timeAxis + ".";

    const plottable = view.plottable;
    const timeExtent = T.timeExtent(plottable);
    const valueExtent = T.valueExtent(plottable, display);
    if (!timeExtent || !valueExtent) {
      svg.append(svgMake("text", { x: width / 2, y: height / 2, "text-anchor": "middle", fill: "#b6bdc8", "font-size": 14 }, "No points to plot with the current selection and filters."));
      svg.setAttribute("aria-label", "Light curve plot: no points to plot");
      return;
    }
    const x = (mjd) => margin.left + (mjd - timeExtent.low) / (timeExtent.high - timeExtent.low) * plotWidth;
    const y = (value) => inverted
      ? margin.top + (value - valueExtent.low) / (valueExtent.high - valueExtent.low) * plotHeight
      : margin.top + (valueExtent.high - value) / (valueExtent.high - valueExtent.low) * plotHeight;

    const frame = svgMake("g", { "aria-hidden": "true", "font-size": 12, fill: "#b6bdc8" });
    for (const tick of T.niceTicks(valueExtent.low, valueExtent.high, Math.max(3, Math.round(plotHeight / 55)))) {
      frame.append(svgMake("line", { x1: margin.left, x2: margin.left + plotWidth, y1: y(tick), y2: y(tick), stroke: "#262b33" }));
      frame.append(svgMake("text", { x: margin.left - 8, y: y(tick) + 4, "text-anchor": "end" }, T.formatNumber(tick, 5)));
    }
    for (const tick of axisTicks(timeExtent, state.axisFormat)) {
      const px = x(tick.mjd);
      if (px < margin.left - 1 || px > margin.left + plotWidth + 1) continue;
      frame.append(svgMake("line", { x1: px, x2: px, y1: margin.top, y2: margin.top + plotHeight, stroke: "#262b33" }));
      frame.append(svgMake("text", { x: px, y: margin.top + plotHeight + 18, "text-anchor": "middle" }, tick.label));
    }
    if (!inverted && valueExtent.low < 0 && valueExtent.high > 0) {
      frame.append(svgMake("line", { x1: margin.left, x2: margin.left + plotWidth, y1: y(0), y2: y(0), stroke: "#8a93a3", "stroke-dasharray": "5 4" }));
    }
    frame.append(svgMake("rect", { x: margin.left, y: margin.top, width: plotWidth, height: plotHeight, fill: "none", stroke: "#4a505a" }));
    frame.append(svgMake("text", { x: margin.left + plotWidth / 2, y: height - 10, "text-anchor": "middle", "font-size": 13, fill: "#dce0e8" }, "Time — " + timeAxis));
    const yTitle = inverted ? display.label + " — brighter is up ↑" : "Flux density (" + display.label + ")";
    frame.append(svgMake("text", { transform: "translate(15 " + (margin.top + plotHeight / 2) + ") rotate(-90)", "text-anchor": "middle", "font-size": 13, fill: "#dce0e8" }, yTitle));
    svg.append(frame);

    const clip = svgMake("clipPath", { id: "lc-clip" });
    clip.append(svgMake("rect", { x: margin.left, y: margin.top, width: plotWidth, height: plotHeight }));
    const defs = svgMake("defs");
    defs.append(clip);
    svg.append(defs);

    const layer = svgMake("g", { "clip-path": "url(#lc-clip)" });
    let selectedPoint = null;
    for (const series of view.series) {
      if (!series.selected) continue;
      const index = seriesIndex(series);
      const colour = palette[index % palette.length];
      const shape = shapeFor(index);
      const points = series.rows.filter(T.isPlottable);
      if (state.connect && points.length > 1) {
        layer.append(svgMake("polyline", { points: points.map((row) => x(row.t).toFixed(1) + "," + y(row.y).toFixed(1)).join(" "), fill: "none", stroke: colour, "stroke-opacity": 0.55, "stroke-width": 1.2 }));
      }
      for (const row of points) {
        const px = x(row.t);
        const py = y(row.y);
        if (row.yErr !== null && row.yErr > 0) {
          const top = y(row.y - row.yErr);
          const bottom = y(row.y + row.yErr);
          layer.append(svgMake("line", { x1: px, x2: px, y1: top, y2: bottom, stroke: colour, "stroke-width": 1.2, "stroke-opacity": 0.85 }));
          layer.append(svgMake("line", { x1: px - 3, x2: px + 3, y1: top, y2: top, stroke: colour, "stroke-width": 1.2 }));
          layer.append(svgMake("line", { x1: px - 3, x2: px + 3, y1: bottom, y2: bottom, stroke: colour, "stroke-width": 1.2 }));
        }
        const marker = svgMake("path", { d: markerPath(shape, px, py, 4.2), fill: colour, stroke: "#0b0d10", "stroke-width": 1 });
        marker.append(svgMake("title", {}, "Row " + row.record.id + (row.record.obsId ? ", " + row.record.obsId : "") + ": " + T.formatNumber(row.y, 6) + " " + display.label));
        layer.append(marker);
        state.plotPoints.push({ x: px, y: py, row });
        if (row.record.id === state.selectedId) selectedPoint = { px, py, colour };
      }
    }
    svg.append(layer);
    if (selectedPoint) {
      svg.append(svgMake("circle", { cx: selectedPoint.px, cy: selectedPoint.py, r: 10, fill: "none", stroke: "#f8f9fb", "stroke-width": 2 }));
      svg.append(svgMake("circle", { cx: selectedPoint.px, cy: selectedPoint.py, r: 13, fill: "none", stroke: "#0b0d10", "stroke-width": 1, "stroke-opacity": 0.8 }));
    }
    svg.setAttribute("aria-label", "Light curve plot: " + plural(plottable.length, "point") + " in " + plural(view.series.filter((series) => series.selected && series.stats.valid).length, "series") + ". " + (inverted ? "Magnitude axis inverted, brighter is up." : ""));
  }

  nodes.svg.addEventListener("pointerdown", (event) => {
    if (state.plotPoints.length === 0) return;
    const box = nodes.svg.getBoundingClientRect();
    const px = event.clientX - box.left;
    const py = event.clientY - box.top;
    const reach = event.pointerType === "touch" ? 26 : 14;
    let best = null;
    for (const point of state.plotPoints) {
      const distance = Math.hypot(point.x - px, point.y - py);
      if (distance <= reach && (!best || distance < best.distance)) best = { distance, point };
    }
    if (best) select(best.point.row.record.id, { from: "plot" });
  });

  nodes.svg.addEventListener("keydown", (event) => {
    const points = state.view ? state.view.plottable : [];
    if (points.length === 0) return;
    const current = points.findIndex((row) => row.record.id === state.selectedId);
    let next = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = current < 0 ? 0 : Math.min(points.length - 1, current + 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = current < 0 ? points.length - 1 : Math.max(0, current - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = points.length - 1;
    else if (event.key === "Escape" && state.selectedId !== null) { event.preventDefault(); select(null, { from: "plot" }); return; }
    if (next === null) return;
    event.preventDefault();
    select(points[next].record.id, { from: "plot" });
  });

  new ResizeObserver(() => { if (state.view && !nodes.plotPanel.hidden) drawPlot(); }).observe(nodes.chart);

  // ---- Tables ----------------------------------------------------------------------------------------------------------
  function renderSummary() {
    const view = state.view;
    const display = state.display;
    const unit = " (" + display.label + ")";
    nodes.heads.first.textContent = "First (" + state.axisFormat.toUpperCase() + ", " + state.plotTime.scale + ")";
    nodes.heads.last.textContent = "Last (" + state.axisFormat.toUpperCase() + ", " + state.plotTime.scale + ")";
    nodes.heads.mean.textContent = display.kind === "magnitude" ? "Mean magnitude" + unit : "Mean" + unit;
    nodes.heads.median.textContent = display.kind === "magnitude" ? "Median magnitude" + unit : "Median" + unit;
    const timeText = (mjd) => (mjd === null ? "—" : T.formatTime(mjd, state.axisFormat, 0));
    const rows = view.series.filter((series) => series.selected).map((series) => {
      const stats = series.stats;
      return make("tr", {}, [
        make("th", { scope: "row", text: series.sourceId }),
        make("td", { text: series.band.label }),
        make("td", { text: String(stats.rows) }),
        make("td", { text: String(stats.valid) }),
        make("td", { text: timeText(stats.first) }),
        make("td", { text: timeText(stats.last) }),
        make("td", { text: stats.mean === null ? "—" : T.formatNumber(stats.mean, 6) }),
        make("td", { text: stats.median === null ? "—" : T.formatNumber(stats.median, 6) }),
        make("td", { text: stats.summaryNote || (series.excludedForTime ? plural(series.excludedForTime, "row") + " left out: time cannot be converted." : "") }),
      ]);
    });
    nodes.summaryBody.replaceChildren(...rows);
    nodes.summaryCaption.textContent = rows.length ? "Series shown: " + rows.length : "No series selected";
  }

  const tableColumns = ["Row", "Source", "Band", "Obs ID", "Time", "Value", "Uncertainty", "Flags", "Notes"];

  function renderTable() {
    const view = state.view;
    const display = state.display;
    const columns = tableColumns.slice();
    columns[4] = "Time (" + state.axisFormat.toUpperCase() + ", " + state.plotTime.scale + (state.plotTime.barycentric ? ", barycentric" : "") + ")";
    columns[5] = "Value (" + display.label + ")";
    columns[6] = "Uncertainty (" + display.label + ")";
    nodes.tableHead.replaceChildren(...columns.map((name) => make("th", { scope: "col", text: name })));
    const rows = view.rows;
    if (state.selectedId !== null) {
      const at = rows.findIndex((row) => row.record.id === state.selectedId);
      if (at >= state.rowLimit) state.rowLimit = at + 1;
    }
    const shown = rows.slice(0, state.rowLimit);
    const focusId = state.selectedId ?? (shown[0] ? shown[0].record.id : null);
    nodes.tableBody.replaceChildren(...shown.map((row) => tableRow(row, display, focusId)));
    nodes.showAll.hidden = rows.length <= state.rowLimit;
    nodes.showAll.textContent = "Show all " + rows.length.toLocaleString("en-US") + " rows";
    nodes.tableCaption.textContent = plural(rows.length, "observation") + " shown" + (rows.length > shown.length ? ", first " + shown.length.toLocaleString("en-US") + " listed" : "");
    nodes.tableNote.textContent = rows.length === 0 ? "No rows match the current series, time range and quality settings." : "";
  }

  function valueCell(value, digits = 6) {
    return value === null ? make("td", { class: "lc-missing", text: "—" }) : make("td", { text: T.formatNumber(value, digits) });
  }

  function tableRow(row, display, focusId) {
    const record = row.record;
    const selected = record.id === state.selectedId;
    const notes = T.rowStatus(row, display);
    const errorCell = row.yErr !== null ? make("td", { text: "± " + T.formatNumber(row.yErr, 4) })
      : record.value !== null && row.y !== null ? make("td", { class: "lc-missing", text: "unknown" }) : make("td", { class: "lc-missing", text: "—" });
    return make("tr", { "data-id": record.id, "aria-selected": selected ? "true" : "false", tabindex: record.id === focusId ? "0" : "-1", class: selected ? "lc-row lc-row--selected" : "lc-row" }, [
      make("th", { scope: "row", text: String(record.id) }),
      make("td", { text: record.sourceId }),
      make("td", { text: row.series.band.label }),
      make("td", { text: record.obsId || "—" }),
      make("td", { text: T.formatTime(row.t, state.axisFormat, 0) }),
      valueCell(row.y),
      errorCell,
      make("td", { text: record.flags === null ? "—" : String(record.flags) }),
      make("td", { text: notes.join("; ") }),
    ]);
  }

  nodes.showAll.addEventListener("click", () => {
    state.rowLimit = Infinity;
    renderTable();
  });

  nodes.tableBody.addEventListener("click", (event) => {
    const tr = event.target.closest("tr[data-id]");
    if (tr) select(Number(tr.dataset.id), { from: "table" });
  });

  nodes.tableBody.addEventListener("keydown", (event) => {
    const tr = event.target.closest("tr[data-id]");
    if (!tr) return;
    const rows = [...nodes.tableBody.rows];
    const at = rows.indexOf(tr);
    let target = null;
    if (event.key === "ArrowDown") target = rows[Math.min(rows.length - 1, at + 1)];
    else if (event.key === "ArrowUp") target = rows[Math.max(0, at - 1)];
    else if (event.key === "Home") target = rows[0];
    else if (event.key === "End") target = rows[rows.length - 1];
    else if (event.key === "PageDown") target = rows[Math.min(rows.length - 1, at + 10)];
    else if (event.key === "PageUp") target = rows[Math.max(0, at - 10)];
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(Number(tr.dataset.id), { from: "table" }); return; }
    else if (event.key === "Escape") { select(null, { from: "table" }); return; }
    if (!target) return;
    event.preventDefault();
    select(Number(target.dataset.id), { from: "table" });
    target.focus();
  });

  // ---- Selection and detail ---------------------------------------------------------------------------------------------
  function select(id, { from }) {
    state.selectedId = id;
    for (const tr of nodes.tableBody.rows) {
      const on = id !== null && Number(tr.dataset.id) === id;
      tr.setAttribute("aria-selected", on ? "true" : "false");
      tr.classList.toggle("lc-row--selected", on);
      tr.tabIndex = on ? 0 : -1;
    }
    if (id === null && nodes.tableBody.rows[0]) nodes.tableBody.rows[0].tabIndex = 0;
    if (id !== null && !nodes.tableBody.querySelector('tr[data-id="' + id + '"]')) {
      state.rowLimit = Infinity;
      renderTable();
    }
    if (id !== null && from !== "table") {
      const tr = nodes.tableBody.querySelector('tr[data-id="' + id + '"]');
      tr?.scrollIntoView({ block: "nearest" });
    }
    drawPlot();
    renderDetail();
    const row = state.view.rows.find((entry) => entry.record.id === id);
    nodes.live.textContent = row
      ? "Selected row " + id + (row.record.obsId ? ", observation " + row.record.obsId : "") + ", " + row.series.band.label + ", " + T.formatTime(row.t, state.axisFormat, 0) + ", " + (row.y === null ? "no plotted value" : T.formatNumber(row.y, 6) + " " + state.display.label) + "."
      : "Selection cleared.";
  }

  function renderDetail() {
    const row = state.selectedId === null ? null : state.view.rows.find((entry) => entry.record.id === state.selectedId);
    nodes.detailEmpty.hidden = Boolean(row);
    nodes.detail.hidden = !row;
    if (!row) return;
    const record = row.record;
    const display = state.display;
    const original = record.value === null ? "no measurement" : T.formatNumber(record.value, 9) + " " + record.unit.label;
    const originalErr = record.err === null ? (record.errState === "invalid" ? "invalid in the file" : "unknown (not given)") : "± " + T.formatNumber(record.err, 9) + " " + record.unit.label;
    const timeBlock = T.formatTime(row.t, "iso", 0) + " · MJD " + T.formatTime(row.t, "mjd") + " · JD " + T.formatTime(row.t, "jd") + " (" + state.plotTime.scale + (state.plotTime.barycentric ? ", barycentric" : "") + ")";
    const entries = [
      ["Row in the file", String(record.id)],
      ["Observation ID", record.obsId || "Unavailable"],
      ["Source", record.sourceId],
      ["Band", row.series.band.label + (record.wavelength !== null ? " · wavelength " + T.formatNumber(record.wavelength, 6) + " µm" + (record.lambdaWidth !== null ? ", width " + T.formatNumber(record.lambdaWidth, 4) + " µm" : "") : "")],
      ["Time as written", record.timeText + (state.profile === "export" ? " (" + record.scale + ", original file)" : " (" + T.timeLabel(state.config.timeFormat, record.scale, record.barycentric) + ")")],
      ["Time shown", timeBlock],
      ["Value as written", original],
      ["Uncertainty as written", originalErr],
      ["Value shown (" + display.label + ")", row.y === null ? "Unavailable: " + row.valueIssue : T.formatNumber(row.y, 9) + (row.yErr !== null ? " ± " + T.formatNumber(row.yErr, 6) : ", uncertainty unknown")],
      ["Flags", hexFlags(record.flags)],
    ];
    const notes = T.rowStatus(row, display).concat(record.issues);
    if (notes.length) entries.push(["Notes", [...new Set(notes)].join(" ")]);
    nodes.detail.replaceChildren(...entries.map(([name, value]) => make("div", {}, [make("dt", { text: name }), make("dd", { text: value })])));
  }

  // ---- Export ------------------------------------------------------------------------------------------------------------
  nodes.exportButton.addEventListener("click", () => {
    const rows = state.view?.rows ?? [];
    if (rows.length === 0) {
      say(nodes.exportStatus, "There are no rows to export. Change the filters first.", true);
      return;
    }
    const csv = T.exportCsv(rows, state.binning);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = make("a", { href: url, download: "light-curve-selection.csv" });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    const scales = [...new Set(rows.map((row) => row.record.scale + (row.record.barycentric ? " (barycentric)" : "")))];
    const units = [...new Set(rows.map((row) => row.record.unit.label))];
    say(nodes.exportStatus, "Downloaded " + plural(rows.length, "row") + " as light-curve-selection.csv. Original time scale: " + scales.join(", ") + ". Original unit: " + units.join(", ") + ".");
  });

  // ---- Inputs --------------------------------------------------------------------------------------------------------------
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) loadFile(fileInput.files[0]);
    fileInput.value = "";
  });

  nodes.example.addEventListener("click", () => {
    if (typeof lightCurveExample === "undefined") {
      say(nodes.status, "The example data could not be loaded.", true);
      return;
    }
    state.loadToken++;
    loadText(lightCurveExample.csv, lightCurveExample.name, lightCurveExample.provenance, { binningWidth: lightCurveExample.binningWidth });
  });

  fileInput.disabled = false;
  nodes.example.disabled = typeof lightCurveExample === "undefined";
})();
