// Image Differencing: shows Δ = target − reference for two FITS images. FITS structure and calibrated pixel values come
// from tools/fits.js (shared with FITS Viewer and Time Machine), coordinates from tools/wcs.js, the observation model
// (time, wavelength, observing conditions) from tools/pair.js, and ALL difference computation (units, grid check,
// reprojection, masks, variance, FITS export) from tools/difference.js. This file is the user interface only.
//
// Display never feeds back into the computation: the gray range, the diverging color limit, zoom and pan only decide how
// pictures are painted from the arrays in the result. Every readout reads the arrays, not the pictures.
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
  const { createWcs, screenToFits, fitsToScreen, insideImage } = Wcs;

  const roles = ["reference", "target"];
  const kinds = ["reference", "target", "difference"];
  const roleTitle = { reference: "Reference", target: "Target" };
  const kindLabel = { reference: "Reference", target: "Target, on the reference grid", difference: "Difference Δ = target − reference" };
  const minus = "−";
  const zoomStep = 2;
  const tapDistance = 5;

  const query = (name, scope = document) => scope.querySelector("[data-id-" + name + "]");

  const el = {
    status: query("status"), example: query("example"), swap: query("swap"), slots: query("slots"),
    alignment: query("alignment"), background: query("background"), assumeWrap: query("assume-wrap"), assume: query("assume"),
    settingsNote: query("settings-note"),
    sign: query("sign"), verdict: query("verdict"), notes: query("notes"), summary: query("summary"),
    conditions: query("conditions"), conditionsBody: query("conditions-body"),
    fit: query("fit"), clip: query("clip"), limit: query("limit"), customWrap: query("custom-wrap"), custom: query("custom"),
    displayNote: query("display-note"), panels: query("panels"),
    legend: query("legend"), legendBar: query("legend-bar"), legendLow: query("legend-low"), legendHigh: query("legend-high"), legendText: query("legend-text"),
    live: query("live"),
    pixelNote: query("pixel-note"), pixelX: query("pixel-x"), pixelY: query("pixel-y"), pixelGo: query("pixel-go"),
    pixelCenter: query("pixel-center"), pixelClear: query("pixel-clear"), readout: query("readout"), readoutBody: query("readout-body"),
    download: query("download"), exportStatus: query("export-status"),
  };

  // ---- State ---------------------------------------------------------------------------------------------------------
  function newSlot(role) {
    return { role, file: null, name: "", isExample: false, hdus: null, choices: [], hduIndex: -1, version: 0, hduVersion: 0, loading: false, error: "", message: "", image: null };
  }

  const data = { reference: newSlot("reference"), target: newSlot("target") };
  const dom = {};
  const state = {
    alignment: "reproject", background: "none", assume: false, clip: "1-99", limit: "99", custom: "",
    outcome: null, result: null, pair: null,
    pictures: { reference: null, target: null, difference: null },
    ranges: { gray: null, limit: null, limitNote: "" },
    selected: null,
    view: { zoom: 1, centerX: 1, centerY: 1 },
  };
  let panels = {};
  let hatch = null;

  // ---- Small helpers -------------------------------------------------------------------------------------------------
  function significant(value, digits = 5) {
    return Number(value.toPrecision(digits)).toString().replace("-", minus);
  }

  function signed(value, digits = 6) {
    return (value > 0 ? "+" : "") + significant(value, digits);
  }

  function degrees(value, digits = 5) {
    return value.toFixed(digits).replace("-", minus) + "°";
  }

  function withUnit(text, unit) {
    return unit ? text + " " + unit : text;
  }

  function timeText(time) {
    if (!time || !time.valid) return "Observation time unavailable";
    return time.display + " " + time.scale;
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

  function setFact(root, name, text, attribute = "data-id-slot-fact") {
    const target = root.querySelector("[" + attribute + '="' + name + '"]');
    if (target && target.textContent !== text) target.textContent = text;
  }

  // ---- Slots: DOM ----------------------------------------------------------------------------------------------------
  function buildSlots() {
    const slotTemplate = document.querySelector("[data-id-slot-template]");
    for (const role of roles) {
      const root = slotTemplate.content.firstElementChild.cloneNode(true);
      root.setAttribute("aria-labelledby", "id-slot-" + role + "-title");
      const title = query("slot-title", root);
      title.id = "id-slot-" + role + "-title";
      title.textContent = roleTitle[role];
      query("slot-badge", root).textContent = role === "reference" ? "Subtracted from the target" : "Δ = this − reference";
      el.slots.append(root);
      dom[role] = {
        root, file: query("file", root), fileLabel: query("file-label", root), hdu: query("hdu", root), status: query("slot-status", root),
      };
    }
  }

  // ---- Panels --------------------------------------------------------------------------------------------------------
  function buildPanels() {
    const template = document.querySelector("[data-id-panel-template]");
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

  // All three panels show the reference grid, so one view state and one scale serve every panel.
  function fitSize() {
    const measured = Object.values(panels).map((panel) => ({ width: Math.max(1, panel.viewport.clientWidth), height: Math.max(1, panel.viewport.clientHeight) }));
    return { width: Math.min(...measured.map((size) => size.width)), height: Math.min(...measured.map((size) => size.height)) };
  }

  function geometry(panel) {
    const result = state.result;
    return Pair.viewGeometry(state.view, result.width, result.height, panel.size, fitSize());
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
    if (data.reference.loading || data.target.loading) return "Reading the file…";
    if (!data.reference.image || !data.target.image) return "Load a reference and a target image to see them here.";
    if (state.outcome && !state.outcome.ok) return "No difference could be computed. The reason is given under Result.";
    return "Nothing to show.";
  }

  function renderPanel(panel) {
    panel.frame = 0;
    const result = state.result;
    const picture = state.pictures[panel.kind];
    if (!result || !picture) {
      panel.canvas.hidden = true;
      panel.empty.hidden = false;
      panel.empty.querySelector("p").textContent = panel.kind === "difference" && result && result.empty ? result.emptyReason : emptyMessage();
      panel.viewport.removeAttribute("data-loaded");
      panel.viewport.removeAttribute("data-pannable");
      panel.title.textContent = "";
      panel.range.textContent = "";
      panel.zoom.textContent = "";
      panel.pointer.textContent = "";
      panel.viewport.setAttribute("aria-label", kindLabel[panel.kind] + " view, no image");
      return;
    }
    panel.empty.hidden = true;
    panel.canvas.hidden = false;
    panel.viewport.toggleAttribute("data-loaded", true);
    resizePanel(panel);
    Pair.clampView(state.view, result.width, result.height, fitSize());
    const geo = geometry(panel);
    const ctx = panel.ctx;
    const ratio = panel.size.ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = "#060709";
    ctx.fillRect(0, 0, panel.size.width, panel.size.height);
    ctx.imageSmoothingEnabled = false;
    const origin = fitsToScreen(geo, 0.5, result.height + 0.5);
    const extent = { x: origin.x, y: origin.y, width: result.width * geo.scale, height: result.height * geo.scale };
    ctx.fillStyle = hatchPattern(ctx);
    ctx.fillRect(extent.x, extent.y, extent.width, extent.height);
    ctx.drawImage(picture, extent.x, extent.y, extent.width, extent.height);
    ctx.strokeStyle = "#4a505a";
    ctx.lineWidth = 1;
    ctx.strokeRect(extent.x - 0.5, extent.y - 0.5, extent.width + 1, extent.height + 1);
    drawSelection(ctx, geo, result);

    const side = panel.kind === "reference" ? result.reference : panel.kind === "target" ? result.target : null;
    panel.title.textContent = side
      ? [side.obsId ?? "Observation ID unavailable", timeText(side.time)].join(" · ")
      : result.mode === "pixel-difference" ? "Pixel difference" : "Reprojected difference";
    panel.canvas.setAttribute("aria-label", kindLabel[panel.kind] + (side ? ", observation " + (side.obsId ?? "ID unavailable") + ", " + timeText(side.time) : ", " + result.counts.valid + " valid pixels"));
    panel.viewport.setAttribute("aria-label", kindLabel[panel.kind] + " view");
    panel.range.textContent = panel.kind === "difference"
      ? state.ranges.limit === null ? "Color scale unavailable" : "Color scale ±" + significant(state.ranges.limit) + (result.unit ? " " + result.unit : "") + " · zero is the neutral color · " + state.ranges.limitNote
      : state.ranges.gray ? "Display range " + significant(state.ranges.gray.low) + " to " + significant(state.ranges.gray.high) + (result.unit ? " " + result.unit : "") + " · shared by reference and target" : "Display range unavailable";
    const zoom = state.view.zoom;
    panel.zoom.textContent = "Zoom " + (zoom < 10 ? zoom.toFixed(1) : zoom.toFixed(0)) + "× (1× shows the whole image) · pan and zoom linked";
    panel.viewport.toggleAttribute("data-pannable", zoom > 1.001);
    panel.viewport.toggleAttribute("data-selected", Boolean(state.selected));
    updatePointerLine(panel, geo, result);
  }

  function drawSelection(ctx, geo, result) {
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

  // The value of one pixel as shown in a panel (read from the arrays).
  function pixelText(kind, pixel, result) {
    if (!pixel) return "Outside image data";
    const unit = result.unit;
    if (kind === "reference") return result.reference.valid[pixel.index] ? withUnit(significant(result.reference.values[pixel.index], 7), unit) : "NaN, BLANK or masked";
    if (kind === "target") {
      if (pixel.status === Diff.status.outside) return "Outside the area covered by the target";
      return result.target.valid[pixel.index] ? withUnit(significant(result.target.values[pixel.index], 7), unit) : "NaN, BLANK or masked";
    }
    return pixel.valid ? withUnit(signed(pixel.difference, 7), unit) : "Invalid · " + pixel.reason;
  }

  function pixelOfFits(result, x, y) {
    if (!insideImage(x, y, result.width, result.height)) return null;
    const column = Math.min(result.width - 1, Math.floor(x - 0.5));
    const row = Math.min(result.height - 1, Math.floor(y - 0.5));
    return Diff.pixelAt(result, column, row);
  }

  function updatePointerLine(panel, geo, result) {
    if (!panel.point) {
      panel.pointer.textContent = "Pointer: move over the image to read the pixel value.";
      return;
    }
    const at = screenToFits(geo, panel.point.x, panel.point.y);
    const pixel = pixelOfFits(result, at.x, at.y);
    const sky = pixel && result.wcs ? result.wcs.pixelToSky(pixel.column + 1, pixel.row + 1) : null;
    panel.pointer.textContent = pixel
      ? "Pointer: pixel " + (pixel.column + 1) + ", " + (pixel.row + 1) + (sky ? " · RA " + degrees(sky.ra) + ", Dec " + degrees(sky.dec) : "") + " · " + pixelText(panel.kind, pixel, result)
      : "Pointer: outside image data";
  }

  // ---- View changes --------------------------------------------------------------------------------------------------
  function fitView() {
    const result = state.result;
    state.view = result ? Pair.createView(result.width, result.height) : { zoom: 1, centerX: 1, centerY: 1 };
  }

  function zoomBy(panel, factor, sx, sy) {
    const result = state.result;
    if (!result) return;
    Pair.zoomViewAt(state.view, factor, result.width, result.height, panel.size, fitSize(), sx, sy);
    invalidate();
  }

  function panBy(panel, dx, dy) {
    const result = state.result;
    if (!result) return;
    Pair.panViewByScreen(state.view, dx, dy, result.width, result.height, panel.size, fitSize());
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
    const panel = panels.difference;
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
    const pixel = Diff.pixelAt(result, selected.column, selected.row);
    return "Pixel " + (selected.column + 1) + ", " + (selected.row + 1) + ". Reference " + pixelText("reference", pixel, result) +
      ". Target " + pixelText("target", pixel, result) + ". Difference " + pixelText("difference", pixel, result) + ".";
  }

  function targetSourcePosition(result, column, row) {
    const image = data.target.image;
    if (!image || !image.wcs || !result.wcs) return null;
    const sky = result.wcs.pixelToSky(column + 1, row + 1);
    const at = sky && image.wcs.skyToPixel(sky.ra, sky.dec);
    return at && insideImage(at.x, at.y, image.width, image.height) ? at : null;
  }

  function renderReadout() {
    const result = state.result;
    const selected = state.selected;
    const enabled = Boolean(result);
    for (const button of [el.pixelGo]) button.setAttribute("aria-disabled", String(!enabled));
    el.pixelCenter.setAttribute("aria-disabled", String(!selected));
    el.pixelClear.setAttribute("aria-disabled", String(!selected));
    el.readout.hidden = !(result && selected);
    if (!result || !selected) {
      el.readoutBody.replaceChildren();
      if (!selected) el.pixelNote.textContent = result
        ? "Select a pixel in any of the three images, or enter its position below. Pixel positions are FITS pixel numbers on the reference grid (1 to " + result.width + " in x, 1 to " + result.height + " in y), where the first pixel is (1, 1)."
        : "Compute a difference first. Then select a pixel in any of the three images, or enter its position here.";
      return;
    }
    el.pixelX.value = String(selected.column + 1);
    el.pixelY.value = String(selected.row + 1);
    el.pixelNote.textContent = "Selected pixel " + (selected.column + 1) + ", " + (selected.row + 1) + " on the reference grid.";
    const pixel = Diff.pixelAt(result, selected.column, selected.row);
    const sky = result.wcs ? result.wcs.pixelToSky(selected.column + 1, selected.row + 1) : null;
    const rows = [];
    rows.push(["Pixel (x, y), reference grid", (selected.column + 1) + ", " + (selected.row + 1)]);
    rows.push(["RA, Dec (ICRS)", sky ? degrees(sky.ra, 6) + ", " + degrees(sky.dec, 6) : "Unavailable"]);
    rows.push(["Reference · " + (result.reference.obsId ?? "ID unavailable"), pixelText("reference", pixel, result)]);
    const source = result.mode === "reprojected-difference" ? targetSourcePosition(result, selected.column, selected.row) : null;
    rows.push(["Target · " + (result.target.obsId ?? "ID unavailable") + (result.mode === "reprojected-difference" ? " (bilinear, on the reference grid)" : ""), pixelText("target", pixel, result)]);
    if (result.mode === "reprojected-difference") rows.push(["Position in the target file (x, y)", source ? source.x.toFixed(3) + ", " + source.y.toFixed(3) : "Outside the target image"]);
    rows.push(["Δ = target − reference", pixelText("difference", pixel, result), pixel.valid ? "" : "invalid"]);
    rows.push(["Var(Δ)", pixel.variance !== null ? significant(pixel.variance, 6) + (result.unit ? " (" + result.unit + ")²" : "") : result.variance ? "Unavailable at this pixel" : "Unavailable (needs a variance image in both files)"]);
    rows.push(["SNR = Δ / σ", pixel.snr !== null ? signed(pixel.snr, 4) : "Unavailable"]);
    rows.push(["Pixel status", pixel.reason, pixel.valid ? "" : "invalid"]);
    el.readoutBody.replaceChildren(...rows.map(([label, value, flag]) => {
      const row = document.createElement("tr");
      const head = document.createElement("th");
      head.scope = "row";
      head.textContent = label;
      const cell = document.createElement("td");
      cell.textContent = value;
      if (flag) cell.dataset.state = flag;
      row.append(head, cell);
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
      const result = state.result;
      if (!result) return;
      const at = screenToFits(geometry(panel), point.x, point.y);
      if (!insideImage(at.x, at.y, result.width, result.height)) {
        announce("That point is outside the image data, so no pixel was selected.");
        return;
      }
      selectPixel(Math.floor(at.x - 0.5), Math.floor(at.y - 0.5));
    };

    viewport.addEventListener("pointerdown", (event) => {
      if (!state.result || (event.pointerType === "mouse" && event.button !== 0)) return;
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
      if (!state.result) return;
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
      if (!state.result || !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const point = local(event);
      zoomBy(panel, Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0025)), point.x, point.y);
    }, { passive: false });

    viewport.addEventListener("keydown", (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey || !state.result) return;
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

  // ---- Loading files -------------------------------------------------------------------------------------------------
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

  // A VARIANCE image of the same size, if the file has one. Only an image named VARIANCE counts; ERR or sigma images
  // are not squared on the user's behalf.
  async function readVariance(slot, hdu) {
    const index = slot.hdus.findIndex((entry) => entry !== hdu && String(entry.fields.EXTNAME ?? "").trim().toUpperCase() === "VARIANCE");
    if (index < 0) return { values: null, unit: undefined, note: "No VARIANCE image in this file" };
    const candidate = slot.hdus[index];
    if (!candidate.renderable || candidate.axes[0] !== hdu.axes[0] || candidate.axes[1] !== hdu.axes[1]) {
      return { values: null, unit: undefined, note: "VARIANCE image (HDU " + index + ") ignored: it cannot be read or its size differs from the image" };
    }
    const values = await readValues(slot.file, candidate);
    const unit = typeof candidate.fields.BUNIT === "string" ? candidate.fields.BUNIT.trim() : undefined;
    return { values, unit, note: "VARIANCE image in HDU " + index + (unit ? ", unit " + unit : ", no BUNIT") };
  }

  async function readImage(slot, version, token) {
    const hdu = slot.hdus[slot.hduIndex];
    const values = await readValues(slot.file, hdu);
    if (version !== slot.version || token !== slot.hduVersion) return null;
    const wavelength = await readWaveSummary(slot.file, slot.hdus, hdu);
    const variance = await readVariance(slot, hdu);
    if (version !== slot.version || token !== slot.hduVersion) return null;
    const wcs = createWcs(hdu.fields);
    const [width, height] = hdu.axes;
    const image = {
      width, height, values, hdu, wavelength,
      wcs: wcs.ok ? wcs.wcs : null, wcsReason: wcs.ok ? "" : wcs.reason,
      unit: typeof hdu.fields.BUNIT === "string" ? hdu.fields.BUNIT.trim() : "",
      variance: variance.values, varianceUnit: variance.unit, varianceNote: variance.note,
      fingerprint: Pair.fingerprintValues(values),
      meta: null,
    };
    image.meta = Pair.describeObservation(hdu, slot.hduIndex, { wavelength });
    return image;
  }

  async function showHdu(slot, version) {
    const token = ++slot.hduVersion;
    slot.image = null;
    slot.loading = true;
    slot.error = "";
    slot.message = "Reading image pixels…";
    clearResult();
    refresh();
    try {
      const image = await readImage(slot, version, token);
      if (!image) return;
      slot.image = image;
      slot.loading = false;
      slot.message = (slot.isExample ? "SPHEREx example loaded." : slot.name + " loaded.") + (image.wcs ? "" : " No usable sky coordinates.");
    } catch (error) {
      if (version !== slot.version || token !== slot.hduVersion) return;
      slot.loading = false;
      slot.image = null;
      slot.error = (slot.isExample ? "The SPHEREx example" : slot.name) + " could not be displayed. " + error.message;
      slot.message = "";
    }
    afterSlotChange(slot);
  }

  async function openFile(slot, source, name, isExample = false) {
    const version = ++slot.version;
    slot.hduVersion++;
    Object.assign(slot, { file: null, name: "", isExample: false, hdus: null, choices: [], hduIndex: -1, image: null, error: "", loading: true, message: "Reading FITS headers…" });
    clearResult();
    refresh();
    try {
      const file = await source;
      if (version !== slot.version) return;
      const hdus = await readFitsHdus(file);
      if (version !== slot.version) return;
      const choices = hdus.map((hdu, index) => ({ hdu, index })).filter(({ hdu }) => hdu.renderable);
      if (!choices.length) {
        const reasons = hdus.map((hdu, index) => "HDU " + index + " (" + hdu.name + "): " + whyNotDisplayable(hdu));
        throw new Error("This file has no image HDU that Image Differencing can read. " + reasons.join("; ") + ".");
      }
      const preferred = choices.find(({ hdu }) => hdu.fields.EXTNAME === "IMAGE") ?? choices[0];
      Object.assign(slot, { file, name, isExample, hdus, choices, hduIndex: preferred.index });
      await showHdu(slot, version);
    } catch (error) {
      if (version !== slot.version) return;
      Object.assign(slot, { file: null, name: "", isExample: false, hdus: null, choices: [], hduIndex: -1, image: null, loading: false, error: (isExample ? "The SPHEREx example" : name) + " could not be opened. " + error.message, message: "" });
      afterSlotChange(slot);
    }
  }

  function afterSlotChange(slot) {
    refresh({ compute: true });
    announce(slot.error ? roleTitle[slot.role] + ": " + slot.error : slot.message);
  }

  let exampleLoad;
  function loadExample() {
    if (!exampleLoad) {
      exampleLoad = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = siteAsset("assets/tools/spherex-time-machine-example.js");
        script.addEventListener("load", () => {
          const decode = (text) => Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
          resolve({
            reference: new File([decode(spherexTimeMachineExample.reference)], "SPHEREx-QR2-2025W21_2C_0280_1-D2.fits"),
            target: new File([decode(spherexTimeMachineExample.comparison)], "SPHEREx-QR2-2025W24_1A_0514_1-D2.fits"),
          });
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

  // ---- Computation (all in difference.js) ----------------------------------------------------------------------------
  function clearResult() {
    state.outcome = null;
    state.result = null;
    state.pair = null;
    state.selected = null;
    state.pictures = { reference: null, target: null, difference: null };
    window.AstroNotLatestDifference = null;
  }

  function diffInput(slot) {
    const image = slot.image;
    return {
      name: slot.name, meta: image.meta, width: image.width, height: image.height, values: image.values, wcs: image.wcs, wcsReason: image.wcsReason,
      unit: image.unit, fingerprint: image.fingerprint, fields: image.hdu.fields, variance: image.variance, varianceUnit: image.varianceUnit,
    };
  }

  function pairInput(slot) {
    const image = slot.image;
    return { name: slot.name, meta: image.meta, width: image.width, height: image.height, wcs: image.wcs, wcsReason: image.wcsReason, fingerprint: image.fingerprint };
  }

  function compute() {
    const keep = state.selected;
    const previous = state.result;
    clearResult();
    const [reference, target] = [data.reference, data.target];
    if (!reference.image || !target.image) return;
    state.pair = Pair.compareObservations(pairInput(reference), pairInput(target));
    state.outcome = Diff.computeDifference(diffInput(reference), diffInput(target), { alignment: state.alignment, background: state.background, assumeSameUnit: state.assume });
    if (state.outcome.ok) {
      state.result = state.outcome.result;
      window.AstroNotLatestDifference = state.result; // The reusable result for other tools (Motion Detector) and for tests.
      if (!previous || previous.width !== state.result.width || previous.height !== state.result.height) fitView();
      if (keep && previous && previous.width === state.result.width && previous.height === state.result.height) state.selected = keep;
    }
    buildPictures();
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

  function customLimit() {
    const text = state.custom.trim().replace(minus, "-");
    if (!text) return null;
    const value = Number(text);
    return Number.isFinite(value) && value > 0 ? value : NaN;
  }

  function buildPictures() {
    const result = state.result;
    state.ranges = { gray: null, limit: null, limitNote: "" };
    if (!result) return;
    const make = () => document.createElement("canvas");
    state.ranges.gray = Pair.displayRange([result.reference.values, result.target.values], ...clipFractions());
    state.pictures.reference = make();
    state.pictures.target = make();
    paintGray(state.pictures.reference, result.reference.values, result.reference.valid, state.ranges.gray, result.width, result.height);
    paintGray(state.pictures.target, result.target.values, result.target.valid, state.ranges.gray, result.width, result.height);
    if (result.empty) return;

    let limit;
    let note;
    const custom = state.limit === "custom" ? customLimit() : null;
    if (state.limit === "custom" && custom !== null && !Number.isNaN(custom)) {
      limit = custom;
      note = "custom limit";
    } else {
      const percentile = state.limit === "custom" ? 99 : Number(state.limit);
      limit = Diff.symmetricLimit(result.difference, result.valid, percentile);
      note = percentile === 100 ? "maximum |Δ|" : percentile + "th percentile of |Δ|";
    }
    if (limit === 0) {
      limit = 1;
      note += "; every valid Δ is zero, so ±1 is shown";
    }
    state.ranges.limit = limit;
    state.ranges.limitNote = note;
    state.pictures.difference = make();
    paintDiverging(state.pictures.difference, result.difference, result.valid, limit, result.width, result.height);
  }

  function renderLegend() {
    const result = state.result;
    const limit = state.ranges.limit;
    el.legend.hidden = !result;
    if (!result) return;
    const hasScale = limit !== null && !result.empty;
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
    const unit = result.unit ? " " + result.unit : "";
    el.legendLow.textContent = minus + significant(limit, 4) + unit;
    el.legendHigh.textContent = "+" + significant(limit, 4) + unit;
    el.legendText.textContent = "Δ = target − reference, in " + (result.unit || "the (unspecified) image unit") + ". Zero is the neutral center. Blue: the target is lower than the reference. Red: the target is higher. Values beyond the limits (" + state.ranges.limitNote + ") are clipped in the picture only; readouts and exports keep the exact values.";
  }

  // ---- Rendering the page --------------------------------------------------------------------------------------------
  function refresh(options = {}) {
    if (options.compute) compute();
    for (const role of roles) renderSlot(role);
    renderResult();
    renderControls();
    renderLegend();
    renderReadout();
    invalidate();
  }

  function renderSlot(role) {
    const slot = data[role];
    const d = dom[role];
    const image = slot.image;
    const meta = image && image.meta;
    d.fileLabel.textContent = slot.file ? "Change FITS file" : "Choose FITS file";
    d.status.toggleAttribute("data-error", Boolean(slot.error));
    d.status.textContent = slot.error || slot.message;
    d.hdu.replaceChildren(...slot.choices.map(({ hdu, index }) => new Option(index + " · " + hdu.name + " (" + hdu.axes.join(" × ") + ")", index)));
    if (slot.choices.length) d.hdu.value = String(slot.hduIndex);
    d.hdu.disabled = !slot.choices.length;
    const set = (name, text) => setFact(d.root, name, text);
    set("file", slot.file ? slot.name + (slot.isExample ? " · SPHEREx example" : " · local file") : "—");
    set("obsId", meta ? meta.obsId ?? "Unavailable" : "—");
    set("hdu", meta ? meta.hduIndex + " · " + meta.hduName : "—");
    set("size", meta ? meta.width + " × " + meta.height + " pixels" : "—");
    set("unit", meta ? meta.unit ?? "Unavailable" : "—");
    set("time", meta ? timeText(meta.time) : "—");
    set("wavelength", meta ? meta.wavelength ? significant(meta.wavelength.center.micron, 4) + " μm at the center (bandwidth " + significant(meta.wavelength.center.bandwidth, 3) + " μm)" : "Unavailable" : "—");
    set("detector", meta ? meta.detector === null ? "Unavailable" : "D" + meta.detector : "—");
    set("variance", image ? image.varianceNote : "—");
    set("wcs", image ? image.wcs ? image.wcs.summary : "Unavailable: " + image.wcsReason : "—");
  }

  function addItem(list, text, className) {
    const item = document.createElement("li");
    if (className) item.className = className;
    item.textContent = text;
    list.append(item);
  }

  function percent(part, whole) {
    return whole ? (100 * part / whole).toFixed(1) + "%" : "0%";
  }

  function renderResult() {
    const { outcome, result, pair } = state;
    const [reference, target] = [data.reference, data.target];
    el.notes.replaceChildren();
    el.summary.hidden = !result;
    el.conditions.hidden = !pair;
    el.swap.setAttribute("aria-disabled", String(!(reference.file || target.file)));
    el.download.setAttribute("aria-disabled", String(!result || result.empty));
    el.assumeWrap.hidden = !(outcome && !outcome.ok && outcome.code === "unit-missing") && !(state.assume && outcome && outcome.ok && outcome.result.unitCheck.state === "assumed");
    el.exportStatus.textContent = "";

    if (!outcome) {
      el.verdict.textContent = reference.loading || target.loading ? "Reading the selected file…"
        : reference.image || target.image ? "Load the other image to compute the difference."
          : "Load a reference and a target image to compute the difference.";
      el.notes.hidden = true;
      return;
    }

    if (!outcome.ok) {
      el.verdict.textContent = "No difference was computed.";
      addItem(el.notes, outcome.reason, "tm-notes__error");
    } else {
      const time = pair.time;
      el.verdict.textContent = result.empty
        ? "The difference is empty. " + result.emptyReason
        : result.counts.valid.toLocaleString("en-US") + " valid pixels of " + result.counts.total.toLocaleString("en-US") + ". " +
          (time.state === "ordered" ? "The target was observed " + time.text + "." : time.state === "same" ? "Both observations have the same time." : "The observation times are not both available, so their order is not known.");
      if (result.empty) addItem(el.notes, result.emptyReason, "tm-notes__warning");
      for (const text of result.warnings) addItem(el.notes, text, "tm-notes__warning");
      for (const text of result.notes) addItem(el.notes, text, "tm-notes__info");
      if (time.state === "ordered" && time.earlier === "comparison") addItem(el.notes, "The target was observed before the reference, so a positive Δ means the target (the earlier image) is brighter.", "tm-notes__info");
    }
    for (const warning of pair.warnings) {
      if (["duplicate", "no-overlap", "unit"].includes(warning.code)) continue; // The computation reports these with its own reason.
      addItem(el.notes, warning.text.replaceAll("comparison", "target").replaceAll("Comparison", "Target"), "tm-notes__" + warning.severity);
    }
    el.notes.hidden = !el.notes.children.length;

    if (result) renderSummary(result);
    renderConditions(pair);
  }

  function renderSummary(result) {
    const set = (name, text) => setFact(el.summary, name, text, "data-id-fact");
    const describe = (entry) => (entry.obsId ?? "ID unavailable") + " (" + timeText(entry.time) + ")";
    set("observations", "Reference " + describe(result.reference) + " · Target " + describe(result.target));
    set("method", result.summary + " " + result.interpretation);
    if (result.resampling) {
      const r = result.resampling;
      set("resampling", "Bilinear interpolation of the target onto the reference grid. Grid offset before alignment: " + significant(r.gridOffsetBeforePixels, 3) + " pixel (" + significant(r.gridOffsetBeforeArcsec, 3) + " arcsec). Pixel scale: target " + significant(r.targetPixelScaleArcsec, 4) + " arcsec, reference " + significant(r.referencePixelScaleArcsec, 4) + " arcsec. Usable footprint: all four neighbouring target pixel centers must lie inside the target. A pixel is invalid when its interpolation touches a NaN or masked pixel. " + r.correlation);
    } else {
      set("resampling", "None. Both arrays are on one verified pixel grid and are subtracted as they are.");
    }
    const c = result.counts;
    set("valid", c.valid.toLocaleString("en-US") + " of " + c.total.toLocaleString("en-US") + " reference-grid pixels (" + percent(c.valid, c.total) + "). Invalid: " + c.outside.toLocaleString("en-US") + " outside the area covered by the target, " + c.referenceInvalid.toLocaleString("en-US") + " NaN or masked in the reference, " + c.targetInvalid.toLocaleString("en-US") + " NaN or masked in the target.");
    set("unit", (result.unit || "Unavailable") + (result.unitCheck.note ? ". " + result.unitCheck.note : ". Both images use the same unit."));
    set("variance", result.varianceNote);
    set("background", result.background.method === "none" ? "None. A constant sky or zodiacal background difference, if present, stays in Δ."
      : result.background.value === null ? result.background.description : result.background.description + " Offset " + signed(result.background.value, 6) + (result.unit ? " " + result.unit : "") + " from " + result.background.pixels.toLocaleString("en-US") + " pixels.");
    set("psf", "Not applied. " + "Differences in the point spread function and pixel scale between the exposures remain in Δ and leave residuals around bright sources.");
  }

  function renderConditions(pair) {
    const conversion = Diff.unitConversion(data.target.image.unit, data.reference.image.unit);
    el.conditionsBody.replaceChildren(...pair.conditions.map((entry) => {
      let { status, note } = entry;
      if (entry.key === "unit") {
        // pair.js compares units without case; the difference needs the exact unit.
        status = conversion.state === "same" ? "same" : conversion.state === "unknown" ? "unknown" : "different";
        note = conversion.state === "scaled" ? "Converted by a Jy prefix." : conversion.state === "different" ? "Not comparable." : "";
      }
      const row = document.createElement("tr");
      row.dataset.status = status;
      const label = document.createElement("th");
      label.scope = "row";
      label.textContent = entry.label;
      const cells = [entry.reference, entry.comparison].map((text) => {
        const cell = document.createElement("td");
        cell.textContent = text;
        return cell;
      });
      const match = document.createElement("td");
      match.textContent = { same: "Same", different: "Differs", unknown: "Unknown" }[status] + (note ? " · " + note : "");
      row.append(label, ...cells, match);
      return row;
    }));
  }

  function renderControls() {
    const result = state.result;
    el.fit.setAttribute("aria-disabled", String(!result));
    el.alignment.value = state.alignment;
    el.background.value = state.background;
    el.assume.checked = state.assume;
    el.clip.value = state.clip;
    el.limit.value = state.limit;
    el.customWrap.hidden = state.limit !== "custom";
    const notes = [];
    if (state.limit === "custom" && customLimit() !== null && Number.isNaN(customLimit())) notes.push("The custom limit must be a number greater than zero; the 99th percentile is used until it is.");
    el.displayNote.textContent = (notes.length ? notes.join(" ") + " " : "") + "The display range and the color scale change only how the images look. Values, masks and the difference are never altered by them.";
    el.settingsNote.textContent = state.alignment === "require-same-grid"
      ? "The target will not be resampled: if the two images are not on one verified pixel grid, no difference is computed."
      : "If the images are on one verified pixel grid they are subtracted as they are. Otherwise the target is bilinearly reprojected onto the reference grid, which smooths it and correlates its noise.";
  }

  // ---- Swap, export, buttons -----------------------------------------------------------------------------------------
  function swapRoles() {
    if (!(data.reference.file || data.target.file)) return;
    [data.reference, data.target] = [data.target, data.reference];
    data.reference.role = "reference";
    data.target.role = "target";
    state.selected = null;
    fitView();
    refresh({ compute: true });
    const result = state.result;
    announce("Reference and target swapped. Reference: " + (data.reference.image ? data.reference.image.meta.obsId ?? "ID unavailable" : "empty") + ". Target: " + (data.target.image ? data.target.image.meta.obsId ?? "ID unavailable" : "empty") + ". " + (result ? "Δ = target − reference was recomputed." : ""));
  }

  function downloadResult() {
    const result = state.result;
    if (!result || result.empty) return;
    const safe = (text) => String(text ?? "unavailable").replace(/[^A-Za-z0-9_-]+/g, "_");
    const bytes = Diff.buildDifferenceFits(result);
    const name = "AstroNot-difference_" + safe(result.target.obsId) + "-minus-" + safe(result.reference.obsId) + ".fits";
    const link = document.createElement("a");
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/fits" }));
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    el.exportStatus.textContent = "Saved " + name + " (" + bytes.length.toLocaleString("en-US") + " bytes): Δ = target − reference on the reference grid.";
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
    for (const role of roles) {
      const d = dom[role];
      d.file.addEventListener("change", () => {
        const file = d.file.files[0];
        d.file.value = ""; // So choosing the same file again fires another change.
        if (file) openFile(data[role], file, file.name);
      });
      d.hdu.addEventListener("change", () => {
        const slot = data[role];
        if (!slot.file) return;
        slot.hduIndex = Number(d.hdu.value);
        showHdu(slot, slot.version);
      });
      d.file.disabled = false;
    }

    el.example.addEventListener("click", async () => {
      setStatus("Loading the example pair…");
      try {
        const files = await loadExample();
        setStatus("");
        await Promise.all(roles.map((role) => openFile(data[role], files[role], files[role].name, true)));
        setStatus("Example pair: two real SPHEREx QR2 observations of the same field, 18 days apart. The reference is the earlier one.");
      } catch (error) {
        setStatus(error.message, true);
      }
    });
    el.example.disabled = false;

    const press = (button, action) => button.addEventListener("click", () => {
      if (button.getAttribute("aria-disabled") === "true") return;
      action();
    });
    press(el.swap, swapRoles);
    press(el.download, downloadResult);
    press(el.fit, () => { fitView(); invalidate(); announce("All views fitted to the whole image."); });
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

    el.alignment.addEventListener("change", () => { state.alignment = el.alignment.value; refresh({ compute: true }); });
    el.background.addEventListener("change", () => { state.background = el.background.value; refresh({ compute: true }); });
    el.assume.addEventListener("change", () => { state.assume = el.assume.checked; refresh({ compute: true }); });
    el.clip.addEventListener("change", () => { state.clip = el.clip.value; buildPictures(); refresh(); });
    el.limit.addEventListener("change", () => { state.limit = el.limit.value; buildPictures(); refresh(); });
    el.custom.addEventListener("input", () => { state.custom = el.custom.value; buildPictures(); refresh(); });
  }

  buildSlots();
  buildPanels();
  wire();
  refresh({ compute: true });
})();
