// Mosaic Builder: combines two or more overlapping FITS images into one image on a common WCS. FITS structure and calibrated
// pixel values come from tools/fits.js (shared with FITS Viewer, Time Machine and Image Differencing), coordinates from
// tools/wcs.js, the observation model from tools/pair.js, bilinear reprojection from tools/difference.js, and ALL mosaic
// computation (units, bands, output grid, resampling, combination, coverage, FITS export) from tools/mosaic-model.js.
// This file is the user interface only.
//
// Display never feeds back into the computation: the gray range, the colors, zoom and pan only decide how pictures are
// painted from the arrays in the result. Every readout reads the arrays, not the pictures.
(function () {
  "use strict";

  const Wcs = AstroNotWcs;
  const Pair = AstroNotPair;
  const Mosaic = AstroNotMosaic;

  // Optional Rust/WebAssembly accelerator for the reprojection loop (rust/crates/reproject). It is installed when it has
  // loaded; until then, and whenever it cannot load (no WebAssembly, no SIMD, file missing), the JavaScript loop runs.
  // <html data-reproject="wasm|js"> tells which one is installed; AstroNotDifference.kernelStatus() counts the calls.
  if (typeof AstroNotWasm === "object") {
    AstroNotWasm.load("reproject").then((kernel) => {
      document.documentElement.dataset.reproject = AstroNotDifference.useKernel(kernel) ? "wasm" : "js";
    });
  }
  const { createWcs, screenToFits, fitsToScreen, insideImage } = Wcs;

  const minus = "−";
  const zoomStep = 2;
  const tapDistance = 5;
  const palette = ["#ffd24a", "#5fd3ff", "#ff7f6e", "#8be28b", "#d79bff", "#ff9f43", "#9aa7ff", "#f0f0f0"];
  const coverageStops = [[58, 54, 120], [40, 120, 160], [60, 170, 130], [200, 210, 70], [250, 240, 150]];
  const panelKinds = ["mosaic", "coverage"];
  const panelLabel = { mosaic: "Mosaic", coverage: "Coverage map" };

  const query = (name, scope = document) => scope.querySelector("[data-mb-" + name + "]");

  const el = {
    file: query("file"), fileLabel: query("file-label"), example: query("example"), clear: query("clear"), status: query("status"),
    inputsEmpty: query("inputs-empty"), inputsWrap: query("inputs-wrap"), inputsBody: query("inputs-body"),
    mode: query("mode"), grid: query("grid"), scale: query("scale"), width: query("width"), height: query("height"), settingsNote: query("settings-note"),
    verdict: query("verdict"), notes: query("notes"), suggest: query("suggest"), planFacts: query("plan-facts"),
    build: query("build"), cancel: query("cancel"), progress: query("progress"), buildStatus: query("build-status"),
    footEmpty: query("foot-empty"), footWrap: query("foot-wrap"), footBody: query("foot-body"),
    fit: query("fit"), clip: query("clip"), outlines: query("outlines"), panels: query("panels"),
    legend: query("legend"), legendList: query("legend-list"), live: query("live"),
    pixelNote: query("pixel-note"), pixelX: query("pixel-x"), pixelY: query("pixel-y"), pixelGo: query("pixel-go"),
    pixelCenter: query("pixel-center"), pixelClear: query("pixel-clear"), readout: query("readout"), readoutBody: query("readout-body"),
    resultVerdict: query("result-verdict"), resultNotes: query("result-notes"), resultFacts: query("result-facts"),
    download: query("download"), exportStatus: query("export-status"),
  };

  // ---- State ---------------------------------------------------------------------------------------------------------
  const state = {
    entries: [], nextId: 1,
    mode: "mean", grid: "auto", scale: "", width: "", height: "",
    plan: null, building: false, buildToken: 0,
    result: null, resultEntries: null, resultInputs: null,
    clip: "1-99", outlines: true,
    pictures: { mosaic: null, coverage: null }, ranges: { gray: null },
    selected: null, view: { zoom: 1, centerX: 1, centerY: 1 },
    viewKey: "",
  };
  let panels = {};
  let hatch = null;

  // ---- Small helpers -------------------------------------------------------------------------------------------------
  function significant(value, digits = 5) {
    return Number(value.toPrecision(digits)).toString().replace("-", minus);
  }

  function degrees(value, digits = 5) {
    return value.toFixed(digits).replace("-", minus) + "°";
  }

  function withUnit(text, unit) {
    return unit ? text + " " + unit : text;
  }

  function count(value) {
    return value.toLocaleString("en-US");
  }

  function megabytes(bytes) {
    return (bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0) + " MB";
  }

  function plural(number, word) {
    return number + " " + word + (number === 1 ? "" : "s");
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

  function setFact(root, name, text, attribute) {
    const target = root.querySelector("[" + attribute + '="' + name + '"]');
    if (target && target.textContent !== text) target.textContent = text;
  }

  function addItem(list, text, className) {
    const item = document.createElement("li");
    if (className) item.className = className;
    item.textContent = text;
    list.append(item);
  }

  function cell(text, tag = "td") {
    const node = document.createElement(tag);
    node.textContent = text;
    return node;
  }

  // ---- Loading files -------------------------------------------------------------------------------------------------
  function newEntry(file, name, isExample) {
    return {
      id: state.nextId++, key: (isExample ? "example:" : "file:") + name + ":" + file.size + ":" + (isExample ? 0 : file.lastModified),
      file, name, isExample, hdus: null, choices: [], hduIndex: -1, loading: true, error: "", message: "Reading FITS headers…", image: null, version: 0, hduVersion: 0,
    };
  }

  function whyNotDisplayable(hdu) {
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

  // A VARIANCE image of the same size, if the file has one. Only an image named VARIANCE counts.
  async function readVariance(entry, hdu) {
    const index = entry.hdus.findIndex((candidate) => candidate !== hdu && String(candidate.fields.EXTNAME ?? "").trim().toUpperCase() === "VARIANCE");
    if (index < 0) return { values: null, unit: undefined, note: "No VARIANCE image" };
    const candidate = entry.hdus[index];
    if (!candidate.renderable || candidate.axes[0] !== hdu.axes[0] || candidate.axes[1] !== hdu.axes[1]) {
      return { values: null, unit: undefined, note: "VARIANCE image (HDU " + index + ") ignored: it cannot be read or its size differs" };
    }
    const values = await readValues(entry.file, candidate);
    const unit = typeof candidate.fields.BUNIT === "string" ? candidate.fields.BUNIT.trim() : undefined;
    return { values, unit, note: "VARIANCE in HDU " + index + (unit ? ", unit " + unit : ", no BUNIT") };
  }

  async function readWaveTable(entry, hdu) {
    const name = String(hdu.fields.PS1_0W ?? "WCS-WAVE").trim();
    const table = entry.hdus.find((candidate) => candidate.fields.XTENSION === "BINTABLE" && candidate.fields.EXTNAME === name);
    if (!table || table.byteLength > 1 << 20) return null;
    const bytes = await entry.file.slice(table.dataStart, table.dataStart + table.byteLength).arrayBuffer();
    return Pair.parseWaveTable(bytes, table.fields, hdu.fields);
  }

  async function readImage(entry, version, token) {
    const hdu = entry.hdus[entry.hduIndex];
    const values = await readValues(entry.file, hdu);
    if (version !== entry.version || token !== entry.hduVersion) return null;
    const table = await readWaveTable(entry, hdu);
    const variance = await readVariance(entry, hdu);
    if (version !== entry.version || token !== entry.hduVersion) return null;
    const created = createWcs(hdu.fields);
    const [width, height] = hdu.axes;
    const wcs = created.ok ? created.wcs : null;
    const wavelength = table ? Pair.wavelengthSummary(table, hdu.fields, width, height) : null;
    const image = {
      width, height, values, hdu, fields: hdu.fields, wcs, wcsReason: created.ok ? "" : created.reason,
      unit: typeof hdu.fields.BUNIT === "string" ? hdu.fields.BUNIT.trim() : "",
      variance: variance.values, varianceUnit: variance.unit, varianceNote: variance.note,
      wavelength, wavelengthAt: wcs && table ? Mosaic.wavelengthSampler(table, hdu.fields, wcs) : null,
      fingerprint: Pair.fingerprintValues(values), meta: null, footprint: null,
    };
    image.meta = Pair.describeObservation(hdu, entry.hduIndex, { wavelength });
    image.footprint = wcs ? Mosaic.describeFootprint(Object.assign({}, image, { name: entry.name })) : null;
    return image;
  }

  async function showHdu(entry, version) {
    const token = ++entry.hduVersion;
    entry.image = null;
    entry.loading = true;
    entry.error = "";
    entry.message = "Reading image pixels…";
    inputsChanged();
    try {
      const image = await readImage(entry, version, token);
      if (!image) return;
      entry.image = image;
      entry.loading = false;
      entry.message = entry.name + " loaded." + (image.wcs ? "" : " No usable sky coordinates.");
    } catch (error) {
      if (version !== entry.version || token !== entry.hduVersion) return;
      entry.loading = false;
      entry.image = null;
      entry.error = entry.name + " could not be read. " + error.message;
      entry.message = "";
    }
    inputsChanged();
    announce(entry.error || entry.message);
  }

  async function openEntry(entry) {
    const version = ++entry.version;
    try {
      const hdus = await readFitsHdus(await entry.file);
      if (version !== entry.version) return;
      const choices = hdus.map((hdu, index) => ({ hdu, index })).filter(({ hdu }) => hdu.renderable);
      if (!choices.length) {
        const reasons = hdus.map((hdu, index) => "HDU " + index + " (" + hdu.name + "): " + whyNotDisplayable(hdu));
        throw new Error("This file has no image HDU that Mosaic Builder can read. " + reasons.join("; ") + ".");
      }
      const preferred = choices.find(({ hdu }) => hdu.fields.EXTNAME === "IMAGE") ?? choices[0];
      Object.assign(entry, { hdus, choices, hduIndex: preferred.index });
      await showHdu(entry, version);
    } catch (error) {
      if (version !== entry.version) return;
      Object.assign(entry, { hdus: null, choices: [], hduIndex: -1, image: null, loading: false, error: entry.name + " could not be opened. " + error.message, message: "" });
      inputsChanged();
      announce(entry.error);
    }
  }

  function addFiles(files, isExample = false) {
    const added = [];
    const skipped = [];
    let full = 0;
    for (const { file, name } of files) {
      const entry = newEntry(file, name, isExample);
      if (state.entries.some((other) => other.key === entry.key)) {
        skipped.push(name);
        continue;
      }
      if (state.entries.length >= Mosaic.limits.maxInputs) {
        full++;
        continue;
      }
      state.entries.push(entry);
      added.push(entry);
    }
    const parts = [];
    if (added.length) parts.push(plural(added.length, "file") + " added.");
    if (skipped.length) parts.push(skipped.join(", ") + (skipped.length === 1 ? " is" : " are") + " already in the list (same file name, size and date), so " + (skipped.length === 1 ? "it was" : "they were") + " not added again. To use another image HDU of a file, change the HDU in its row.");
    if (full) parts.push(plural(full, "file") + " not added: a mosaic accepts at most " + Mosaic.limits.maxInputs + " inputs.");
    setStatus(parts.join(" ") || "No file was added.", !added.length && Boolean(skipped.length || full));
    announce(parts.join(" "));
    inputsChanged();
    for (const entry of added) openEntry(entry);
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
            { file: new File([decode(spherexTimeMachineExample.reference)], "SPHEREx-QR2-2025W21_2C_0280_1-D2.fits"), name: "SPHEREx-QR2-2025W21_2C_0280_1-D2.fits" },
            { file: new File([decode(spherexTimeMachineExample.comparison)], "SPHEREx-QR2-2025W24_1A_0514_1-D2.fits"), name: "SPHEREx-QR2-2025W24_1A_0514_1-D2.fits" },
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

  // ---- Inputs and settings -> plan -----------------------------------------------------------------------------------
  function readyEntries() {
    return state.entries.filter((entry) => entry.image);
  }

  // The model input of an entry. A file that appears twice (two HDUs) is told apart by its HDU number.
  function modelInput(entry) {
    const image = entry.image;
    const twice = state.entries.filter((other) => other.file === entry.file).length > 1;
    return {
      name: entry.name + (twice ? " [HDU " + entry.hduIndex + "]" : ""), meta: image.meta, width: image.width, height: image.height, values: image.values,
      wcs: image.wcs, wcsReason: image.wcsReason, unit: image.unit, fields: image.fields, variance: image.variance, varianceUnit: image.varianceUnit,
      fingerprint: image.fingerprint, wavelength: image.wavelength, wavelengthAt: image.wavelengthAt,
    };
  }

  function parseSettings(ready) {
    const options = { mode: state.mode };
    const problems = [];
    const scale = state.scale.trim();
    if (scale) {
      const value = Number(scale);
      if (!Number.isFinite(value) || value <= 0) problems.push("The output pixel scale must be a number greater than zero (arcsec per pixel).");
      else options.scaleArcsec = value;
    }
    for (const [name, label] of [["width", "width"], ["height", "height"]]) {
      const text = state[name].trim();
      if (!text) continue;
      const value = Number(text);
      if (!Number.isInteger(value) || value < 1) problems.push("The output " + label + " must be a whole number of pixels, at least 1.");
      else options[name] = value;
    }
    if (state.grid.startsWith("ref:")) {
      const id = Number(state.grid.slice(4));
      const index = ready.findIndex((entry) => entry.id === id);
      if (index >= 0) {
        options.gridMode = "reference";
        options.referenceIndex = index;
      }
    }
    return { options, problems };
  }

  function computePlan() {
    const ready = readyEntries();
    if (state.entries.some((entry) => entry.loading)) return { kind: "loading", ready };
    if (ready.length < 2) return { kind: "few", ready, count: ready.length };
    const { options, problems } = parseSettings(ready);
    if (problems.length) return { kind: "settings", ready, problems };
    const inputs = ready.map(modelInput);
    const outcome = Mosaic.preflight(inputs, options);
    return { kind: outcome.ok ? "ok" : "refused", ready, inputs, options, outcome, variance: Mosaic.varianceAvailability(inputs) };
  }

  function clearResult() {
    state.buildToken++; // Stops a running build.
    state.building = false;
    state.result = null;
    state.resultEntries = null;
    state.resultInputs = null;
    state.selected = null;
    state.pictures = { mosaic: null, coverage: null };
    state.ranges = { gray: null };
    window.AstroNotLatestMosaic = null;
    el.progress.hidden = true;
    el.exportStatus.textContent = "";
  }

  // Inputs changed (files, HDUs, removals): the previous mosaic no longer describes the selection.
  function inputsChanged() {
    const hadResult = Boolean(state.result) || state.building;
    clearResult();
    el.buildStatus.textContent = hadResult ? "The inputs changed, so the previous mosaic was discarded. Build it again." : "";
    refresh();
  }

  function settingsChanged() {
    const hadResult = Boolean(state.result) || state.building;
    clearResult();
    el.buildStatus.textContent = hadResult ? "The settings changed, so the previous mosaic was discarded. Build it again." : "";
    refresh();
  }

  function refresh() {
    state.plan = computePlan();
    renderInputs();
    renderSettings();
    renderPlan();
    renderFootprints();
    renderResult();
    renderLegend();
    renderReadout();
    renderButtons();
    syncView();
    invalidate();
  }

  // ---- Rendering: inputs ---------------------------------------------------------------------------------------------
  function bandText(entry) {
    const image = entry.image;
    if (!image) return "—";
    if (image.wavelength) return significant(image.wavelength.center.micron, 4) + " μm (bandwidth " + significant(image.wavelength.center.bandwidth, 3) + " μm; " + significant(image.wavelength.min, 4) + "–" + significant(image.wavelength.max, 4) + " across the image)";
    const filter = image.meta && image.meta.filter;
    return filter ? "Filter " + filter : "Unavailable";
  }

  function flagsOf(plan) {
    const flags = new Map(); // entry id -> { kind, text }
    if (!plan || plan.kind !== "refused") return flags;
    const outcome = plan.outcome;
    const entryAt = (index) => plan.ready[index];
    if (outcome.code === "duplicate" && outcome.inputs) {
      const [a, b] = outcome.inputs;
      flags.set(entryAt(b).id, { kind: "duplicate", text: "Duplicate of input " + (state.entries.indexOf(entryAt(a)) + 1) + ": identical pixel values. Remove one of them." });
      flags.set(entryAt(a).id, { kind: "duplicate", text: "Identical to input " + (state.entries.indexOf(entryAt(b)) + 1) + "." });
    } else if (Number.isInteger(outcome.input) && entryAt(outcome.input)) {
      flags.set(entryAt(outcome.input).id, { kind: "problem", text: outcome.reason });
    }
    return flags;
  }

  function renderInputs() {
    const entries = state.entries;
    el.inputsEmpty.hidden = entries.length > 0;
    el.inputsWrap.hidden = entries.length === 0;
    const flags = flagsOf(state.plan);
    const rows = entries.map((entry, index) => {
      const row = document.createElement("tr");
      const flag = flags.get(entry.id);
      row.dataset.state = entry.error ? "error" : entry.loading ? "loading" : "ready";
      if (flag) row.dataset.flag = flag.kind;
      const image = entry.image;
      const meta = image && image.meta;

      const number = document.createElement("th");
      number.scope = "row";
      const chip = document.createElement("span");
      chip.className = "mb-chip";
      chip.style.setProperty("--chip", palette[index % palette.length]);
      chip.textContent = String(index + 1);
      number.append(chip);

      const name = document.createElement("td");
      const title = document.createElement("span");
      title.className = "mb-name";
      title.textContent = entry.name;
      const sub = document.createElement("span");
      sub.className = "mb-sub";
      sub.textContent = entry.error ? "" : entry.loading ? entry.message : (meta && meta.obsId ? "Observation " + meta.obsId : "Observation ID unavailable") + (entry.isExample ? " · SPHEREx example" : " · local file");
      name.append(title, sub);
      if (entry.error) {
        const error = document.createElement("span");
        error.className = "mb-error";
        error.textContent = entry.error;
        name.append(error);
      }
      if (flag) {
        const problem = document.createElement("span");
        problem.className = "mb-error";
        problem.textContent = flag.text;
        name.append(problem);
      }

      const hduCell = document.createElement("td");
      if (entry.choices.length) {
        const select = document.createElement("select");
        select.setAttribute("aria-label", "Image HDU of input " + (index + 1) + ", " + entry.name);
        for (const { hdu, index: hduIndex } of entry.choices) select.append(new Option(hduIndex + " · " + hdu.name + " (" + hdu.axes.join(" × ") + ")", hduIndex));
        select.value = String(entry.hduIndex);
        select.addEventListener("change", () => {
          entry.hduIndex = Number(select.value);
          showHdu(entry, entry.version);
        });
        hduCell.append(select);
      } else hduCell.textContent = "—";

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "workspace-button";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", "Remove input " + (index + 1) + ", " + entry.name);
      remove.addEventListener("click", () => removeEntry(entry));
      const actions = document.createElement("td");
      actions.append(remove);

      row.append(
        number, name, hduCell,
        cell(image ? image.width + " × " + image.height + " pixels" : "—"),
        cell(image ? image.unit || "Unavailable" : "—"),
        cell(bandText(entry)),
        cell(image ? image.varianceNote : "—"),
        cell(image ? image.wcs ? image.wcs.summary : "Unavailable: " + image.wcsReason : "—"),
        actions,
      );
      return row;
    });
    el.inputsBody.replaceChildren(...rows);
  }

  function removeEntry(entry) {
    const index = state.entries.indexOf(entry);
    if (index < 0) return;
    entry.version++;
    entry.hduVersion++;
    state.entries.splice(index, 1);
    setStatus(entry.name + " removed.");
    announce(entry.name + " removed. " + plural(state.entries.length, "input") + " left.");
    inputsChanged();
    const buttons = el.inputsBody.querySelectorAll("button");
    (buttons[Math.min(index, buttons.length - 1)] ?? el.file).focus();
  }

  // ---- Rendering: settings -------------------------------------------------------------------------------------------
  function renderSettings() {
    const ready = readyEntries();
    const wanted = state.grid;
    const options = [new Option("Automatic: north-up TAN grid on the footprints", "auto")];
    for (const entry of ready) options.push(new Option("WCS of input " + (state.entries.indexOf(entry) + 1) + " (" + entry.name + ")", "ref:" + entry.id));
    el.grid.replaceChildren(...options);
    if (![...el.grid.options].some((option) => option.value === wanted)) state.grid = "auto";
    el.grid.value = state.grid;
    el.mode.value = state.mode;
    const reference = state.grid !== "auto";
    el.scale.disabled = reference;
    el.scale.placeholder = reference ? "fixed by the reference WCS" : "finest input scale";
    const plan = state.plan;
    const inverse = el.mode.querySelector('option[value="inverse-variance"]');
    if (plan && plan.variance) {
      inverse.disabled = !plan.variance.ok && state.mode !== "inverse-variance";
    } else inverse.disabled = false;
    const notes = [];
    if (plan && plan.variance && !plan.variance.ok && plan.kind !== "few" && plan.kind !== "loading") notes.push(plan.variance.reason);
    if (plan && plan.kind === "settings") notes.push(...plan.problems);
    notes.push(reference
      ? "The mosaic uses the WCS of one input as its grid: that input is not resampled where it lies on the grid, and the output scale is the scale of that input. A width and height crop the grid around the center of the footprints."
      : "Leave the scale, width and height empty for the default: the finest input pixel scale and the size of the footprint union. A width and height are centered on the footprints.");
    el.settingsNote.textContent = notes.join(" ");
  }

  // ---- Rendering: plan -----------------------------------------------------------------------------------------------
  function samplingText(plan) {
    const grid = plan.outcome.grid;
    const lines = [];
    plan.outcome.inputs.forEach((input, index) => {
      const sampling = Mosaic.samplingFor(grid.scaleArcsec, grid.inputScales[index]);
      if (sampling.n > 1) lines.push("input " + (index + 1) + ": " + sampling.n + " × " + sampling.n + " samples per output pixel (output pixels " + significant(sampling.ratio, 3) + " times larger)");
    });
    return "Bilinear interpolation of surface brightness through both WCS; values are interpolated and averaged, never summed." + (lines.length ? " Output pixels are larger than the pixels of some inputs, so " + lines.join("; ") + "." : "");
  }

  function bandSummary(bands) {
    if (bands.state === "same") return "Same band: wavelength agrees within one bandwidth at the same sky positions.";
    if (bands.state === "unknown") return "Not verified: no per-pixel wavelength table or BAND/FILTER keyword in every input.";
    return "Different bands.";
  }

  function renderPlan() {
    const plan = state.plan;
    el.notes.replaceChildren();
    el.suggest.replaceChildren();
    el.suggest.hidden = true;
    el.planFacts.hidden = true;
    const pending = state.entries.length - readyEntries().length;
    if (plan.kind === "loading") {
      el.verdict.textContent = "Reading the selected files…";
    } else if (plan.kind === "few") {
      el.verdict.textContent = plan.count === 0 ? "Add two or more input images to plan the mosaic." : "Add at least one more input image. A mosaic needs two or more.";
      for (const entry of state.entries) if (entry.error) addItem(el.notes, entry.error, "tm-notes__error");
    } else if (plan.kind === "settings") {
      el.verdict.textContent = "The settings need a correction before the mosaic can be planned.";
      for (const text of plan.problems) addItem(el.notes, text, "tm-notes__error");
    } else if (plan.kind === "refused") {
      const outcome = plan.outcome;
      el.verdict.textContent = "The mosaic cannot be built from these inputs.";
      addItem(el.notes, outcome.reason, "tm-notes__error");
      if (outcome.suggestion) renderSuggestions(outcome.suggestion);
      for (const entry of state.entries) if (entry.error) addItem(el.notes, entry.error, "tm-notes__warning");
    } else {
      const { grid, units, bands, mode } = plan.outcome;
      el.verdict.textContent = "Ready: " + plural(plan.ready.length, "input") + " will be combined on a " + count(grid.width) + " × " + count(grid.height) + " pixel grid (" + count(grid.pixels) + " pixels).";
      for (const text of units.notes) addItem(el.notes, text, "tm-notes__info");
      for (const text of bands.notes) addItem(el.notes, text, "tm-notes__info");
      if (grid.autoSize && (state.width.trim() || state.height.trim())) {
        addItem(el.notes, "The footprints alone need " + grid.autoSize.width + " × " + grid.autoSize.height + " pixels at this scale; the output size you set crops or extends that field around its center.", "tm-notes__info");
      }
      const links = Mosaic.connectivity(plan.outcome.inputs);
      if (links.groups.length > 1) {
        addItem(el.notes, "The inputs fall into " + links.groups.length + " groups that do not overlap each other on the sky (" + links.groups.map((group) => group.map((index) => index + 1).join(", ")).join(" | ") + "). Pixels between them will be invalid, and there is no overlap to check the groups against each other.", "tm-notes__warning");
      }
      if (pending > 0) addItem(el.notes, plural(pending, "input") + " could not be read and " + (pending === 1 ? "is" : "are") + " not part of this mosaic. See the Selected inputs table.", "tm-notes__warning");
      el.planFacts.hidden = false;
      const set = (name, text) => setFact(el.planFacts, name, text, "data-mb-fact");
      set("grid", grid.mode === "reference"
        ? count(grid.width) + " × " + count(grid.height) + " pixels, TAN" + (plan.outcome.inputs[grid.referenceIndex].wcs.sipOrder !== null ? "-SIP" : "") + ", using the WCS of input " + (grid.referenceIndex + 1) + " (north is not necessarily up)"
        : count(grid.width) + " × " + count(grid.height) + " pixels, TAN projection, north up, east left");
      set("scale", significant(grid.scaleArcsec, 5) + " arcsec per pixel" + (grid.mode === "reference" ? " (scale of the reference WCS)" : state.scale.trim() ? " (set by you; finest input " + significant(grid.finestScale, 4) + " arcsec)" : " (the finest input scale)"));
      set("center", degrees(grid.center.ra, 6) + ", " + degrees(grid.center.dec, 6) + " (RA, Dec)");
      set("unit", (units.unitText || units.unit) + " · " + (units.kind === "surface-brightness" ? "surface brightness, averaged and never summed" : "intensive quantity, averaged and never summed") + (units.factors.some((factor) => factor !== 1) ? ". Converted inputs: " + plan.ready.map((entry, index) => units.factors[index] !== 1 ? (state.entries.indexOf(entry) + 1) + " × " + significant(units.factors[index], 6) : null).filter(Boolean).join(", ") : ""));
      set("band", bandSummary(bands));
      set("combine", mode === "inverse-variance" ? "Inverse-variance weighted mean: weight = 1 / variance of the reprojected pixel. A pixel is valid where at least one input contributes." : "Mean with equal weights over the inputs that have a valid value at the pixel." + (plan.outcome.useVariance ? " The variance of the mean is propagated." : ""));
      set("resampling", samplingText(plan));
      set("memory", "About " + megabytes(grid.memory.bytes) + " (output arrays, pictures and export " + megabytes(grid.memory.outputBytes) + ", inputs " + megabytes(grid.memory.inputBytes) + ") of the " + megabytes(Mosaic.limits.memoryBytes) + " limit. Output limit " + count(Mosaic.limits.maxPixels) + " pixels, " + count(Mosaic.limits.maxAxis) + " per axis.");
    }
    el.notes.hidden = !el.notes.children.length;
  }

  function renderSuggestions(suggestion) {
    const make = (text, action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "workspace-button";
      button.textContent = text;
      button.addEventListener("click", action);
      el.suggest.append(button);
    };
    if (suggestion.scaleArcsec) {
      make("Use a coarser scale: " + suggestion.scaleArcsec + " arcsec per pixel (" + suggestion.scaleSize.width + " × " + suggestion.scaleSize.height + " pixels)", () => {
        state.scale = String(suggestion.scaleArcsec);
        state.width = "";
        state.height = "";
        syncSettingInputs();
        settingsChanged();
        announce("Output scale set to " + suggestion.scaleArcsec + " arcsec per pixel.");
      });
    }
    if (suggestion.field) {
      make("Limit the field to the central " + suggestion.field.width + " × " + suggestion.field.height + " pixels", () => {
        state.width = String(suggestion.field.width);
        state.height = String(suggestion.field.height);
        syncSettingInputs();
        settingsChanged();
        announce("Output size limited to " + suggestion.field.width + " by " + suggestion.field.height + " pixels.");
      });
    }
    el.suggest.hidden = !el.suggest.children.length;
  }

  function syncSettingInputs() {
    el.scale.value = state.scale;
    el.width.value = state.width;
    el.height.value = state.height;
  }

  // ---- Rendering: footprints -----------------------------------------------------------------------------------------
  function renderFootprints() {
    const entries = state.entries.filter((entry) => entry.image && entry.image.footprint);
    el.footEmpty.hidden = entries.length > 0;
    el.footWrap.hidden = entries.length === 0;
    const result = state.result;
    const rows = entries.map((entry) => {
      const index = state.entries.indexOf(entry);
      const footprint = entry.image.footprint;
      const row = document.createElement("tr");
      const number = document.createElement("th");
      number.scope = "row";
      const chip = document.createElement("span");
      chip.className = "mb-chip";
      chip.style.setProperty("--chip", palette[index % palette.length]);
      chip.textContent = String(index + 1);
      number.append(chip);
      const at = result && state.resultEntries ? state.resultEntries.indexOf(entry) : -1;
      const record = at >= 0 ? result.inputs[at] : null;
      row.append(
        number,
        cell(entry.name + (entry.image.meta && entry.image.meta.obsId ? " · " + entry.image.meta.obsId : "")),
        cell(degrees(footprint.center.ra, 5) + ", " + degrees(footprint.center.dec, 5)),
        cell(footprint.widthArcmin !== null ? significant(footprint.widthArcmin, 4) + " × " + significant(footprint.heightArcmin, 4) : "Unavailable"),
        cell(degrees(footprint.rotationDegrees, 2)),
        cell(footprint.scaleArcsec !== null ? significant(footprint.scaleArcsec, 4) + " arcsec" : "Unavailable"),
        cell(record ? count(record.validPixels) + (record.invalidPixels ? " (" + count(record.invalidPixels) + " invalid inside its footprint)" : "") : "Not built yet"),
        cell(record && result.counts.valid ? (100 * record.validPixels / result.counts.valid).toFixed(1) + "%" : "—"),
      );
      return row;
    });
    el.footBody.replaceChildren(...rows);
  }

  // ---- Rendering: result ---------------------------------------------------------------------------------------------
  function renderResult() {
    const result = state.result;
    el.resultNotes.replaceChildren();
    el.resultFacts.hidden = !result;
    if (!result) {
      el.resultVerdict.textContent = state.building ? "Building the mosaic…" : "No mosaic has been built yet.";
      el.resultNotes.hidden = true;
      return;
    }
    const c = result.counts;
    el.resultVerdict.textContent = result.empty
      ? "The mosaic is empty. " + result.emptyReason
      : count(c.valid) + " valid pixels of " + count(c.total) + " (" + (100 * c.valid / c.total).toFixed(1) + "%). " + plural(c.maxCoverage, "image") + " at most cover a pixel; " + count(c.overlap) + " pixels are covered by two or more.";
    if (result.empty) addItem(el.resultNotes, result.emptyReason, "tm-notes__warning");
    for (const text of result.warnings) addItem(el.resultNotes, text, "tm-notes__warning");
    for (const text of result.notes) addItem(el.resultNotes, text, "tm-notes__info");
    for (const text of result.resampling.notes) addItem(el.resultNotes, text, "tm-notes__info");
    el.resultNotes.hidden = !el.resultNotes.children.length;
    const set = (name, text) => setFact(el.resultFacts, name, text, "data-mb-result");
    set("valid", count(c.valid) + " of " + count(c.total) + " pixels. Invalid: " + count(c.invalid) + " (covered by no input, or every covering input is NaN, BLANK or masked there). Invalid pixels are NaN in the file and 1 in MASK.");
    set("coverage", result.counts.histogram.map((pixels, number) => (number === 0 ? "none" : plural(number, "image")) + ": " + count(pixels)).join(" · "));
    set("unit", withUnit(result.unitText, "") + " · " + result.modeLabel + (result.units.factors.some((factor) => factor !== 1) ? " · inputs converted to this unit with the factors in the notes" : ""));
    set("weights", result.weights === "equal" ? "Equal weights. Each valid input counts once at a pixel." : "Weight = " + result.weights + ".");
    set("variance", result.variance ? "Available as the VARIANCE extension: " + result.varianceMode + ". Bilinear resampling correlates neighbouring pixels, so sums over several pixels must not treat these variances as independent." : "Unavailable: not every input has a VARIANCE image in matching units.");
    set("wavelength", result.wavelengthRange ? significant(result.wavelengthRange.min, 5) + "–" + significant(result.wavelengthRange.max, 5) + " μm across the inputs. A mosaic of SPHEREx exposures averages the slightly different wavelengths that each exposure has at one sky position." : "Unavailable");
    set("sources", result.inputs.map((record, index) => (index + 1) + ": " + record.name + " (" + (record.obsId ?? "observation ID unavailable") + (record.hduName ? ", HDU " + record.hduIndex + " " + record.hduName : "") + ")").join(" · "));
  }

  function renderButtons() {
    const plan = state.plan;
    const ready = plan.kind === "ok";
    el.build.setAttribute("aria-disabled", String(!ready || state.building));
    el.build.hidden = state.building;
    el.cancel.hidden = !state.building;
    el.download.setAttribute("aria-disabled", String(!state.result || state.result.empty));
    el.clear.setAttribute("aria-disabled", String(state.entries.length === 0));
    el.fit.setAttribute("aria-disabled", String(!dims()));
  }

  // ---- Panels --------------------------------------------------------------------------------------------------------
  function buildPanels() {
    const template = document.querySelector("[data-mb-panel-template]");
    for (const kind of panelKinds) {
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
      panel.roleLabel.textContent = panelLabel[kind];
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

  // The grid shown: the built mosaic, or the planned grid before it is built.
  function dims() {
    if (state.result) return { width: state.result.width, height: state.result.height, built: true };
    const plan = state.plan;
    if (plan && plan.kind === "ok") return { width: plan.outcome.grid.width, height: plan.outcome.grid.height, built: false };
    return null;
  }

  function outlinesOf(entries) {
    if (state.result) return state.result.inputs.map((record, index) => ({ index: state.entries.indexOf(state.resultEntries[index]), outline: record.outline }));
    const plan = state.plan;
    if (plan && plan.kind === "ok") return plan.outcome.grid.outlines.map((outline, index) => ({ index: state.entries.indexOf(plan.ready[index]), outline }));
    return [];
  }

  function syncView() {
    const d = dims();
    const key = d ? d.width + "x" + d.height : "";
    if (key !== state.viewKey) {
      state.viewKey = key;
      fitView();
    }
  }

  function fitSize() {
    const measured = Object.values(panels).map((panel) => ({ width: Math.max(1, panel.viewport.clientWidth), height: Math.max(1, panel.viewport.clientHeight) }));
    return { width: Math.min(...measured.map((size) => size.width)), height: Math.min(...measured.map((size) => size.height)) };
  }

  function geometry(panel) {
    const d = dims();
    return Pair.viewGeometry(state.view, d.width, d.height, panel.size, fitSize());
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
    const plan = state.plan;
    if (plan.kind === "loading") return "Reading the file…";
    if (plan.kind === "few") return "Add two or more input images to plan the mosaic.";
    if (plan.kind === "refused") return "The mosaic cannot be built. The reason is given under Output grid and checks.";
    if (plan.kind === "settings") return "Correct the settings to plan the mosaic.";
    return "Nothing to show.";
  }

  function drawOutlines(ctx, geo) {
    if (!state.outlines) return;
    ctx.lineJoin = "round";
    for (const { index, outline } of outlinesOf()) {
      if (index < 0 || !outline.length) continue;
      const color = palette[index % palette.length];
      const points = outline.map(([x, y]) => fitsToScreen(geo, x, y));
      ctx.beginPath();
      points.forEach((point, step) => (step ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)));
      ctx.closePath();
      for (const [style, width] of [["rgba(0,0,0,0.75)", 3.5], [color, 1.75]]) {
        ctx.strokeStyle = style;
        ctx.lineWidth = width;
        ctx.stroke();
      }
      // The number of the input at its first corner, inside a small dark tag.
      const tag = points[0];
      ctx.font = "600 12px Inter, Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(6,7,9,0.88)";
      ctx.fillRect(tag.x - 8, tag.y - 8, 16, 16);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.strokeRect(tag.x - 8, tag.y - 8, 16, 16);
      ctx.fillStyle = "#f8f9fb";
      ctx.fillText(String(index + 1), tag.x, tag.y + 0.5);
    }
  }

  function drawSelection(ctx, geo) {
    const selected = state.selected;
    if (!selected) return;
    const centre = fitsToScreen(geo, selected.column + 1, selected.row + 1);
    const half = geo.scale / 2;
    for (const [color, width] of [["rgba(0,0,0,0.85)", 4], ["#ffd24a", 2]]) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      if (geo.scale >= 10) ctx.rect(centre.x - half, centre.y - half, geo.scale, geo.scale);
      else ctx.arc(centre.x, centre.y, 9, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function renderPanel(panel) {
    panel.frame = 0;
    const d = dims();
    const result = state.result;
    if (!d) {
      panel.canvas.hidden = true;
      panel.empty.hidden = false;
      panel.empty.querySelector("p").textContent = state.building ? "Building the mosaic…" : emptyMessage();
      panel.viewport.removeAttribute("data-loaded");
      panel.viewport.removeAttribute("data-pannable");
      panel.title.textContent = "";
      panel.range.textContent = "";
      panel.zoom.textContent = "";
      panel.pointer.textContent = "";
      panel.viewport.setAttribute("aria-label", panelLabel[panel.kind] + " view, no image");
      return;
    }
    const picture = state.pictures[panel.kind];
    panel.empty.hidden = true;
    panel.canvas.hidden = false;
    panel.viewport.toggleAttribute("data-loaded", true);
    resizePanel(panel);
    Pair.clampView(state.view, d.width, d.height, fitSize());
    const geo = geometry(panel);
    const ctx = panel.ctx;
    const ratio = panel.size.ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = "#060709";
    ctx.fillRect(0, 0, panel.size.width, panel.size.height);
    ctx.imageSmoothingEnabled = false;
    const origin = fitsToScreen(geo, 0.5, d.height + 0.5);
    const extent = { x: origin.x, y: origin.y, width: d.width * geo.scale, height: d.height * geo.scale };
    ctx.fillStyle = hatchPattern(ctx);
    ctx.fillRect(extent.x, extent.y, extent.width, extent.height);
    if (picture) ctx.drawImage(picture, extent.x, extent.y, extent.width, extent.height);
    ctx.strokeStyle = "#4a505a";
    ctx.lineWidth = 1;
    ctx.strokeRect(extent.x - 0.5, extent.y - 0.5, extent.width + 1, extent.height + 1);
    drawOutlines(ctx, geo);
    drawSelection(ctx, geo);

    const sizeText = d.width + " × " + d.height + " pixels";
    panel.title.textContent = result ? sizeText + " · " + plural(result.inputs.length, "input") : "Planned grid " + sizeText + " · not built yet";
    panel.canvas.setAttribute("aria-label", panelLabel[panel.kind] + ", " + sizeText + (result ? ", " + count(result.counts.valid) + " valid pixels" : ", not built yet"));
    panel.viewport.setAttribute("aria-label", panelLabel[panel.kind] + " view");
    if (!result) {
      panel.range.textContent = "Build the mosaic to fill this view. The outlines show where each input falls on the planned grid.";
    } else if (panel.kind === "mosaic") {
      panel.range.textContent = state.ranges.gray ? "Display range " + significant(state.ranges.gray.low) + " to " + significant(state.ranges.gray.high) + " " + result.unitText + " · gray stretch for display only" : "Display range unavailable";
    } else {
      panel.range.textContent = "Number of inputs with a valid value per pixel: 1 to " + result.counts.maxCoverage + " (see the legend below)";
    }
    const zoom = state.view.zoom;
    panel.zoom.textContent = "Zoom " + (zoom < 10 ? zoom.toFixed(1) : zoom.toFixed(0)) + "× (1× shows the whole grid) · pan and zoom linked";
    panel.viewport.toggleAttribute("data-pannable", zoom > 1.001);
    panel.viewport.toggleAttribute("data-selected", Boolean(state.selected));
    updatePointerLine(panel, geo, d);
  }

  function pixelOfFits(d, x, y) {
    if (!insideImage(x, y, d.width, d.height)) return null;
    const column = Math.min(d.width - 1, Math.floor(x - 0.5));
    const row = Math.min(d.height - 1, Math.floor(y - 0.5));
    return { column, row };
  }

  function updatePointerLine(panel, geo, d) {
    if (!panel.point) {
      panel.pointer.textContent = "Pointer: move over the image to read the pixel value.";
      return;
    }
    const at = screenToFits(geo, panel.point.x, panel.point.y);
    const pixel = pixelOfFits(d, at.x, at.y);
    if (!pixel) {
      panel.pointer.textContent = "Pointer: outside the output grid";
      return;
    }
    const wcs = state.result ? state.result.wcs : state.plan.outcome.grid.wcs;
    const sky = wcs.pixelToSky(pixel.column + 1, pixel.row + 1);
    let reading = "";
    if (state.result) {
      const info = Mosaic.pixelAt(state.result, pixel.column, pixel.row);
      reading = " · " + (panel.kind === "mosaic" ? (info.valid ? withUnit(significant(info.value, 7), state.result.unitText) : "invalid") : plural(info.coverage, "image"));
    }
    panel.pointer.textContent = "Pointer: pixel " + (pixel.column + 1) + ", " + (pixel.row + 1) + (sky ? " · RA " + degrees(sky.ra) + ", Dec " + degrees(sky.dec) : "") + reading;
  }

  // ---- View changes --------------------------------------------------------------------------------------------------
  function fitView() {
    const d = dims();
    state.view = d ? Pair.createView(d.width, d.height) : { zoom: 1, centerX: 1, centerY: 1 };
  }

  function zoomBy(panel, factor, sx, sy) {
    const d = dims();
    if (!d) return;
    Pair.zoomViewAt(state.view, factor, d.width, d.height, panel.size, fitSize(), sx, sy);
    invalidate();
  }

  function panBy(panel, dx, dy) {
    const d = dims();
    if (!d) return;
    Pair.panViewByScreen(state.view, dx, dy, d.width, d.height, panel.size, fitSize());
    invalidate();
  }

  // ---- Selecting a pixel ---------------------------------------------------------------------------------------------
  function selectPixel(column, row, options = {}) {
    const result = state.result;
    if (!result) return;
    column = Math.min(result.width - 1, Math.max(0, column));
    row = Math.min(result.height - 1, Math.max(0, row));
    state.selected = { column, row };
    if (options.reveal) revealSelection();
    renderReadout();
    invalidate();
    announce(readoutSentence(), options.delay ?? 0);
  }

  function revealSelection() {
    const result = state.result;
    const panel = panels.mosaic;
    if (!result || !state.selected) return;
    const geo = geometry(panel);
    const at = fitsToScreen(geo, state.selected.column + 1, state.selected.row + 1);
    const margin = Math.min(panel.size.width, panel.size.height) * 0.12;
    if (at.x < margin || at.y < margin || at.x > panel.size.width - margin || at.y > panel.size.height - margin) {
      state.view.centerX = state.selected.column + 1;
      state.view.centerY = state.selected.row + 1;
      Pair.clampView(state.view, result.width, result.height, fitSize());
    }
  }

  function moveSelection(dx, dy) {
    const result = state.result;
    if (!result) return;
    if (!state.selected) {
      selectPixel(Math.floor(state.view.centerX - 0.5), Math.floor(state.view.centerY - 0.5), { reveal: true, delay: 120 });
      return;
    }
    selectPixel(state.selected.column + dx, state.selected.row + dy, { reveal: true, delay: 150 });
  }

  function readoutSentence() {
    const result = state.result;
    const selected = state.selected;
    if (!result || !selected) return "";
    const info = Mosaic.pixelAt(result, selected.column, selected.row);
    return "Pixel " + (selected.column + 1) + ", " + (selected.row + 1) + ". " + (info.valid ? "Mosaic " + withUnit(significant(info.value, 7), result.unitText) : "Invalid, covered by no input") + ". " + plural(info.coverage, "image") + ".";
  }

  const stateText = { 0: "Contributes", 1: "Outside this input", 3: "Touches a NaN or masked pixel" };

  function renderReadout() {
    const result = state.result;
    const selected = state.selected;
    for (const button of [el.pixelGo]) button.setAttribute("aria-disabled", String(!result));
    el.pixelCenter.setAttribute("aria-disabled", String(!selected));
    el.pixelClear.setAttribute("aria-disabled", String(!selected));
    el.readout.hidden = !(result && selected);
    if (!result || !selected) {
      el.readoutBody.replaceChildren();
      if (!selected) el.pixelNote.textContent = result
        ? "Select a pixel in either view, or enter its position below. Pixel positions are FITS pixel numbers on the mosaic grid (1 to " + result.width + " in x, 1 to " + result.height + " in y), where the first pixel is (1, 1)."
        : "Build a mosaic first. Then select a pixel in either view, or enter its position here.";
      return;
    }
    el.pixelX.value = String(selected.column + 1);
    el.pixelY.value = String(selected.row + 1);
    el.pixelNote.textContent = "Selected pixel " + (selected.column + 1) + ", " + (selected.row + 1) + " on the mosaic grid.";
    const info = Mosaic.pixelAt(result, selected.column, selected.row);
    const sky = result.wcs.pixelToSky(selected.column + 1, selected.row + 1);
    const rows = [];
    rows.push(["Pixel (x, y), mosaic grid", (selected.column + 1) + ", " + (selected.row + 1)]);
    rows.push(["RA, Dec (ICRS)", sky ? degrees(sky.ra, 6) + ", " + degrees(sky.dec, 6) : "Unavailable"]);
    rows.push([result.modeLabel, info.valid ? withUnit(significant(info.value, 8), result.unitText) : "Invalid · no input has a valid value here", info.valid ? "" : "invalid"]);
    rows.push(["Coverage", plural(info.coverage, "image") + " with a valid value"]);
    rows.push(["Variance of the mosaic", info.variance !== null ? significant(info.variance, 6) + " (" + result.unitText + ")²" : result.variance ? "Unavailable at this pixel" : "Unavailable (needs a variance image in every input)"]);
    const pieces = Mosaic.pixelContributions(result, state.resultInputs, selected.column, selected.row);
    for (const piece of pieces) {
      const entryIndex = state.entries.indexOf(state.resultEntries[piece.index]);
      const label = "Input " + (entryIndex + 1) + " · " + (piece.obsId ?? "ID unavailable");
      const where = piece.position && Number.isFinite(piece.position.x) ? " · file position " + piece.position.x.toFixed(2) + ", " + piece.position.y.toFixed(2) : "";
      const factor = result.units.factors[piece.index];
      rows.push([label, piece.value !== null
        ? withUnit(significant(piece.value, 7), result.unitText) + " (bilinear" + (factor !== 1 ? ", converted × " + significant(factor, 6) : "") + ")" + where
        : piece.reason + where, piece.value === null ? "invalid" : ""]);
    }
    el.readoutBody.replaceChildren(...rows.map(([label, value, flag]) => {
      const row = document.createElement("tr");
      const head = document.createElement("th");
      head.scope = "row";
      head.textContent = label;
      const body = document.createElement("td");
      body.textContent = value;
      if (flag) body.dataset.state = flag;
      row.append(head, body);
      return row;
    }));
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
    const selectAt = (point) => {
      const d = dims();
      if (!d || !state.result) return;
      const at = screenToFits(geometry(panel), point.x, point.y);
      if (!insideImage(at.x, at.y, d.width, d.height)) {
        announce("That point is outside the output grid, so no pixel was selected.");
        return;
      }
      selectPixel(Math.floor(at.x - 0.5), Math.floor(at.y - 0.5));
    };

    viewport.addEventListener("pointerdown", (event) => {
      if (!dims() || (event.pointerType === "mouse" && event.button !== 0)) return;
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
      if (!dims()) return;
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
      if (wasTap && point) selectAt(point);
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
      if (!dims() || !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const point = local(event);
      zoomBy(panel, Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0025)), point.x, point.y);
    }, { passive: false });

    viewport.addEventListener("keydown", (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey || !dims()) return;
      const step = event.shiftKey ? 10 : 1;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (moves[event.key]) {
        event.preventDefault();
        moveSelection(...moves[event.key]);
        return;
      }
      const actions = {
        "+": () => zoomBy(panel, zoomStep),
        "=": () => zoomBy(panel, zoomStep),
        "-": () => zoomBy(panel, 1 / zoomStep),
        "_": () => zoomBy(panel, 1 / zoomStep),
        "0": () => { fitView(); invalidate(); },
        Home: () => { fitView(); invalidate(); },
        Enter: () => selectPixel(Math.floor(state.view.centerX - 0.5), Math.floor(state.view.centerY - 0.5), { reveal: false }),
      };
      const action = actions[event.key];
      if (!action) return; // Tab and other keys keep their normal behavior, so focus can leave the view.
      event.preventDefault();
      action();
    });
  }

  // ---- Pictures (display only) ---------------------------------------------------------------------------------------
  function clipFractions() {
    const [low, high] = state.clip.split("-").map(Number);
    return [low / 100, high / 100];
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
        if (!valid[index] || !range) continue; // Transparent: the hatch shows through.
        const shade = span > 0 ? Math.max(0, Math.min(255, 255 * (values[index] - range.low) / span)) : 128;
        picture.data[at] = picture.data[at + 1] = picture.data[at + 2] = shade;
        picture.data[at + 3] = 255;
      }
    }
    context.putImageData(picture, 0, 0);
  }

  // Color of a coverage count: 1 is the first stop, the largest count the last.
  function coverageColor(number, maximum) {
    const t = maximum <= 1 ? 0.5 : (number - 1) / (maximum - 1);
    const scaled = t * (coverageStops.length - 1);
    const low = Math.min(coverageStops.length - 2, Math.floor(scaled));
    const f = scaled - low;
    return coverageStops[low].map((channel, k) => Math.round(channel + f * (coverageStops[low + 1][k] - channel)));
  }

  function paintCoverage(canvas, coverage, width, height, maximum) {
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    const picture = context.createImageData(width, height);
    const table = Array.from({ length: maximum + 1 }, (_, number) => (number ? coverageColor(number, maximum) : null));
    for (let y = 0; y < height; y++) {
      const sourceRow = (height - y - 1) * width;
      for (let x = 0; x < width; x++) {
        const color = table[coverage[sourceRow + x]];
        if (!color) continue;
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
    const result = state.result;
    state.ranges = { gray: null };
    state.pictures = { mosaic: null, coverage: null };
    if (!result) return;
    const make = () => document.createElement("canvas");
    state.ranges.gray = Pair.displayRange([result.values], ...clipFractions());
    state.pictures.mosaic = make();
    paintGray(state.pictures.mosaic, result.values, result.valid, state.ranges.gray, result.width, result.height);
    state.pictures.coverage = make();
    paintCoverage(state.pictures.coverage, result.coverage, result.width, result.height, Math.max(1, result.counts.maxCoverage));
  }

  function renderLegend() {
    const result = state.result;
    el.legend.hidden = !result;
    if (!result) return;
    const maximum = Math.max(1, result.counts.maxCoverage);
    const items = [];
    for (let number = 1; number <= maximum; number++) {
      const item = document.createElement("li");
      const swatch = document.createElement("span");
      swatch.className = "mb-swatch";
      swatch.style.background = "rgb(" + coverageColor(number, maximum).join(",") + ")";
      swatch.setAttribute("aria-hidden", "true");
      item.append(swatch, document.createTextNode(plural(number, "image") + ": " + count(result.counts.histogram[number]) + " pixels"));
      items.push(item);
    }
    el.legendList.replaceChildren(...items);
  }

  // ---- Build, export, buttons ----------------------------------------------------------------------------------------
  async function build() {
    const plan = state.plan;
    if (plan.kind !== "ok" || state.building) return;
    clearResult();
    const token = state.buildToken;
    state.building = true;
    el.progress.hidden = false;
    el.progress.value = 0;
    el.buildStatus.textContent = "Building the mosaic…";
    renderButtons();
    renderResult();
    announce("Building the mosaic.");
    const entries = plan.ready.slice();
    const inputs = plan.inputs;
    const outcome = await Mosaic.buildMosaicAsync(inputs, plan.options, {
      cancelled: () => token !== state.buildToken,
      pause: () => new Promise((resolve) => setTimeout(resolve, 0)),
      onProgress: (step) => {
        if (token !== state.buildToken) return;
        el.progress.value = step.total ? step.done / step.total : 0;
        el.buildStatus.textContent = step.label + " " + Math.round(100 * step.done / Math.max(1, step.total)) + "%";
      },
    });
    if (token !== state.buildToken) return; // Cancelled, or the inputs or settings changed meanwhile.
    state.building = false;
    el.progress.hidden = true;
    if (!outcome.ok) {
      el.buildStatus.textContent = "The mosaic was not built. " + outcome.reason;
      refresh();
      return;
    }
    state.result = outcome.result;
    state.resultEntries = entries;
    state.resultInputs = inputs;
    window.AstroNotLatestMosaic = state.result; // For tests and other tools.
    buildPictures();
    fitView();
    el.buildStatus.textContent = "Mosaic built: " + count(state.result.counts.valid) + " valid pixels on a " + state.result.width + " × " + state.result.height + " grid.";
    refresh();
    announce(el.buildStatus.textContent);
  }

  function cancelBuild() {
    if (!state.building) return;
    clearResult();
    el.buildStatus.textContent = "The build was cancelled.";
    announce("The build was cancelled.");
    refresh();
    el.build.focus();
  }

  function downloadResult() {
    const result = state.result;
    if (!result || result.empty) return;
    const bytes = Mosaic.buildMosaicFits(result);
    const name = "AstroNot-mosaic_" + result.inputs.length + "-inputs_" + result.width + "x" + result.height + ".fits";
    const link = document.createElement("a");
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/fits" }));
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    el.exportStatus.textContent = "Saved " + name + " (" + count(bytes.length) + " bytes): MOSAIC, MASK, COVERAGE" + (result.variance ? ", VARIANCE" : "") + ", with the WCS, BUNIT and " + plural(result.inputs.length, "source") + ".";
  }

  function readPixelInputs() {
    const result = state.result;
    if (!result) return;
    const x = Number(el.pixelX.value.trim());
    const y = Number(el.pixelY.value.trim());
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 1 || y < 1 || x > result.width || y > result.height) {
      el.pixelNote.textContent = "Enter whole pixel numbers: x from 1 to " + result.width + " and y from 1 to " + result.height + ".";
      return;
    }
    selectPixel(x - 1, y - 1, { reveal: true });
  }

  function wire() {
    el.file.addEventListener("change", () => {
      const files = [...el.file.files];
      el.file.value = ""; // So choosing the same file again fires another change.
      if (files.length) addFiles(files.map((file) => ({ file, name: file.name })));
    });
    el.file.disabled = false;

    el.example.addEventListener("click", async () => {
      setStatus("Loading the example pair…");
      try {
        addFiles(await loadExample(), true);
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
      for (const entry of state.entries) { entry.version++; entry.hduVersion++; }
      state.entries = [];
      setStatus("All inputs removed.");
      announce("All inputs removed.");
      inputsChanged();
      el.file.focus();
    });
    press(el.build, build);
    el.cancel.addEventListener("click", cancelBuild);
    press(el.download, downloadResult);
    press(el.fit, () => { fitView(); invalidate(); announce("All views fitted to the whole grid."); });
    press(el.pixelGo, readPixelInputs);
    press(el.pixelCenter, () => {
      if (!state.selected) return;
      state.view.centerX = state.selected.column + 1;
      state.view.centerY = state.selected.row + 1;
      invalidate();
      announce("Views centered on pixel " + (state.selected.column + 1) + ", " + (state.selected.row + 1) + ".");
    });
    press(el.pixelClear, () => {
      state.selected = null;
      renderReadout();
      invalidate();
      announce("Selected pixel cleared.");
    });
    for (const input of [el.pixelX, el.pixelY]) {
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          readPixelInputs();
        }
      });
    }

    el.mode.addEventListener("change", () => { state.mode = el.mode.value; settingsChanged(); });
    el.grid.addEventListener("change", () => { state.grid = el.grid.value; settingsChanged(); });
    for (const [name, input] of [["scale", el.scale], ["width", el.width], ["height", el.height]]) {
      input.addEventListener("input", () => { state[name] = input.value; settingsChanged(); });
    }
    el.clip.addEventListener("change", () => { state.clip = el.clip.value; buildPictures(); invalidate(); });
    el.outlines.addEventListener("change", () => { state.outlines = el.outlines.checked; invalidate(); });
  }

  buildPanels();
  wire();
  refresh();
})();
