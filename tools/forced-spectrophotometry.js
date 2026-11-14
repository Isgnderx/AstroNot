// Forced Spectrophotometry: SPHEREx spectra by forced ePSF photometry on every frame of a frame list, read from the IRSA archive
// copy on Amazon S3 (or from local FITS files). ALL measurement, frame selection, target parsing and CSV logic is in
// tools/forced-phot.js (the port of spxphot), FITS byte-range reading in tools/fits-range.js, SIA CSV reading in
// tools/observation-csv.js, coordinate parsing in tools/xmatch.js and the spectrum plot in tools/forced-spectrophotometry-plot.js.
// This file is the user interface only.
(function () {
  "use strict";

  const FP = AstroNotForcedPhot;
  const Range = AstroNotFitsRange;
  const Xmatch = AstroNotXmatch;

  const maxTargets = 20;
  const maxListedFrames = 500;
  const defaultConcurrency = 6;
  const query = (name, scope = document) => scope.querySelector("[data-fs-" + name + "]");

  const el = {
    csv: query("csv"), fits: query("fits"), example: query("example"), clear: query("clear"), status: query("status"),
    framesWrap: query("frames-wrap"), framesCaption: query("frames-caption"), frames: query("frames"),
    unit: query("unit"), addTarget: query("add-target"), targetsCsv: query("targets-csv"), targets: query("targets"), targetsStatus: query("targets-status"),
    paramsStatus: query("params-status"),
    measure: query("measure"), cancel: query("cancel"), progressWrap: query("progress-wrap"), progress: query("progress"), progressText: query("progress-text"),
    runStatus: query("run-status"), stale: query("stale"),
    verdict: query("verdict"), plot: query("plot"), resultsWrap: query("results-wrap"), resultsHead: query("results-head"), results: query("results"), report: query("report"),
    downloadIrsa: query("download-irsa"), downloadLab: query("download-lab"), exportStatus: query("export-status"),
  };
  // The spectrum plot (tools/forced-spectrophotometry-plot.js) reports a point chosen there through selectRow.
  const plot = AstroNotForcedSpectrumPlot.create({ figure: el.plot, onSelect: (index) => selectRow(index, { fromPlot: true }) });
  const fields = {};
  for (const input of document.querySelectorAll("[data-fs-param]")) fields[input.dataset.fsParam] = input;
  const detectorBoxes = [...document.querySelectorAll("[data-fs-detector]")];

  // frames: engine Frame objects (frameFromImportRow) plus { sourceName, local, memory, hasEpsf }.
  // targets: the raw text of each target row. result: the last run. selected: index into result.rows (shared with the plot).
  const state = { frames: [], targets: [], params: null, filters: null, run: null, result: null, selected: null, sort: null, order: [], nextTarget: 1, exampleScripts: {} };

  // ---- Small helpers --------------------------------------------------------------------------------------------------------------
  function writeStatus(node, message, error = false) {
    node.toggleAttribute("data-error", error);
    node.textContent = message;
  }
  const setStatus = (message, error) => writeStatus(el.status, message, error);
  const setRunStatus = (message, error) => writeStatus(el.runStatus, message, error);

  function setDisabled(button, disabled) {
    button.setAttribute("aria-disabled", String(disabled));
  }
  const isDisabled = (button) => button.getAttribute("aria-disabled") === "true";

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

  function sentence(text) {
    const s = String(text).trim();
    if (!s) return s;
    return s[0].toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? "" : ".");
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

  // ---- Frames ---------------------------------------------------------------------------------------------------------------------
  // Add frames, leaving out any whose uri is already loaded. Returns { added, duplicates }.
  function addFrames(frames) {
    const known = new Set(state.frames.map((frame) => frame.uri));
    let added = 0;
    let duplicates = 0;
    for (const frame of frames) {
      if (known.has(frame.uri)) {
        duplicates++;
        continue;
      }
      known.add(frame.uri);
      state.frames.push(frame);
      added++;
    }
    linkLocalFrames();
    return { added, duplicates };
  }

  // A local file takes the collection of an imported frame row with the same observation ID and detector; otherwise it has none.
  function linkLocalFrames() {
    for (const frame of state.frames) {
      if (!frame.local) continue;
      const twin = state.frames.find((other) => !other.local && other.obsId && other.obsId === frame.obsId && other.detector === frame.detector);
      frame.collection = twin ? twin.collection : "";
      frame.dataCollection = twin ? twin.dataCollection : "";
      frame.deep = twin ? twin.deep : false;
    }
  }

  function collectionCounts() {
    const counts = new Map();
    for (const frame of state.frames) {
      const key = frame.collection || "local, no collection";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts].map(([name, count]) => name + " " + count).join(", ");
  }

  function loadedSummary() {
    return state.frames.length ? plural(state.frames.length, "frame") + " loaded (" + collectionCounts() + ")." : "No frame loaded.";
  }

  // Read SIA CSV texts ([{ name, text }]) into frames.
  function importCsvTexts(files) {
    const incoming = [];
    const notes = [];
    for (const { name, text } of files) {
      const parsed = parseIrsaResults(text);
      if (!parsed.ok) {
        notes.push(name + " was not read: " + parsed.message);
        continue;
      }
      let notFrames = 0;
      for (const row of parsed.rows) {
        const frame = FP.frameFromImportRow(row);
        if (!frame) notFrames++;
        else incoming.push({ ...frame, sourceName: name, local: false, memory: null, hasEpsf: null });
      }
      const left = parsed.skipped.length + notFrames;
      if (left) notes.push(name + ": " + plural(left, "row") + " of " + parsed.total + " left out (not a SPHEREx level 2 FITS file on IRSA, or unreadable).");
    }
    const { added, duplicates } = addFrames(incoming);
    renderFrames();
    afterInputsChanged();
    const head = plural(added, "frame") + " added, " + plural(duplicates, "duplicate") + " left out. ";
    setStatus((head + loadedSummary() + " " + notes.join(" ")).trim(), added === 0 && notes.length > 0);
    return added;
  }

  async function importCsvFiles(files) {
    setStatus("Reading " + plural(files.length, "CSV file") + "…");
    const texts = [];
    const failed = [];
    for (const file of files) {
      try {
        texts.push({ name: file.name, text: await file.text() });
      } catch (error) {
        failed.push(file.name + " could not be read: " + error.message);
      }
    }
    importCsvTexts(texts);
    if (failed.length) setStatus(el.status.textContent + " " + failed.join(" "), true);
  }

  // A local FITS file: the IMAGE header gives the observation ID, detector and mid-exposure MJD; the run reads it from memory.
  async function readLocalFits(file) {
    const memory = Range.createMemorySource(new Uint8Array(await file.arrayBuffer()));
    const hdus = await Range.walkHdus(memory, { until: "WCS-WAVE", max: 8 });
    const image = hdus.find((hdu) => hdu.name === "IMAGE");
    if (!image) throw new Error("it has no IMAGE extension, so it is not a SPHEREx level 2 file");
    const obsId = image.header.get("OBSID");
    const detector = image.header.num("DETECTOR", NaN);
    return {
      uri: file.name, url: null,
      obsId: typeof obsId === "string" ? obsId.trim() : "",
      collection: "", dataCollection: "", deep: false,
      detector: Number.isInteger(detector) ? detector : null,
      mjd: image.header.num("MJD-AVG", NaN),
      sourceName: file.name, local: true, memory, hasEpsf: hdus.some((hdu) => hdu.name === "EPSF"),
    };
  }

  async function addLocalFiles(files) {
    setStatus("Reading " + plural(files.length, "FITS file") + "…");
    const incoming = [];
    const notes = [];
    for (const file of files) {
      try {
        const frame = await readLocalFits(file);
        incoming.push(frame);
        if (!frame.hasEpsf) notes.push(file.name + " has no EPSF extension (pre-QR3 data?); it stays in the list and the run will skip it.");
      } catch (error) {
        notes.push(file.name + " could not be opened: " + (error && error.message ? error.message : String(error)) + ".");
      }
    }
    const { added, duplicates } = addFrames(incoming);
    renderFrames();
    afterInputsChanged();
    const head = plural(added, "local frame") + " added, " + plural(duplicates, "duplicate") + " left out. ";
    setStatus((head + loadedSummary() + " " + notes.join(" ")).trim(), added === 0 && notes.length > 0);
  }

  async function useExample() {
    try {
      await loadScript("bd17", "assets/tools/spherex-bd17-frames.js");
    } catch (error) {
      setStatus(error.message, true);
      return;
    }
    const example = window.spherexBd17Frames;
    const added = importCsvTexts(example.files);
    state.targets[0] = { ...blankTarget(), label: example.target.label, ra: String(example.target.ra), dec: String(example.target.dec) };
    el.unit.value = "deg";
    renderTargets();
    afterInputsChanged();
    writeStatus(el.targetsStatus, "Target 1 is the example's position, " + example.target.label + " (frame lists retrieved from IRSA on " + example.fetched + ").");
    setStatus(el.status.textContent + (added ? " The run reads these frames from the IRSA archive copy on Amazon S3, so it needs network access (about two minutes at 6 concurrent frames)." : ""));
  }

  function removeAllFrames() {
    if (isDisabled(el.clear)) {
      setStatus("There is no frame to remove.");
      return;
    }
    state.frames = [];
    renderFrames();
    afterInputsChanged();
    setStatus("All frames removed.");
  }

  function readsFrom(frame) {
    if (!frame.local) return "S3";
    return frame.hasEpsf ? "local" : "local · no EPSF";
  }

  function renderFrames() {
    const count = state.frames.length;
    el.framesWrap.hidden = !count;
    setDisabled(el.clear, !count);
    el.framesCaption.textContent = count > maxListedFrames ? "Loaded frames (the first " + maxListedFrames + " of " + count + " are listed)" : "Loaded frames (" + count + ")";
    el.frames.replaceChildren(...state.frames.slice(0, maxListedFrames).map((frame) => {
      const row = document.createElement("tr");
      const reads = cell("td", readsFrom(frame));
      if (frame.local && !frame.hasEpsf) reads.setAttribute("data-note", "");
      row.append(
        cell("th", frame.sourceName, { scope: "row" }),
        cell("td", frame.collection || "—"),
        cell("td", frame.detector === null ? "Unavailable" : String(frame.detector)),
        cell("td", Number.isFinite(frame.mjd) ? frame.mjd.toFixed(5) : "Unavailable"),
        reads,
      );
      return row;
    }));
  }

  // ---- Targets --------------------------------------------------------------------------------------------------------------------
  function blankTarget() {
    return { id: state.nextTarget++, label: "", ra: "", dec: "", galaxy: false, n: "1", re: "", q: "1", pa: "0" };
  }

  const shapeFields = [
    ["n", "Sérsic index n"], ["re", "Effective radius Re (arcsec)"], ["q", "Axis ratio b/a"], ["pa", "Position angle (deg)"],
  ];

  // Check one target row. Returns { blank, target, problems: [{ keys, message }] }; target is what the run takes.
  function checkTarget(entry, index, unit) {
    const problems = [];
    const blank = !entry.label.trim() && !entry.ra.trim() && !entry.dec.trim() && !entry.galaxy;
    if (blank) return { blank, target: null, problems };
    const angle = (key, axis) => {
      const parsed = Xmatch.parseAngle(entry[key], axis, unit);
      if (parsed.error) problems.push({ keys: [key], message: parsed.missing ? axis.toUpperCase().replace("DEC", "Dec") + " is empty." : sentence(parsed.error) });
      return parsed.value;
    };
    const ra = angle("ra", "ra");
    const dec = angle("dec", "dec");
    const label = entry.label.replace(/[\u0000-\u001f]/g, " ").trim() || "src" + (index + 1);
    if (label.length > 80) problems.push({ keys: ["label"], message: "The label is longer than 80 characters." });
    let shape = null;
    if (entry.galaxy) {
      const values = shapeFields.map(([key, name]) => {
        const text = entry[key].trim();
        const value = text === "" ? NaN : Number(text);
        if (!Number.isFinite(value)) problems.push({ keys: [key], message: name + (text === "" ? " is empty." : " is not a number.") });
        return value;
      });
      if (values.every(Number.isFinite)) {
        const checked = FP.validateShape(...values);
        if (!checked.ok) problems.push({ keys: shapeFields.map(([key]) => key), message: sentence(checked.reason) });
        else shape = checked.shape;
      }
    }
    return { blank, problems, target: problems.length ? null : { name: label, ra, dec, shape } };
  }

  function readTargets() {
    const unit = el.unit.value;
    const checks = state.targets.map((entry, index) => checkTarget(entry, index, unit));
    const targets = checks.filter((check) => check.target).map((check) => check.target);
    const problems = [];
    checks.forEach((check, index) => {
      if (check.problems.length) problems.push("Target " + (index + 1) + ": " + check.problems.map((problem) => problem.message).join(" "));
    });
    return { checks, targets, problems };
  }

  // Write each row's problems next to its fields.
  function showTargetProblems(checks) {
    for (const [index, item] of [...el.targets.children].entries()) {
      const check = checks[index];
      if (!check) continue;
      const bad = new Set(check.problems.flatMap((problem) => problem.keys));
      for (const input of item.querySelectorAll("[data-fs-target-key]")) {
        const key = input.dataset.fsTargetKey;
        if (bad.has(key)) input.setAttribute("aria-invalid", "true");
        else input.removeAttribute("aria-invalid");
      }
      query("target-message", item).textContent = check.problems.map((problem) => problem.message).join(" ");
    }
  }

  function targetInput(entry, key, labelText, attributes) {
    const label = document.createElement("label");
    const input = cell("input", "", { type: "text", autocomplete: "off", spellcheck: "false", "data-fs-target-key": key, "aria-describedby": "fs-target-message-" + entry.id, ...attributes });
    input.value = entry[key];
    input.addEventListener("input", () => {
      entry[key] = input.value;
      afterInputsChanged();
    });
    label.append(labelText + " ", input);
    return label;
  }

  function renderTargets() {
    const unit = el.unit.value;
    const raHint = unit === "deg" ? "332.882637" : "22:11:31.83";
    const decHint = unit === "deg" ? "18.093128" : "+18:05:35.3";
    el.targets.replaceChildren(...state.targets.map((entry, index) => {
      const item = cell("li", "", { class: "fs-target" });
      const head = cell("div", "", { class: "fs-target__head" });
      const title = cell("h3", "Target " + (index + 1));
      const actions = cell("div", "", { class: "tm-actions" });
      const shapeId = "fs-target-shape-" + entry.id;
      const galaxy = cell("button", "Galaxy model", { type: "button", class: "workspace-button", "aria-pressed": String(entry.galaxy), "aria-controls": shapeId });
      const remove = cell("button", "Remove", { type: "button", class: "workspace-button", "aria-label": "Remove target " + (index + 1), "aria-disabled": String(state.targets.length === 1) });
      actions.append(galaxy, remove);
      head.append(title, actions);

      const main = cell("div", "", { class: "fs-target__fields" });
      main.append(
        targetInput(entry, "label", "Label", { placeholder: "src" + (index + 1) }),
        targetInput(entry, "ra", unit === "deg" ? "RA (degrees)" : "RA (h:m:s)", { inputmode: unit === "deg" ? "decimal" : "text", placeholder: raHint }),
        targetInput(entry, "dec", unit === "deg" ? "Dec (degrees)" : "Dec (d:m:s)", { inputmode: unit === "deg" ? "decimal" : "text", placeholder: decHint }),
      );
      const shape = cell("div", "", { class: "fs-target__shape", id: shapeId });
      shape.hidden = !entry.galaxy;
      shape.append(...shapeFields.map(([key, name]) => targetInput(entry, key, name, { inputmode: "decimal" })),
        cell("p", "Not validated: in spxphot's test the Sérsic fluxes ran about 4 % above the IRSA tool's (NGC 7619, median ratio 1.040). Treat galaxy fluxes as indicative only; see How the flux is computed.", { class: "fs-target__caveat" }));
      const message = cell("p", "", { class: "fs-target__message", id: "fs-target-message-" + entry.id, "data-fs-target-message": "" });

      galaxy.addEventListener("click", () => {
        entry.galaxy = !entry.galaxy;
        galaxy.setAttribute("aria-pressed", String(entry.galaxy));
        shape.hidden = !entry.galaxy;
        afterInputsChanged();
      });
      remove.addEventListener("click", () => {
        if (state.targets.length === 1) {
          writeStatus(el.targetsStatus, "At least one target row stays; clear its fields instead.", true);
          return;
        }
        state.targets = state.targets.filter((other) => other !== entry);
        renderTargets();
        afterInputsChanged();
        writeStatus(el.targetsStatus, "Target removed. " + plural(state.targets.length, "target row") + " left.");
        el.addTarget.focus();
      });
      item.append(head, main, shape, message);
      return item;
    }));
    setDisabled(el.addTarget, state.targets.length >= maxTargets);
    showTargetProblems(readTargets().checks);
  }

  function addTarget() {
    if (state.targets.length >= maxTargets) {
      writeStatus(el.targetsStatus, "At most " + maxTargets + " targets can be measured in one run (spxphot's limit).", true);
      return;
    }
    state.targets.push(blankTarget());
    renderTargets();
    afterInputsChanged();
    writeStatus(el.targetsStatus, plural(state.targets.length, "target row") + ".");
    const inputs = el.targets.lastElementChild.querySelectorAll("input");
    if (inputs.length > 1) inputs[1].focus();
  }

  async function loadTargetsCsv(file) {
    let text;
    try {
      text = await file.text();
    } catch (error) {
      writeStatus(el.targetsStatus, file.name + " could not be read: " + error.message, true);
      return;
    }
    const parsed = FP.parseTargetsCsv(text);
    if (!parsed.ok) {
      writeStatus(el.targetsStatus, file.name + " was not used: " + sentence(parsed.reason), true);
      return;
    }
    state.targets = parsed.targets.map((target) => ({
      ...blankTarget(), label: String(target.name), ra: String(target.ra), dec: String(target.dec), galaxy: Boolean(target.shape),
      ...(target.shape ? { n: String(target.shape.n), re: String(target.shape.reArcsec), q: String(target.shape.axisRatio), pa: String(target.shape.paDeg) } : {}),
    }));
    el.unit.value = "deg";
    renderTargets();
    afterInputsChanged();
    writeStatus(el.targetsStatus, plural(state.targets.length, "target") + " read from " + file.name + " (coordinates in degrees).");
  }

  // ---- Filters and parameters ------------------------------------------------------------------------------------------------------
  function readParams() {
    const problems = [];
    const text = (key) => fields[key].value.trim();
    const optional = (key, name) => {
      if (text(key) === "") return null;
      const value = Number(text(key));
      if (!Number.isFinite(value)) {
        problems.push(name + " is not a number.");
        return null;
      }
      return value;
    };
    const whole = (key, name, low, high) => {
      const value = Number(text(key));
      if (text(key) === "" || !Number.isInteger(value) || value < low || value > high) {
        problems.push(name + " must be a whole number from " + low + " to " + high + ".");
        return null;
      }
      return value;
    };
    const mjdMin = optional("mjdMin", "MJD minimum");
    const mjdMax = optional("mjdMax", "MJD maximum");
    const wvlMin = optional("wvlMin", "Wavelength minimum");
    const wvlMax = optional("wvlMax", "Wavelength maximum");
    if (mjdMin !== null && mjdMax !== null && mjdMin > mjdMax) problems.push("MJD minimum is larger than MJD maximum.");
    if (wvlMin !== null && wvlMax !== null && wvlMin > wvlMax) problems.push("Wavelength minimum is larger than wavelength maximum.");
    const chosen = detectorBoxes.filter((box) => box.checked).map((box) => Number(box.value));
    if (!chosen.length) problems.push("Choose at least one detector.");
    const detectors = chosen.length === detectorBoxes.length ? [] : chosen; // all six = no detector filter, as spxphot's default

    const fitSize = whole("fitSize", "Fit size", 1, 99);
    const bkgHalf = whole("bkgHalf", "Background half-size", 1, 99);
    const exclusion = Number(text("bkgExcludeR"));
    if (text("bkgExcludeR") === "" || !Number.isFinite(exclusion) || exclusion < 0) problems.push("Exclusion radius must be a number of pixels, 0 or more.");
    // Concurrency never blocks a run: an empty or non-numeric field means the default, a number outside 1–12 is brought inside.
    const notes = [];
    const concurrencyText = text("concurrency");
    const concurrencyValue = concurrencyText === "" ? NaN : Number(concurrencyText);
    let concurrency = defaultConcurrency;
    if (!Number.isFinite(concurrencyValue)) {
      notes.push((concurrencyText === "" ? "Concurrent frames is empty" : "Concurrent frames is not a number") + ", so the run reads " + defaultConcurrency + " frames at a time.");
    } else {
      concurrency = Math.min(12, Math.max(1, Math.trunc(concurrencyValue)));
      if (concurrency !== concurrencyValue) notes.push("Concurrent frames takes a whole number from 1 to 12, so the run reads " + concurrency + " frames at a time.");
    }

    const params = {
      ...FP.defaultParams, fitSize, fitShape: fields.fitShape.value, bkgHalf, bkgExcludeR: exclusion, bkgStat: fields.bkgStat.value,
      skyFit: fields.skyFit.checked, astropyWave: fields.astropyWave.checked,
    };
    const filters = { deep: fields.deep.checked, detectors, mjdMin, mjdMax, wvlMin, wvlMax };
    return { ok: problems.length === 0, problems, notes, params, filters, concurrency };
  }

  // ---- Controls and staleness ---------------------------------------------------------------------------------------------------------
  function updateControls() {
    const running = Boolean(state.run);
    const targets = readTargets();
    setDisabled(el.measure, running || !state.frames.length || !targets.targets.length);
    setDisabled(el.cancel, !running);
    // While a run is going the results shown are the previous run's, so they cannot be downloaded as if they were current.
    const rows = state.result ? state.result.rows.length : 0;
    setDisabled(el.downloadIrsa, running || !rows);
    setDisabled(el.downloadLab, running || !rows);
    return targets;
  }

  function afterInputsChanged() {
    const targets = updateControls();
    showTargetProblems(targets.checks);
    const params = readParams();
    writeStatus(el.paramsStatus, [...params.problems, ...params.notes].join(" "), !params.ok);
    if (state.run) state.run.changed = true;
    else if (state.result) markStale();
  }

  function markStale() {
    el.stale.textContent = "Frames, targets or parameters changed since this run. Measure again to update the results.";
  }

  // ---- Run ------------------------------------------------------------------------------------------------------------------------------
  function openSource(frame) {
    return frame.memory ?? Range.createHttpSource(frame.url);
  }

  function refusal() {
    if (state.run) return "A run is already in progress. Cancel it first to start another.";
    if (!state.frames.length) return "Load at least one frame first: import an SIA CSV file, choose FITS files or use the BD+17 4708 example.";
    const targets = readTargets();
    if (targets.problems.length) return "Fix the targets first. " + targets.problems.join(" ");
    if (!targets.targets.length) return "Enter at least one target (RA and Dec).";
    const params = readParams();
    if (!params.ok) return "Fix the filters and parameters first. " + params.problems.join(" ");
    return null;
  }

  async function measure() {
    const reason = refusal();
    if (reason) {
      setRunStatus(reason, true);
      return;
    }
    const { targets } = readTargets();
    const { params, filters, concurrency } = readParams();
    const selection = FP.selectFrames(state.frames, filters);
    if (!selection.frames.length) {
      const x = selection.excluded;
      setRunStatus("No frame passes the filters (" + x.deep + " deep-field, " + x.detector + " by detector, " + x.mjd + " by MJD left out). Change the filters or load more frames.", true);
      return;
    }
    const controller = new AbortController();
    state.run = { controller };
    state.params = params;
    state.filters = filters;
    el.stale.textContent = state.result ? "Measuring again: the plot, table and report below are from the previous run until this one finishes, and the downloads wait for it." : "";
    el.progress.max = Math.max(1, selection.frames.length);
    el.progress.value = 0;
    el.progressText.textContent = "0 / " + selection.frames.length + " frames";
    el.progressWrap.hidden = false;
    updateControls();
    setRunStatus("Measuring " + plural(targets.length, "target") + " on " + plural(selection.frames.length, "frame") + ", " + concurrency + " at a time…");

    let outcome;
    try {
      outcome = await FP.runForcedPhotometry({
        frames: selection.frames, targets, params, filters, concurrency, openSource, signal: controller.signal,
        onProgress({ done, total, failed }) {
          el.progress.max = Math.max(1, total);
          el.progress.value = done;
          el.progressText.textContent = done + " / " + total + " frames" + (failed ? " (" + failed + " failed)" : "");
        },
      });
    } catch (error) {
      state.run = null;
      updateControls();
      setRunStatus("The run stopped: " + (error && error.message ? error.message : String(error)), true);
      el.stale.textContent = state.result ? "The results below are from the previous run; this run stopped before it finished." : "";
      return;
    }
    const changed = state.run.changed;
    state.run = null;
    const { rows, report } = outcome;
    state.result = { rows, report, targets, params, filters, excluded: selection.excluded, loaded: state.frames.length };
    window.AstroNotLatestForcedSpectrophotometry = state.result; // The reusable result, for tests and other tools.
    state.sort = null;
    state.selected = null;
    const line = rows.length + " spectral points, " + report.failed.length + " frame failures, " + report.epsfDownloads + " ePSF calibration downloads, " + report.seconds.toFixed(1) + " s";
    setRunStatus((report.cancelled ? "Cancelled after " + (report.measured + report.skipped.length + report.failed.length) + " of " + report.frames + " frames: " : "") + line, report.failed.length > 0);
    el.stale.textContent = "";
    renderResults();
    if (changed) markStale();
  }

  function cancel() {
    if (!state.run) {
      setRunStatus("Nothing is running.");
      return;
    }
    state.run.controller.abort();
    setDisabled(el.cancel, true);
    setRunStatus("Cancelling: no new frame is started; frames already being read finish first…");
  }

  // ---- Results ------------------------------------------------------------------------------------------------------------------------
  const columns = [...FP.irsaColumns, "flag_names"];
  const integerColumns = new Set(["flags", "lvf_id", "det_id", "n_pix"]);
  const fixedDigits = { ra: 6, dec: 6, lambda: 5, lambda_width: 5, mjd: 5, x_image: 2, y_image: 2 };

  function cellValue(row, column) {
    return column === "flag_names" ? FP.flagNames(row.flags).join(", ") : row[column];
  }

  // Display text of one value (the CSV downloads carry the full precision).
  function display(column, value) {
    if (typeof value === "boolean") return String(value);
    if (typeof value !== "number") return String(value ?? "");
    if (!Number.isFinite(value)) return "";
    if (integerColumns.has(column)) return String(value);
    if (column in fixedDigits) return value.toFixed(fixedDigits[column]);
    return String(Number(value.toPrecision(6)));
  }

  function compare(a, b) {
    const missingA = typeof a === "number" ? !Number.isFinite(a) : a === "" || a === undefined;
    const missingB = typeof b === "number" ? !Number.isFinite(b) : b === "" || b === undefined;
    if (missingA || missingB) return missingA === missingB ? 0 : missingA ? 1 : -1; // missing values last in both directions
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b));
  }

  function sortOrder() {
    const rows = state.result.rows;
    const order = rows.map((_, index) => index);
    if (!state.sort) return order;
    const { column, direction } = state.sort;
    return order.sort((i, j) => {
      const a = cellValue(rows[i], column);
      const b = cellValue(rows[j], column);
      const missing = (v) => (typeof v === "number" ? !Number.isFinite(v) : v === "");
      if (missing(a) || missing(b)) return compare(a, b) || i - j;
      return direction * compare(a, b) || i - j;
    });
  }

  function renderHead() {
    el.resultsHead.replaceChildren(...columns.map((column) => {
      const th = cell("th", "", { scope: "col" });
      const name = column === "flag_names" ? "Flag names" : column;
      const button = cell("button", name, { type: "button", class: "fs-sort" });
      if (state.sort && state.sort.column === column) {
        th.setAttribute("aria-sort", state.sort.direction > 0 ? "ascending" : "descending");
        button.append(cell("span", state.sort.direction > 0 ? " ▲" : " ▼", { "aria-hidden": "true" }));
      }
      button.addEventListener("click", () => sortBy(column));
      th.append(button);
      return th;
    }));
  }

  function sortBy(column) {
    if (!state.result) return;
    state.sort = state.sort && state.sort.column === column ? { column, direction: -state.sort.direction } : { column, direction: 1 };
    renderTable();
    const button = [...el.resultsHead.querySelectorAll("button")][columns.indexOf(column)];
    if (button) button.focus();
  }

  function renderTable() {
    const rows = state.result.rows;
    state.order = sortOrder();
    renderHead();
    // Roving tabindex: one Tab stop for the whole table (the selected row, else the first), arrow keys move inside it.
    const stop = state.order.includes(state.selected) ? state.selected : state.order[0];
    el.results.replaceChildren(...state.order.map((index) => {
      const row = rows[index];
      const tr = cell("tr", "", { role: "row", tabindex: index === stop ? "0" : "-1", "aria-selected": String(index === state.selected), "data-index": String(index) });
      if (row.flags) tr.setAttribute("data-flagged", "");
      for (const column of columns) {
        const text = display(column, cellValue(row, column));
        tr.append(cell("td", text, text === "" ? { "data-empty": "" } : {}));
      }
      return tr;
    }));
  }

  // Select one result row (index into state.result.rows); the table and the plot share this selection.
  // focus: move keyboard focus to the row. fromPlot: the plot made the choice (it has already ringed the point), so the
  // table row is scrolled into view instead.
  function selectRow(index, { focus = false, fromPlot = false } = {}) {
    if (!state.result || !(index >= 0 && index < state.result.rows.length)) return;
    state.selected = index;
    let chosen = null;
    for (const tr of el.results.children) {
      const match = Number(tr.dataset.index) === index;
      tr.setAttribute("aria-selected", String(match));
      tr.setAttribute("tabindex", match ? "0" : "-1");
      if (match) chosen = tr;
    }
    if (!fromPlot) plot.select(index);
    if (!chosen) return;
    if (focus) chosen.focus({ preventScroll: true });
    if (focus || fromPlot) scrollRowIntoView(chosen);
  }

  // Scroll the results box (not the page) so the row shows below the sticky header.
  function scrollRowIntoView(tr) {
    const box = el.resultsWrap.getBoundingClientRect();
    const head = el.resultsHead.getBoundingClientRect().height;
    const row = tr.getBoundingClientRect();
    if (row.top < box.top + head) el.resultsWrap.scrollTop -= box.top + head - row.top;
    else if (row.bottom > box.bottom) el.resultsWrap.scrollTop += row.bottom - box.bottom;
  }

  function renderReport() {
    const { report, excluded, loaded } = state.result;
    const facts = cell("dl", "", { class: "workspace-facts" });
    const fact = (label, value) => {
      const row = document.createElement("div");
      row.append(cell("dt", label), cell("dd", value));
      facts.append(row);
    };
    const left = excluded.deep + excluded.detector + excluded.mjd;
    fact("Frames found", report.frames + (left ? " of " + loaded + " loaded (" + excluded.deep + " deep-field, " + excluded.detector + " by detector, " + excluded.mjd + " by MJD left out by the filters)" : " (every loaded frame)"));
    fact("Measured", String(report.measured));
    fact("Skipped", String(report.skipped.length));
    fact("Failed", String(report.failed.length));
    fact("ePSF calibration downloads", String(report.epsfDownloads));
    fact("Time", report.seconds.toFixed(1) + " s" + (report.cancelled ? " (cancelled)" : ""));
    const parts = [facts];
    const list = (title, entries, text) => {
      if (!entries.length) return;
      const details = document.createElement("details");
      details.append(cell("summary", title + " (" + entries.length + ")"), cell("ul", ""));
      details.lastChild.append(...entries.map((entry) => cell("li", text(entry))));
      parts.push(details);
    };
    list("Skipped frames and reasons", report.skipped, (entry) => entry.uri + ": " + entry.reason);
    list("Failed frames and errors", report.failed, (entry) => entry.uri + ": " + entry.error);
    el.report.replaceChildren(...parts);
    el.report.hidden = false;
  }

  function renderResults() {
    const result = state.result;
    el.resultsWrap.hidden = !result || !result.rows.length;
    el.plot.hidden = !result || !result.rows.length;
    el.report.hidden = !result;
    updateControls();
    plot.render(result ? result.rows : null, state.selected);
    if (!result) {
      el.results.replaceChildren();
      el.verdict.textContent = "Load frames and enter a target, then press Measure.";
      el.exportStatus.textContent = "";
      return;
    }
    const points = result.rows.length;
    el.verdict.textContent = points
      ? plural(points, "spectral point") + " for " + plural(result.targets.length, "target") + " from " + plural(result.report.measured, "measured frame") + "."
      : "No spectral point: no target fell on a measured frame" + (result.report.failed.length ? ", and some frames failed (see below)." : ".");
    if (points) renderTable();
    else el.results.replaceChildren();
    renderReport();
    el.exportStatus.textContent = points ? plural(points, "row") + " ready to download." : "No spectral point to export.";
  }

  // ---- Downloads -------------------------------------------------------------------------------------------------------------------------
  function download(kind) {
    const result = state.result;
    if (state.run) {
      el.exportStatus.textContent = "A run is in progress: the results shown are from the previous run. Download after it finishes, or cancel it.";
      return;
    }
    if (!result || !result.rows.length) {
      el.exportStatus.textContent = "Measure first: there is no spectral point to download.";
      return;
    }
    const label = (result.targets[0].name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "source");
    const lab = kind === "lab";
    const name = "forced-spectrophotometry_" + label + (lab ? "-spectrum-lab" : "") + ".csv";
    const text = lab ? FP.rowsToSpectrumLabCsv(result.rows) : FP.rowsToIrsaCsv(result.rows);
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    el.exportStatus.textContent = name + " downloaded with " + plural(result.rows.length, "row") + "." + (lab ? " Open Spectrum Lab and choose this file there." : "");
  }

  // ---- Wiring ------------------------------------------------------------------------------------------------------------------------------
  el.csv.addEventListener("change", () => {
    const chosen = [...el.csv.files];
    el.csv.value = "";
    if (chosen.length) importCsvFiles(chosen);
  });
  el.fits.addEventListener("change", () => {
    const chosen = [...el.fits.files];
    el.fits.value = "";
    if (chosen.length) addLocalFiles(chosen);
  });
  el.example.addEventListener("click", () => { useExample(); });
  el.clear.addEventListener("click", removeAllFrames);
  el.unit.addEventListener("change", () => { renderTargets(); afterInputsChanged(); });
  el.addTarget.addEventListener("click", addTarget);
  el.targetsCsv.addEventListener("change", () => {
    const file = el.targetsCsv.files[0];
    el.targetsCsv.value = "";
    if (file) loadTargetsCsv(file);
  });
  for (const input of [...Object.values(fields), ...detectorBoxes]) {
    input.addEventListener("input", afterInputsChanged);
    input.addEventListener("change", afterInputsChanged);
  }
  el.measure.addEventListener("click", () => { measure(); });
  el.cancel.addEventListener("click", cancel);
  el.results.addEventListener("click", (event) => {
    const tr = event.target.closest("tr[data-index]");
    if (tr) selectRow(Number(tr.dataset.index));
  });
  el.results.addEventListener("keydown", (event) => {
    const tr = event.target.closest("tr[data-index]");
    if (!tr) return;
    let next = null;
    if (event.key === "Enter" || event.key === " ") next = tr;
    else if (event.key === "ArrowDown") next = tr.nextElementSibling;
    else if (event.key === "ArrowUp") next = tr.previousElementSibling;
    else if (event.key === "Home") next = el.results.firstElementChild;
    else if (event.key === "End") next = el.results.lastElementChild;
    else return;
    event.preventDefault();
    if (next) selectRow(Number(next.dataset.index), { focus: true });
  });
  el.downloadIrsa.addEventListener("click", () => download("irsa"));
  el.downloadLab.addEventListener("click", () => download("lab"));

  // ---- Start --------------------------------------------------------------------------------------------------------------------------------
  const first = blankTarget();
  const search = new URLSearchParams(location.search);
  const linkRa = search.get("ra");
  const linkDec = search.get("dec");
  if (linkRa !== null && linkDec !== null) {
    first.label = "target";
    first.ra = linkRa;
    first.dec = linkDec;
    el.unit.value = Xmatch.parseAngle(linkRa, "ra", "deg").error ? "sexagesimal" : "deg";
  }
  state.targets = [first];
  renderTargets();
  renderFrames();
  if (linkRa !== null && linkDec !== null) writeStatus(el.targetsStatus, "Target 1 is the position from the link (RA " + linkRa + ", Dec " + linkDec + ").");
  el.csv.disabled = false;
  el.fits.disabled = false;
  el.example.disabled = false;
  el.targetsCsv.disabled = false;
  afterInputsChanged();
})();
