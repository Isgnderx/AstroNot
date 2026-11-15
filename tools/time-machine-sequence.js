// Time Machine, archive mode: search a sky position, build a dated sequence of SPHEREx frames on one grid and play through it.
// DOM code only; every number comes from tools/time-sequence.js (AstroNotTimeSequence). The two-file comparison mode of the same
// page is tools/time-machine.js and is not touched by this file.
(() => {
  "use strict";

  // Mode tabs: "Sky position" (this file) and "Two local files" (tools/time-machine.js). Arrow keys move between tabs.
  const tabs = [...document.querySelectorAll("[data-tm-tab]")];
  function selectTab(tab, focus = false) {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
    }
    if (focus) tab.focus();
    const url = new URL(location.href);
    if (tab.dataset.tmTab === "files") url.searchParams.set("mode", "files");
    else url.searchParams.delete("mode");
    try {
      history.replaceState(history.state, "", url);
    } catch {
      // file:// pages may refuse history changes
    }
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", (event) => {
      const d = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!d) return;
      event.preventDefault();
      selectTab(tabs[(i + d + tabs.length) % tabs.length], true);
    });
  });
  if (new URLSearchParams(location.search).get("mode") === "files" && tabs[1]) selectTab(tabs[1]);

  const TS = globalThis.AstroNotTimeSequence;
  const root = document.querySelector("[data-ts]");
  if (!TS || !root || typeof parseIrsaResults !== "function") return;

  const $ = (sel) => root.querySelector(sel);
  const el = {
    form: $("[data-ts-form]"),
    status: $("[data-ts-status]"),
    search: $("[data-ts-search]"),
    examples: [...root.querySelectorAll("[data-ts-example]")],
    fallback: $("[data-ts-fallback]"),
    fallbackReason: $("[data-ts-fallback-reason]"),
    irsaLink: $("[data-ts-irsa-link]"),
    importInput: $("[data-ts-import]"),
    player: $("[data-ts-player]"),
    summary: $("[data-ts-summary]"),
    prev: $("[data-ts-prev]"),
    next: $("[data-ts-next]"),
    pageLabel: $("[data-ts-page-label]"),
    viewport: $("[data-ts-viewport]"),
    canvas: $("[data-ts-canvas]"),
    loading: $("[data-ts-loading]"),
    caption: $("[data-ts-caption]"),
    play: $("[data-ts-play]"),
    slider: $("[data-ts-slider]"),
    speed: $("[data-ts-speed]"),
    across: $("[data-ts-across]"),
    strip: $("[data-ts-strip]"),
    stretch: $("[data-ts-stretch]"),
    range: $("[data-ts-range]"),
    background: $("[data-ts-background]"),
    scale: $("[data-ts-scale]"),
    warnings: $("[data-ts-warnings]"),
    table: $("[data-ts-table]"),
    tableBody: $("[data-ts-table-body]"),
    live: $("[data-ts-live]"),
  };

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const examples = {
    orion: { ra: "83.8221", dec: "-5.3911", release: "dr1", detector: "2", field: "0.25", sampling: "day", wavelength: "hold1" },
    nep: { ra: "270.6930", dec: "61.8765", release: "dr1_deep", detector: "1", field: "0.15", sampling: "day", wavelength: "hold1" },
    m31: { ra: "10.6847", dec: "41.2690", release: "dr1", detector: "1", field: "0.4", sampling: "visit", wavelength: "hold2" },
  };

  // One search = one "run": its frames, sequence, grid and loaded images. A new search replaces it; stale async work checks `run`.
  let run = null;
  const searches = new Map(); // proxy URL -> CSV, so switching back to a detector does not search again
  let page = 0;
  let index = 0; // frame index within the page
  let timer = null;

  // ---- helpers -------------------------------------------------------------------------------------------------------------
  function setStatus(target, message, error = false) {
    target.toggleAttribute("data-error", error);
    target.textContent = message;
  }
  const announce = (message) => (el.live.textContent = message);
  const fmtUm = (v) => (Number.isFinite(v) ? v.toFixed(3) + " µm" : "—");
  const fmtPct = (v) => Math.round(v * 100) + "%";
  const fmtMb = (bytes) => (bytes / 1e6).toFixed(1) + " MB";
  const utc = (meta, frame) => (meta && meta.dateObs ? meta.dateObs.replace("T", " ").replace(/\.\d+$/, "") + " UTC" : TS.mjdToIso(frame.mjd).replace("T", " ").replace("Z", " UTC"));
  const day = (frame) => TS.mjdToIso(frame.mjd).slice(0, 10);
  const text = (tag, content, cls) => {
    const node = document.createElement(tag);
    if (content !== undefined) node.textContent = content;
    if (cls) node.className = cls;
    return node;
  };

  function fields() {
    const f = Object.fromEntries(new FormData(el.form));
    return f;
  }

  // ---- search --------------------------------------------------------------------------------------------------------------
  async function search(event) {
    event?.preventDefault();
    const f = fields();
    const parsed = TS.parseQuery({ ra: f.ra, dec: f.dec, release: f.release, field: f.field, detector: f.detector });
    if (!parsed.ok) {
      setStatus(el.status, parsed.message, true);
      return;
    }
    stop();
    const q = parsed.query;
    const myRun = (run = { query: q, frames: null, controller: new AbortController() });
    el.fallback.hidden = true;
    el.player.hidden = true;
    el.search.disabled = true;
    setStatus(el.status, "Searching " + TS.collections[q.release].label + ", detector " + q.detector + ", at RA " + q.ra.toFixed(5) + "°, Dec " + q.dec.toFixed(5) + "°…");
    el.irsaLink.href = TS.irsaSiaUrl(q);
    const requestUrl = TS.proxySiaUrl(siteAsset("api/sia"), q);
    let csv = searches.get(requestUrl) ?? null;
    let reason = "";
    try {
      if (csv !== null) throw "cached";
      const response = await fetch(requestUrl, { headers: { Accept: "text/csv" } });
      const body = await response.text();
      if (response.ok && !/^\s*<(!doctype|html)/i.test(body)) searches.set(requestUrl, (csv = body));
      else if (response.status === 404 || /^\s*<(!doctype|html)/i.test(body)) reason = "no-proxy";
      else reason = body.trim() || "HTTP " + response.status;
    } catch (e) {
      if (e !== "cached") reason = "no-proxy";
    } finally {
      el.search.disabled = false;
    }
    if (run !== myRun) return;
    if (csv === null) {
      el.fallback.hidden = false;
      el.fallbackReason.textContent =
        reason === "no-proxy"
          ? "This copy of the site has no search service (a static host or a file opened directly), and IRSA does not let a page read its answer."
          : "The search service answered: " + reason;
      setStatus(el.status, "Search the archive with the IRSA link below, then choose the saved CSV.", reason !== "no-proxy");
      return;
    }
    useResults(csv, "IRSA");
  }

  async function importCsv() {
    const file = el.importInput.files[0];
    if (!file) return;
    const f = fields();
    const parsed = TS.parseQuery({ ra: f.ra, dec: f.dec, release: f.release, field: f.field, detector: f.detector });
    if (!parsed.ok) {
      setStatus(el.status, parsed.message, true);
      return;
    }
    stop();
    run = { query: parsed.query, frames: null, controller: new AbortController() };
    if (file.size > 20 * 1024 * 1024) {
      setStatus(el.status, "This file is larger than 20 MB, so it is not an IRSA search result.", true);
      return;
    }
    useResults(await file.text(), file.name);
  }

  function useResults(csv, origin) {
    const parsed = parseIrsaResults(csv);
    if (!parsed.ok) {
      setStatus(el.status, parsed.message, true);
      return;
    }
    run.frames = TS.framesFromRows(parsed.rows);
    run.origin = origin;
    run.truncated = parsed.total >= TS.MAX_SIA_RECORDS;
    // A CSV saved from an older IRSA link may hold every detector: keep the chosen one.
    if (run.frames.length === 0) {
      setStatus(el.status, "No SPHEREx frames contain this position in " + TS.collections[run.query.release].label + ". Try another release or the deep fields.", true);
      return;
    }
    build();
  }

  // ---- sequence ------------------------------------------------------------------------------------------------------------
  // (Re)build the sequence from the frames already found: detector, sampling and wavelength mode can change without a new search.
  function build() {
    if (!run || !run.frames) return;
    stop();
    run.controller.abort();
    run.controller = new AbortController();
    const f = fields();
    const detector = Number(f.detector);
    const counts = TS.countByDetector(run.frames);
    const { groups, undated } = TS.groupFrames(run.frames, { detector, sampling: f.sampling });
    const grid = TS.createGrid({ ra: run.query.ra, dec: run.query.dec, fieldDeg: Number(f.field) });
    const ctx = TS.createContext();
    const mode = f.wavelength === "any" ? "any" : "wavelength";
    const chooser = TS.createChooser(ctx, run.query, { mode, tolerance: f.wavelength === "hold2" ? 2 : 1, margin: grid.width / 2, groups });
    Object.assign(run, { detector, counts, groups, undated, grid, ctx, chooser, mode, cache: new Map(), results: new Map(), seq: TS.createSequence(groups, chooser) });
    page = 0;
    index = 0;
    const perDetector = Object.keys(counts)
      .sort()
      .map((d) => "D" + d + ": " + counts[d])
      .join(", ");
    const own = counts[detector] ?? 0;
    setStatus(el.status, own + " detector " + detector + " frames contain this position, on " + groups.length + (f.sampling === "day" ? " observing days" : f.sampling === "visit" ? " visits" : " exposures") + (run.truncated ? ". IRSA returned its maximum of 10000 rows, so later frames may be missing." : "."));
    if (groups.length === 0) {
      el.player.hidden = true;
      setStatus(el.status, "No detector " + detector + " frames contain this position. Detectors found: " + (perDetector || "none") + ".", true);
      return;
    }
    el.player.hidden = false;
    el.canvas.width = grid.width;
    el.canvas.height = grid.height;
    el.scale.textContent = "Field " + grid.fieldDeg + "° · " + grid.width + " × " + grid.height + " px · " + grid.scaleArcsec.toFixed(2) + "″ per pixel · north up, east left";
    showPage(0);
  }

  function pageItems() {
    return run.seq.items.slice(page * TS.PAGE_SIZE, (page + 1) * TS.PAGE_SIZE);
  }

  async function showPage(p) {
    const myRun = run;
    page = p;
    index = Math.min(index, TS.PAGE_SIZE - 1);
    el.loading.hidden = false;
    el.loading.textContent = run.mode === "wavelength" ? "Finding frames at one wavelength…" : "Finding frames…";
    renderControls();
    try {
      // one extra item tells whether a later page exists
      await run.seq.ensure((p + 1) * TS.PAGE_SIZE + 1, { signal: run.controller.signal, onProgress: () => myRun === run && renderControls() });
    } catch (e) {
      if (myRun !== run || run.controller.signal.aborted) return;
      setStatus(el.status, "Could not read the frames: " + (e && e.message ? e.message : e), true);
    }
    if (myRun !== run) return;
    const items = pageItems();
    if (items.length === 0) {
      el.loading.textContent = "No frames at one wavelength.";
      renderControls();
      if (p === 0) {
        setStatus(el.status, "No frame of this detector matched the reference wavelength. Choose “Any wavelength” or a wider tolerance.", true);
      }
      return;
    }
    index = Math.min(index, items.length - 1);
    renderControls();
    await loadPage(items, myRun);
    if (myRun === run && page === p) prefetch(p + 1, myRun);
  }

  // Load the page's frames, three at a time; draw each as it arrives.
  async function loadPage(items, myRun) {
    el.loading.textContent = "Reading frames from the archive…";
    let next = 0;
    const worker = async () => {
      while (next < items.length && myRun === run) {
        const item = items[next++];
        await loadItem(item, myRun);
        if (myRun !== run) return;
        renderAll();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (myRun === run) {
      el.loading.hidden = true;
      renderAll();
    }
  }

  function loadItem(item, myRun) {
    const key = item.frame.uri;
    if (!myRun.cache.has(key)) {
      const p = TS.loadFrame(myRun.ctx, item, myRun.grid).then(
        (result) => ({ ok: true, ...result }),
        (error) => ({ ok: false, error: error && error.message ? error.message : String(error) })
      );
      myRun.cache.set(key, p.then((r) => (myRun.results.set(key, r), r)));
    }
    return myRun.cache.get(key);
  }

  async function prefetch(p, myRun) {
    try {
      await myRun.seq.ensure((p + 1) * TS.PAGE_SIZE + 1, { signal: myRun.controller.signal });
    } catch {
      return;
    }
    if (myRun !== run) return;
    renderControls();
    const items = myRun.seq.items.slice(p * TS.PAGE_SIZE, (p + 1) * TS.PAGE_SIZE);
    for (const item of items) {
      if (myRun !== run) return;
      await loadItem(item, myRun);
    }
  }

  // Loaded result for an item, or undefined while it is still loading.
  const resultOf = (item) => run.results.get(item.frame.uri);

  // ---- rendering -----------------------------------------------------------------------------------------------------------
  function renderControls() {
    if (!run || !run.seq) return;
    const seq = run.seq;
    const items = pageItems();
    const first = page * TS.PAGE_SIZE + 1;
    const last = page * TS.PAGE_SIZE + items.length;
    const knownTotal = seq.done ? String(seq.items.length) : "at least " + seq.items.length;
    el.pageLabel.textContent = items.length ? "Frames " + first + "–" + last + " of " + knownTotal : "Frames — of " + knownTotal;
    el.prev.disabled = page === 0;
    el.next.disabled = !(seq.items.length > (page + 1) * TS.PAGE_SIZE);
    el.slider.max = String(Math.max(0, items.length - 1));
    el.slider.value = String(index);
    el.slider.disabled = items.length < 2;
    el.play.disabled = items.length < 2 && !el.across.checked;
    root.style.setProperty("--ts-count", String(Math.max(1, items.length)));

    const span = seq.items.length > 1 ? seq.items[seq.items.length - 1].frame.mjd - seq.items[0].frame.mjd : 0;
    const ref = run.chooser.state.reference;
    const tol = run.chooser.state.tolerance;
    // Separate pieces (one text node each) so each can be translated on its own.
    const pieces = [
      "Detector " + run.detector,
      run.mode !== "wavelength"
        ? "any wavelength"
        : ref === null
          ? "one wavelength"
          : "one wavelength (" + ref.toFixed(3) + " µm, within " + tol + (tol === 1 ? " channel)" : " channels)"),
      seq.items.length + (seq.done ? "" : "+") + " frames over " + TS.formatElapsed(span),
    ];
    if (seq.skipped) pieces.push(seq.skipped + " skipped (no frame at this wavelength)");
    el.summary.replaceChildren(...pieces.flatMap((piece, i) => (i ? [text("span", " · "), text("span", piece)] : [text("span", piece)])));

    // filmstrip
    const cells = items.map((item, i) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ts-thumb";
      button.dataset.tsThumb = String(i);
      button.setAttribute("aria-pressed", String(i === index));
      const canvas = document.createElement("canvas");
      canvas.width = run.grid.width;
      canvas.height = run.grid.height;
      canvas.setAttribute("aria-hidden", "true");
      button.append(canvas, text("span", day(item.frame), "ts-thumb__date"));
      button.setAttribute("aria-label", "Frame " + (page * TS.PAGE_SIZE + i + 1) + ", " + day(item.frame));
      li.append(button);
      return li;
    });
    el.strip.replaceChildren(...cells);
    drawThumbs();
  }

  // Display offset of a result: its own median sky level when "Remove each frame's sky level" is on, else 0.
  function offsetOf(result) {
    if (!el.background.checked) return 0;
    if (result.median === undefined) result.median = TS.median(result.values);
    return Number.isFinite(result.median) ? result.median : 0;
  }

  function pageRange(items) {
    if (el.range.value !== "shared") return null;
    const results = items.map(resultOf).filter((r) => r && r.ok && r.coverage > 0);
    return results.length ? TS.sharedRange(results.map((r) => r.values), 0.5, 99.5, 200000, results.map(offsetOf)) : null;
  }

  function draw(canvas, result, range) {
    if (!result || !result.ok) return false;
    const offset = offsetOf(result);
    const r = range ?? TS.sharedRange([result.values], 0.5, 99.5, 200000, [offset]);
    if (!r) return false;
    const ctx2d = canvas.getContext("2d");
    const image = ctx2d.createImageData(run.grid.width, run.grid.height);
    TS.toRgba(result.values, r, el.stretch.value, image.data, offset);
    ctx2d.putImageData(image, 0, 0);
    return true;
  }

  function drawThumbs() {
    const items = pageItems();
    const range = pageRange(items);
    el.strip.querySelectorAll("canvas").forEach((canvas, i) => {
      const result = resultOf(items[i]);
      const ok = draw(canvas, result, range);
      canvas.parentElement.toggleAttribute("data-pending", !result);
      canvas.parentElement.toggleAttribute("data-failed", Boolean(result && (!result.ok || result.coverage === 0)));
      if (!ok) canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    });
  }

  function renderFrame() {
    const items = pageItems();
    const item = items[index];
    if (!item) return;
    const result = resultOf(item);
    el.strip.querySelectorAll("[data-ts-thumb]").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.tsThumb) === index)));
    el.slider.value = String(index);
    const n = page * TS.PAGE_SIZE + index + 1;
    const since = item.frame.mjd - run.seq.items[0].frame.mjd;
    if (!result) {
      el.caption.replaceChildren(text("strong", "Frame " + n + " · " + day(item.frame)), text("span", " Loading…"));
      return;
    }
    if (!result.ok) {
      el.caption.replaceChildren(text("strong", "Frame " + n + " · " + day(item.frame)), text("span", " Could not be read: " + result.error));
      return;
    }
    draw(el.canvas, result, pageRange(items));
    const m = result.meta;
    const parts = [
      utc(m, item.frame),
      (since === 0 ? "first frame" : "+" + TS.formatElapsed(since) + " after the first frame"),
      m.obsId + " · D" + m.detector,
      fmtUm(result.wavelength) + " at the target",
      fmtPct(result.coverage) + " of the field covered",
    ];
    el.caption.replaceChildren(text("strong", "Frame " + n), ...parts.map((p) => text("span", p)));
    el.viewport.setAttribute("aria-label", "SPHEREx frame " + n + ", observed " + utc(m, item.frame) + ", " + fmtUm(result.wavelength));
  }

  function renderTable() {
    const items = pageItems();
    const rows = items.map((item, i) => {
      const r = resultOf(item);
      const tr = document.createElement("tr");
      const since = item.frame.mjd - run.seq.items[0].frame.mjd;
      const cells = [
        String(page * TS.PAGE_SIZE + i + 1),
        r && r.ok ? utc(r.meta, item.frame) : utc(null, item.frame),
        since === 0 ? "—" : "+" + TS.formatElapsed(since),
        item.frame.obsId,
        r && r.ok ? fmtUm(r.wavelength) + (Number.isFinite(r.bandwidth) ? " ± " + (r.bandwidth / 2).toFixed(3) : "") : "…",
        r ? (r.ok ? fmtPct(r.coverage) : "Error") : "…",
        r && r.ok ? fmtMb(r.bytes) : "…",
      ];
      cells.forEach((c, k) => tr.append(text(k === 0 ? "th" : "td", c)));
      if (r && !r.ok) tr.title = r.error;
      return tr;
    });
    el.tableBody.replaceChildren(...rows);
    el.table.hidden = rows.length === 0;
  }

  function renderWarnings() {
    const items = pageItems();
    const results = items.map(resultOf).filter((r) => r && r.ok);
    const notes = [];
    if (results.length > 1 && run.mode === "any") {
      const waves = results.map((r) => r.wavelength).filter(Number.isFinite);
      const bands = results.map((r) => r.bandwidth).filter(Number.isFinite);
      if (waves.length > 1 && bands.length) {
        const spread = Math.max(...waves) - Math.min(...waves);
        const band = Math.min(...bands);
        if (spread > band) {
          notes.push(["warning", "The wavelengths on this page span " + spread.toFixed(3) + " µm, more than one channel (" + band.toFixed(3) + " µm). Brightness changes may come from the wavelength, not from time. Choose “Hold one wavelength” to avoid this."]);
        }
      }
    }
    const partial = results.filter((r) => r.coverage > 0 && r.coverage < 0.98).length;
    if (partial) notes.push(["info", "Frames covering only part of the field (the position is near a detector edge): " + partial + ". Uncovered pixels are drawn in dark blue-grey."]);
    const failed = items.map(resultOf).filter((r) => r && !r.ok).length;
    if (failed) notes.push(["error", "Frames that could not be read from the archive: " + failed + ". The others are shown."]);
    if (run.truncated) notes.push(["info", "IRSA returned its maximum of 10000 rows for this position, so the sequence may stop before the latest observations."]);
    el.warnings.replaceChildren(...notes.map(([kind, msg]) => text("li", msg, "tm-notes__" + kind)));
    el.warnings.hidden = notes.length === 0;
  }

  function renderAll() {
    if (!run || !run.seq) return;
    drawThumbs();
    renderFrame();
    renderTable();
    renderWarnings();
  }

  // ---- playback ------------------------------------------------------------------------------------------------------------
  function speeds() {
    const options = reducedMotion.matches ? [0.5, 1] : [0.5, 1, 2, 4];
    el.speed.replaceChildren(...options.map((v) => new Option(v + " frames per second", String(v))));
    el.speed.value = String(Math.min(2, options[options.length - 1]));
  }

  function step(delta) {
    const items = pageItems();
    if (!items.length) return;
    let i = index + delta;
    if (i >= items.length || i < 0) {
      if (el.across.checked) {
        const target = i < 0 ? page - 1 : page + 1;
        const exists = target >= 0 && run.seq.items.length > target * TS.PAGE_SIZE;
        if (exists) {
          index = i < 0 ? TS.PAGE_SIZE - 1 : 0;
          showPage(target);
          return;
        }
        if (timer && i >= items.length && page > 0) {
          // end of the sequence: start again from the first page
          index = 0;
          showPage(0);
          return;
        }
      }
      i = (i + items.length) % items.length;
    }
    index = i;
    renderFrame();
  }

  function play() {
    if (timer) return;
    const ms = 1000 / Number(el.speed.value || 1);
    timer = setInterval(() => {
      // wait on frames that are still loading rather than skipping them
      const item = pageItems()[(index + 1) % Math.max(1, pageItems().length)];
      if (item && resultOf(item) === undefined && !el.loading.hidden) return;
      step(1);
    }, ms);
    el.play.setAttribute("aria-pressed", "true");
    el.play.textContent = "Pause";
    announce("Playing");
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    el.play.setAttribute("aria-pressed", "false");
    el.play.textContent = "Play";
    announce("Paused");
  }

  // ---- events --------------------------------------------------------------------------------------------------------------
  el.form.addEventListener("submit", search);
  el.importInput.addEventListener("change", importCsv);
  for (const name of ["sampling", "wavelength", "field"]) {
    el.form.elements[name].addEventListener("change", () => {
      if (run && run.frames) build();
    });
  }
  // Each search covers one detector (fewer rows, so a deep field's whole year fits), so a new detector is a new search.
  for (const name of ["detector", "release"]) {
    el.form.elements[name].addEventListener("change", () => {
      if (run) search();
    });
  }
  for (const button of el.examples) {
    button.addEventListener("click", () => {
      const ex = examples[button.dataset.tsExample];
      for (const [k, v] of Object.entries(ex)) el.form.elements[k].value = v;
      search();
    });
  }
  el.prev.addEventListener("click", () => {
    stop();
    index = 0;
    if (page > 0) showPage(page - 1);
  });
  el.next.addEventListener("click", () => {
    stop();
    index = 0;
    showPage(page + 1);
  });
  el.slider.addEventListener("input", () => {
    index = Number(el.slider.value);
    renderFrame();
  });
  el.strip.addEventListener("click", (event) => {
    const button = event.target.closest("[data-ts-thumb]");
    if (!button) return;
    stop();
    index = Number(button.dataset.tsThumb);
    renderFrame();
  });
  el.play.addEventListener("click", () => (timer ? stop() : play()));
  el.speed.addEventListener("change", () => {
    if (timer) {
      stop();
      play();
    }
  });
  el.stretch.addEventListener("change", renderAll);
  el.range.addEventListener("change", renderAll);
  el.background.addEventListener("change", renderAll);
  el.across.addEventListener("change", renderControls);
  el.viewport.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight") step(1);
    else if (event.key === "ArrowLeft") step(-1);
    else if (event.key === " " || event.key === "k") timer ? stop() : play();
    else if (event.key === "PageDown" && !el.next.disabled) el.next.click();
    else if (event.key === "PageUp" && !el.prev.disabled) el.prev.click();
    else return;
    event.preventDefault();
  });
  reducedMotion.addEventListener?.("change", speeds);
  document.addEventListener("visibilitychange", () => document.hidden && stop());

  speeds();
  el.search.disabled = false;
  el.examples.forEach((b) => (b.disabled = false));

  // ?ra=&dec=&release=&detector= in the page URL starts a search (links from other tools).
  const params = new URLSearchParams(location.search);
  if (params.has("ra") && params.has("dec")) {
    for (const k of ["ra", "dec", "release", "detector", "field", "sampling", "wavelength"]) {
      if (params.has(k) && el.form.elements[k]) el.form.elements[k].value = params.get(k);
    }
    search();
  }
})();
