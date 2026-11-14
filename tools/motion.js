// Motion Detector: moving-object candidates from several observations of one field. This file is the user interface only.
// FITS structure and calibrated pixels come from tools/fits.js (shared with FITS Viewer and Image Differencing), sky and pixel
// geometry from tools/wcs.js, observation time and view geometry from tools/pair.js, the signed difference from
// tools/difference.js, and the detection, pairing, positions, rates and CSV from tools/motion-model.js.
//
// Display never feeds back into a measurement: the gray range, the diverging color limit, zoom and pan only decide how
// pictures are painted from arrays. Every readout reads the arrays, not the pictures. Results are CANDIDATES; nothing here
// confirms a moving object.
(function () {
  "use strict";

  const Wcs = AstroNotWcs;
  const Pair = AstroNotPair;
  const Diff = AstroNotDifference;

  // Optional Rust/WebAssembly accelerator for the reprojection loop (rust/crates/reproject). It is installed when it has
  // loaded; until then, and whenever it cannot load (no WebAssembly, no SIMD, file missing), the JavaScript loop runs.
  // <html data-reproject="wasm|js"> tells which one is installed; AstroNotDifference.kernelStatus() counts the calls.
  if (typeof AstroNotWasm === "object") {
    AstroNotWasm.load("reproject").then((kernel) => {
      document.documentElement.dataset.reproject = AstroNotDifference.useKernel(kernel) ? "wasm" : "js";
    });
  }
  const Motion = AstroNotMotion;
  const { createWcs, screenToFits, fitsToScreen, insideImage } = Wcs;

  const minus = "−";
  const maxEpochs = 10;
  const zoomStep = 2;
  const tapDistance = 5;
  const kinds = ["reference", "epoch", "difference"];
  const reviewLabel = { candidate: "Candidate", keep: "Kept for review", dismissed: "Dismissed" };

  const query = (name, scope = document) => scope.querySelector("[data-mo-" + name + "]");

  const el = {
    files: query("files"), filesLabel: query("files-label"), example: query("example"), clear: query("clear"), status: query("status"),
    epochsWrap: query("epochs-wrap"), epochs: query("epochs"),
    mode: query("mode"), threshold: query("threshold"), thresholdLabel: query("threshold-label"), min: query("min"), max: query("max"),
    alignment: query("alignment"), assumeWrap: query("assume-wrap"), assume: query("assume"), settingsNote: query("settings-note"),
    verdict: query("verdict"), notes: query("notes"), summary: query("summary"),
    newCandidate: query("new"), candidatesNote: query("candidates-note"), candidatesWrap: query("candidates-wrap"), candidates: query("candidates"),
    detail: query("detail"), detailTitle: query("detail-title"), detailOrigin: query("detail-origin"), detailNotes: query("detail-notes"),
    positions: query("positions"), track: query("track"), plot: query("plot"), plotCaption: query("plot-caption"),
    epochSelect: query("epoch"), clip: query("clip"), limit: query("limit"), refine: query("refine"), fit: query("fit"),
    panels: query("panels"), legend: query("legend"), legendBar: query("legend-bar"), legendLow: query("legend-low"), legendHigh: query("legend-high"), legendText: query("legend-text"),
    readout: query("readout"), live: query("live"), download: query("download"), exportStatus: query("export-status"),
  };

  // ---- State ---------------------------------------------------------------------------------------------------------
  let idCounter = 0;
  let manualCounter = 0;
  const state = {
    items: [], referenceId: null,
    settings: { mode: "local-mad", threshold: "5", min: "2.5", max: "15", alignment: "reproject", assume: false },
    series: null, analysisError: "", analysisToken: 0, analysisTimer: 0, resetNote: "",
    candidates: [], selectedId: null, shownId: null, cursor: null,
    clip: "1-99", limit: "99",
    pictures: { reference: null, epoch: null, difference: null }, ranges: { gray: null, limit: null, limitNote: "" },
    view: { zoom: 1, centerX: 1, centerY: 1 },
  };
  let panels = {};
  let hatch = null;

  // ---- Small helpers -------------------------------------------------------------------------------------------------
  function significant(value, digits = 5) {
    return Number(value.toPrecision(digits)).toString().replace("-", minus);
  }

  function fixed(value, digits) {
    return value.toFixed(digits).replace("-", minus);
  }

  function degrees(value, digits = 5) {
    return fixed(value, digits) + "°";
  }

  function arcsecText(value, digits = 3) {
    return fixed(value, digits) + "″";
  }

  function timeText(time) {
    if (!time || !time.valid) return "Observation time unavailable";
    return time.display + " " + time.scale + (time.manual ? " (entered manually)" : "");
  }

  function setStatus(message, error = false) {
    el.status.toggleAttribute("data-error", error);
    el.status.textContent = message;
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

  function node(tag, text, className) {
    const created = document.createElement(tag);
    if (text !== undefined && text !== null) created.textContent = text;
    if (className) created.className = className;
    return created;
  }

  function cell(tag, content, className) {
    const created = document.createElement(tag);
    if (className) created.className = className;
    if (content instanceof Node) created.append(content);
    else if (content !== undefined && content !== null) created.textContent = content;
    return created;
  }

  function addItem(list, text, className) {
    const item = document.createElement("li");
    if (className) item.className = className;
    item.textContent = text;
    list.append(item);
  }

  function setFact(root, name, text, attribute = "data-mo-fact") {
    const target = root.querySelector("[" + attribute + '="' + name + '"]');
    if (target && target.textContent !== text) target.textContent = text;
  }

  function parseNumber(text) {
    const clean = String(text).trim().replace(minus, "-");
    if (!clean) return NaN;
    const value = Number(clean);
    return Number.isFinite(value) ? value : NaN;
  }

  // ---- Loading files -------------------------------------------------------------------------------------------------
  function newItem(name, isExample) {
    return { id: "E" + ++idCounter, name, isExample, file: null, hdus: null, choices: [], hduIndex: -1, version: 0, hduVersion: 0, loading: true, error: "", message: "Reading FITS headers…", epoch: null, manualTime: "", manualError: "" };
  }

  function whyNotDisplayable(hdu) {
    if (!hdu.image) return "it is not an uncompressed two-dimensional image (" + hdu.axes.length + " axes)";
    if (hdu.bitpix === 64) return "64-bit integer images are not supported";
    return "it exceeds the limit of " + fitsMaxPixels.toLocaleString("en-US") + " pixels or 4,096 pixels per axis";
  }

  async function readWaveSummary(file, hdus, hdu) {
    const name = String(hdu.fields.PS1_0W ?? "WCS-WAVE").trim();
    const table = hdus.find((entry) => entry.fields.XTENSION === "BINTABLE" && entry.fields.EXTNAME === name);
    if (!table || table.byteLength > 1 << 20) return null;
    const bytes = await file.slice(table.dataStart, table.dataStart + table.byteLength).arrayBuffer();
    const parsed = Pair.parseWaveTable(bytes, table.fields, hdu.fields);
    return parsed ? Pair.wavelengthSummary(parsed, hdu.fields, hdu.axes[0], hdu.axes[1]) : null;
  }

  async function readValues(file, hdu) {
    const bytes = await file.slice(hdu.dataStart, hdu.dataStart + hdu.byteLength).arrayBuffer();
    const read = fitsPixelReader(bytes, hdu); // BSCALE and BZERO are applied here, once; BLANK becomes NaN.
    const values = new Float64Array(hdu.pixels);
    for (let index = 0; index < values.length; index++) values[index] = read(index);
    return values;
  }

  // A VARIANCE image of the same size, if the file has one. Only an image named VARIANCE counts.
  async function readVariance(item, hdu) {
    const index = item.hdus.findIndex((entry) => entry !== hdu && String(entry.fields.EXTNAME ?? "").trim().toUpperCase() === "VARIANCE");
    if (index < 0) return { values: null, unit: undefined, note: "No VARIANCE image in this file" };
    const candidate = item.hdus[index];
    if (!candidate.renderable || candidate.axes[0] !== hdu.axes[0] || candidate.axes[1] !== hdu.axes[1]) {
      return { values: null, unit: undefined, note: "VARIANCE image (HDU " + index + ") ignored: it cannot be read or its size differs from the image" };
    }
    const values = await readValues(item.file, candidate);
    const unit = typeof candidate.fields.BUNIT === "string" ? candidate.fields.BUNIT.trim() : undefined;
    return { values, unit, note: "VARIANCE image in HDU " + index + (unit ? ", unit " + unit : ", no BUNIT") };
  }

  async function readEpoch(item, version, token) {
    const hdu = item.hdus[item.hduIndex];
    const values = await readValues(item.file, hdu);
    if (version !== item.version || token !== item.hduVersion) return null;
    const wavelength = await readWaveSummary(item.file, item.hdus, hdu);
    const variance = await readVariance(item, hdu);
    if (version !== item.version || token !== item.hduVersion) return null;
    const epoch = Motion.buildEpoch(hdu, item.hduIndex, values, { id: item.id, name: item.name, wavelength, variance: variance.values, varianceUnit: variance.unit });
    epoch.varianceNote = variance.note;
    if (!epoch.meta.time.valid && item.manualTime) Motion.withManualTime(epoch, item.manualTime);
    return epoch;
  }

  async function showHdu(item, version) {
    const token = ++item.hduVersion;
    item.epoch = null;
    item.loading = true;
    item.error = "";
    item.message = "Reading image pixels…";
    refresh();
    try {
      const epoch = await readEpoch(item, version, token);
      if (!epoch || !state.items.includes(item)) return;
      item.epoch = epoch;
      item.loading = false;
      item.message = (epoch.wcs ? "" : "No usable sky coordinates: " + epoch.wcsReason);
    } catch (error) {
      if (version !== item.version || token !== item.hduVersion) return;
      item.loading = false;
      item.epoch = null;
      item.error = item.name + " could not be read. " + error.message;
      item.message = "";
    }
    afterItemChange(item);
  }

  async function openItem(item, source) {
    const version = ++item.version;
    try {
      const file = await source;
      if (version !== item.version) return;
      const hdus = await readFitsHdus(file);
      if (version !== item.version) return;
      const choices = hdus.map((hdu, index) => ({ hdu, index })).filter(({ hdu }) => hdu.renderable);
      if (!choices.length) {
        const reasons = hdus.map((hdu, index) => "HDU " + index + " (" + hdu.name + "): " + whyNotDisplayable(hdu));
        throw new Error("This file has no image HDU that Motion Detector can read. " + reasons.join("; ") + ".");
      }
      const preferred = choices.find(({ hdu }) => hdu.fields.EXTNAME === "IMAGE") ?? choices[0];
      Object.assign(item, { file, hdus, choices, hduIndex: preferred.index });
      await showHdu(item, version);
    } catch (error) {
      if (version !== item.version || !state.items.includes(item)) return;
      Object.assign(item, { file: null, hdus: null, choices: [], hduIndex: -1, epoch: null, loading: false, error: item.name + " could not be opened. " + error.message, message: "" });
      afterItemChange(item);
    }
  }

  function afterItemChange(item) {
    scheduleAnalysis();
    announce(item.error ? item.error : item.name + " loaded" + (item.message ? ". " + item.message : "."));
  }

  function addFiles(files, examples = false) {
    const room = maxEpochs - state.items.length;
    const accepted = files.slice(0, Math.max(0, room));
    if (files.length > accepted.length) setStatus("Motion Detector holds at most " + maxEpochs + " observations. " + (files.length - accepted.length) + " file(s) were not added.", true);
    else setStatus("");
    for (const entry of accepted) {
      const item = newItem(entry.name, examples);
      state.items.push(item);
      openItem(item, entry.file);
    }
    scheduleAnalysis();
  }

  let exampleLoad;
  function loadExample() {
    if (!exampleLoad) {
      exampleLoad = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = siteAsset("assets/tools/spherex-time-machine-example.js");
        script.addEventListener("load", () => {
          const decode = (text) => Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
          resolve([
            { name: "SPHEREx-QR2-2025W21_2C_0280_1-D2.fits", file: new File([decode(spherexTimeMachineExample.reference)], "SPHEREx-QR2-2025W21_2C_0280_1-D2.fits") },
            { name: "SPHEREx-QR2-2025W24_1A_0514_1-D2.fits", file: new File([decode(spherexTimeMachineExample.comparison)], "SPHEREx-QR2-2025W24_1A_0514_1-D2.fits") },
          ]);
        }, { once: true });
        script.addEventListener("error", () => reject(new Error("The example files could not be loaded.")), { once: true });
        document.head.append(script);
      }).catch((error) => {
        exampleLoad = undefined;
        throw error;
      });
    }
    return exampleLoad;
  }

  function removeItem(item) {
    item.version++;
    item.hduVersion++;
    state.items = state.items.filter((entry) => entry !== item);
    if (state.referenceId === item.id) state.referenceId = null;
    announce(item.name + " removed.");
    scheduleAnalysis();
  }

  // ---- Analysis ------------------------------------------------------------------------------------------------------
  function readSettings() {
    const settings = state.settings;
    const threshold = parseNumber(settings.threshold);
    const min = parseNumber(settings.min);
    const max = parseNumber(settings.max);
    if (!(threshold > 0)) return { error: "The threshold must be a number greater than zero." };
    if (!(min >= 0.5)) return { error: "The minimum separation must be a number of at least 0.5 pixel." };
    if (!(max > min)) return { error: "The search radius must be larger than the minimum separation." };
    return { options: { mode: settings.mode, threshold, minSeparationPixels: min, maxSeparationPixels: max, alignment: settings.alignment, assumeSameUnit: settings.assume } };
  }

  // Any change of input clears the old result at once, so it can never be read as belonging to the new input.
  function scheduleAnalysis() {
    clearTimeout(state.analysisTimer);
    state.analysisToken++;
    const previous = state.series;
    state.series = null;
    state.analysisError = "";
    window.AstroNotLatestMotion = null;
    state.keepManual = previous ? { referenceId: previous.referenceId, ids: previous.entries.map((entry) => entry.id).join(",") + "|" + previous.settings.alignment } : state.keepManual ?? null;
    const reviewed = state.candidates.filter((candidate) => candidate.origin === "detected" && (candidate.status !== "candidate" || Object.keys(candidate.positions).some((id) => {
      const first = candidate.detected[id];
      return !first || first.x !== candidate.positions[id].x || first.y !== candidate.positions[id].y;
    })));
    state.resetNote = reviewed.length ? reviewed.length + " detected candidate(s) with a review choice or a corrected position were replaced because the input or the detection settings changed." : "";
    state.candidates = state.candidates.filter((candidate) => candidate.origin === "manual");
    state.pictures = { reference: null, epoch: null, difference: null };
    refresh();
    state.analysisTimer = setTimeout(runAnalysis, 20);
  }

  function runAnalysis() {
    const token = state.analysisToken;
    if (state.items.some((item) => item.loading)) return; // The last file to finish starts the analysis.
    const epochs = state.items.filter((item) => item.epoch).map((item) => item.epoch);
    if (epochs.length < 2) {
      state.series = null;
      state.candidates = [];
      state.selectedId = null;
      refresh();
      return;
    }
    const parsed = readSettings();
    if (parsed.error) {
      state.analysisError = parsed.error;
      refresh();
      return;
    }
    const series = Motion.analyzeSeries(epochs, Object.assign({ referenceId: state.referenceId ?? undefined }, parsed.options));
    if (token !== state.analysisToken) return;
    if (!series.ok) {
      state.analysisError = series.reason;
      state.candidates = [];
      refresh();
      return;
    }
    const sameInput = state.keepManual && state.keepManual.referenceId === series.referenceId && state.keepManual.ids === series.entries.map((entry) => entry.id).join(",") + "|" + series.settings.alignment;
    const manual = sameInput ? state.candidates.filter((candidate) => candidate.origin === "manual") : [];
    if (!sameInput && state.candidates.some((candidate) => candidate.origin === "manual")) {
      state.resetNote = (state.resetNote ? state.resetNote + " " : "") + "Candidates marked by hand were removed because the reference or the set of observations changed.";
    }
    state.series = series;
    state.candidates = series.candidates.concat(manual);
    window.AstroNotLatestMotion = series;
    if (!state.candidates.some((candidate) => candidate.id === state.selectedId)) state.selectedId = state.candidates.length ? state.candidates[0].id : null;
    const shown = shownEntries();
    if (!shown.some((entry) => entry.id === state.shownId)) state.shownId = shown.length ? shown[0].id : null;
    if (state.selectedId) showSelectedEpoch();
    fitView();
    buildPictures();
    refresh();
    announce(state.candidates.length ? state.candidates.length + " candidate(s) found." : "Search finished. No candidate was found.");
  }

  function selectedCandidate() {
    return state.candidates.find((candidate) => candidate.id === state.selectedId) ?? null;
  }

  function entryOf(id) {
    return state.series ? state.series.entries.find((entry) => entry.id === id) ?? null : null;
  }

  // Epochs that have a difference image with the reference, in time order.
  function shownEntries() {
    if (!state.series) return [];
    const list = state.series.entries.filter((entry) => !entry.isReference && entry.included && entry.diff);
    return list.sort((a, b) => timeKey(a.epoch) - timeKey(b.epoch));
  }

  function timeKey(epoch) {
    const time = Motion.epochTime(epoch);
    return time ? time.mjd : Infinity;
  }

  function referenceEntry() {
    return state.series ? state.series.entries.find((entry) => entry.isReference) : null;
  }

  function evaluate(candidate) {
    return Motion.evaluateCandidate(state.series, candidate);
  }

  // The epoch shown next to the reference follows the selected candidate: its latest epoch that has a difference image.
  function showSelectedEpoch() {
    const candidate = selectedCandidate();
    if (!candidate || !state.series) return;
    const options = shownEntries();
    const have = options.filter((entry) => candidate.positions[entry.id]);
    if (have.length && !have.some((entry) => entry.id === state.shownId)) state.shownId = have[have.length - 1].id;
  }

  // ---- Pictures (display only) ---------------------------------------------------------------------------------------
  function clipFractions() {
    const [low, high] = state.clip.split("-").map(Number);
    return [low / 100, high / 100];
  }

  function shownDiff() {
    const entry = entryOf(state.shownId);
    return entry && entry.diff ? entry.diff : null;
  }

  function paintGray(canvas, values, valid, range, width, height) {
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    const picture = context.createImageData(width, height);
    const span = range ? range.high - range.low : 0;
    for (let y = 0; y < height; y++) {
      const sourceRow = (height - y - 1) * width; // FITS axis 2 starts at the bottom of the picture.
      for (let x = 0; x < width; x++) {
        const index = sourceRow + x;
        const at = (y * width + x) * 4;
        if (!valid[index] || !range) continue;
        const shade = span > 0 ? Math.max(0, Math.min(255, 255 * (values[index] - range.low) / span)) : 128;
        picture.data[at] = picture.data[at + 1] = picture.data[at + 2] = shade;
        picture.data[at + 3] = 255;
      }
    }
    context.putImageData(picture, 0, 0);
  }

  const colorTable = Array.from({ length: 513 }, (_, index) => Diff.divergingColor((index - 256) / 256));

  function paintDiverging(canvas, difference, valid, limit, width, height) {
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    const picture = context.createImageData(width, height);
    for (let y = 0; y < height; y++) {
      const sourceRow = (height - y - 1) * width;
      for (let x = 0; x < width; x++) {
        const index = sourceRow + x;
        if (!valid[index]) continue;
        const t = Math.max(-1, Math.min(1, difference[index] / limit));
        const color = colorTable[Math.round(t * 256) + 256];
        const at = (y * width + x) * 4;
        picture.data[at] = color[0];
        picture.data[at + 1] = color[1];
        picture.data[at + 2] = color[2];
        picture.data[at + 3] = 255;
      }
    }
    context.putImageData(picture, 0, 0);
  }

  function buildPictures() {
    state.pictures = { reference: null, epoch: null, difference: null };
    state.ranges = { gray: null, limit: null, limitNote: "" };
    const diff = shownDiff();
    if (!diff) return;
    const make = () => document.createElement("canvas");
    state.ranges.gray = Pair.displayRange([diff.reference.values, diff.target.values], ...clipFractions());
    state.pictures.reference = make();
    state.pictures.epoch = make();
    paintGray(state.pictures.reference, diff.reference.values, diff.reference.valid, state.ranges.gray, diff.width, diff.height);
    paintGray(state.pictures.epoch, diff.target.values, diff.target.valid, state.ranges.gray, diff.width, diff.height);
    if (diff.empty) return;
    const percentile = Number(state.limit);
    let limit = Diff.symmetricLimit(diff.difference, diff.valid, percentile);
    let note = percentile === 100 ? "maximum |Δ|" : percentile + "th percentile of |Δ|";
    if (limit === 0) {
      limit = 1;
      note += "; every valid Δ is zero, so ±1 is shown";
    }
    state.ranges.limit = limit;
    state.ranges.limitNote = note;
    state.pictures.difference = make();
    paintDiverging(state.pictures.difference, diff.difference, diff.valid, limit, diff.width, diff.height);
  }

  // ---- Panels --------------------------------------------------------------------------------------------------------
  const kindLabel = { reference: "Reference", epoch: "Epoch shown", difference: "Difference Δ = epoch − reference" };

  function buildPanels() {
    const template = document.querySelector("[data-mo-panel-template]");
    for (const kind of kinds) {
      const root = template.content.firstElementChild.cloneNode(true);
      const panel = {
        kind, root,
        viewport: query("viewport", root), canvas: query("canvas", root), empty: query("empty", root),
        title: query("panel-title", root), roleLabel: query("panel-role", root),
        range: query("range", root), zoom: query("zoom", root), pointer: query("pointer", root),
        size: { width: 1, height: 1, ratio: window.devicePixelRatio || 1 },
        point: null, frame: 0, touches: new Map(), pinch: null, down: null,
      };
      panel.ctx = panel.canvas.getContext("2d");
      panel.roleLabel.textContent = kindLabel[kind];
      new ResizeObserver(() => invalidate(panel)).observe(panel.viewport);
      attachPanelEvents(panel);
      panels[kind] = panel;
      el.panels.append(root);
    }
  }

  function invalidate(panel) {
    if (panel) {
      if (!panel.frame) panel.frame = requestAnimationFrame(() => renderPanel(panel));
    } else {
      for (const each of Object.values(panels)) invalidate(each);
    }
  }

  function resizePanel(panel) {
    const width = panel.viewport.clientWidth;
    const height = panel.viewport.clientHeight;
    const ratio = window.devicePixelRatio || 1;
    if (width === panel.size.width && height === panel.size.height && ratio === panel.size.ratio && panel.canvas.width) return;
    panel.size.width = Math.max(1, width);
    panel.size.height = Math.max(1, height);
    panel.size.ratio = ratio;
    panel.canvas.width = Math.max(1, Math.round(panel.size.width * ratio));
    panel.canvas.height = Math.max(1, Math.round(panel.size.height * ratio));
  }

  function fitSize() {
    const measured = Object.values(panels).map((panel) => ({ width: Math.max(1, panel.viewport.clientWidth), height: Math.max(1, panel.viewport.clientHeight) }));
    return { width: Math.min(...measured.map((size) => size.width)), height: Math.min(...measured.map((size) => size.height)) };
  }

  function grid() {
    return state.series ? { width: state.series.reference.width, height: state.series.reference.height } : null;
  }

  function geometry(panel) {
    const g = grid();
    return Pair.viewGeometry(state.view, g.width, g.height, panel.size, fitSize());
  }

  function hatchPattern(ctx) {
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

  function emptyMessage() {
    if (state.items.some((item) => item.loading)) return "Reading the files…";
    if (state.items.filter((item) => item.epoch).length < 2) return "Load two or more observations of one field to see them here.";
    if (state.analysisError) return "No search was run. The reason is given under Search result.";
    if (!state.series) return "Searching…";
    if (!shownDiff()) return "No epoch could be subtracted from the reference. The reasons are listed under Observations.";
    return "Nothing to show.";
  }

  function outlinedText(ctx, text, x, y, color) {
    text = window.AstroNotLanguage?.translate(text) ?? text;
    ctx.font = "600 12px Inter, system-ui, sans-serif";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  // shape: "ring" (reference position) or "square" (position in the epoch shown). Shapes differ so color is not the only cue.
  function drawMarker(ctx, geo, position, shape, color, label, faint = false, below = false) {
    const at = fitsToScreen(geo, position.x, position.y);
    const radius = faint ? 6 : 10;
    ctx.save();
    ctx.setLineDash(faint ? [3, 3] : []);
    for (const [stroke, width] of [["rgba(0,0,0,0.85)", faint ? 3 : 4], [color, faint ? 1 : 2]]) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.beginPath();
      if (shape === "ring") ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
      else ctx.rect(at.x - radius, at.y - radius, radius * 2, radius * 2);
      ctx.stroke();
    }
    ctx.restore();
    if (label) outlinedText(ctx, label, at.x + radius + 4, below ? at.y + radius + 12 : at.y - radius - 2, color);
  }

  function drawOverlays(ctx, geo, panel) {
    const diff = shownDiff();
    const reference = state.series.reference;
    const selected = selectedCandidate();
    const refId = reference.id;
    const mark = (candidate, id) => candidate.positions[id];
    if (panel.kind === "difference") {
      for (const candidate of state.candidates) {
        if (candidate === selected || candidate.status === "dismissed") continue;
        if (mark(candidate, refId)) drawMarker(ctx, geo, mark(candidate, refId), "ring", "#9aa3b2", candidate.id, true);
        if (mark(candidate, state.shownId)) drawMarker(ctx, geo, mark(candidate, state.shownId), "square", "#9aa3b2", "", true);
      }
    }
    if (selected) {
      const a = mark(selected, refId);
      const b = mark(selected, state.shownId);
      if (panel.kind === "difference" && a && b) {
        const from = fitsToScreen(geo, a.x, a.y);
        const to = fitsToScreen(geo, b.x, b.y);
        ctx.save();
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = "#f2f4f8";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
        ctx.restore();
      }
      if (a && panel.kind !== "epoch") drawMarker(ctx, geo, a, "ring", "#8fd3ff", selected.id + " reference");
      if (a && panel.kind === "epoch") drawMarker(ctx, geo, a, "ring", "#8fd3ff", "", true);
      if (b && panel.kind !== "reference") drawMarker(ctx, geo, b, "square", "#ffd24a", selected.id + " epoch", false, panel.kind === "difference");
    }
    const cursor = state.cursor;
    if (cursor && diff) {
      const centre = fitsToScreen(geo, cursor.column + 1, cursor.row + 1);
      const half = geo.scale / 2;
      for (const [color, width] of [["rgba(0,0,0,0.85)", 4], ["#ffffff", 1.5]]) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        if (geo.scale >= 10) ctx.rect(centre.x - half, centre.y - half, geo.scale, geo.scale);
        else {
          ctx.moveTo(centre.x - 12, centre.y);
          ctx.lineTo(centre.x - 5, centre.y);
          ctx.moveTo(centre.x + 5, centre.y);
          ctx.lineTo(centre.x + 12, centre.y);
          ctx.moveTo(centre.x, centre.y - 12);
          ctx.lineTo(centre.x, centre.y - 5);
          ctx.moveTo(centre.x, centre.y + 5);
          ctx.lineTo(centre.x, centre.y + 12);
        }
        ctx.stroke();
      }
    }
  }

  function renderPanel(panel) {
    panel.frame = 0;
    const diff = shownDiff();
    const picture = state.pictures[panel.kind];
    if (!diff || !picture) {
      panel.canvas.hidden = true;
      panel.empty.hidden = false;
      panel.empty.querySelector("p").textContent = diff && diff.empty ? diff.emptyReason : emptyMessage();
      panel.viewport.removeAttribute("data-loaded");
      panel.viewport.removeAttribute("data-pannable");
      for (const line of [panel.title, panel.range, panel.zoom, panel.pointer]) line.textContent = "";
      panel.viewport.setAttribute("aria-label", kindLabel[panel.kind] + " view, no image");
      return;
    }
    panel.empty.hidden = true;
    panel.canvas.hidden = false;
    panel.viewport.toggleAttribute("data-loaded", true);
    resizePanel(panel);
    Pair.clampView(state.view, diff.width, diff.height, fitSize());
    const geo = geometry(panel);
    const ctx = panel.ctx;
    const ratio = panel.size.ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = "#060709";
    ctx.fillRect(0, 0, panel.size.width, panel.size.height);
    ctx.imageSmoothingEnabled = false;
    const origin = fitsToScreen(geo, 0.5, diff.height + 0.5);
    const extent = { x: origin.x, y: origin.y, width: diff.width * geo.scale, height: diff.height * geo.scale };
    ctx.fillStyle = hatchPattern(ctx);
    ctx.fillRect(extent.x, extent.y, extent.width, extent.height);
    ctx.drawImage(picture, extent.x, extent.y, extent.width, extent.height);
    ctx.strokeStyle = "#4a505a";
    ctx.lineWidth = 1;
    ctx.strokeRect(extent.x - 0.5, extent.y - 0.5, extent.width + 1, extent.height + 1);
    drawOverlays(ctx, geo, panel);

    const side = panel.kind === "reference" ? diff.reference : panel.kind === "epoch" ? diff.target : null;
    panel.title.textContent = side
      ? [side.obsId ?? "Observation ID unavailable", timeText(side.time)].join(" · ")
      : diff.mode === "pixel-difference" ? "Pixel difference" : "Reprojected difference";
    panel.canvas.setAttribute("aria-label", kindLabel[panel.kind] + (side ? ", observation " + (side.obsId ?? "ID unavailable") + ", " + timeText(side.time) : ", " + diff.counts.valid + " valid pixels") + ". Markers show the selected candidate.");
    panel.viewport.setAttribute("aria-label", kindLabel[panel.kind] + " view");
    panel.range.textContent = panel.kind === "difference"
      ? state.ranges.limit === null ? "Color scale unavailable" : "Color scale ±" + significant(state.ranges.limit) + (diff.unit ? " " + diff.unit : "") + " · zero is the neutral color · " + state.ranges.limitNote
      : state.ranges.gray ? "Display range " + significant(state.ranges.gray.low) + " to " + significant(state.ranges.gray.high) + (diff.unit ? " " + diff.unit : "") + " · shared by reference and epoch" : "Display range unavailable";
    const zoom = state.view.zoom;
    panel.zoom.textContent = "Zoom " + (zoom < 10 ? zoom.toFixed(1) : zoom.toFixed(0)) + "× (1× shows the whole image) · pan and zoom linked";
    panel.viewport.toggleAttribute("data-pannable", zoom > 1.001);
    updatePointerLine(panel, geo, diff);
  }

  function pixelText(kind, pixel, diff) {
    if (!pixel) return "Outside image data";
    const unit = diff.unit ? " " + diff.unit : "";
    if (kind === "reference") return diff.reference.valid[pixel.index] ? significant(diff.reference.values[pixel.index], 7) + unit : "NaN, BLANK or masked";
    if (kind === "epoch") {
      if (pixel.status === Diff.status.outside) return "Outside the area covered by the epoch";
      return diff.target.valid[pixel.index] ? significant(diff.target.values[pixel.index], 7) + unit : "NaN, BLANK or masked";
    }
    return pixel.valid ? (pixel.difference > 0 ? "+" : "") + significant(pixel.difference, 7) + unit : "Invalid · " + pixel.reason;
  }

  function pixelOfFits(diff, x, y) {
    if (!insideImage(x, y, diff.width, diff.height)) return null;
    return Diff.pixelAt(diff, Math.min(diff.width - 1, Math.floor(x - 0.5)), Math.min(diff.height - 1, Math.floor(y - 0.5)));
  }

  function updatePointerLine(panel, geo, diff) {
    if (!panel.point) {
      panel.pointer.textContent = "Pointer: move over the image to read the pixel value.";
      return;
    }
    const at = screenToFits(geo, panel.point.x, panel.point.y);
    const pixel = pixelOfFits(diff, at.x, at.y);
    const sky = pixel ? state.series.reference.wcs.pixelToSky(pixel.column + 1, pixel.row + 1) : null;
    panel.pointer.textContent = pixel
      ? "Pointer: pixel " + (pixel.column + 1) + ", " + (pixel.row + 1) + (sky ? " · RA " + degrees(sky.ra) + ", Dec " + degrees(sky.dec) : "") + " · " + pixelText(panel.kind, pixel, diff)
      : "Pointer: outside image data";
  }

  // ---- View changes --------------------------------------------------------------------------------------------------
  function fitView() {
    const g = grid();
    state.view = g ? Pair.createView(g.width, g.height) : { zoom: 1, centerX: 1, centerY: 1 };
  }

  function zoomBy(panel, factor, sx, sy) {
    const g = grid();
    if (!g) return;
    Pair.zoomViewAt(state.view, factor, g.width, g.height, panel.size, fitSize(), sx, sy);
    invalidate();
  }

  function panBy(panel, dx, dy) {
    const g = grid();
    if (!g) return;
    Pair.panViewByScreen(state.view, dx, dy, g.width, g.height, panel.size, fitSize());
    invalidate();
  }

  // ---- Cursor, marking ------------------------------------------------------------------------------------------------
  function setCursor(column, row, options = {}) {
    const g = grid();
    if (!g || !shownDiff()) return;
    column = Math.min(g.width - 1, Math.max(0, column));
    row = Math.min(g.height - 1, Math.max(0, row));
    state.cursor = { column, row };
    if (options.reveal) revealCursor();
    renderReadout();
    invalidate();
    announce(readoutText(), options.delay ?? 0);
  }

  function revealCursor() {
    const g = grid();
    const panel = panels.difference;
    if (!g || !state.cursor) return;
    const at = fitsToScreen(geometry(panel), state.cursor.column + 1, state.cursor.row + 1);
    const margin = Math.min(panel.size.width, panel.size.height) * 0.12;
    if (at.x < margin || at.y < margin || at.x > panel.size.width - margin || at.y > panel.size.height - margin) {
      state.view.centerX = state.cursor.column + 1;
      state.view.centerY = state.cursor.row + 1;
      Pair.clampView(state.view, g.width, g.height, fitSize());
    }
  }

  function readoutText() {
    const diff = shownDiff();
    const cursor = state.cursor;
    if (!diff || !cursor) return "Select a pixel to read the reference, epoch and Δ values.";
    const pixel = Diff.pixelAt(diff, cursor.column, cursor.row);
    const sky = state.series.reference.wcs.pixelToSky(cursor.column + 1, cursor.row + 1);
    return "Pixel " + (cursor.column + 1) + ", " + (cursor.row + 1) + (sky ? " (RA " + degrees(sky.ra, 6) + ", Dec " + degrees(sky.dec, 6) + ")" : "") +
      ". Reference " + pixelText("reference", pixel, diff) + ". Epoch " + pixelText("epoch", pixel, diff) + ". Δ " + pixelText("difference", pixel, diff) + ".";
  }

  function renderReadout() {
    el.readout.textContent = readoutText();
  }

  // The epoch whose position a click on this panel sets, or null.
  function markTarget(panel) {
    if (panel.kind === "reference") return state.series.referenceId;
    if (panel.kind === "epoch") return state.shownId;
    return null;
  }

  function markPosition(candidate, epochId, x, y, how) {
    const series = state.series;
    const g = grid();
    if (!series || !g || !insideImage(x, y, g.width, g.height)) {
      announce("That position is outside the image data, so nothing was marked.");
      return;
    }
    const entry = entryOf(epochId);
    let position = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, method: how === "key" ? "marked with the keyboard" : "marked by click", note: "" };
    if (el.refine.checked && entry && entry.image) {
      const refined = Motion.refineCentroid(entry.image, x, y);
      if (refined.refined) {
        position = { x: Math.round(refined.x * 100) / 100, y: Math.round(refined.y * 100) / 100, method: position.method + ", snapped to the centroid", note: "Centroid in the " + (entry.isReference ? "reference" : "epoch") + " image, background " + significant(refined.background, 4) };
      } else {
        position.note = "Not snapped: " + refined.reason;
      }
    }
    Motion.setPosition(candidate, epochId, position);
    const sky = series.reference.wcs.pixelToSky(position.x, position.y);
    refresh();
    announce(candidate.id + ": position in " + epochLabel(entry) + " set to pixel " + fixed(position.x, 2) + ", " + fixed(position.y, 2) + (sky ? " (RA " + degrees(sky.ra, 5) + ", Dec " + degrees(sky.dec, 5) + ")" : "") + ". " + (position.note ? position.note + "." : ""));
  }

  function epochLabel(entry) {
    if (!entry) return "the epoch";
    return entry.epoch.meta.obsId ?? entry.epoch.name;
  }

  function handleTap(panel, point) {
    const diff = shownDiff();
    if (!diff) return;
    const at = screenToFits(geometry(panel), point.x, point.y);
    if (!insideImage(at.x, at.y, diff.width, diff.height)) {
      announce("That point is outside the image data, so no pixel was selected.");
      return;
    }
    setCursor(Math.floor(at.x - 0.5), Math.floor(at.y - 0.5));
    const candidate = selectedCandidate();
    const target = markTarget(panel);
    if (candidate && target) markPosition(candidate, target, at.x, at.y, "click");
    else if (!candidate && target) announce("Pixel read. Select or create a candidate to mark its position.");
    else if (candidate) announce("Pixel read. To mark a position, click the Reference or the Epoch image.");
  }

  // ---- Pointer, wheel and keyboard -----------------------------------------------------------------------------------
  function attachPanelEvents(panel) {
    const viewport = panel.viewport;
    const local = (event) => {
      const rect = viewport.getBoundingClientRect();
      return { x: event.clientX - rect.left - viewport.clientLeft, y: event.clientY - rect.top - viewport.clientTop };
    };
    const pinchState = () => {
      const [a, b] = [...panel.touches.values()];
      return { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    };

    viewport.addEventListener("pointerdown", (event) => {
      if (!shownDiff() || (event.pointerType === "mouse" && event.button !== 0)) return;
      const point = local(event);
      panel.touches.set(event.pointerId, point);
      viewport.setPointerCapture(event.pointerId);
      viewport.toggleAttribute("data-dragging", true);
      panel.down = panel.touches.size === 1 ? { x: point.x, y: point.y, moved: false } : null;
      if (panel.touches.size === 2) panel.pinch = pinchState();
      if (event.pointerType !== "mouse") panel.point = point;
      viewport.focus({ preventScroll: true });
      invalidate(panel);
    });

    viewport.addEventListener("pointermove", (event) => {
      if (!shownDiff()) return;
      const point = local(event);
      if (panel.touches.has(event.pointerId)) {
        if (panel.down && Math.hypot(point.x - panel.down.x, point.y - panel.down.y) > tapDistance) panel.down.moved = true;
        if (panel.touches.size === 1) {
          const previous = panel.touches.get(event.pointerId);
          // A finger on the fully visible image scrolls the page (touch-action: pan-y), so it must not also move the view.
          if (event.pointerType !== "touch" || state.view.zoom > 1.001) panBy(panel, point.x - previous.x, point.y - previous.y);
          panel.touches.set(event.pointerId, point);
        } else if (panel.touches.size === 2 && panel.pinch) {
          panel.touches.set(event.pointerId, point);
          const next = pinchState();
          panBy(panel, next.x - panel.pinch.x, next.y - panel.pinch.y);
          if (panel.pinch.distance > 0 && next.distance > 0) zoomBy(panel, next.distance / panel.pinch.distance, next.x, next.y);
          panel.pinch = next;
          panel.down = null;
        }
      }
      panel.point = point;
      invalidate(panel);
    });

    const end = (event) => {
      const wasTap = event.type === "pointerup" && panel.down && !panel.down.moved && panel.touches.size === 1;
      const point = panel.touches.get(event.pointerId);
      panel.touches.delete(event.pointerId);
      panel.pinch = panel.touches.size === 2 ? pinchState() : null;
      if (panel.touches.size === 0) viewport.removeAttribute("data-dragging");
      if (wasTap && point) handleTap(panel, point);
      if (panel.touches.size === 0) panel.down = null;
      if (event.type === "pointercancel" || event.pointerType !== "mouse") panel.point = null;
      invalidate(panel);
    };
    viewport.addEventListener("pointerup", end);
    viewport.addEventListener("pointercancel", end);
    viewport.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "mouse" && !panel.touches.has(event.pointerId)) {
        panel.point = null;
        invalidate(panel);
      }
    });

    viewport.addEventListener("wheel", (event) => {
      if (!shownDiff() || !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const point = local(event);
      zoomBy(panel, Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0025)), point.x, point.y);
    }, { passive: false });

    viewport.addEventListener("keydown", (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey || !shownDiff()) return;
      const step = event.shiftKey ? 10 : 1;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (moves[event.key]) {
        event.preventDefault();
        if (!state.cursor) setCursor(Math.floor(state.view.centerX - 0.5), Math.floor(state.view.centerY - 0.5), { reveal: true, delay: 120 });
        else setCursor(state.cursor.column + moves[event.key][0], state.cursor.row + moves[event.key][1], { reveal: true, delay: 150 });
        return;
      }
      const actions = {
        "+": () => zoomBy(panel, zoomStep),
        "=": () => zoomBy(panel, zoomStep),
        "-": () => zoomBy(panel, 1 / zoomStep),
        "_": () => zoomBy(panel, 1 / zoomStep),
        "0": () => { fitView(); invalidate(); },
        Home: () => { fitView(); invalidate(); },
        Enter: () => {
          if (!state.cursor) {
            setCursor(Math.floor(state.view.centerX - 0.5), Math.floor(state.view.centerY - 0.5));
            return;
          }
          const candidate = selectedCandidate();
          const target = markTarget(panel);
          if (candidate && target) markPosition(candidate, target, state.cursor.column + 1, state.cursor.row + 1, "key");
          else announce(candidate ? "Pixel read. Press Enter in the Reference or the Epoch image to mark a position." : "Pixel read. Select or create a candidate to mark its position.");
        },
      };
      const action = actions[event.key];
      if (!action) return; // Tab and other keys keep their normal behavior, so focus can leave the view.
      event.preventDefault();
      action();
    });
  }

  // ---- Page rendering ------------------------------------------------------------------------------------------------
  function refresh() {
    renderEpochs();
    renderSettings();
    renderResult();
    renderCandidates();
    renderDetail();
    renderControls();
    renderLegend();
    renderReadout();
    invalidate();
  }

  function percent(part, whole) {
    return whole ? (100 * part / whole).toFixed(1) + "%" : "0%";
  }

  function renderEpochs() {
    el.epochsWrap.hidden = !state.items.length;
    el.clear.setAttribute("aria-disabled", String(!state.items.length));
    const referenceId = state.series ? state.series.referenceId : state.referenceId ?? autoReferenceId();
    const rows = state.items.map((item) => {
      const row = document.createElement("tr");
      const entry = entryOf(item.id);
      const epoch = item.epoch;

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "mo-reference";
      radio.className = "mo-radio";
      radio.checked = referenceId === item.id;
      radio.disabled = !epoch;
      radio.setAttribute("aria-label", "Use " + item.name + " as the reference");
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        state.referenceId = item.id;
        announce(item.name + " is now the reference.");
        scheduleAnalysis();
      });
      row.append(cell("td", radio));

      const who = document.createElement("td");
      who.append(node("strong", epoch ? epoch.meta.obsId ?? "Observation ID unavailable" : item.name));
      who.append(node("div", item.name + (item.isExample ? " · SPHEREx example" : " · local file"), "mo-sub"));
      row.append(who);

      const hduCell = document.createElement("td");
      const select = document.createElement("select");
      select.setAttribute("aria-label", "Image HDU of " + item.name);
      for (const { hdu, index } of item.choices) select.append(new Option(index + " · " + hdu.name + " (" + hdu.axes.join(" × ") + ")", index));
      select.disabled = !item.choices.length;
      if (item.choices.length) select.value = String(item.hduIndex);
      select.addEventListener("change", () => {
        item.hduIndex = Number(select.value);
        showHdu(item, item.version).then(() => {});
      });
      hduCell.append(select);
      row.append(hduCell);

      const timeCell = document.createElement("td");
      if (epoch) {
        const time = epoch.meta.time;
        timeCell.append(node("div", timeText(time)));
        if (time.valid) timeCell.append(node("div", "from " + time.sourceLabel, "mo-sub"));
        else {
          timeCell.append(node("div", (time.reason ?? "Observation time unavailable") + ". Rates need a time.", "mo-sub"));
          const input = document.createElement("input");
          input.type = "text";
          input.autocomplete = "off";
          input.placeholder = "UTC, 2025-05-24T04:24:53";
          input.value = item.manualTime;
          input.setAttribute("aria-label", "Observation time of " + item.name + " in UTC, entered manually");
          input.addEventListener("change", () => {
            const text = input.value.trim();
            if (!text) { item.manualTime = ""; item.manualError = ""; applyTime(item, ""); return; }
            const result = Motion.withManualTime(epoch, text);
            if (!result.ok) {
              item.manualError = result.reason;
              input.setAttribute("aria-invalid", "true");
              announce("Time rejected. " + result.reason);
              refresh();
              return;
            }
            item.manualTime = text;
            item.manualError = "";
            applyTime(item, text);
          });
          timeCell.append(input);
          if (item.manualError) timeCell.append(node("div", item.manualError, "mo-sub mo-error"));
        }
        if (epoch.meta.time.valid && item.manualTime && epoch.meta.time.manual) {
          const undo = node("button", "Clear manual time", "workspace-button mo-small");
          undo.type = "button";
          undo.addEventListener("click", () => { item.manualTime = ""; item.manualError = ""; applyTime(item, ""); });
          timeCell.append(undo);
        }
      } else timeCell.textContent = "—";
      row.append(timeCell);

      const diffCell = document.createElement("td");
      if (item.error) {
        diffCell.append(node("span", item.error, "mo-error"));
      } else if (item.loading) {
        diffCell.textContent = item.message || "Reading…";
      } else if (!epoch) {
        diffCell.textContent = "—";
      } else if (!state.series) {
        diffCell.textContent = state.analysisError ? "Not computed" : state.items.length < 2 ? "Waiting for a second observation" : "Searching…";
      } else if (entry && entry.isReference) {
        diffCell.textContent = "This is the reference (Δ is epoch − this image).";
      } else if (entry && !entry.included) {
        diffCell.append(node("span", "Left out: " + entry.reason, "mo-error"));
      } else if (entry) {
        const c = entry.diff.counts;
        diffCell.append(node("div", c.valid.toLocaleString("en-US") + " valid pixels (" + percent(c.valid, c.total) + ") · " + (entry.diff.mode === "pixel-difference" ? "pixel difference" : "bilinear reprojection")));
        diffCell.append(node("div", entry.pairs.length + " pair(s)" + (entry.rejected.length ? ", " + entry.rejected.length + " rejected" : "") + ", " + entry.unpaired.positive.length + " unpaired positive and " + entry.unpaired.negative.length + " unpaired negative residual(s)", "mo-sub"));
      }
      if (epoch && item.message && !item.loading) diffCell.append(node("div", item.message, "mo-sub"));
      row.append(diffCell);

      const remove = node("button", "Remove", "workspace-button mo-small");
      remove.type = "button";
      remove.setAttribute("aria-label", "Remove " + item.name);
      remove.addEventListener("click", () => removeItem(item));
      row.append(cell("td", remove));
      return row;
    });
    el.epochs.replaceChildren(...rows);
  }

  function autoReferenceId() {
    const epochs = state.items.filter((item) => item.epoch).map((item) => item.epoch);
    return epochs.length ? epochs[Motion.defaultReference(epochs)].id : null;
  }

  // A typed time only changes rates, unless it changes which epoch is the automatic reference.
  function applyTime(item, text) {
    if (!item.epoch) return;
    if (text) Motion.withManualTime(item.epoch, text);
    else {
      item.epoch.meta = Pair.describeObservation(item.epoch.hdu, item.epoch.hduIndex, { wavelength: item.epoch.wavelength });
    }
    const referenceChanged = state.series && !state.referenceId && autoReferenceId() !== state.series.referenceId;
    if (referenceChanged) scheduleAnalysis();
    else refresh();
    announce(text ? "Time of " + item.name + " set to " + text + " UTC, entered manually." : "Manual time of " + item.name + " cleared.");
  }

  function renderSettings() {
    const settings = state.settings;
    el.mode.value = settings.mode;
    if (document.activeElement !== el.threshold) el.threshold.value = settings.threshold;
    if (document.activeElement !== el.min) el.min.value = settings.min;
    if (document.activeElement !== el.max) el.max.value = settings.max;
    el.alignment.value = settings.alignment;
    const unit = state.series ? state.series.settings.unit : null;
    el.thresholdLabel.textContent = settings.mode === "snr" ? "Threshold (SNR, signed)" : settings.mode === "absolute" ? "Threshold (|Δ| in " + (unit ?? "the image unit") + ")" : "Threshold (× scatter of Δ)";
    const outcomeNeedsAssume = state.series && state.series.entries.some((entry) => !entry.included && /BUNIT is missing/.test(entry.reason));
    el.assumeWrap.hidden = !(outcomeNeedsAssume || settings.assume);
    el.assume.checked = settings.assume;
    const m = Motion.modeText[settings.mode];
    el.settingsNote.textContent = "Peaks are found in Δ with the method “" + m + "”. A negative and a positive residual closer than " + settings.max + " pixels and at least " + settings.min + " pixels apart form a pair; a smaller separation looks like a registration or PSF residual of a static source, so a source that moves less than this is not found. " +
      (settings.alignment === "require-same-grid" ? "No epoch is resampled: if an epoch is not on the reference pixel grid it is left out." : "An epoch on another grid is bilinearly reprojected onto the reference grid, which smooths it and correlates its noise.");
  }

  function renderResult() {
    const series = state.series;
    el.notes.replaceChildren();
    el.summary.hidden = !series;
    const loaded = state.items.filter((item) => item.epoch).length;
    if (state.analysisError) {
      el.verdict.textContent = "No search was run.";
      addItem(el.notes, state.analysisError, "tm-notes__error");
      el.notes.hidden = false;
      return;
    }
    if (!series) {
      el.verdict.textContent = state.items.some((item) => item.loading) ? "Reading the selected files…"
        : loaded === 1 ? "Load at least one more observation of the same field."
          : loaded >= 2 ? "Searching for candidates…" : "Load at least two observations of the same field to search for candidates.";
      el.notes.hidden = !state.resetNote;
      if (state.resetNote) addItem(el.notes, state.resetNote, "tm-notes__info");
      return;
    }
    const used = series.entries.filter((entry) => entry.included);
    const n = state.candidates.length;
    el.verdict.textContent = n
      ? n + " candidate" + (n === 1 ? "" : "s") + " in " + used.length + " observation" + (used.length === 1 ? "" : "s") + ". A candidate is a pair of residuals in the difference images, not a confirmed moving object."
      : "No candidate was found in " + used.length + " observation" + (used.length === 1 ? "" : "s") + " with these settings. That does not show that nothing moves: a source that moves less than the minimum separation, or faintly, would be missed.";
    if (series.notes.length) for (const text of series.notes) addItem(el.notes, text, "tm-notes__warning");
    for (const entry of series.entries) if (!entry.included && !entry.isReference) addItem(el.notes, (entry.epoch.meta.obsId ?? entry.epoch.name) + " was left out: " + entry.reason, "tm-notes__warning");
    const seen = new Set();
    for (const entry of series.entries) {
      if (!entry.diff) continue;
      for (const text of entry.diff.warnings.concat(entry.diff.notes)) {
        if (seen.has(text)) continue;
        seen.add(text);
        addItem(el.notes, text, "tm-notes__info");
      }
    }
    const untimed = series.entries.filter((entry) => !Motion.epochTime(entry.epoch));
    if (untimed.length) addItem(el.notes, "Observation time is unavailable for " + untimed.map((entry) => entry.epoch.meta.obsId ?? entry.epoch.name).join(", ") + ". Candidates keep their displacement, but no rate can be computed for a track that includes it. You can enter a UTC time in the Observations table.", "tm-notes__warning");
    const times = series.entries.map((entry) => Motion.epochTime(entry.epoch)).filter(Boolean);
    if (times.length >= 2 && new Set(times.map((time) => time.scale)).size > 1) addItem(el.notes, "The observations use different time scales, so rates are not computed across them.", "tm-notes__warning");
    for (const text of state.resetNote ? [state.resetNote] : []) addItem(el.notes, text, "tm-notes__info");
    const pairedInfo = series.counts;
    if (pairedInfo.unpairedPositive + pairedInfo.unpairedNegative) addItem(el.notes, (pairedInfo.unpairedPositive + pairedInfo.unpairedNegative) + " residual(s) had no partner of the opposite sign (" + pairedInfo.unpairedPositive + " positive, " + pairedInfo.unpairedNegative + " negative). They are brightness changes, transients or artifacts, or a moving source whose partner lies outside the search radius or the valid area; they are not listed as candidates.", "tm-notes__info");
    if (pairedInfo.rejected) addItem(el.notes, pairedInfo.rejected + " residual pair(s) were rejected as residuals of static sources (registration, PSF or brightness changes; the reason for each is kept with the epoch, and the counts are in the “Difference with the reference” column).", "tm-notes__info");
    el.notes.hidden = !el.notes.children.length;

    const s = series.settings;
    const set = (name, text) => setFact(el.summary, name, text);
    set("reference", (series.reference.meta.obsId ?? series.reference.name) + " · " + timeText(series.reference.meta.time) + (state.referenceId ? " (chosen)" : " (earliest valid time)"));
    set("difference", "Δ = epoch − reference, on the reference pixel grid, unit " + (s.unit ?? "unavailable") + ". Positive: the epoch is brighter (the source is there). Negative: the reference is brighter (the source was there).");
    set("threshold", "Peaks of |Δ| of at least " + s.thresholdText + ", method: " + s.method + ".");
    set("pairs", series.counts.pairs + " paired (search radius " + s.maxSeparationPixels + " px, minimum separation " + s.minSeparationPixels + " px), " + series.counts.rejected + " rejected, " + series.counts.unpairedPositive + " positive and " + series.counts.unpairedNegative + " negative unpaired. Pairs sharing one reference position (within " + s.linkTolerancePixels + " px) in several epochs are one candidate.");
    set("excluded", series.counts.nearInvalid + " residual peak(s) within 2 pixels of the image edge, a NaN or masked pixel, or the area an epoch does not cover.");
    set("scale", s.pixelScaleArcsec !== null ? significant(s.pixelScaleArcsec, 4) + " arcsec per pixel (reference)" : "Unavailable");
  }

  // ---- Candidates table -----------------------------------------------------------------------------------------------
  function trackSummary(candidate) {
    const evaluated = evaluate(candidate);
    const track = evaluated.track;
    const points = evaluated.points;
    const byId = (id) => points.find((point) => point.id === id);
    if (!track.ok) return { evaluated, text: { range: "—", observed: "—", dt: "—", disp: "—", rate: "—", pa: "—" }, reason: track.reason };
    const first = byId(track.ordered[0]);
    const last = byId(track.ordered[track.ordered.length - 1]);
    const where = (point) => degrees(point.ra, 5) + ", " + degrees(point.dec, 5);
    const rate = track.rate;
    return {
      evaluated,
      text: {
        range: where(first) + " → " + where(last),
        observed: track.chronological ? first.time.display + " → " + last.time.display + " " + first.time.scale : "Not all times are known",
        dt: track.deltaTHours !== undefined ? Pair.formatDuration(track.deltaTDays) : "Unavailable",
        disp: arcsecText(track.displacement.arcsec),
        rate: rate ? significant(rate.speed, 3) + " ″/h (" + significant(rate.perDay, 3) + " ″/day)" : "Unavailable",
        pa: rate && rate.pa !== null ? fixed(rate.pa, 1) + "° (" + rate.direction + ")" : track.displacement.pa !== null ? fixed(track.displacement.pa, 1) + "° (displacement)" : "—",
      },
      reason: track.rateReason,
    };
  }

  function renderCandidates() {
    const series = state.series;
    const list = state.candidates;
    el.newCandidate.setAttribute("aria-disabled", String(!(series && referenceEntry() && referenceEntry().image)));
    el.candidatesWrap.hidden = !list.length;
    if (!series) {
      el.candidatesNote.textContent = state.analysisError ? "No search was run." : "Candidates appear here after at least two observations are loaded.";
      el.candidates.replaceChildren();
      return;
    }
    el.candidatesNote.textContent = list.length
      ? "Select a candidate to inspect its positions and show it on the images. Review it against the original images before keeping it."
      : "No candidate was found. You can still mark a source by hand with “New candidate”.";
    const rows = list.map((candidate) => {
      const summary = trackSummary(candidate);
      const row = document.createElement("tr");
      row.dataset.candidate = candidate.id;
      if (candidate.id === state.selectedId) row.dataset.selected = "";
      if (candidate.status === "dismissed") row.dataset.dismissed = "";
      const button = node("button", candidate.id, "mo-row-button");
      button.type = "button";
      button.setAttribute("aria-label", "Candidate " + candidate.id + ", " + reviewLabel[candidate.status] + ", " + Object.keys(candidate.positions).length + " positions" + (candidate.origin === "manual" ? ", marked by hand" : ""));
      if (candidate.id === state.selectedId) button.setAttribute("aria-current", "true");
      button.addEventListener("click", () => selectCandidate(candidate.id, true));
      const head = document.createElement("th");
      head.scope = "row";
      head.append(button);
      if (candidate.origin === "manual") head.append(node("div", "by hand", "mo-sub"));
      row.append(head);
      row.append(cell("td", reviewLabel[candidate.status]));
      row.append(cell("td", String(Object.keys(candidate.positions).length) + " of " + series.entries.filter((entry) => entry.included).length));
      row.append(cell("td", summary.text.range));
      row.append(cell("td", summary.text.observed));
      row.append(cell("td", summary.text.dt));
      row.append(cell("td", summary.text.disp));
      const rateCell = cell("td", summary.text.rate);
      if (summary.reason && summary.text.rate === "Unavailable") rateCell.append(node("div", summary.reason, "mo-sub"));
      row.append(rateCell);
      row.append(cell("td", summary.text.pa));
      return row;
    });
    el.candidates.replaceChildren(...rows);
  }

  function selectCandidate(id, focusDetail) {
    state.selectedId = id;
    showSelectedEpoch();
    buildPictures();
    refresh();
    const candidate = selectedCandidate();
    if (candidate) announce("Candidate " + candidate.id + " selected. " + Object.keys(candidate.positions).length + " positions. " + candidate.reasons[0]);
    if (focusDetail) {
      const button = el.candidates.querySelector('[data-candidate="' + id + '"] .mo-row-button');
      if (button) button.focus({ preventScroll: true });
    }
  }

  // ---- Candidate detail ------------------------------------------------------------------------------------------------
  function sortedEntries() {
    const entries = state.series.entries.filter((entry) => entry.included);
    return entries.sort((a, b) => timeKey(a.epoch) - timeKey(b.epoch) || state.series.entries.indexOf(a) - state.series.entries.indexOf(b));
  }

  function positionInput(candidate, entry, axis) {
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.autocomplete = "off";
    input.className = "mo-position-input";
    input.dataset.epoch = entry.id;
    input.dataset.axis = axis;
    const position = candidate.positions[entry.id];
    input.value = position ? String(Math.round(position[axis] * 100) / 100) : "";
    input.setAttribute("aria-label", "Pixel " + axis + " of " + candidate.id + " in " + epochLabel(entry));
    input.addEventListener("change", () => commitTyped(candidate, entry));
    return input;
  }

  function commitTyped(candidate, entry) {
    const row = el.positions.querySelector('[data-epoch-row="' + entry.id + '"]');
    const [xi, yi] = [row.querySelector('[data-axis="x"]'), row.querySelector('[data-axis="y"]')];
    const x = parseNumber(xi.value);
    const y = parseNumber(yi.value);
    if (xi.value.trim() === "" && yi.value.trim() === "") {
      delete candidate.positions[entry.id];
      refresh();
      announce(candidate.id + ": position in " + epochLabel(entry) + " cleared.");
      return;
    }
    const g = grid();
    if (!(Number.isFinite(x) && Number.isFinite(y)) || !insideImage(x, y, g.width, g.height)) {
      announce("Enter both pixel numbers as numbers inside the image: x from 0.5 to " + (g.width + 0.5) + " and y from 0.5 to " + (g.height + 0.5) + ".");
      renderDetail();
      return;
    }
    Motion.setPosition(candidate, entry.id, { x, y, method: "typed", note: "Typed by the user" });
    refresh();
    announce(candidate.id + ": position in " + epochLabel(entry) + " set to pixel " + fixed(x, 2) + ", " + fixed(y, 2) + ".");
  }

  function renderDetail() {
    const candidate = selectedCandidate();
    const series = state.series;
    el.detail.hidden = !(candidate && series);
    if (!candidate || !series) return;
    const evaluated = evaluate(candidate);
    const { track, points } = evaluated;
    el.detailTitle.textContent = "Candidate " + candidate.id + " · " + reviewLabel[candidate.status];
    el.detailOrigin.textContent = candidate.origin === "manual" ? "This candidate was marked by hand; no residual pair was detected for it." : "It was found as a pair of residuals in the difference images.";
    for (const button of el.detail.querySelectorAll("[data-mo-review]")) button.setAttribute("aria-pressed", String(button.dataset.moReview === candidate.status));

    el.detailNotes.replaceChildren();
    for (const text of candidate.reasons) addItem(el.detailNotes, text, "tm-notes__info");
    for (const text of candidate.warnings) addItem(el.detailNotes, text, "tm-notes__warning");
    addItem(el.detailNotes, "Variable sources, alignment and PSF residuals, saturated pixels, blends and artifacts can produce the same pattern. Compare the Reference and Epoch images before keeping it.", "tm-notes__warning");
    for (const text of evaluated.issues) addItem(el.detailNotes, text, "tm-notes__warning");
    el.detailNotes.hidden = false;

    const entries = sortedEntries();
    const fitById = new Map((track.ok && track.rate && track.rate.residuals ? track.rate.residuals : []).map((item) => [item.id, item.norm]));
    const rows = entries.map((entry, index) => {
      const point = points.find((item) => item.id === entry.id);
      const row = document.createElement("tr");
      row.dataset.epochRow = entry.id;
      if (entry.id === state.shownId) row.dataset.shown = "";
      const who = document.createElement("th");
      who.scope = "row";
      who.append(node("strong", (index + 1) + " · " + epochLabel(entry)));
      who.append(node("div", entry.isReference ? "Reference" : "Epoch", "mo-sub"));
      row.append(who);
      row.append(cell("td", timeText(Motion.epochTime(entry.epoch))));
      row.append(cell("td", positionInput(candidate, entry, "x")));
      row.append(cell("td", positionInput(candidate, entry, "y")));
      row.append(cell("td", point && Number.isFinite(point.ra) ? degrees(point.ra, 6) + ", " + degrees(point.dec, 6) : "—"));
      row.append(cell("td", point ? point.source ? fixed(point.source.x, 2) + ", " + fixed(point.source.y, 2) : "Outside this image" : "—"));
      row.append(cell("td", point && point.east !== undefined ? fixed(point.east, 2) + ", " + fixed(point.north, 2) : "—"));
      row.append(cell("td", point && fitById.has(entry.id) ? fixed(fitById.get(entry.id), 2) : "—"));
      const sourceCell = document.createElement("td");
      if (point) {
        sourceCell.append(node("div", point.method + (point.edited ? " (corrected, detected position kept)" : "")));
        if (point.note) sourceCell.append(node("div", point.note, "mo-sub"));
      } else sourceCell.textContent = "No position yet";
      row.append(sourceCell);
      const actions = document.createElement("td");
      actions.className = "mo-actions";
      if (!entry.isReference) {
        const show = node("button", "Show", "workspace-button mo-small");
        show.type = "button";
        show.setAttribute("aria-label", "Show epoch " + epochLabel(entry) + " in the images");
        show.addEventListener("click", () => { state.shownId = entry.id; buildPictures(); refresh(); announce("Showing " + epochLabel(entry) + "."); });
        actions.append(show);
      }
      if (point) {
        const clear = node("button", "Clear", "workspace-button mo-small");
        clear.type = "button";
        clear.setAttribute("aria-label", "Clear the position of " + candidate.id + " in " + epochLabel(entry));
        clear.addEventListener("click", () => { delete candidate.positions[entry.id]; refresh(); announce("Position cleared."); });
        actions.append(clear);
      }
      row.append(actions);
      return row;
    });
    el.positions.replaceChildren(...rows);

    renderTrackFacts(candidate, evaluated);
    drawPlot(candidate, evaluated);
  }

  function renderTrackFacts(candidate, evaluated) {
    const { track, points } = evaluated;
    const set = (name, text) => setFact(el.track, name, text, "data-mo-track-fact");
    set("n", points.length + " position" + (points.length === 1 ? "" : "s") + (track.ok ? " · " + (track.chronological ? "ordered by observation time" : "ordered by epoch, not by time") : ""));
    if (!track.ok) {
      for (const name of ["displacement", "dt", "rate", "direction", "fit"]) set(name, name === "displacement" ? track.reason : "Unavailable");
      return;
    }
    const d = track.displacement;
    const idOf = (id) => epochLabel(entryOf(id));
    set("displacement", arcsecText(d.arcsec, 3) + " from " + idOf(d.fromId) + " to " + idOf(d.toId) + " (east " + (d.east >= 0 ? "+" : "") + fixed(d.east, 2) + "″, north " + (d.north >= 0 ? "+" : "") + fixed(d.north, 2) + "″)");
    set("dt", track.deltaTHours !== undefined ? Pair.formatDuration(track.deltaTDays) + " (" + significant(track.deltaTHours, 5) + " h)" : "Unavailable: " + track.rateReason);
    const rate = track.rate;
    if (!rate) {
      set("rate", "Unavailable. " + track.rateReason);
      set("direction", d.pa !== null ? "Displacement toward position angle " + fixed(d.pa, 1) + "° (" + d.direction + "), north through east." : "No displacement.");
      set("fit", "Unavailable without a rate.");
      return;
    }
    set("rate", significant(rate.speed, 4) + " arcsec/hour = " + significant(rate.perDay, 4) + " arcsec/day (" + rate.method + ")" + (rate.sigmaSpeed !== null ? ", formal uncertainty ±" + significant(rate.sigmaSpeed, 2) + " arcsec/hour" : ", no uncertainty from two positions"));
    set("direction", rate.pa !== null ? "Position angle " + fixed(rate.pa, 1) + "° (" + rate.direction + "), measured from north through east; east " + (rate.east >= 0 ? "+" : "") + significant(rate.east, 4) + " and north " + (rate.north >= 0 ? "+" : "") + significant(rate.north, 4) + " arcsec/hour." : "No motion measured.");
    set("fit", rate.residualRms !== null ? "Residual rms " + significant(rate.residualRms, 3) + "″ with " + rate.dof + " degree" + (rate.dof === 1 ? "" : "s") + " of freedom. Position errors are not propagated." + (track.notes.length ? " " + track.notes.join(" ") : "") : "No fit residuals. " + track.notes.join(" "));
  }

  // ---- Track plot -------------------------------------------------------------------------------------------------------
  function niceStep(span, target = 5) {
    const raw = span / target;
    const power = 10 ** Math.floor(Math.log10(raw));
    const fraction = raw / power;
    return (fraction >= 5 ? 5 : fraction >= 2 ? 2 : 1) * power;
  }

  function drawPlot(candidate, evaluated) {
    const translate = window.AstroNotLanguage?.translate ?? ((text) => text);
    const canvas = el.plot;
    const { track, points } = evaluated;
    const width = Math.max(280, Math.round(canvas.clientWidth || 640));
    const height = Math.round(Math.min(380, Math.max(240, width * 0.55)));
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.blockSize = height + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = "#060709";
    ctx.fillRect(0, 0, width, height);
    const measured = points.filter((point) => point.east !== undefined);
    if (!track.ok || measured.length < 2) {
      ctx.fillStyle = "#b6bdc8";
      ctx.font = "14px Inter, system-ui, sans-serif";
      ctx.fillText(translate("Mark at least two positions to see the track."), 16, 28, width - 32);
      canvas.setAttribute("aria-label", "Track plot: fewer than two positions marked.");
      el.plotCaption.textContent = "Track on the sky: needs at least two positions.";
      return;
    }
    const fitted = new Map();
    if (track.rate && track.rate.residuals) for (const item of track.rate.residuals) {
      const point = measured.find((entry) => entry.id === item.id);
      if (point) fitted.set(item.id, { east: point.east - item.east, north: point.north - item.north });
    }
    const xs = measured.map((point) => point.east);
    const ys = measured.map((point) => point.north);
    let [xMin, xMax, yMin, yMax] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const span = Math.max(xMax - xMin, yMax - yMin, 1);
    const pad = span * 0.18;
    const cx = (xMin + xMax) / 2;
    const cy = (yMin + yMax) / 2;
    const margin = { left: 64, right: 18, top: 16, bottom: 40 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    const half = Math.max(span / 2 + pad, 0.5);
    const scale = Math.min(plotW, plotH) / (2 * half);
    // East is drawn to the LEFT, north up, as on the sky.
    const toX = (east) => margin.left + plotW / 2 - (east - cx) * scale;
    const toY = (north) => margin.top + plotH / 2 - (north - cy) * scale;
    const step = niceStep(2 * half);
    ctx.font = "11px Inter, system-ui, sans-serif";
    ctx.lineWidth = 1;
    for (let east = Math.ceil((cx - half * plotW / Math.min(plotW, plotH)) / step) * step; east <= cx + half * plotW / Math.min(plotW, plotH); east += step) {
      const x = toX(east);
      if (x < margin.left || x > margin.left + plotW) continue;
      ctx.strokeStyle = "#1e2229";
      ctx.beginPath(); ctx.moveTo(x, margin.top); ctx.lineTo(x, margin.top + plotH); ctx.stroke();
      ctx.fillStyle = "#b6bdc8";
      ctx.fillText(fixed(east, step < 1 ? 1 : 0), x - 10, margin.top + plotH + 14);
    }
    for (let north = Math.ceil((cy - half * plotH / Math.min(plotW, plotH)) / step) * step; north <= cy + half * plotH / Math.min(plotW, plotH); north += step) {
      const y = toY(north);
      if (y < margin.top || y > margin.top + plotH) continue;
      ctx.strokeStyle = "#1e2229";
      ctx.beginPath(); ctx.moveTo(margin.left, y); ctx.lineTo(margin.left + plotW, y); ctx.stroke();
      ctx.fillStyle = "#b6bdc8";
      ctx.fillText(fixed(north, step < 1 ? 1 : 0), 24, y + 4);
    }
    ctx.strokeStyle = "#4a505a";
    ctx.strokeRect(margin.left, margin.top, plotW, plotH);
    ctx.fillStyle = "#dce0e8";
    ctx.font = "12px Inter, system-ui, sans-serif";
    ctx.fillText(translate("← East offset from the first position (arcsec)"), margin.left + plotW / 2 - 130, height - 8, plotW);
    ctx.save();
    ctx.translate(13, margin.top + plotH / 2 + 60);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(translate("North offset (arcsec) ↑"), 0, 0, plotH);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(margin.left, margin.top, plotW, plotH);
    ctx.clip();
    const order = track.ordered.map((id) => measured.find((point) => point.id === id)).filter(Boolean);
    // Straight-line model through the fitted positions (or the two points).
    ctx.strokeStyle = "#8fd3ff";
    ctx.lineWidth = 2;
    ctx.setLineDash(fitted.size ? [] : [6, 4]);
    ctx.beginPath();
    order.forEach((point, index) => {
      const place = fitted.get(point.id) ?? point;
      if (index === 0) ctx.moveTo(toX(place.east), toY(place.north));
      else ctx.lineTo(toX(place.east), toY(place.north));
    });
    ctx.stroke();
    ctx.setLineDash([]);
    // Residual segments.
    ctx.strokeStyle = "#ffd24a";
    ctx.lineWidth = 1.5;
    for (const point of order) {
      const place = fitted.get(point.id);
      if (!place) continue;
      ctx.beginPath(); ctx.moveTo(toX(place.east), toY(place.north)); ctx.lineTo(toX(point.east), toY(point.north)); ctx.stroke();
    }
    order.forEach((point, index) => {
      const x = toX(point.east);
      const y = toY(point.north);
      ctx.fillStyle = point.entry.isReference ? "#101216" : "#f2f4f8";
      ctx.strokeStyle = "#f2f4f8";
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (point.entry.isReference) ctx.arc(x, y, 6, 0, Math.PI * 2);
      else ctx.rect(x - 5, y - 5, 10, 10);
      ctx.fill();
      ctx.stroke();
      outlinedText(ctx, String(index + 1), x + 9, y - 8, "#f2f4f8");
    });
    ctx.restore();
    const description = order.map((point, index) => (index + 1) + " " + epochLabel(point.entry) + ": east " + fixed(point.east, 1) + "″, north " + fixed(point.north, 1) + "″").join("; ");
    canvas.setAttribute("aria-label", "Track of " + candidate.id + " on the sky, east to the left. Positions in time order: " + description + ".");
    el.plotCaption.textContent = "Track of " + candidate.id + " on the sky (north up, east left): numbers follow the time order, a ring is the reference epoch and squares are the other epochs. The blue line is the " + (fitted.size ? "least-squares straight line, yellow ticks join each position to it" : "straight line between the two positions") + ". The positions table is the text version.";
  }

  // ---- Controls, legend ---------------------------------------------------------------------------------------------
  function renderControls() {
    const shown = shownEntries();
    el.epochSelect.replaceChildren(...shown.map((entry) => new Option((epochLabel(entry)) + " · " + timeText(Motion.epochTime(entry.epoch)), entry.id)));
    el.epochSelect.disabled = !shown.length;
    if (shown.length && state.shownId) el.epochSelect.value = state.shownId;
    el.fit.setAttribute("aria-disabled", String(!shownDiff()));
    el.clip.value = state.clip;
    el.limit.value = state.limit;
    const hasCandidates = state.candidates.length > 0;
    el.download.setAttribute("aria-disabled", String(!hasCandidates));
    el.exportStatus.textContent = "";
    for (const button of el.detail.querySelectorAll("[data-mo-review]")) button.disabled = !selectedCandidate();
  }

  function renderLegend() {
    const diff = shownDiff();
    const limit = state.ranges.limit;
    el.legend.hidden = !diff;
    if (!diff) return;
    const hasScale = limit !== null && !diff.empty;
    el.legendBar.hidden = !hasScale;
    el.legendLow.parentElement.hidden = !hasScale;
    if (!hasScale) {
      el.legendText.textContent = "No valid pixels, so there is no color scale.";
      return;
    }
    const context = el.legendBar.getContext("2d");
    const { width, height } = el.legendBar;
    for (let x = 0; x < width; x++) {
      const color = Diff.divergingColor((x + 0.5) / width * 2 - 1);
      context.fillStyle = "rgb(" + color.join(",") + ")";
      context.fillRect(x, 0, 1, height);
    }
    const unit = diff.unit ? " " + diff.unit : "";
    el.legendLow.textContent = minus + significant(limit, 4) + unit;
    el.legendHigh.textContent = "+" + significant(limit, 4) + unit;
    el.legendText.textContent = "Δ = epoch − reference, in " + (diff.unit || "the (unspecified) image unit") + ". Zero is the neutral center. Blue: the epoch is lower than the reference (where a moving source was). Red: the epoch is higher (where it is). Values beyond the limits (" + state.ranges.limitNote + ") are clipped in the picture only; readouts and exports keep the exact values. Hatched pixels have no valid value.";
  }

  // ---- Export, buttons ------------------------------------------------------------------------------------------------
  function downloadCsv() {
    if (!state.series || !state.candidates.length) return;
    const text = Motion.candidatesCsv(state.series, state.candidates);
    const safe = (value) => String(value ?? "unavailable").replace(/[^A-Za-z0-9_-]+/g, "_");
    const name = "AstroNot-motion-candidates_" + safe(state.series.settings.referenceObsId) + ".csv";
    const link = document.createElement("a");
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    el.exportStatus.textContent = "Saved " + name + " (" + state.candidates.length + " candidate(s), " + (text.trim().split("\r\n").length - 1) + " position row(s)). Review status is included; every candidate is a candidate, not a confirmed object.";
  }

  function newManualCandidate() {
    if (!state.series || !referenceEntry() || !referenceEntry().image) return;
    const candidate = Motion.newCandidate(state.series, ++manualCounter);
    state.candidates.push(candidate);
    state.selectedId = candidate.id;
    refresh();
    announce("Candidate " + candidate.id + " created. Click the Reference image to set its reference position and the Epoch image to set its position in the epoch shown.");
  }

  function setReview(status) {
    const candidate = selectedCandidate();
    if (!candidate) return;
    candidate.status = status; // Only the status; positions, times and IDs are untouched.
    refresh();
    announce("Candidate " + candidate.id + ": " + reviewLabel[status] + ".");
  }

  function wire() {
    el.files.addEventListener("change", () => {
      const files = [...el.files.files];
      el.files.value = ""; // So choosing the same file again fires another change.
      if (files.length) addFiles(files.map((file) => ({ name: file.name, file })));
    });
    el.files.disabled = false;

    el.example.addEventListener("click", async () => {
      setStatus("Loading the example pair…");
      try {
        const files = await loadExample();
        setStatus("");
        addFiles(files, true);
        setStatus("Example pair: two real SPHEREx QR2 cutouts of one field, 18 days apart. The tool reports whatever candidates it finds in them, which may be none.");
      } catch (error) {
        setStatus(error.message, true);
      }
    });
    el.example.disabled = false;

    const press = (button, action) => button.addEventListener("click", () => {
      if (button.getAttribute("aria-disabled") === "true") return;
      action();
    });
    press(el.clear, () => {
      for (const item of state.items) { item.version++; item.hduVersion++; }
      state.items = [];
      state.referenceId = null;
      state.candidates = [];
      state.selectedId = null;
      setStatus("");
      scheduleAnalysis();
      announce("All observations removed.");
    });
    press(el.download, downloadCsv);
    press(el.newCandidate, newManualCandidate);
    press(el.fit, () => { fitView(); invalidate(); announce("All views fitted to the whole image."); });
    for (const button of el.detail.querySelectorAll("[data-mo-review]")) button.addEventListener("click", () => setReview(button.dataset.moReview));

    const rerun = (key, element) => element.addEventListener("change", () => {
      state.settings[key] = element.type === "checkbox" ? element.checked : element.value;
      scheduleAnalysis();
    });
    rerun("mode", el.mode);
    rerun("threshold", el.threshold);
    rerun("min", el.min);
    rerun("max", el.max);
    rerun("alignment", el.alignment);
    rerun("assume", el.assume);

    el.epochSelect.addEventListener("change", () => { state.shownId = el.epochSelect.value; buildPictures(); refresh(); announce("Showing " + epochLabel(entryOf(state.shownId)) + "."); });
    el.clip.addEventListener("change", () => { state.clip = el.clip.value; buildPictures(); refresh(); });
    el.limit.addEventListener("change", () => { state.limit = el.limit.value; buildPictures(); refresh(); });

    // Up and Down move through the candidate list without leaving the keyboard.
    el.candidates.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const buttons = [...el.candidates.querySelectorAll(".mo-row-button")];
      const index = buttons.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      const next = buttons[Math.min(buttons.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))];
      selectCandidate(next.closest("tr").dataset.candidate, true);
    });
  }

  // Optional WebAssembly accelerator for the residual search (rust/crates/detect). null keeps the JavaScript code.
  if (window.AstroNotWasm) AstroNotWasm.load("detect").then((kernel) => { if (kernel) Motion.useKernel(kernel); });

  buildPanels();
  wire();
  refresh();
  window.addEventListener("astronot-languagechange", refresh);
})();
