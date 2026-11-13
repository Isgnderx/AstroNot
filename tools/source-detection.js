// Source Detection workspace: finds detected candidates in one calibrated 2D FITS image HDU. FITS structure and calibrated
// pixel values come from tools/fits.js (shared with FITS Viewer, Time Machine and Image Differencing), sky coordinates from
// tools/wcs.js, the pan and zoom geometry from tools/pair.js, and ALL detection and export computation from
// tools/detect.js. This file is the user interface only.
//
// Display never feeds back into the computation: the display range, the stretch, zoom, pan and marker drawing only decide how
// the array is painted. Detection and every readout read the calibrated array.
(function () {
  "use strict";

  const Wcs = AstroNotWcs;
  const Pair = AstroNotPair;
  const Detect = AstroNotDetect;
  const { createWcs, screenToFits, fitsToScreen, insideImage } = Wcs;

  const zoomStep = 2;
  const tapDistance = 5;
  const gridRadius = 3;
  const query = (name, scope = document) => scope.querySelector("[data-sd-" + name + "]");

  const el = {
    file: query("file"), fileLabel: query("file-label"), example: query("example"), hdu: query("hdu"), status: query("status"),
    imageFacts: query("image-facts"),
    form: query("form"), meshWrap: query("mesh-wrap"), thresholdLabel: query("threshold-label"), thresholdNote: query("threshold-note"),
    run: query("run"), runStatus: query("run-status"),
    verdict: query("verdict"), notes: query("notes"), summary: query("summary"), resultPanel: document.querySelector(".sd-result"),
    fit: query("fit"), zoomIn: query("zoom-in"), zoomOut: query("zoom-out"), displayNote: query("display-note"),
    viewport: query("viewport"), empty: query("empty"), canvas: query("canvas"), zoomLine: query("zoom-line"), pointer: query("pointer"), live: query("live"),
    sort: query("sort"), tableNote: query("table-note"), tableWrap: query("table-wrap"), caption: query("caption"), body: query("body"),
    candidatesPanel: document.querySelector(".sd-candidates"),
    detailNote: query("detail-note"), detailWrap: query("detail-wrap"), detailBody: query("detail-body"), detailCaption: query("detail-caption"),
    gridWrap: query("grid-wrap"), gridBody: query("grid-body"), gridCaption: query("grid-caption"),
    downloadCsv: query("download-csv"), downloadJson: query("download-json"), onlySky: query("only-sky"), exportStatus: query("export-status"),
  };
  const params = {};
  for (const input of document.querySelectorAll("[data-sd-param]")) params[input.dataset.sdParam] = input;
  const displayControls = {};
  for (const input of document.querySelectorAll("[data-sd-display]")) displayControls[input.dataset.sdDisplay] = input;

  // ---- State ---------------------------------------------------------------------------------------------------------
  const state = {
    file: null, name: "", isExample: false, hdus: null, choices: [], hduIndex: -1, version: 0, hduVersion: 0, loading: false, error: "", message: "",
    image: null,
    run: { token: 0, running: false, stage: "", error: "", message: "" },
    result: null, stale: false, selected: null, order: [], sort: "id",
    view: { zoom: 1, centerX: 1, centerY: 1 },
    picture: null, overlay: null,
    size: { width: 1, height: 1, ratio: window.devicePixelRatio || 1 },
    point: null, pointerType: "mouse", frame: 0, touches: new Map(), pinch: null, down: null,
  };
  const ctx = el.canvas.getContext("2d");
  const rows = new Map();
  let hatch = null;
  let runTimer = 0;

  // ---- Small helpers -------------------------------------------------------------------------------------------------
  const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
  const count = (value) => value.toLocaleString("en-US");

  function significant(value, digits = 5) {
    return Number(value.toPrecision(digits)).toString();
  }

  function withUnit(text, unit) {
    return unit ? text + " " + unit : text;
  }

  function setStatus(message, error = false) {
    el.status.toggleAttribute("data-error", error);
    el.status.textContent = message;
  }

  function setRunStatus(message, error = false) {
    el.runStatus.toggleAttribute("data-error", error);
    el.runStatus.textContent = message;
  }

  let announceTimer = 0;
  function announce(message, delay = 0) {
    clearTimeout(announceTimer);
    if (!delay) {
      el.live.textContent = message;
      return;
    }
    announceTimer = setTimeout(() => { el.live.textContent = message; }, delay);
  }

  function setFact(name, text) {
    const target = el.imageFacts.querySelector('[data-sd-fact="' + name + '"]');
    if (target && target.textContent !== text) target.textContent = text;
  }

  function setSummary(name, text) {
    const target = el.summary.querySelector('[data-sd-sum="' + name + '"]');
    if (target && target.textContent !== text) target.textContent = text;
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  function addItem(list, text, className) {
    const item = document.createElement("li");
    if (className) item.className = className;
    item.textContent = text;
    list.append(item);
  }

  function unitOf() {
    return state.image && state.image.unit ? state.image.unit : "";
  }

  // ---- Loading a file ------------------------------------------------------------------------------------------------
  function whyNotReadable(hdu) {
    if (!hdu.image) return "it is not an uncompressed two-dimensional image (" + hdu.axes.length + " axes)";
    if (hdu.bitpix === 64) return "64-bit integer images are not supported";
    return "it exceeds the limit of " + fitsMaxPixels.toLocaleString("en-US") + " pixels or 4,096 pixels per axis";
  }

  async function readValues(file, hdu) {
    const bytes = await file.slice(hdu.dataStart, hdu.dataStart + hdu.byteLength).arrayBuffer();
    const read = fitsPixelReader(bytes, hdu); // BSCALE and BZERO are applied here, once; BLANK becomes NaN.
    const values = new Float64Array(hdu.pixels);
    for (let index = 0; index < values.length; index++) values[index] = read(index);
    return values;
  }

  // A VARIANCE image of the same size whose unit is the square of the image unit. ERR or sigma images are not squared on
  // the user's behalf.
  async function readVariance(hdus, file, hdu, unit) {
    const index = hdus.findIndex((entry) => entry !== hdu && String(entry.fields.EXTNAME ?? "").trim().toUpperCase() === "VARIANCE");
    if (index < 0) return { values: null, note: "None in this file, so the noise is measured from the image." };
    const candidate = hdus[index];
    if (!candidate.renderable || candidate.axes[0] !== hdu.axes[0] || candidate.axes[1] !== hdu.axes[1]) {
      return { values: null, note: "HDU " + index + " (VARIANCE) is ignored: it cannot be read or its size differs from the image." };
    }
    const varianceUnit = typeof candidate.fields.BUNIT === "string" ? candidate.fields.BUNIT.trim() : "";
    const check = Detect.varianceUnitCheck(varianceUnit, unit);
    if (!check.ok) return { values: null, note: "HDU " + index + " (VARIANCE) is ignored. " + check.reason };
    const values = await readValues(file, candidate);
    return { values, note: "HDU " + index + (varianceUnit ? ", unit " + varianceUnit : ", no BUNIT") + ". Available as a noise source." + (check.assumed ? " " + check.reason : "") };
  }

  async function readImage(version, token) {
    const hdu = state.hdus[state.hduIndex];
    const values = await readValues(state.file, hdu);
    if (version !== state.version || token !== state.hduVersion) return null;
    const unit = typeof hdu.fields.BUNIT === "string" ? hdu.fields.BUNIT.trim() : "";
    const variance = await readVariance(state.hdus, state.file, hdu, unit);
    if (version !== state.version || token !== state.hduVersion) return null;
    const wcs = createWcs(hdu.fields);
    const [width, height] = hdu.axes;
    let valid = 0;
    for (let index = 0; index < values.length; index++) if (Number.isFinite(values[index])) valid++;
    return {
      width, height, values, hdu, unit, valid,
      variance: variance.values, varianceNote: variance.note,
      wcs: wcs.ok ? wcs.wcs : null, wcsReason: wcs.ok ? "" : wcs.reason,
      obsId: typeof hdu.fields.OBSID === "string" && hdu.fields.OBSID.trim() ? hdu.fields.OBSID.trim() : null,
      saturateKeyword: isNumber(hdu.fields.SATURATE) ? hdu.fields.SATURATE : null,
    };
  }

  function clearResult() {
    state.run.token++;
    state.run.running = false;
    state.run.stage = "";
    state.run.error = "";
    state.result = null;
    state.stale = false;
    state.selected = null;
    state.order = [];
    state.overlay = null;
    window.AstroNotLatestDetection = null;
  }

  async function showHdu(version) {
    const token = ++state.hduVersion;
    state.image = null;
    state.picture = null;
    state.loading = true;
    state.error = "";
    state.message = "Reading image pixels…";
    clearResult();
    fitView();
    refresh();
    try {
      const image = await readImage(version, token);
      if (!image) return;
      state.image = image;
      state.loading = false;
      state.message = (state.isExample ? "SPHEREx example loaded." : state.name + " loaded.") + (image.wcs ? "" : " It has no usable sky coordinates, so candidates are listed in pixels only.");
      if (image.valid === 0) state.message += " Every pixel is NaN or BLANK, so nothing can be detected.";
      buildPicture();
      fitView();
    } catch (error) {
      if (version !== state.version || token !== state.hduVersion) return;
      state.loading = false;
      state.image = null;
      state.error = (state.isExample ? "The SPHEREx example" : state.name) + " could not be read. " + error.message;
      state.message = "";
    }
    refresh();
    announce(state.error || state.message);
    if (state.image) runDetection();
  }

  async function openFile(source, name, isExample = false) {
    const version = ++state.version;
    state.hduVersion++;
    Object.assign(state, { file: null, name: "", isExample: false, hdus: null, choices: [], hduIndex: -1, image: null, picture: null, error: "", loading: true, message: "Reading FITS headers…" });
    clearResult();
    refresh();
    try {
      const file = await source;
      if (version !== state.version) return;
      const hdus = await readFitsHdus(file);
      if (version !== state.version) return;
      const choices = hdus.map((hdu, index) => ({ hdu, index })).filter(({ hdu }) => hdu.renderable);
      if (!choices.length) {
        const reasons = hdus.map((hdu, index) => "HDU " + index + " (" + hdu.name + "): " + whyNotReadable(hdu));
        throw new Error("This file has no image HDU that Source Detection can read. " + reasons.join("; ") + ".");
      }
      const preferred = choices.find(({ hdu }) => hdu.fields.EXTNAME === "IMAGE") ?? choices[0];
      Object.assign(state, { file, name, isExample, hdus, choices, hduIndex: preferred.index });
      await showHdu(version);
    } catch (error) {
      if (version !== state.version) return;
      Object.assign(state, { file: null, name: "", isExample: false, hdus: null, choices: [], hduIndex: -1, image: null, picture: null, loading: false, error: (isExample ? "The SPHEREx example" : name) + " could not be opened. " + error.message, message: "" });
      refresh();
      announce(state.error);
    }
  }

  let exampleLoad;
  function loadExample() {
    if (!exampleLoad) {
      exampleLoad = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = siteAsset("assets/tools/spherex-example.js");
        script.addEventListener("load", () => {
          try {
            resolve(new File([Uint8Array.from(atob(spherexExampleData), (character) => character.charCodeAt(0))], "SPHEREx-QR2-D2.fits"));
          } catch {
            reject(new Error("The example file could not be read."));
          }
        }, { once: true });
        script.addEventListener("error", () => reject(new Error("The example file could not be loaded.")), { once: true });
        document.head.append(script);
      }).catch((error) => {
        exampleLoad = undefined;
        throw error;
      });
    }
    return exampleLoad;
  }

  // ---- Settings ------------------------------------------------------------------------------------------------------
  function rawParams() {
    const raw = {
      background: params.background.value, noise: params.noise.value, thresholdMode: params.thresholdMode.value,
      threshold: params.threshold.value, minPixels: params.minPixels.value, smoothFwhm: params.smoothFwhm.value,
      deblend: params.deblend.checked, valleySigma: params.valleySigma.value, saturation: params.saturation.value,
    };
    if (raw.background === "mesh") raw.meshSize = params.meshSize.value;
    if (raw.saturation.trim() === "" && state.image && state.image.saturateKeyword !== null) raw.saturation = state.image.saturateKeyword;
    return raw;
  }

  function renderSettings() {
    const image = state.image;
    const unit = unitOf() || "image units";
    el.meshWrap.hidden = params.background.value !== "mesh";
    const variance = params.noise.querySelector('option[value="variance"]');
    const available = Boolean(image && image.variance);
    variance.disabled = !available;
    variance.textContent = available ? "From the VARIANCE image (√variance, pixel by pixel)" : "From the VARIANCE image (unavailable for this image)";
    if (!available && params.noise.value === "variance") params.noise.value = "measured";
    const sigma = params.thresholdMode.value === "sigma";
    el.thresholdLabel.textContent = sigma ? "Threshold (× σ)" : "Threshold (" + unit + " above the background)";
    el.thresholdNote.textContent = sigma
      ? "A threshold in σ is relative to the noise of this image, so the same number is a brighter level in a noisier image, and in a noisier part when the noise comes from a mesh or a VARIANCE image. The result shows the level in " + unit + "."
      : "An absolute threshold ignores the noise: a pixel must exceed the background by this many " + unit + ". Use it when the noise cannot be measured (for example in a noise-free image).";
    params.saturation.placeholder = image && image.saturateKeyword !== null ? "header SATURATE = " + significant(image.saturateKeyword, 8) : "none";
    const ready = Boolean(image) && !state.loading;
    el.run.setAttribute("aria-disabled", String(!ready));
  }

  function markStale() {
    if (!state.result && !state.run.running) return;
    if (!state.stale) {
      state.stale = true;
      setRunStatus("A setting changed. The candidates below are from the previous settings until the new run finishes.");
      renderStale();
    }
  }

  function renderStale() {
    el.resultPanel.toggleAttribute("data-stale", state.stale);
    el.candidatesPanel.toggleAttribute("data-stale", state.stale);
  }

  function runSoon() {
    clearTimeout(runTimer);
    runTimer = setTimeout(runDetection, 0);
  }

  // ---- Running the detection -----------------------------------------------------------------------------------------
  async function runDetection() {
    clearTimeout(runTimer);
    const image = state.image;
    if (!image || state.loading) {
      setRunStatus("Load an image first.", true);
      return;
    }
    const checked = Detect.validateParams(rawParams());
    clearResult();
    const token = state.run.token;
    renderStale();
    if (!checked.ok) {
      state.run.error = checked.errors.join(" ");
      setRunStatus("The settings are not valid. " + state.run.error, true);
      refresh();
      return;
    }
    state.run.running = true;
    state.run.stage = "Starting…";
    setRunStatus("Running detection…");
    refresh();
    const input = { width: image.width, height: image.height, values: image.values, variance: image.variance, wcs: image.wcs, unit: image.unit };
    let outcome;
    try {
      outcome = await Detect.detectSources(input, checked.params, {
        tick,
        cancelled: () => token !== state.run.token || image !== state.image,
        progress: (stage) => {
          if (token !== state.run.token) return;
          state.run.stage = stage;
          setRunStatus("Running detection. " + stage);
          el.verdict.textContent = "Running detection. " + stage;
        },
      });
    } catch (error) {
      outcome = { ok: false, code: "error", reason: "Detection stopped unexpectedly. " + error.message };
    }
    if (token !== state.run.token) return;
    state.run.running = false;
    if (!outcome.ok) {
      state.run.error = outcome.reason;
      setRunStatus(outcome.reason, true);
      refresh();
      announce("Detection did not run. " + outcome.reason);
      return;
    }
    state.result = outcome;
    state.order = orderedNumbers();
    buildOverlay();
    window.AstroNotLatestDetection = { result: outcome, image: { name: state.name, obsId: image.obsId, hduIndex: state.hduIndex } };
    setRunStatus("Detection finished in " + (outcome.elapsedMs / 1000).toFixed(outcome.elapsedMs < 100 ? 3 : 2) + " s.");
    refresh();
    announce(verdictText(outcome));
  }

  function verdictText(result) {
    const n = result.sources.length;
    if (!n) return "No candidates. No group of at least " + result.params.minPixels + " connected pixels lies above the threshold.";
    return count(n) + " detected " + (n === 1 ? "candidate" : "candidates") + ".";
  }

  // ---- Table and selection -------------------------------------------------------------------------------------------
  function orderedNumbers() {
    const result = state.result;
    if (!result) return [];
    const list = result.sources.slice();
    const by = {
      id: (a, b) => a.number - b.number,
      peak: (a, b) => b.peak - a.peak || a.number - b.number,
      flux: (a, b) => b.fluxSum - a.fluxSum || a.number - b.number,
      area: (a, b) => b.area - a.area || a.number - b.number,
      position: (a, b) => a.y - b.y || a.x - b.x || a.number - b.number,
    };
    list.sort(by[state.sort] ?? by.id);
    return list.map((source) => source.number);
  }

  function sourceByNumber(number) {
    return state.result && number ? state.result.sources[number - 1] : null;
  }

  function flagWords(source) {
    return source.flags.map((flag) => flag.replace("_", " ")).join(", ");
  }

  function renderTable() {
    const result = state.result;
    rows.clear();
    el.body.replaceChildren();
    el.tableWrap.hidden = !(result && result.sources.length);
    if (!result) {
      el.tableNote.textContent = state.run.running ? "Running detection…" : state.run.error ? "No candidates are listed because the last run failed. " + state.run.error : "Run detection to list candidates.";
      return;
    }
    const image = state.image;
    const unit = result.unit;
    if (!result.sources.length) {
      el.tableNote.textContent = "No candidates. Lower the threshold or the minimum number of connected pixels, or turn on smoothing for faint extended sources.";
      return;
    }
    el.tableNote.textContent = count(result.sources.length) + " detected candidates, not catalog identifications. Select a row or a marker. Positions use the FITS pixel convention with origin 1: the center of the first pixel is (1, 1).";
    el.caption.textContent = "Detected candidates in " + (state.name || "the image") + ", HDU " + state.hduIndex + ". x and y: flux-weighted centroid in FITS pixel numbers (origin 1). RA and Dec: degrees, ICRS" + (image && image.wcs ? "" : " (unavailable: no usable WCS)") + ". Peak and flux sum: background-subtracted, in " + (unit || "the image unit") + ". S/N: peak detection significance.";
    const fragment = document.createDocumentFragment();
    for (const number of state.order) {
      const source = result.sources[number - 1];
      const row = document.createElement("tr");
      row.dataset.number = String(number);
      const head = document.createElement("th");
      head.scope = "row";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sd-pick";
      button.textContent = source.id;
      button.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-label", "Select candidate " + source.id);
      head.append(button);
      row.append(head);
      const cells = [
        source.x.toFixed(2), source.y.toFixed(2),
        source.ra === null ? "—" : source.ra.toFixed(6), source.dec === null ? "—" : source.dec.toFixed(6),
        String(source.area), significant(source.peak, 4), significant(source.fluxSum, 4),
        source.significance === null ? "—" : significant(source.significance, 3),
        source.flags.length ? flagWords(source) : "—",
      ];
      cells.forEach((text, index) => {
        const cell = document.createElement("td");
        cell.textContent = text;
        if (index === 8 && source.flags.length) cell.dataset.flags = "";
        row.append(cell);
      });
      rows.set(number, row);
      fragment.append(row);
    }
    el.body.append(fragment);
    updateRowSelection();
  }

  function updateRowSelection() {
    for (const [number, row] of rows) {
      const selected = number === state.selected;
      row.toggleAttribute("data-selected", selected);
      row.querySelector("button").setAttribute("aria-pressed", String(selected));
    }
  }

  function select(number, options = {}) {
    const source = sourceByNumber(number);
    if (!source) return;
    state.selected = number;
    updateRowSelection();
    if (options.scrollRow) rows.get(number)?.scrollIntoView({ block: "nearest" });
    if (options.reveal) revealSource(source);
    renderDetail();
    invalidate();
    announce("Candidate " + source.id + " selected. Centroid " + source.x.toFixed(2) + ", " + source.y.toFixed(2) + ". Area " + source.area + " pixels. " + (source.flags.length ? "Flags: " + flagWords(source) + "." : "No quality flags."), options.delay ?? 0);
  }

  function clearSelection() {
    if (state.selected === null) return;
    state.selected = null;
    updateRowSelection();
    renderDetail();
    invalidate();
    announce("Selection cleared.");
  }

  function selectNeighbour(step) {
    if (!state.order.length) return;
    const index = state.order.indexOf(state.selected);
    const next = index < 0 ? (step > 0 ? 0 : state.order.length - 1) : (index + step + state.order.length) % state.order.length;
    select(state.order[next], { reveal: true, scrollRow: true, delay: 120 });
  }

  // Pan (never zoom) so the candidate is on the screen. The view keeps its zoom.
  function revealSource(source) {
    const image = state.image;
    if (!image) return;
    const geo = geometry();
    const at = fitsToScreen(geo, source.x, source.y);
    const margin = Math.min(state.size.width, state.size.height) * 0.12;
    if (at.x < margin || at.y < margin || at.x > state.size.width - margin || at.y > state.size.height - margin) {
      state.view.centerX = source.x;
      state.view.centerY = source.y;
      Pair.clampView(state.view, image.width, image.height, state.size);
    }
  }

  function flagExplanation(source) {
    return source.flags.map((flag) => flag.replace("_", " ") + " (" + Detect.flagText[flag] + ")").join("; ");
  }

  function formatValue(value) {
    return Number.isFinite(value) ? significant(value, 5) : "NaN, BLANK or masked";
  }

  function renderDetail() {
    const source = sourceByNumber(state.selected);
    el.detailWrap.hidden = !source;
    el.gridWrap.hidden = !source;
    if (!source) {
      el.detailBody.replaceChildren();
      el.gridBody.replaceChildren();
      el.detailNote.textContent = state.result && state.result.sources.length
        ? "Select a marker or a table row to see its measurements and the calibrated pixel values around its peak."
        : "Run detection and select a candidate to see its measurements and the calibrated pixel values around its peak.";
      return;
    }
    const image = state.image;
    const result = state.result;
    const unit = result.unit;
    el.detailNote.textContent = "Candidate " + source.id + " is a detected candidate, not a catalog identification. The values below are measured from the calibrated array, not from the picture.";
    el.detailCaption.textContent = "Measurements of " + source.id + " (" + (state.name || "image") + ", HDU " + state.hduIndex + ")";
    const entries = [
      ["Centroid x, y (FITS pixels, origin 1)", source.x.toFixed(3) + ", " + source.y.toFixed(3) + (source.centroidFallback ? " (the peak pixel: no positive weights)" : "")],
      ["RA, Dec (ICRS, degrees)", source.ra === null ? "Unavailable" + (image.wcs ? " (the WCS could not convert this position)" : ": no usable WCS (" + image.wcsReason + ")") : source.ra.toFixed(7) + ", " + source.dec.toFixed(7)],
      ["Area", source.area + " pixels"],
      ["Peak above background", withUnit(significant(source.peak, 6), unit)],
      ["Flux sum above background", withUnit(significant(source.fluxSum, 6), unit) + " (sum of pixel values, not a flux density)"],
      ["Local background at the peak", withUnit(significant(source.background, 6), unit)],
      ["Peak detection S/N", source.significance === null ? "Unavailable (the noise is zero or the threshold is absolute)" : significant(source.significance, 4)],
      ["Peak pixel x, y (FITS pixels)", source.peakX + ", " + source.peakY + " · value " + withUnit(formatValue(source.peakValue), unit)],
      ["Bounding box x, y", source.bbox.xMin + " to " + source.bbox.xMax + ", " + source.bbox.yMin + " to " + source.bbox.yMax],
      ["Quality flags", source.flags.length ? flagExplanation(source) : "None", source.flags.length ? "flag" : ""],
    ];
    el.detailBody.replaceChildren(...entries.map(([label, value, flag]) => {
      const row = document.createElement("tr");
      const head = document.createElement("th");
      head.scope = "row";
      head.textContent = label;
      const cell = document.createElement("td");
      cell.textContent = value;
      if (flag) cell.dataset.flag = "";
      row.append(head, cell);
      return row;
    }));

    el.gridCaption.textContent = "Calibrated pixel values" + (unit ? " (" + unit + ")" : "") + " around the peak pixel (" + source.peakX + ", " + source.peakY + "), read from the FITS array. Rows are FITS y, top row highest. Outlined cells belong to " + source.id + "; the heavy outline is the peak pixel; blank cells lie outside the image.";
    const header = document.createElement("tr");
    header.append(document.createElement("td"));
    for (let dx = -gridRadius; dx <= gridRadius; dx++) {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = "x " + (source.peakX + dx);
      header.append(th);
    }
    const body = [header];
    for (let dy = gridRadius; dy >= -gridRadius; dy--) {
      const y = source.peakY + dy;
      const row = document.createElement("tr");
      const head = document.createElement("th");
      head.scope = "row";
      head.textContent = "y " + y;
      row.append(head);
      for (let dx = -gridRadius; dx <= gridRadius; dx++) {
        const x = source.peakX + dx;
        const cell = document.createElement("td");
        if (x < 1 || y < 1 || x > image.width || y > image.height) {
          cell.dataset.outside = "";
          cell.textContent = "·";
          cell.title = "Outside the image";
        } else {
          const index = (y - 1) * image.width + (x - 1);
          const value = image.values[index];
          cell.textContent = Number.isFinite(value) ? significant(value, 4) : "NaN";
          if (!Number.isFinite(value)) cell.dataset.invalid = "";
          const label = result.labels[index];
          if (label === source.number) {
            cell.dataset.member = "";
            cell.title = "Pixel " + x + ", " + y + " belongs to " + source.id;
          } else if (label) {
            cell.dataset.other = "";
            cell.title = "Pixel " + x + ", " + y + " belongs to " + result.sources[label - 1].id;
          }
          if (dx === 0 && dy === 0) cell.dataset.peak = "";
        }
        row.append(cell);
      }
      body.push(row);
    }
    el.gridBody.replaceChildren(...body);
  }

  // ---- Result summary ------------------------------------------------------------------------------------------------
  function renderResult() {
    const result = state.result;
    const image = state.image;
    el.notes.replaceChildren();
    el.summary.hidden = !result;
    if (!image) {
      el.verdict.textContent = state.loading ? "Reading the selected file…" : "Load an image to detect sources.";
      if (state.error) addItem(el.notes, state.error, "tm-notes__error");
      el.notes.hidden = !el.notes.children.length;
      return;
    }
    if (state.run.running) {
      el.verdict.textContent = "Running detection. " + state.run.stage;
      el.notes.hidden = true;
      return;
    }
    if (!result) {
      el.verdict.textContent = state.run.error ? "No candidates were computed." : "Run detection to find candidates.";
      if (state.run.error) addItem(el.notes, state.run.error, "tm-notes__error");
      el.notes.hidden = !el.notes.children.length;
      return;
    }
    const unit = result.unit;
    const n = result.sources.length;
    el.verdict.textContent = n
      ? count(n) + " detected " + (n === 1 ? "candidate" : "candidates") + " in " + count(result.width) + " × " + count(result.height) + " pixels. They are candidates found by this method, not catalog identifications."
      : "No candidates. No group of at least " + result.params.minPixels + " connected pixels lies above the threshold.";
    for (const text of result.warnings) addItem(el.notes, text, "tm-notes__warning");
    for (const text of result.notes) addItem(el.notes, text, "tm-notes__info");
    if (!n && result.counts.aboveThreshold > 0) addItem(el.notes, count(result.counts.aboveThreshold) + " pixels are above the threshold, but they form only groups smaller than " + result.params.minPixels + " pixels.", "tm-notes__info");
    el.notes.hidden = !el.notes.children.length;

    const u = unit || "image units";
    const t = result.threshold;
    const noise = result.noise;
    setSummary("method", result.method + ". Pixels above the threshold are grouped by 8-connectivity; each group is one candidate.");
    setSummary("background", result.background.description + ". Level " + (result.background.level === null ? "unavailable" : withUnit(significant(result.background.level, 5), unit)) +
      (result.background.cells > 1 ? " (range " + significant(result.background.levelMin, 4) + " to " + significant(result.background.levelMax, 4) + ")" : "") + ".");
    const sigmaRange = noise.sigmaMin !== null && noise.sigmaMax !== null && noise.sigmaMin !== noise.sigmaMax ? " (range " + significant(noise.sigmaMin, 3) + " to " + significant(noise.sigmaMax, 3) + ")" : "";
    setSummary("noise", noise.description + ". σ = " + (noise.sigmaMedian === null ? "unavailable" : withUnit(significant(noise.sigmaMedian, 4), unit)) + sigmaRange + ".");
    if (t.mode === "sigma") {
      setSummary("threshold", significant(t.value, 4) + " σ above the background = " + (t.levelMedian === null ? "unavailable" : withUnit(significant(t.levelMedian, 4), unit)) +
        (t.levelMin !== t.levelMax ? " (from " + significant(t.levelMin, 3) + " to " + significant(t.levelMax, 3) + ", because the noise differs across the image)" : "") +
        ". A pixel must exceed the local background by this much; the same " + significant(t.value, 3) + " σ would be a higher level in a noisier image.");
    } else {
      setSummary("threshold", "Absolute: " + withUnit(significant(t.value, 5), u) + " above the local background. The noise is not used for the threshold" + (noise.sigmaMedian > 0 ? " (it is " + significant(t.value / noise.sigmaMedian, 3) + " σ for the median noise)" : "") + ".");
    }
    setSummary("smoothing", result.smoothing + (result.params.smoothFwhm > 0 && noise.detectionSigma !== null ? ". Noise of the smoothed image: " + withUnit(significant(noise.detectionSigma, 3), unit) + "." : "."));
    const c = result.counts;
    setSummary("pixels", count(c.valid) + " of " + count(c.total) + " pixels are valid (" + count(c.invalid) + " NaN, BLANK or infinite)" + (c.untestable ? "; " + count(c.untestable) + " valid pixels cannot be tested (zero or unknown noise, or too little valid data in the smoothing kernel)" : "") + ". " + count(c.aboveThreshold) + " are above the threshold.");
    setSummary("segments", count(c.regionsFound) + " connected groups; " + count(c.regionsTooSmall) + " smaller than " + result.params.minPixels + " pixels were dropped; " + count(c.regionsWithSeveralPeaks) + " hold more than one significant peak" + (result.params.deblend ? " and were split." : " (not split: deblending is off)."));
    setSummary("candidates", count(c.candidates) + " detected candidates, " + count(c.flagged) + " with at least one quality flag.");
    setSummary("time", (result.elapsedMs / 1000).toFixed(result.elapsedMs < 100 ? 3 : 2) + " s on this device.");
  }

  function renderFacts() {
    const image = state.image;
    const hdu = image ? image.hdu : null;
    setFact("file", state.file ? state.name + (state.isExample ? " · SPHEREx example" : " · local file") : "—");
    setFact("obsId", image ? image.obsId ?? "Unavailable" : "—");
    setFact("hdu", image ? state.hduIndex + " · " + hdu.name + " (HDU numbers start at 0)" : "—");
    setFact("size", image ? image.width + " × " + image.height + " pixels" : "—");
    setFact("unit", image ? image.unit || "Unavailable" : "—");
    setFact("valid", image ? count(image.valid) + " of " + count(image.width * image.height) + (image.valid < image.width * image.height ? " (the rest are NaN or BLANK)" : "") : "—");
    setFact("wcs", image ? image.wcs ? image.wcs.summary : "Unavailable: " + image.wcsReason + " Candidates are listed in pixels only." : "—");
    setFact("variance", image ? image.varianceNote : "—");
    el.fileLabel.textContent = state.file ? "Change FITS file" : "Choose FITS file";
    el.hdu.replaceChildren(...state.choices.map(({ hdu: entry, index }) => new Option(index + " · " + entry.name + " (" + entry.axes.join(" × ") + ")", index)));
    if (state.choices.length) el.hdu.value = String(state.hduIndex);
    el.hdu.disabled = !state.choices.length;
    el.status.toggleAttribute("data-error", Boolean(state.error));
    el.status.textContent = state.error || state.message;
  }

  function renderExport() {
    const result = state.result;
    const ready = Boolean(result && result.sources.length);
    el.downloadCsv.setAttribute("aria-disabled", String(!ready));
    el.downloadJson.setAttribute("aria-disabled", String(!ready));
    el.exportStatus.textContent = ready ? "" : result ? "There are no candidates to export." : "Run detection to export candidates.";
    el.onlySky.disabled = !ready;
  }

  function exportMeta() {
    const image = state.image;
    return { sourceFile: state.name, obsId: image.obsId, hduIndex: state.hduIndex, hduName: image.hdu.name, wcsSummary: image.wcs ? image.wcs.summary : null };
  }

  function safeName() {
    const image = state.image;
    const stem = (image.obsId ?? state.name.replace(/\.[^.]*$/, "")) || "image";
    return "AstroNot-source-detection_" + stem.replace(/[^A-Za-z0-9_-]+/g, "_") + "_hdu" + state.hduIndex;
  }

  function download(name, text, type) {
    const link = document.createElement("a");
    const url = URL.createObjectURL(new Blob([text], { type }));
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function downloadCsv() {
    const result = state.result;
    if (!result || !result.sources.length) return;
    const text = Detect.buildCsv(result, exportMeta(), { onlySky: el.onlySky.checked });
    const rowsWritten = text.split("\r\n").length - 2;
    const name = safeName() + ".csv";
    if (!rowsWritten) {
      el.exportStatus.textContent = "No candidate has sky coordinates, so nothing was saved. Clear “Only candidates with sky coordinates” to save pixel positions.";
      return;
    }
    download(name, text, "text/csv;charset=utf-8");
    el.exportStatus.textContent = "Saved " + name + ": " + count(rowsWritten) + " candidates, FITS pixel origin 1. Source IDs belong to this run.";
  }

  function downloadJson() {
    const result = state.result;
    if (!result || !result.sources.length) return;
    const name = safeName() + "-parameters.json";
    download(name, JSON.stringify(Detect.buildMetadata(result, exportMeta()), null, 2) + "\n", "application/json");
    el.exportStatus.textContent = "Saved " + name + ": method, threshold and its unit, and every setting of this run.";
  }

  // ---- Display -------------------------------------------------------------------------------------------------------
  function buildPicture() {
    const image = state.image;
    state.picture = null;
    if (!image) return;
    const [low, high] = displayControls.range.value.split("-").map((text) => Number(text) / 100);
    const range = Pair.displayRange([image.values], low, high);
    const picture = document.createElement("canvas");
    picture.width = image.width;
    picture.height = image.height;
    const context = picture.getContext("2d");
    if (!context) return;
    const data = context.createImageData(image.width, image.height);
    const asinh = displayControls.stretch.value === "asinh";
    const span = range ? range.high - range.low : 0;
    const scale = asinh ? 1 / Math.asinh(10) : 1;
    for (let y = 0; y < image.height; y++) {
      const source = (image.height - y - 1) * image.width; // FITS row 1 is the bottom of the picture.
      for (let x = 0; x < image.width; x++) {
        const value = image.values[source + x];
        const out = (y * image.width + x) * 4;
        if (!Number.isFinite(value) || !range) continue; // alpha 0: shown as hatching
        let t = span > 0 ? (value - range.low) / span : 0.5;
        t = Math.min(1, Math.max(0, t));
        if (asinh) t = Math.asinh(10 * t) * scale;
        data.data[out] = data.data[out + 1] = data.data[out + 2] = Math.round(255 * t);
        data.data[out + 3] = 255;
      }
    }
    context.putImageData(data, 0, 0);
    state.picture = picture;
  }

  function buildOverlay() {
    const result = state.result;
    state.overlay = null;
    if (!result) return;
    const overlay = document.createElement("canvas");
    overlay.width = result.width;
    overlay.height = result.height;
    const context = overlay.getContext("2d");
    if (!context) return;
    const data = context.createImageData(result.width, result.height);
    for (let y = 0; y < result.height; y++) {
      const source = (result.height - y - 1) * result.width;
      for (let x = 0; x < result.width; x++) {
        if (!result.labels[source + x]) continue;
        const out = (y * result.width + x) * 4;
        data.data[out] = 255;
        data.data[out + 1] = 150;
        data.data[out + 2] = 60;
        data.data[out + 3] = 120;
      }
    }
    context.putImageData(data, 0, 0);
    state.overlay = overlay;
  }

  function hatchPattern() {
    if (!hatch) {
      const tile = document.createElement("canvas");
      tile.width = tile.height = 8;
      const tileContext = tile.getContext("2d");
      tileContext.fillStyle = "#14171c";
      tileContext.fillRect(0, 0, 8, 8);
      tileContext.strokeStyle = "#5b6270";
      tileContext.lineWidth = 1;
      tileContext.beginPath();
      tileContext.moveTo(0, 8);
      tileContext.lineTo(8, 0);
      tileContext.moveTo(-1, 1);
      tileContext.lineTo(1, -1);
      tileContext.moveTo(7, 9);
      tileContext.lineTo(9, 7);
      tileContext.stroke();
      hatch = tile;
    }
    return ctx.createPattern(hatch, "repeat");
  }

  function invalidate() {
    if (!state.frame) state.frame = requestAnimationFrame(renderCanvas);
  }

  function resizeCanvas() {
    const width = el.viewport.clientWidth;
    const height = el.viewport.clientHeight;
    const ratio = window.devicePixelRatio || 1;
    if (width === state.size.width && height === state.size.height && ratio === state.size.ratio && el.canvas.width) return;
    state.size.width = Math.max(1, width);
    state.size.height = Math.max(1, height);
    state.size.ratio = ratio;
    el.canvas.width = Math.max(1, Math.round(state.size.width * ratio));
    el.canvas.height = Math.max(1, Math.round(state.size.height * ratio));
  }

  function geometry() {
    const image = state.image;
    return Pair.viewGeometry(state.view, image.width, image.height, state.size, state.size);
  }

  function fitView() {
    const image = state.image;
    state.view = image ? Pair.createView(image.width, image.height) : { zoom: 1, centerX: 1, centerY: 1 };
  }

  function drawMarker(context, x, y, flagged, selected) {
    const radius = 7;
    context.save();
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.lineWidth = 4;
    context.strokeStyle = "rgba(0, 0, 0, 0.85)";
    context.setLineDash(flagged ? [3, 3] : []);
    context.stroke();
    context.lineWidth = 1.75;
    context.strokeStyle = "#f2f4f8";
    context.stroke();
    if (selected) {
      context.setLineDash([]);
      context.beginPath();
      context.arc(x, y, radius + 5, 0, Math.PI * 2);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        context.moveTo(x + dx * (radius + 5), y + dy * (radius + 5));
        context.lineTo(x + dx * (radius + 11), y + dy * (radius + 11));
      }
      context.lineWidth = 5;
      context.strokeStyle = "rgba(0, 0, 0, 0.85)";
      context.stroke();
      context.lineWidth = 2.5;
      context.strokeStyle = "#ffd24a";
      context.stroke();
    }
    context.restore();
  }

  function renderCanvas() {
    state.frame = 0;
    const image = state.image;
    if (!image || !state.picture) {
      el.canvas.hidden = true;
      el.empty.hidden = false;
      el.empty.querySelector("p").textContent = state.loading ? "Reading the file…" : state.error ? "No image is shown. Choose another FITS file or load the SPHEREx example." : "Load an image to see it here.";
      el.viewport.removeAttribute("data-loaded");
      el.viewport.removeAttribute("data-pannable");
      el.zoomLine.textContent = "";
      el.pointer.textContent = "";
      return;
    }
    el.empty.hidden = true;
    el.canvas.hidden = false;
    el.viewport.toggleAttribute("data-loaded", true);
    resizeCanvas();
    Pair.clampView(state.view, image.width, image.height, state.size);
    const geo = geometry();
    const ratio = state.size.ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = "#060709";
    ctx.fillRect(0, 0, state.size.width, state.size.height);
    const origin = fitsToScreen(geo, 0.5, image.height + 0.5);
    const extent = { x: origin.x, y: origin.y, width: image.width * geo.scale, height: image.height * geo.scale };
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = hatchPattern();
    ctx.fillRect(extent.x, extent.y, extent.width, extent.height);
    ctx.imageSmoothingEnabled = geo.scale < 1;
    ctx.drawImage(state.picture, extent.x, extent.y, extent.width, extent.height);
    if (displayControls.segments.checked && state.overlay) ctx.drawImage(state.overlay, extent.x, extent.y, extent.width, extent.height);
    ctx.imageSmoothingEnabled = false;
    ctx.strokeStyle = "#4a505a";
    ctx.lineWidth = 1;
    ctx.strokeRect(extent.x - 0.5, extent.y - 0.5, extent.width + 1, extent.height + 1);

    const result = state.result;
    const selected = sourceByNumber(state.selected);
    if (selected && selected.pixels.length <= 20000) {
      ctx.fillStyle = "rgba(255, 210, 74, 0.5)";
      for (const p of selected.pixels) {
        const column = p % image.width;
        const row = (p - column) / image.width;
        const corner = fitsToScreen(geo, column + 0.5, row + 1.5);
        ctx.fillRect(corner.x, corner.y, geo.scale, geo.scale);
      }
    }
    if (result && displayControls.markers.checked && !state.stale) {
      for (const source of result.sources) {
        if (source === selected) continue;
        const at = fitsToScreen(geo, source.x, source.y);
        if (at.x < -12 || at.y < -12 || at.x > state.size.width + 12 || at.y > state.size.height + 12) continue;
        drawMarker(ctx, at.x, at.y, source.flags.length > 0, false);
      }
    }
    if (selected && !state.stale) {
      const at = fitsToScreen(geo, selected.x, selected.y);
      drawMarker(ctx, at.x, at.y, selected.flags.length > 0, true);
      ctx.font = "600 13px Inter, system-ui, sans-serif";
      ctx.textBaseline = "bottom";
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.9)";
      ctx.fillStyle = "#ffd24a";
      ctx.strokeText(selected.id, at.x + 20, at.y - 12);
      ctx.fillText(selected.id, at.x + 20, at.y - 12);
    }

    el.canvas.setAttribute("aria-label", "Image " + image.width + " × " + image.height + " pixels" + (result ? " with " + result.sources.length + " detected candidates marked" : ""));
    const zoom = state.view.zoom;
    el.zoomLine.textContent = "Zoom " + (zoom < 10 ? zoom.toFixed(1) : zoom.toFixed(0)) + "× (1× shows the whole image) · zoom and pan do not change any measurement";
    el.viewport.toggleAttribute("data-pannable", zoom > 1.001);
    updatePointerLine(geo);
  }

  function updatePointerLine(geo) {
    const image = state.image;
    if (!state.point) {
      el.pointer.textContent = "Pointer: move over the image to read the pixel value.";
      return;
    }
    const at = screenToFits(geo, state.point.x, state.point.y);
    if (!insideImage(at.x, at.y, image.width, image.height)) {
      el.pointer.textContent = "Pointer: outside image data";
      return;
    }
    const column = Math.min(image.width - 1, Math.floor(at.x - 0.5));
    const row = Math.min(image.height - 1, Math.floor(at.y - 0.5));
    const value = image.values[row * image.width + column];
    const sky = image.wcs ? image.wcs.pixelToSky(column + 1, row + 1) : null;
    el.pointer.textContent = "Pointer: pixel " + (column + 1) + ", " + (row + 1) + (sky ? " · RA " + sky.ra.toFixed(5) + "°, Dec " + sky.dec.toFixed(5) + "°" : "") + " · " + withUnit(formatValue(value), image.unit);
  }

  // ---- Pointer, wheel and keyboard -----------------------------------------------------------------------------------
  function zoomBy(factor, sx, sy) {
    const image = state.image;
    if (!image || !state.picture) return;
    Pair.zoomViewAt(state.view, factor, image.width, image.height, state.size, state.size, sx, sy);
    invalidate();
  }

  function panBy(dx, dy) {
    const image = state.image;
    if (!image || !state.picture) return;
    Pair.panViewByScreen(state.view, dx, dy, image.width, image.height, state.size, state.size);
    invalidate();
  }

  function pickAt(point) {
    const result = state.result;
    if (!result || state.stale || !displayControls.markers.checked) {
      announce(result ? "Candidate markers are hidden or out of date, so nothing was selected." : "There are no candidates yet.");
      return;
    }
    const geo = geometry();
    const reach = state.pointerType === "mouse" ? 14 : 22;
    let best = null;
    let bestDistance = reach;
    for (const source of result.sources) {
      const at = fitsToScreen(geo, source.x, source.y);
      const distance = Math.hypot(at.x - point.x, at.y - point.y);
      if (distance <= bestDistance) {
        best = source;
        bestDistance = distance;
      }
    }
    if (best) select(best.number, { scrollRow: true });
    else announce("No candidate near that point.");
  }

  function attachViewportEvents() {
    const viewport = el.viewport;
    const local = (event) => {
      const rect = viewport.getBoundingClientRect();
      return { x: event.clientX - rect.left - viewport.clientLeft, y: event.clientY - rect.top - viewport.clientTop };
    };
    const pinchState = () => {
      const [a, b] = [...state.touches.values()];
      return { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    };

    viewport.addEventListener("pointerdown", (event) => {
      if (!state.picture || (event.pointerType === "mouse" && event.button !== 0)) return;
      const point = local(event);
      state.pointerType = event.pointerType;
      state.touches.set(event.pointerId, point);
      viewport.setPointerCapture(event.pointerId);
      viewport.toggleAttribute("data-dragging", true);
      state.down = state.touches.size === 1 ? { x: point.x, y: point.y, moved: false } : null;
      if (state.touches.size === 2) state.pinch = pinchState();
      if (event.pointerType !== "mouse") state.point = point;
      viewport.focus({ preventScroll: true });
      invalidate();
    });

    viewport.addEventListener("pointermove", (event) => {
      if (!state.picture) return;
      const point = local(event);
      if (state.touches.has(event.pointerId)) {
        if (state.down && Math.hypot(point.x - state.down.x, point.y - state.down.y) > tapDistance) state.down.moved = true;
        if (state.touches.size === 1) {
          const previous = state.touches.get(event.pointerId);
          // A finger on the fully visible image scrolls the page (touch-action: pan-y), so it must not also move the view.
          if (event.pointerType !== "touch" || state.view.zoom > 1.001) panBy(point.x - previous.x, point.y - previous.y);
          state.touches.set(event.pointerId, point);
        } else if (state.touches.size === 2 && state.pinch) {
          state.touches.set(event.pointerId, point);
          const next = pinchState();
          panBy(next.x - state.pinch.x, next.y - state.pinch.y);
          if (state.pinch.distance > 0 && next.distance > 0) zoomBy(next.distance / state.pinch.distance, next.x, next.y);
          state.pinch = next;
          state.down = null;
        }
      }
      state.point = point;
      invalidate();
    });

    const end = (event) => {
      const wasTap = event.type === "pointerup" && state.down && !state.down.moved && state.touches.size === 1;
      const point = state.touches.get(event.pointerId);
      state.touches.delete(event.pointerId);
      state.pinch = state.touches.size === 2 ? pinchState() : null;
      if (state.touches.size === 0) viewport.removeAttribute("data-dragging");
      if (wasTap && point) pickAt(point);
      if (state.touches.size === 0) state.down = null;
      if (event.type === "pointercancel" || event.pointerType !== "mouse") state.point = null;
      invalidate();
    };
    viewport.addEventListener("pointerup", end);
    viewport.addEventListener("pointercancel", end);
    viewport.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "mouse" && !state.touches.has(event.pointerId)) {
        state.point = null;
        invalidate();
      }
    });

    viewport.addEventListener("wheel", (event) => {
      if (!state.picture || !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const point = local(event);
      zoomBy(Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0025)), point.x, point.y);
    }, { passive: false });

    viewport.addEventListener("keydown", (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey || !state.picture) return;
      const pan = 40;
      const moves = { ArrowLeft: [pan, 0], ArrowRight: [-pan, 0], ArrowUp: [0, pan], ArrowDown: [0, -pan] };
      if (moves[event.key]) {
        if (state.view.zoom <= 1.001) return;
        event.preventDefault();
        panBy(...moves[event.key]);
        return;
      }
      const actions = {
        "+": () => zoomBy(zoomStep), "=": () => zoomBy(zoomStep), "-": () => zoomBy(1 / zoomStep), "_": () => zoomBy(1 / zoomStep),
        "0": () => { fitView(); invalidate(); }, Home: () => { fitView(); invalidate(); },
        n: () => selectNeighbour(1), N: () => selectNeighbour(1), "]": () => selectNeighbour(1),
        p: () => selectNeighbour(-1), P: () => selectNeighbour(-1), "[": () => selectNeighbour(-1),
        Enter: () => {
          const source = sourceByNumber(state.selected);
          if (!source) { announce("No candidate is selected. Press N to select the first one."); return; }
          state.view.centerX = source.x;
          state.view.centerY = source.y;
          invalidate();
          announce("Centered on " + source.id + ".");
        },
        Escape: clearSelection,
      };
      const action = actions[event.key];
      if (!action) return; // Tab and other keys keep their normal behavior, so focus can leave the view.
      event.preventDefault();
      action();
    });
  }

  // ---- Rendering the page --------------------------------------------------------------------------------------------
  function renderControls() {
    const has = Boolean(state.picture);
    for (const button of [el.fit, el.zoomIn, el.zoomOut]) button.setAttribute("aria-disabled", String(!has));
    renderSettings();
    renderExport();
  }

  function refresh() {
    renderFacts();
    renderControls();
    renderResult();
    renderStale();
    renderTable();
    renderDetail();
    invalidate();
  }

  // ---- Wiring --------------------------------------------------------------------------------------------------------
  function wire() {
    el.file.addEventListener("change", () => {
      const file = el.file.files[0];
      el.file.value = ""; // So choosing the same file again fires another change.
      if (file) openFile(file, file.name);
    });
    el.example.addEventListener("click", async () => {
      setStatus("Loading the example…");
      try {
        const file = await loadExample();
        await openFile(file, file.name, true);
      } catch (error) {
        setStatus(error.message, true);
      }
    });
    el.hdu.addEventListener("change", () => {
      if (!state.file) return;
      state.hduIndex = Number(el.hdu.value);
      showHdu(state.version);
    });

    const press = (button, action) => button.addEventListener("click", () => {
      if (button.getAttribute("aria-disabled") === "true") return;
      action();
    });
    press(el.fit, () => { fitView(); invalidate(); announce("Whole image fitted."); });
    press(el.zoomIn, () => zoomBy(zoomStep));
    press(el.zoomOut, () => zoomBy(1 / zoomStep));
    press(el.downloadCsv, downloadCsv);
    press(el.downloadJson, downloadJson);

    el.form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (el.run.getAttribute("aria-disabled") === "true") {
        setRunStatus(state.loading ? "The image is still being read." : "Load an image first.", true);
        return;
      }
      runDetection();
    });
    for (const input of Object.values(params)) {
      input.addEventListener("input", markStale);
      input.addEventListener("change", () => {
        renderSettings();
        if (state.image && !state.loading) {
          markStale();
          runSoon();
        }
      });
    }
    displayControls.range.addEventListener("change", () => { buildPicture(); invalidate(); });
    displayControls.stretch.addEventListener("change", () => { buildPicture(); invalidate(); });
    displayControls.markers.addEventListener("change", invalidate);
    displayControls.segments.addEventListener("change", invalidate);
    el.sort.addEventListener("change", () => {
      state.sort = el.sort.value;
      state.order = orderedNumbers();
      renderTable();
      announce("Candidates sorted.");
    });
    el.body.addEventListener("click", (event) => {
      const row = event.target.closest("tr[data-number]");
      if (row) select(Number(row.dataset.number), { reveal: true });
    });
    new ResizeObserver(() => invalidate()).observe(el.viewport);
    attachViewportEvents();

    el.file.disabled = false;
    el.example.disabled = false;
  }

  wire();
  refresh();
})();
