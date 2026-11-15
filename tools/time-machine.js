// Time Machine: compares two observations of one sky field. FITS structure and calibrated pixel values come from
// tools/fits.js (shared with FITS Viewer), all coordinate maths from tools/wcs.js and all pair decisions (observation
// time, sky overlap, pixel-grid check, units, wavelength, duplicate detection, shared view, blink speeds) from
// tools/pair.js. This file is the user interface only.
//
// Data flow: each slot ("reference", "comparison") holds one opened file. Its image keeps the calibrated values
// (BSCALE/BZERO applied, BLANK as NaN) in `values`; the grayscale `picture` is only a rendering of those values with a
// display range. Pan, zoom, contrast and Blink never change `values`, and every readout reads `values`.
(function () {
  "use strict";

  const Wcs = AstroNotWcs;
  const Pair = AstroNotPair;
  const { createWcs, screenToFits, fitsToScreen, insideImage, pixelIndex } = Wcs;

  const roles = ["reference", "comparison"];
  const roleTitle = { reference: "Reference observation", comparison: "Comparison observation" };
  const roleName = { reference: "Reference", comparison: "Comparison" };
  const minus = "−";
  const zoomStep = 2;
  const panFraction = 0.2;
  const tapDistance = 5; // A pointer that moves less than this many CSS pixels between down and up is a tap.

  const query = (name, scope = document) => scope.querySelector("[data-tm-" + name + "]");
  const reducedMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };

  const el = {
    status: query("status"),
    example: query("example"),
    swap: query("swap"),
    slots: query("slots"),
    verdict: query("verdict"),
    warnings: query("warnings"),
    timeline: query("timeline"),
    track: query("track"),
    timelineList: query("timeline-list"),
    timelineText: query("timeline-text"),
    timelineMissing: query("timeline-missing"),
    checks: query("checks"),
    conditions: query("conditions"),
    conditionsBody: query("conditions-body"),
    modeButtons: [...document.querySelectorAll("[data-tm-mode]")],
    contrast: query("contrast"),
    clip: query("clip"),
    link: query("link"),
    align: query("align"),
    controlNote: query("control-note"),
    blinkControls: query("blink-controls"),
    frameButtons: [...document.querySelectorAll("[data-tm-frame]")],
    blinkToggle: query("blink-toggle"),
    speed: query("speed"),
    blinkNote: query("blink-note"),
    panels: query("panels"),
    live: query("live"),
    markNote: query("mark-note"),
    markTable: query("mark-table"),
    markBody: query("mark-body"),
    centerMark: query("center-mark"),
    clearMark: query("clear-mark"),
  };

  // ---- State ---------------------------------------------------------------------------------------------------------
  function newSlot() {
    return {
      role: "", file: null, name: "", isExample: false, hdus: null, choices: [], hduIndex: -1,
      version: 0, hduVersion: 0, loading: false, error: "", message: "",
      image: null, manualTime: null, view: null,
    };
  }

  const data = { reference: newSlot(), comparison: newSlot() };
  data.reference.role = "reference";
  data.comparison.role = "comparison";
  const dom = {};

  const state = {
    mode: "side", // "side" or "blink"
    link: true,
    align: false,
    contrast: "shared",
    clip: "1-99",
    mark: null, // { sky: {ra, dec} } or { owner: slot, x, y }
    blink: Pair.createBlinkState(reducedMotion.matches),
    pair: null,
    aligned: null, // { for: comparison image, against: reference image, image }
    shared: { zoom: 1, centerX: 1, centerY: 1 },
    pairVersion: 0,
  };
  let blinkTimer = 0;
  let live = "";

  // ---- Small helpers -------------------------------------------------------------------------------------------------
  function setStatus(message, error = false) {
    el.status.toggleAttribute("data-error", error);
    el.status.textContent = message;
  }

  function degrees(value, digits = 6) {
    return value.toFixed(digits).replace("-", minus) + "°";
  }

  function significant(value, digits = 4) {
    return Number(value.toPrecision(digits)).toString().replace("-", minus);
  }

  function angleText(value) {
    const precise = Number(value.toPrecision(4)) + "°";
    if (value >= 1) return precise;
    if (value >= 1 / 60) return Number((value * 60).toPrecision(4)) + "′";
    return Number((value * 3600).toPrecision(4)) + "″";
  }

  function setFact(root, name, text) {
    const target = root.querySelector('[data-tm-fact="' + name + '"]');
    if (target.textContent !== text) target.textContent = text;
  }

  function timeText(time) {
    if (!time || !time.valid) return "Observation time unavailable";
    return time.display + " " + time.scale;
  }

  function slotImage(role) {
    return data[role].image;
  }

  // The image drawn and read for a role: the comparison may be shown aligned to the reference grid.
  function displayedImage(role) {
    if (role === "comparison" && state.aligned && state.align) return state.aligned.image;
    return data[role].image;
  }

  function announce(message) {
    live = message;
    el.live.textContent = message;
  }

  // ---- Slots: DOM ----------------------------------------------------------------------------------------------------
  function buildSlots() {
    const slotTemplate = document.querySelector("[data-tm-slot-template]");
    const panelTemplate = document.querySelector("[data-tm-panel-template]");
    for (const role of roles) {
      const root = slotTemplate.content.firstElementChild.cloneNode(true);
      root.dataset.tmSlot = role;
      root.setAttribute("aria-labelledby", "tm-slot-" + role + "-title");
      const title = query("slot-title", root);
      title.id = "tm-slot-" + role + "-title";
      title.textContent = roleTitle[role];
      query("slot-badge", root).textContent = role === "reference" ? "Left panel" : "Right panel";
      el.slots.append(root);
      dom[role] = {
        root,
        file: query("file", root),
        fileLabel: query("file-label", root),
        hdu: query("hdu", root),
        status: query("slot-status", root),
        timeIssues: query("time-issues", root),
        manual: query("manual", root),
        manualInput: query("manual-input", root),
        manualApply: query("manual-apply", root),
        manualClear: query("manual-clear", root),
        panel: null,
      };
    }
    const wrapper = document.createElement("div");
    wrapper.className = "tm-panels__side";
    el.panels.append(wrapper);
    for (const role of roles) {
      const panel = createPanel(panelTemplate, () => role, roleName[role]);
      dom[role].panel = panel;
      wrapper.append(panel.root);
    }
    state.stage = createPanel(panelTemplate, () => state.blink.frame, "Blink");
    state.stage.root.hidden = true;
    state.stage.root.classList.add("tm-panel--stage");
    el.panels.append(state.stage.root);
    dom.sideWrapper = wrapper;
  }

  // ---- Panels --------------------------------------------------------------------------------------------------------
  function createPanel(template, roleOf, label) {
    const root = template.content.firstElementChild.cloneNode(true);
    const panel = {
      root, roleOf, label,
      viewport: query("viewport", root),
      canvas: query("canvas", root),
      empty: query("empty", root),
      badge: query("badge", root),
      title: query("panel-title", root),
      roleLabel: query("panel-role", root),
      range: query("range", root),
      zoom: query("zoom", root),
      pointer: query("pointer", root),
      size: { width: 1, height: 1, ratio: window.devicePixelRatio || 1 },
      point: null, // pointer position in panel CSS pixels while over the image
      frame: 0,
      touches: new Map(),
      pinch: null,
      down: null,
    };
    panel.ctx = panel.canvas.getContext("2d");
    new ResizeObserver(() => invalidate(panel)).observe(panel.viewport);
    attachPanelEvents(panel);
    return panel;
  }

  function allPanels() {
    return [dom.reference.panel, dom.comparison.panel, state.stage];
  }

  function activePanels() {
    return state.mode === "blink" ? [state.stage] : [dom.reference.panel, dom.comparison.panel];
  }

  function linkActive() {
    const link = linkDecision();
    return link.allowed && (state.mode === "blink" || state.link);
  }

  function viewFor(panel) {
    const role = panel.roleOf();
    const slot = data[role];
    if (linkActive()) return state.shared;
    return slot.view;
  }

  // The panel size that sets zoom 1. Linked side-by-side panels share the smaller size so both get one scale.
  function fitFor(panel) {
    if (state.mode === "side" && linkActive()) {
      const [a, b] = [dom.reference.panel.size, dom.comparison.panel.size];
      return { width: Math.min(a.width, b.width), height: Math.min(a.height, b.height) };
    }
    return panel.size;
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

  function geometry(panel, image) {
    return Pair.viewGeometry(viewFor(panel), image.width, image.height, panel.size, fitFor(panel));
  }

  function invalidate(panel) {
    if (panel) {
      if (!panel.frame) panel.frame = requestAnimationFrame(() => renderPanel(panel));
    } else {
      for (const each of allPanels()) invalidate(each);
    }
  }

  function markPosition(role) {
    const mark = state.mark;
    const image = displayedImage(role);
    if (!mark || !image) return null;
    if (mark.owner) {
      return data[role] === mark.owner ? { x: mark.x, y: mark.y } : null;
    }
    if (!image.wcs) return null;
    return image.wcs.skyToPixel(mark.sky.ra, mark.sky.dec);
  }

  function valueText(image, x, y) {
    if (!image) return "—";
    const index = pixelIndex(x, y, image.width, image.height);
    if (index < 0) return "Outside image data";
    const value = image.values[index];
    if (Number.isNaN(value)) return "Undefined (NaN or BLANK)";
    return significant(value, 7) + (image.unit ? " " + image.unit : "");
  }

  function skyAt(image, x, y) {
    if (!image.wcs || !insideImage(x, y, image.width, image.height)) return null;
    return image.wcs.pixelToSky(x, y);
  }

  function renderPanel(panel) {
    panel.frame = 0;
    const role = panel.roleOf();
    const image = displayedImage(role);
    const slot = data[role];
    const visible = !panel.root.hidden;
    if (!visible) return;
    panel.roleLabel.textContent = panel.label === "Blink" ? "Blink · showing " + roleName[role] : roleName[role];
    panel.title.textContent = panelTitle(slot);
    if (!image) {
      panel.canvas.hidden = true;
      panel.empty.hidden = false;
      panel.empty.querySelector("p").textContent = slot.loading ? "Reading the file…" : slot.error ? "This file could not be shown." : "Load an observation to see it here.";
      panel.badge.hidden = true;
      panel.range.textContent = "";
      panel.zoom.textContent = "";
      panel.pointer.textContent = "";
      panel.viewport.removeAttribute("data-loaded");
      panel.viewport.setAttribute("aria-label", roleName[role] + " image view, no image loaded");
      return;
    }
    panel.empty.hidden = true;
    panel.canvas.hidden = false;
    panel.viewport.toggleAttribute("data-loaded", true);
    resizePanel(panel);
    const view = viewFor(panel);
    Pair.clampView(view, image.width, image.height, fitFor(panel));
    const geo = geometry(panel, image);
    const ctx = panel.ctx;
    const ratio = panel.size.ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = "#060709";
    ctx.fillRect(0, 0, panel.size.width, panel.size.height);
    ctx.imageSmoothingEnabled = false;
    const origin = fitsToScreen(geo, 0.5, image.height + 0.5);
    ctx.drawImage(image.picture, origin.x, origin.y, image.width * geo.scale, image.height * geo.scale);
    ctx.strokeStyle = "#4a505a";
    ctx.lineWidth = 1;
    ctx.strokeRect(origin.x - 0.5, origin.y - 0.5, image.width * geo.scale + 1, image.height * geo.scale + 1);
    drawCross(ctx, panel.size.width / 2, panel.size.height / 2);
    const mark = markPosition(role);
    if (mark && insideImage(mark.x, mark.y, image.width, image.height)) {
      const at = fitsToScreen(geo, mark.x, mark.y);
      for (const [color, width] of [["rgba(0,0,0,0.8)", 4], ["#ffd24a", 2]]) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.arc(at.x, at.y, 9, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    panel.canvas.setAttribute("aria-label", roleName[role] + " image" + (slot.image && slot.image.meta ? ", observation " + (slot.image.meta.obsId ?? "ID unavailable") : "") + ", " + timeText(slot.image.meta.time));
    panel.viewport.setAttribute("aria-label", roleName[role] + " image view");
    panel.badge.hidden = panel.label !== "Blink";
    panel.badge.textContent = roleName[role] + " · " + (slot.image.meta.time.valid ? slot.image.meta.time.display : "time unavailable");
    panel.badge.dataset.role = role;
    const range = image.rangeUsed;
    panel.range.textContent = range
      ? "Display range " + significant(range.low) + " to " + significant(range.high) + (image.unit ? " " + image.unit : "") + " · " + (image.rangeLabel || "")
      : "Display range unavailable";
    const zoom = viewFor(panel).zoom;
    panel.zoom.textContent = "Zoom " + (zoom < 10 ? zoom.toFixed(1) : zoom.toFixed(0)) + "× (1× shows the whole image)" + (linkActive() ? " · linked" : "");
    panel.viewport.toggleAttribute("data-pannable", zoom > 1.001);
    updatePointerLine(panel, image, geo);
  }

  function drawCross(ctx, cx, cy) {
    for (const [color, width] of [["rgba(0,0,0,0.75)", 3], ["rgba(255,255,255,0.9)", 1]]) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(cx - 9, cy);
      ctx.lineTo(cx - 3, cy);
      ctx.moveTo(cx + 3, cy);
      ctx.lineTo(cx + 9, cy);
      ctx.moveTo(cx, cy - 9);
      ctx.lineTo(cx, cy - 3);
      ctx.moveTo(cx, cy + 3);
      ctx.lineTo(cx, cy + 9);
      ctx.stroke();
    }
  }

  function panelTitle(slot) {
    const meta = slot.image && slot.image.meta;
    if (!meta) return slot.name || "No file";
    return [timeText(meta.time), meta.obsId ?? "Observation ID unavailable", "HDU " + meta.hduIndex + " " + meta.hduName].join(" · ");
  }

  function updatePointerLine(panel, image, geo) {
    if (!panel.point) {
      panel.pointer.textContent = "Pointer: move over the image to read RA, Dec and the value.";
      return;
    }
    const at = screenToFits(geo, panel.point.x, panel.point.y);
    const sky = skyAt(image, at.x, at.y);
    const where = insideImage(at.x, at.y, image.width, image.height) ? "" : "Outside image data";
    panel.pointer.textContent = "Pointer: pixel " + at.x.toFixed(1) + ", " + at.y.toFixed(1) +
      (sky ? " · RA " + degrees(sky.ra, 5) + ", Dec " + degrees(sky.dec, 5) : where ? " · " + where : " · RA, Dec unavailable") +
      " · " + valueText(image, at.x, at.y);
  }

  // ---- View changes --------------------------------------------------------------------------------------------------
  function fitViews() {
    for (const role of roles) {
      const image = displayedImage(role);
      if (image) data[role].view = Pair.createView(image.width, image.height);
    }
    const reference = displayedImage("reference");
    state.shared = reference ? Pair.createView(reference.width, reference.height) : { zoom: 1, centerX: 1, centerY: 1 };
  }

  function actOn(panel, change) {
    const role = panel.roleOf();
    const image = displayedImage(role);
    if (!image) return;
    change(viewFor(panel), image, fitFor(panel));
    invalidate();
    announceView(panel);
  }

  let announceTimer = 0;
  function announceView(panel) {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      const image = displayedImage(panel.roleOf());
      if (!image) return;
      const view = viewFor(panel);
      const sky = skyAt(image, view.centerX, view.centerY);
      announce(roleName[panel.roleOf()] + " view center " + (sky ? "RA " + degrees(sky.ra, 5) + ", Dec " + degrees(sky.dec, 5) : "pixel " + view.centerX.toFixed(1) + ", " + view.centerY.toFixed(1)) + ". Zoom " + view.zoom.toFixed(1) + " times." + (linkActive() ? " The other image follows." : ""));
    }, 450);
  }

  function zoomPanel(panel, factor, sx, sy) {
    actOn(panel, (view, image, fit) => Pair.zoomViewAt(view, factor, image.width, image.height, panel.size, fit, sx, sy));
  }

  function panPanel(panel, dx, dy) {
    actOn(panel, (view, image, fit) => Pair.panViewByScreen(view, dx, dy, image.width, image.height, panel.size, fit));
  }

  function fitPanel(panel) {
    actOn(panel, (view, image) => Object.assign(view, Pair.createView(image.width, image.height)));
  }

  // ---- Marking a point -----------------------------------------------------------------------------------------------
  function markAt(panel, sx, sy) {
    const role = panel.roleOf();
    const image = displayedImage(role);
    if (!image) return;
    const at = screenToFits(geometry(panel, image), sx, sy);
    if (!insideImage(at.x, at.y, image.width, image.height)) {
      announce("That point is outside the image data, so nothing was marked.");
      return;
    }
    const sky = image.wcs ? image.wcs.pixelToSky(at.x, at.y) : null;
    state.mark = sky ? { sky, from: role } : { owner: data[role], x: at.x, y: at.y };
    renderMark();
    invalidate();
    const lines = ["Marked " + roleName[role] + " pixel " + at.x.toFixed(1) + ", " + at.y.toFixed(1) + (sky ? ", RA " + degrees(sky.ra, 5) + ", Dec " + degrees(sky.dec, 5) : ", no sky coordinates") + "."];
    announce(lines.join(" "));
  }

  function valueAtMark(role) {
    const image = displayedImage(role);
    const position = markPosition(role);
    if (!image) return { pixel: "No image", value: "—", note: "" };
    if (!position) return { pixel: state.mark && state.mark.owner ? "Marked in the other image" : "No sky position (no WCS)", value: "—", note: "" };
    const note = role === "comparison" && state.align && state.aligned ? " (resampled copy)" : "";
    return {
      pixel: position.x.toFixed(2) + ", " + position.y.toFixed(2),
      value: valueText(image, position.x, position.y) + note,
    };
  }

  function renderMark() {
    const mark = state.mark;
    el.markTable.hidden = !mark;
    el.clearMark.setAttribute("aria-disabled", String(!mark));
    el.centerMark.setAttribute("aria-disabled", String(!mark));
    if (!mark) {
      el.markNote.textContent = "Click or tap an image, or press Enter in a focused view, to mark a point. The same sky position is shown in both images when both have a WCS.";
      el.markBody.replaceChildren();
      return;
    }
    el.markNote.textContent = mark.sky
      ? "Marked at RA " + degrees(mark.sky.ra) + ", Dec " + degrees(mark.sky.dec) + " (ICRS) in the " + roleName[mark.from].toLowerCase() + " image. Each value below is read from its own file."
      : "Marked at pixel " + mark.x.toFixed(2) + ", " + mark.y.toFixed(2) + " of one image without sky coordinates. The marked point stays tied to that file.";
    const rows = [];
    const per = { reference: valueAtMark("reference"), comparison: valueAtMark("comparison") };
    rows.push(["Observation", ...roles.map((role) => (data[role].image && data[role].image.meta.obsId) || "Unavailable")]);
    rows.push(["Observed", ...roles.map((role) => data[role].image ? timeText(data[role].image.meta.time) : "—")]);
    rows.push(["Pixel (x, y)", per.reference.pixel, per.comparison.pixel]);
    rows.push(["Value", per.reference.value, per.comparison.value]);
    if (mark.sky) {
      rows.push(["RA, Dec", ...roles.map((role) => {
        const image = displayedImage(role);
        const position = markPosition(role);
        const sky = image && position ? skyAt(image, position.x, position.y) : null;
        return sky ? degrees(sky.ra, 5) + ", " + degrees(sky.dec, 5) : "—";
      })]);
    }
    el.markBody.replaceChildren(...rows.map((cells) => {
      const row = document.createElement("tr");
      cells.forEach((text, index) => {
        const cell = document.createElement(index === 0 ? "th" : "td");
        if (index === 0) cell.scope = "row";
        cell.textContent = text;
        row.append(cell);
      });
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

    viewport.addEventListener("pointerdown", (event) => {
      if (!displayedImage(panel.roleOf()) || (event.pointerType === "mouse" && event.button !== 0)) return;
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
      if (!displayedImage(panel.roleOf())) return;
      const point = local(event);
      if (panel.touches.has(event.pointerId)) {
        if (panel.down && Math.hypot(point.x - panel.down.x, point.y - panel.down.y) > tapDistance) panel.down.moved = true;
        if (panel.touches.size === 1) {
          const previous = panel.touches.get(event.pointerId);
          // A finger on the fully visible image scrolls the page (touch-action: pan-y), so it must not also move the view.
          if (event.pointerType !== "touch" || viewFor(panel).zoom > 1.001) panPanel(panel, point.x - previous.x, point.y - previous.y);
          panel.touches.set(event.pointerId, point);
        } else if (panel.touches.size === 2 && panel.pinch) {
          panel.touches.set(event.pointerId, point);
          const next = pinchState();
          panPanel(panel, next.x - panel.pinch.x, next.y - panel.pinch.y);
          if (panel.pinch.distance > 0 && next.distance > 0) zoomPanel(panel, next.distance / panel.pinch.distance, next.x, next.y);
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
      if (wasTap && point) markAt(panel, point.x, point.y);
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
      if (!displayedImage(panel.roleOf()) || !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const point = local(event);
      zoomPanel(panel, Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0025)), point.x, point.y);
    }, { passive: false });

    viewport.addEventListener("keydown", (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key;
      const isStage = panel === state.stage;
      if (isStage && (key === " " || key.toLowerCase() === "b")) {
        event.preventDefault();
        setBlinking(!state.blink.running);
        return;
      }
      if (isStage && (key === "1" || key === "2")) {
        event.preventDefault();
        chooseFrame(key === "1" ? "reference" : "comparison");
        return;
      }
      if (!displayedImage(panel.roleOf())) return;
      const step = panFraction * Math.min(panel.size.width, panel.size.height) * (event.shiftKey ? 2.5 : 1);
      const actions = {
        ArrowLeft: () => panPanel(panel, step, 0),
        ArrowRight: () => panPanel(panel, -step, 0),
        ArrowUp: () => panPanel(panel, 0, step),
        ArrowDown: () => panPanel(panel, 0, -step),
        "+": () => zoomPanel(panel, zoomStep),
        "=": () => zoomPanel(panel, zoomStep),
        "-": () => zoomPanel(panel, 1 / zoomStep),
        "_": () => zoomPanel(panel, 1 / zoomStep),
        "0": () => fitPanel(panel),
        Home: () => fitPanel(panel),
        Enter: () => markAt(panel, panel.size.width / 2, panel.size.height / 2),
      };
      const action = actions[key];
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

  async function readWaveSummary(slot, file, hdus, hdu) {
    const name = String(hdu.fields.PS1_0W ?? "WCS-WAVE").trim();
    const table = hdus.find((entry) => entry.fields.XTENSION === "BINTABLE" && entry.fields.EXTNAME === name);
    if (!table || table.byteLength > 1 << 20) return null;
    const bytes = await file.slice(table.dataStart, table.dataStart + table.byteLength).arrayBuffer();
    const parsed = Pair.parseWaveTable(bytes, table.fields, hdu.fields);
    return parsed ? Pair.wavelengthSummary(parsed, hdu.fields, hdu.axes[0], hdu.axes[1]) : null;
  }

  async function readImage(slot, version, token) {
    const hdu = slot.hdus[slot.hduIndex];
    const bytes = await slot.file.slice(hdu.dataStart, hdu.dataStart + hdu.byteLength).arrayBuffer();
    if (version !== slot.version || token !== slot.hduVersion) return null;
    const read = fitsPixelReader(bytes, hdu);
    const values = new Float64Array(hdu.pixels);
    for (let index = 0; index < values.length; index++) values[index] = read(index);
    const wavelength = await readWaveSummary(slot, slot.file, slot.hdus, hdu);
    if (version !== slot.version || token !== slot.hduVersion) return null;
    const wcs = createWcs(hdu.fields);
    const [width, height] = hdu.axes;
    return {
      width, height, values, hdu, wavelength,
      picture: document.createElement("canvas"),
      wcs: wcs.ok ? wcs.wcs : null,
      wcsReason: wcs.ok ? "" : wcs.reason,
      unit: typeof hdu.fields.BUNIT === "string" ? hdu.fields.BUNIT.trim() : "",
      fingerprint: Pair.fingerprintValues(values),
      meta: null,
      ownRange: {},
    };
  }

  function buildMeta(slot) {
    const image = slot.image;
    if (!image) return;
    image.meta = Pair.describeObservation(image.hdu, slot.hduIndex, { wavelength: image.wavelength, manualTime: slot.manualTime });
  }

  async function showHdu(slot, version) {
    const token = ++slot.hduVersion;
    slot.image = null;
    slot.loading = true;
    slot.error = "";
    slot.message = "Reading image pixels…";
    clearDerived();
    refresh();
    try {
      const image = await readImage(slot, version, token);
      if (!image) return;
      slot.image = image;
      slot.loading = false;
      slot.manualTime = null;
      buildMeta(slot);
      slot.view = Pair.createView(image.width, image.height);
      slot.message = image.wcs ? "Image loaded." : "Image loaded. No usable sky coordinates.";
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
    Object.assign(slot, { file: null, name: "", isExample: false, hdus: null, choices: [], hduIndex: -1, image: null, error: "", manualTime: null, loading: true, message: "Reading FITS headers…" });
    if (state.mark && state.mark.owner === slot) state.mark = null;
    clearDerived();
    refresh();
    try {
      const file = await source;
      if (version !== slot.version) return;
      const hdus = await readFitsHdus(file);
      if (version !== slot.version) return;
      const choices = hdus.map((hdu, index) => ({ hdu, index })).filter(({ hdu }) => hdu.renderable);
      if (!choices.length) {
        const reasons = hdus.map((hdu, index) => "HDU " + index + " (" + hdu.name + "): " + whyNotDisplayable(hdu));
        throw new Error("This file has no image HDU that Time Machine can display. " + reasons.join("; ") + ".");
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
    refresh({ pictures: true });
    fitViews();
    announce(slot.error ? roleName[slot.role] + " observation: " + slot.error : slot.message);
  }

  let exampleLoad;
  function loadExample() {
    if (!exampleLoad) {
      const addScript = (path, ready) => new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = siteAsset(path);
        script.addEventListener("load", () => resolve(ready()), { once: true });
        script.addEventListener("error", () => reject(new Error("The example files could not be loaded.")), { once: true });
        document.head.append(script);
      });
      exampleLoad = addScript("assets/tools/spherex-time-machine-example.js", () => {
        const decode = (text) => Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
        return {
          reference: new File([decode(spherexTimeMachineExample.reference)], "SPHEREx-QR2-2025W21_2C_0280_1-D2.fits"),
          comparison: new File([decode(spherexTimeMachineExample.comparison)], "SPHEREx-QR2-2025W24_1A_0514_1-D2.fits"),
        };
      }).catch((error) => {
        exampleLoad = undefined;
        throw error;
      });
    }
    return exampleLoad;
  }

  // ---- Derived state: ranges, pictures, aligned copy, pair ----------------------------------------------------------
  function clipFractions() {
    const [low, high] = state.clip.split("-").map(Number);
    return [low / 100, high / 100];
  }

  function clearDerived() {
    state.pair = null;
    state.aligned = null;
  }

  function ownRange(image) {
    if (!image.ownRange[state.clip]) {
      const [low, high] = clipFractions();
      image.ownRange[state.clip] = Pair.displayRange([image.values], low, high) ?? { low: 0, high: 1 };
    }
    return image.ownRange[state.clip];
  }

  function paint(image, range) {
    const { width, height, values } = image;
    const canvas = image.picture;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    const picture = context.createImageData(width, height);
    const span = range.high - range.low;
    for (let y = 0; y < height; y++) {
      const sourceRow = (height - y - 1) * width; // FITS axis 2 starts at the bottom of the picture.
      for (let x = 0; x < width; x++) {
        const value = values[sourceRow + x];
        const shade = Number.isFinite(value) ? (span > 0 ? Math.max(0, Math.min(255, 255 * (value - range.low) / span)) : 128) : 0;
        const at = (y * width + x) * 4;
        picture.data[at] = picture.data[at + 1] = picture.data[at + 2] = shade;
        picture.data[at + 3] = 255;
      }
    }
    context.putImageData(picture, 0, 0);
  }

  function effectiveContrast() {
    return state.pair && state.pair.sharedContrast.allowed ? state.contrast : "separate";
  }

  function repaintAll() {
    const images = roles.map((role) => data[role].image);
    const shared = effectiveContrast() === "shared" && images[0] && images[1]
      ? Pair.displayRange([images[0].values, images[1].values], ...clipFractions())
      : null;
    for (const image of images) {
      if (!image) continue;
      const range = shared ?? ownRange(image);
      image.rangeUsed = range;
      image.rangeLabel = shared ? "shared by both images" : "separate range";
      paint(image, range);
    }
    const aligned = state.aligned;
    if (aligned) {
      aligned.image.rangeUsed = aligned.for.rangeUsed;
      aligned.image.rangeLabel = aligned.for.rangeLabel;
      paint(aligned.image, aligned.image.rangeUsed);
    }
  }

  function inputOf(slot) {
    const image = slot.image;
    return { name: slot.name, meta: image.meta, width: image.width, height: image.height, wcs: image.wcs, wcsReason: image.wcsReason, fingerprint: image.fingerprint };
  }

  function computePair() {
    const [reference, comparison] = roles.map((role) => data[role]);
    state.pair = reference.image && comparison.image ? Pair.compareObservations(inputOf(reference), inputOf(comparison)) : null;
    ensureAligned();
  }

  function alignAvailable() {
    const pair = state.pair;
    if (!pair || pair.duplicate || pair.grid.ok) return false;
    return (pair.overlap.state === "full" || pair.overlap.state === "substantial") && Boolean(data.reference.image.wcs && data.comparison.image.wcs);
  }

  function ensureAligned() {
    if (!state.align || !alignAvailable()) {
      state.aligned = null;
      return;
    }
    const reference = data.reference.image;
    const comparison = data.comparison.image;
    if (state.aligned && state.aligned.for === comparison && state.aligned.against === reference) return;
    const result = Pair.resampleOntoGrid(comparison, reference);
    state.aligned = result && {
      for: comparison, against: reference,
      image: Object.assign(result, { picture: document.createElement("canvas"), unit: comparison.unit, meta: comparison.meta, fingerprint: comparison.fingerprint }),
    };
  }

  // Link and Blink decision for what is actually shown (the aligned copy counts as the comparison when it is on).
  function linkDecision() {
    const pair = state.pair;
    if (!pair) return { allowed: false, reason: "Load both observations first." };
    if (state.align && state.aligned) {
      const grid = Pair.gridCompatibility(data.reference.image, state.aligned.image);
      return Pair.linkedViewDecision(grid, pair.overlap, pair.duplicate);
    }
    return pair.linkedView;
  }

  // ---- Rendering the page --------------------------------------------------------------------------------------------
  function refresh(options = {}) {
    if (options.pictures) {
      computePair();
    }
    const link = linkDecision();
    if (!link.allowed && state.mode === "blink") {
      state.mode = "side";
      stopBlink();
    }
    if (!link.allowed) stopBlink();
    if (options.pictures) repaintAll();
    for (const role of roles) renderSlot(role);
    renderPair();
    renderControls(link);
    renderMark();
    updateModeLayout();
    invalidate();
  }

  function panelHidden(panel, hidden) {
    panel.root.hidden = hidden;
  }

  function updateModeLayout() {
    dom.sideWrapper.hidden = state.mode === "blink";
    panelHidden(state.stage, state.mode !== "blink");
    for (const button of el.modeButtons) button.setAttribute("aria-pressed", String(button.dataset.tmMode === state.mode));
    el.blinkControls.hidden = state.mode !== "blink";
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
    set("frame", meta ? meta.frame ?? "Unavailable" : "—");
    set("time", meta ? timeText(meta.time) : "—");
    set("timeSource", meta ? meta.time.valid ? meta.time.sourceLabel : "Unavailable" : "—");
    set("processed", meta ? meta.processed ?? "Unavailable" : "—");
    set("wavelength", meta ? wavelengthFact(meta.wavelength) : "—");
    set("exposure", meta ? meta.exposureSeconds === null ? "Unavailable" : significant(meta.exposureSeconds, 5) + " s" : "—");
    set("detector", meta ? meta.detector === null ? "Unavailable" : "D" + meta.detector : "—");
    set("wcs", image ? image.wcs ? image.wcs.summary : "Unavailable: " + image.wcsReason : "—");
    const issues = meta ? (meta.time.valid ? meta.time.issues : (meta.time.headerIssues ?? meta.time.issues)) : [];
    d.timeIssues.textContent = meta && !meta.time.valid ? (meta.time.reason ?? "") + (issues.length ? " " + issues.join(" ") : "") : issues.join(" ");
    const needsManual = Boolean(meta) && (!meta.time.valid || meta.time.manual);
    d.manual.hidden = !needsManual;
    d.manualClear.hidden = !(meta && meta.time.manual);
  }

  function wavelengthFact(summary) {
    if (!summary) return "Unavailable";
    return significant(summary.center.micron) + " μm at the center (" + significant(summary.min) + "–" + significant(summary.max) + " μm across the image)";
  }

  function addItem(list, text, className) {
    const item = document.createElement("li");
    if (className) item.className = className;
    item.textContent = text;
    list.append(item);
  }

  function renderPair() {
    const pair = state.pair;
    const [reference, comparison] = roles.map((role) => data[role]);
    el.warnings.replaceChildren();
    el.timeline.hidden = true;
    el.timelineMissing.textContent = "";
    el.checks.hidden = !pair;
    el.conditions.closest("details").hidden = !pair;
    el.swap.setAttribute("aria-disabled", String(!(reference.file || comparison.file)));
    if (!pair) {
      el.verdict.textContent = reference.loading || comparison.loading
        ? "Reading the selected file…"
        : reference.image || comparison.image
          ? "Load the other observation to compare the pair."
          : "Load a reference and a comparison observation to compare them.";
      el.warnings.hidden = true;
      return;
    }

    const blocking = pair.warnings.find((warning) => warning.severity === "error");
    el.verdict.textContent = blocking
      ? blocking.text
      : pair.overlap.state === "full" || pair.overlap.state === "substantial"
        ? "These images cover the same sky area."
        : "Check the notes below before comparing these images.";

    for (const warning of pair.warnings) {
      if (warning !== blocking) addItem(el.warnings, warning.text, "tm-notes__" + warning.severity);
    }
    el.warnings.hidden = !el.warnings.children.length;

    const overlap = pair.overlap;
    const percent = (value) => Math.round(value * 100) + "%";
    set(el.checks, "overlap", overlap.state === "unavailable" ? "Unavailable: " + overlap.reason
      : { full: "Same field", substantial: "Mostly overlapping", partial: "Slight overlap", none: "No overlap" }[overlap.state] +
        " · reference " + percent(overlap.referenceCovered) + " covered, comparison " + percent(overlap.comparisonCovered) + " covered · centers " + angleText(overlap.centerSeparationDegrees) + " apart");
    const aligned = state.align && state.aligned;
    set(el.checks, "grid", pair.grid.ok ? "One common grid (largest offset " + significant(pair.grid.maxOffsetPixels, 2) + " pixels)"
      : pair.grid.reason + (aligned ? " Display alignment is on." : ""));
    const link = linkDecision();
    set(el.checks, "link", link.allowed ? "Available" + (aligned ? ", on the reference grid (comparison resampled)" : "")
      : link.reason === pair.grid.reason ? "Unavailable" : "Unavailable: " + link.reason);

    // Timeline: the two valid times in order.
    if (pair.timeline) {
      el.timeline.hidden = false;
      el.track.replaceChildren();
      el.timelineList.replaceChildren();
      const items = pair.timeline.items;
      items.forEach((item, index) => {
        const dot = document.createElement("span");
        dot.className = "tm-dot";
        dot.dataset.role = item.role;
        dot.textContent = item.role === "reference" ? "R" : "C";
        const same = pair.timeline.state === "same";
        dot.style.left = same ? (index === 0 ? "calc(50% - 0.95rem)" : "calc(50% + 0.95rem)") : item.fraction * 100 + "%";
        el.track.append(dot);
        const slot = data[item.role];
        addItem(el.timelineList, roleName[item.role] + " · " + timeText(item.time) + " · " + (slot.image.meta.obsId ?? "observation ID unavailable") + (item.time.manual ? " · entered manually" : " · from " + item.time.sourceLabel));
      });
      el.timelineText.textContent = pair.timeline.state === "same"
        ? "Both observations have the same time."
        : "The comparison was observed " + pair.time.text + ".";
    } else {
      el.timelineMissing.textContent = "Timeline unavailable: " + pair.time.reason + " You can enter a time by hand in the observation card.";
    }

    el.conditionsBody.replaceChildren(...pair.conditions.map((entry) => {
      const row = document.createElement("tr");
      row.dataset.status = entry.status;
      const label = document.createElement("th");
      label.scope = "row";
      label.textContent = entry.label;
      const cells = [entry.reference, entry.comparison].map((text) => {
        const cell = document.createElement("td");
        cell.textContent = text;
        return cell;
      });
      const match = document.createElement("td");
      match.textContent = { same: "Same", different: "Differs", unknown: "Unknown" }[entry.status] + (entry.note ? " · " + entry.note : "");
      row.append(label, ...cells, match);
      return row;
    }));
  }

  function set(root, name, text) {
    const target = root.querySelector('[data-tm-check="' + name + '"]');
    if (target.textContent !== text) target.textContent = text;
  }

  function renderControls(link) {
    const pair = state.pair;
    const blinkOk = link.allowed;
    el.modeButtons.find((button) => button.dataset.tmMode === "blink").setAttribute("aria-disabled", String(!blinkOk));
    el.link.disabled = !link.allowed || state.mode === "blink";
    el.link.checked = link.allowed && (state.mode === "blink" || state.link);
    el.align.disabled = !alignAvailable();
    el.align.checked = state.align && alignAvailable();

    const shared = pair ? pair.sharedContrast : { allowed: false, reason: "Load both observations to compare their contrast." };
    el.contrast.querySelector('[value="shared"]').disabled = !shared.allowed;
    el.contrast.value = effectiveContrast();
    el.clip.value = state.clip;

    const notes = [];
    if (!shared.allowed) notes.push("Shared contrast is unavailable: " + shared.reason + " Each panel uses its own range.");
    if (pair && !link.allowed) notes.push("Linked pan and zoom and Blink are unavailable: " + link.reason + " Each panel keeps its own pan and zoom.");
    if (pair && link.allowed && state.mode === "side") notes.push(state.link ? "The images share one pixel grid, so pan and zoom are linked." : "Pan and zoom are not linked.");
    if (pair && !alignAvailable() && !pair.grid.ok && !pair.duplicate && pair.overlap.state !== "none") notes.push("Display alignment needs a WCS in both images and a mostly overlapping field.");
    el.controlNote.textContent = notes.join(" ");

    el.blinkNote.textContent = !pair ? "Blink needs two loaded observations on one verified pixel grid."
      : link.allowed && state.blink.running ? "Blink is running at " + state.blink.speed + " frame" + (state.blink.speed === 1 ? "" : "s") + " per second. Choose Stop blinking, or press Space or B in the image, to hold one frame."
      : link.allowed ? (reducedMotion.matches ? "Reduced motion is on, so Blink stays off until you start it and runs at most once per second." : "Blink is stopped until you start it.")
        : "Blink is unavailable: " + link.reason + (alignAvailable() ? " Turn on display alignment to put the comparison on the reference grid." : "");

    const speeds = Pair.blinkSpeedOptions(reducedMotion.matches);
    if (el.speed.options.length !== speeds.length) el.speed.replaceChildren(...speeds.map((speed) => new Option(speed + (speed === 1 ? " frame per second" : " frames per second"), speed)));
    state.blink.speed = Pair.clampBlinkSpeed(state.blink.speed, reducedMotion.matches);
    el.speed.value = String(state.blink.speed);

    for (const button of el.frameButtons) button.setAttribute("aria-pressed", String(button.dataset.tmFrame === state.blink.frame));
    el.blinkToggle.setAttribute("aria-pressed", String(state.blink.running));
    el.blinkToggle.textContent = state.blink.running ? "Stop blinking" : "Start blinking";
  }

  // ---- Blink ---------------------------------------------------------------------------------------------------------
  function stopBlink() {
    clearInterval(blinkTimer);
    blinkTimer = 0;
    state.blink.running = false;
  }

  function setBlinking(running) {
    if (running && !linkDecision().allowed) return;
    stopBlink();
    if (running) {
      state.blink.running = true;
      blinkTimer = setInterval(() => {
        state.blink.frame = Pair.otherFrame(state.blink.frame);
        invalidate(state.stage);
        syncFrameButtons();
      }, 1000 / state.blink.speed);
    }
    renderControls(linkDecision());
    invalidate(state.stage);
    announce(running ? "Blink started at " + state.blink.speed + " frame" + (state.blink.speed === 1 ? "" : "s") + " per second." : "Blink stopped on the " + roleName[state.blink.frame].toLowerCase() + ".");
  }

  function syncFrameButtons() {
    for (const button of el.frameButtons) button.setAttribute("aria-pressed", String(button.dataset.tmFrame === state.blink.frame));
  }

  function chooseFrame(role) {
    const was = state.blink.running;
    stopBlink();
    state.blink.frame = role;
    renderControls(linkDecision());
    invalidate(state.stage);
    announce("Showing the " + roleName[role].toLowerCase() + (was ? ". Blink stopped." : "."));
  }

  function setMode(mode) {
    if (mode === "blink" && !linkDecision().allowed) return;
    stopBlink();
    state.mode = mode;
    refresh();
    announce(mode === "blink" ? "Blink view. Showing the " + roleName[state.blink.frame].toLowerCase() + ", stopped." : "Side by side view.");
  }

  // ---- Swap, manual time, buttons -------------------------------------------------------------------------------------
  function swapRoles() {
    if (!(data.reference.file || data.comparison.file)) return;
    [data.reference, data.comparison] = [data.comparison, data.reference];
    data.reference.role = "reference";
    data.comparison.role = "comparison";
    state.align = false; // The aligned copy was made for the old roles.
    state.aligned = null;
    stopBlink();
    state.blink.frame = "reference";
    for (const role of roles) if (data[role].image) buildMeta(data[role]);
    if (state.mark && state.mark.sky) state.mark.from = state.mark.from === "reference" ? "comparison" : "reference";
    refresh({ pictures: true });
    announce("Roles swapped. Reference: " + (data.reference.image ? timeText(data.reference.image.meta.time) : "empty") + ". Comparison: " + (data.comparison.image ? timeText(data.comparison.image.meta.time) : "empty") + ".");
  }

  function applyManualTime(role) {
    const slot = data[role];
    const text = dom[role].manualInput.value.trim();
    const result = Pair.manualObservationTime(text, slot.image && slot.image.meta ? slot.image.meta.processed : null);
    if (!result.valid) {
      slot.error = "";
      slot.message = result.reason;
      dom[role].status.toggleAttribute("data-error", true);
      dom[role].status.textContent = result.reason;
      return;
    }
    slot.manualTime = result;
    buildMeta(slot);
    refresh({ pictures: true });
    announce(roleName[role] + " observation time set manually to " + timeText(result) + ".");
  }

  function clearManualTime(role) {
    const slot = data[role];
    slot.manualTime = null;
    dom[role].manualInput.value = "";
    buildMeta(slot);
    refresh({ pictures: true });
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
      d.manualApply.addEventListener("click", () => applyManualTime(role));
      d.manualInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          applyManualTime(role);
        }
      });
      d.manualClear.addEventListener("click", () => clearManualTime(role));
      d.file.disabled = false;
    }

    el.example.addEventListener("click", async () => {
      setStatus("Loading the example pair…");
      try {
        const files = await loadExample();
        // Each role gets its own file, so the pair is two different observations.
        setStatus("");
        await Promise.all(roles.map((role) => openFile(data[role], files[role], files[role].name, true)));
        setStatus("Example pair: two real SPHEREx QR2 observations of the same field, 18 days apart.");
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
    for (const button of el.modeButtons) press(button, () => setMode(button.dataset.tmMode));
    for (const button of el.frameButtons) button.addEventListener("click", () => chooseFrame(button.dataset.tmFrame));
    el.blinkToggle.addEventListener("click", () => setBlinking(!state.blink.running));
    el.speed.addEventListener("change", () => {
      state.blink.speed = Pair.clampBlinkSpeed(Number(el.speed.value), reducedMotion.matches);
      if (state.blink.running) setBlinking(true);
    });
    el.contrast.addEventListener("change", () => {
      state.contrast = el.contrast.value;
      repaintAll();
      refresh();
    });
    el.clip.addEventListener("change", () => {
      state.clip = el.clip.value;
      repaintAll();
      refresh();
    });
    el.link.addEventListener("change", () => {
      if (el.link.checked) Object.assign(state.shared, data.reference.view);
      else for (const role of roles) if (data[role].view) Object.assign(data[role].view, state.shared);
      state.link = el.link.checked;
      refresh();
    });
    el.align.addEventListener("change", () => {
      state.align = el.align.checked;
      stopBlink();
      refresh({ pictures: true });
      fitViews();
      invalidate();
    });
    press(el.clearMark, () => {
      state.mark = null;
      renderMark();
      invalidate();
      announce("Mark cleared.");
    });
    press(el.centerMark, () => {
      for (const role of roles) {
        const image = displayedImage(role);
        const position = markPosition(role);
        if (!image || !position || !insideImage(position.x, position.y, image.width, image.height)) continue;
        const view = linkActive() ? state.shared : data[role].view;
        view.centerX = position.x;
        view.centerY = position.y;
      }
      invalidate();
      announce("Both views centered on the marked point where it is inside the image.");
    });
    if (reducedMotion.addEventListener) {
      reducedMotion.addEventListener("change", () => {
        if (reducedMotion.matches) stopBlink();
        refresh();
      });
    }
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stopBlink();
      renderControls(linkDecision());
    });
  }

  buildSlots();
  wire();
  refresh({ pictures: true });
  fitViews();
})();
