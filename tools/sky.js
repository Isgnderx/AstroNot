// Sky Explorer: opens a 2D FITS image HDU, lets the user zoom and pan, and reads RA/Dec and the field of view from
// the image WCS. FITS structure and calibrated pixel values come from tools/fits.js (shared with FITS Viewer);
// all coordinate maths lives in tools/wcs.js. This file is only the user interface.
//
// Data flow: the file is read once per HDU. The calibrated values are kept in `image.values` (BSCALE/BZERO applied,
// BLANK shown as NaN) and the grayscale picture in `image.picture`. Pan and zoom only change `view`; they never read
// the FITS file or the display contrast, and the readouts use `image.values`, not canvas colours.
(function () {
  "use strict";

  const { createWcs, fitScale, screenToFits, fitsToScreen, insideImage, pixelIndex, fieldOfView } = AstroNotWcs;
  const query = (name) => document.querySelector("[data-sky-" + name + "]");
  const out = {};
  for (const element of document.querySelectorAll("[data-sky-out]")) out[element.dataset.skyOut] = element;

  const fileInput = query("file");
  const exampleButton = query("example");
  const status = query("status");
  const viewport = query("viewport");
  const canvas = query("canvas");
  const empty = query("empty");
  const zoomIn = query("zoom-in");
  const zoomOut = query("zoom-out");
  const fitButton = query("fit");
  const zoomLabel = query("zoom-label");
  const live = query("live");
  const hduLabel = query("hdu-label");
  const hduSelect = query("hdu");
  const provenance = query("provenance");
  const context = canvas.getContext("2d");

  const zoomStep = 2;
  const panFraction = 0.2; // Arrow keys move the view by this fraction of the smaller panel side.
  const minus = "−";

  let image = null; // The displayed HDU: { width, height, values, picture, wcs, ... }
  let loaded = null; // The opened file: { file, hdus, name, isExample }
  let loadVersion = 0;
  let hduVersion = 0;
  let example;

  const view = { zoom: 1, centerX: 1, centerY: 1 }; // zoom 1 = fit image
  const panel = { width: 1, height: 1, ratio: window.devicePixelRatio || 1 };
  let pointer = null; // { x, y } in panel CSS pixels, while the pointer is over the image
  let frame = 0;
  let announceTimer = 0;

  // ---- Small helpers ------------------------------------------------------------------------------------------------
  function setStatus(message, error = false) {
    status.toggleAttribute("data-error", error);
    status.textContent = message;
  }

  function setOut(name, text) {
    if (out[name].textContent !== text) out[name].textContent = text;
  }

  function degrees(value, digits = 6) {
    return value.toFixed(digits).replace("-", minus) + "°";
  }

  function angle(value) {
    const precise = Number(value.toPrecision(4)) + "°";
    if (value >= 1) return precise;
    if (value >= 1 / 60) return precise + " · " + Number((value * 60).toPrecision(4)) + "′";
    return precise + " · " + Number((value * 3600).toPrecision(4)) + "″";
  }

  function pixelText(x, y) {
    return x.toFixed(2) + ", " + y.toFixed(2);
  }

  function valueText(x, y) {
    if (!image) return "—";
    const index = pixelIndex(x, y, image.width, image.height);
    if (index < 0) return "Outside image data";
    const value = image.values[index];
    if (Number.isNaN(value)) return "Undefined (NaN or BLANK)";
    return Number(value.toPrecision(7)).toString().replace("-", minus) + (image.unit ? " " + image.unit : "");
  }

  function currentView() {
    const fit = fitScale(image.width, image.height, panel.width, panel.height);
    return { centerX: view.centerX, centerY: view.centerY, scale: fit * view.zoom, width: panel.width, height: panel.height };
  }

  function zoomLimit() {
    const fit = fitScale(image.width, image.height, panel.width, panel.height);
    return Math.max(1, Math.max(64, fit * 16) / fit);
  }

  function clampView() {
    view.zoom = Math.min(zoomLimit(), Math.max(1, view.zoom));
    view.centerX = Math.min(image.width + 0.5, Math.max(0.5, view.centerX));
    view.centerY = Math.min(image.height + 0.5, Math.max(0.5, view.centerY));
  }

  // ---- Rendering ----------------------------------------------------------------------------------------------------
  function resizeCanvas() {
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    const ratio = window.devicePixelRatio || 1;
    if (width === panel.width && height === panel.height && ratio === panel.ratio && canvas.width) return false;
    panel.width = Math.max(1, width);
    panel.height = Math.max(1, height);
    panel.ratio = ratio;
    canvas.width = Math.max(1, Math.round(panel.width * ratio));
    canvas.height = Math.max(1, Math.round(panel.height * ratio));
    return true;
  }

  function draw() {
    const v = currentView();
    context.setTransform(panel.ratio, 0, 0, panel.ratio, 0, 0);
    context.fillStyle = "#060709";
    context.fillRect(0, 0, panel.width, panel.height);
    context.imageSmoothingEnabled = false;
    // The picture canvas has row 0 at the top; FITS (0.5, height + 0.5) is its top-left corner (see wcs.js).
    const origin = fitsToScreen(v, 0.5, image.height + 0.5);
    context.drawImage(image.picture, origin.x, origin.y, image.width * v.scale, image.height * v.scale);
    context.strokeStyle = "#4a505a";
    context.lineWidth = 1;
    context.strokeRect(origin.x - 0.5, origin.y - 0.5, image.width * v.scale + 1, image.height * v.scale + 1);

    // Crosshair marks the view center that the "View center" readout describes.
    const cx = panel.width / 2;
    const cy = panel.height / 2;
    for (const [color, width] of [["rgba(0,0,0,0.75)", 3], ["rgba(255,255,255,0.9)", 1]]) {
      context.strokeStyle = color;
      context.lineWidth = width;
      context.beginPath();
      context.moveTo(cx - 9, cy);
      context.lineTo(cx - 3, cy);
      context.moveTo(cx + 3, cy);
      context.lineTo(cx + 9, cy);
      context.moveTo(cx, cy - 9);
      context.lineTo(cx, cy - 3);
      context.moveTo(cx, cy + 3);
      context.lineTo(cx, cy + 9);
      context.stroke();
    }
  }

  function skyText(x, y) {
    if (!image.wcs) return null;
    const sky = image.wcs.pixelToSky(x, y);
    return sky && { ra: degrees(sky.ra), dec: degrees(sky.dec) };
  }

  function updateCenterReadout() {
    const v = currentView();
    const inside = insideImage(v.centerX, v.centerY, image.width, image.height);
    setOut("centerPixel", pixelText(v.centerX, v.centerY));
    setOut("centerValue", valueText(v.centerX, v.centerY));
    const sky = inside ? skyText(v.centerX, v.centerY) : null;
    setOut("centerRa", sky ? sky.ra : "Unavailable");
    setOut("centerDec", sky ? sky.dec : "Unavailable");

    const fov = fieldOfView(image.wcs, v, image.width, image.height);
    setOut("fovX", fov.horizontal ? angle(fov.horizontal.degrees) : "Unavailable");
    setOut("fovY", fov.vertical ? angle(fov.vertical.degrees) : "Unavailable");
    let note = "";
    if (fov.horizontal && fov.vertical) {
      note = fov.horizontal.clipped || fov.vertical.clipped
        ? "The view has empty margins. Only the part covered by the image is measured."
        : "Measured across the full view.";
    } else if (!image.wcs) {
      note = "Unavailable: this image has no usable WCS.";
    } else if (fov.status) {
      note = "Unavailable: " + fov.status.toLowerCase() + ".";
    }
    setOut("fovNote", note);
    const percent = view.zoom;
    zoomLabel.textContent = "Zoom " + (percent < 10 ? percent.toFixed(1) : percent.toFixed(0)) + "× (1× shows the whole image)";
    viewport.toggleAttribute("data-pannable", view.zoom > 1.001);
    for (const [button, disabled] of [[zoomIn, view.zoom >= zoomLimit() - 1e-9], [zoomOut, view.zoom <= 1 + 1e-9], [fitButton, view.zoom === 1 && view.centerX === (image.width + 1) / 2 && view.centerY === (image.height + 1) / 2]]) {
      button.setAttribute("aria-disabled", String(disabled));
    }
  }

  function updatePointerReadout() {
    if (!image) return;
    if (!pointer) {
      for (const name of ["pointerRa", "pointerDec", "pointerPixel", "pointerValue"]) setOut(name, "—");
      return;
    }
    const at = screenToFits(currentView(), pointer.x, pointer.y);
    const inside = insideImage(at.x, at.y, image.width, image.height);
    setOut("pointerPixel", pixelText(at.x, at.y));
    setOut("pointerValue", valueText(at.x, at.y));
    const sky = inside ? skyText(at.x, at.y) : null;
    const message = inside ? "Unavailable" : "Outside image data";
    setOut("pointerRa", sky ? sky.ra : message);
    setOut("pointerDec", sky ? sky.dec : message);
  }

  function render() {
    frame = 0;
    if (!image) return;
    resizeCanvas();
    clampView();
    draw();
    updateCenterReadout();
    updatePointerReadout();
  }

  function invalidate() {
    if (!frame) frame = requestAnimationFrame(render);
  }

  // Short spoken summary after a keyboard or button action. Pointer movement is never announced.
  function announceSoon() {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      if (!image) return;
      const v = currentView();
      const sky = insideImage(v.centerX, v.centerY, image.width, image.height) ? skyText(v.centerX, v.centerY) : null;
      const fov = fieldOfView(image.wcs, v, image.width, image.height);
      const parts = [sky ? "View center RA " + sky.ra + ", Dec " + sky.dec + ", ICRS." : "Sky coordinates unavailable. View center pixel " + pixelText(v.centerX, v.centerY) + "."];
      if (fov.horizontal && fov.vertical) parts.push("Field of view " + angle(fov.horizontal.degrees).split(" · ").pop() + " by " + angle(fov.vertical.degrees).split(" · ").pop() + ".");
      parts.push("Zoom " + view.zoom.toFixed(1) + " times.");
      live.textContent = parts.join(" ");
    }, 450);
  }

  // ---- View changes -------------------------------------------------------------------------------------------------
  function fit() {
    view.zoom = 1;
    view.centerX = (image.width + 1) / 2;
    view.centerY = (image.height + 1) / 2;
  }

  function zoomAt(factor, sx = panel.width / 2, sy = panel.height / 2) {
    const before = screenToFits(currentView(), sx, sy);
    view.zoom = Math.min(zoomLimit(), Math.max(1, view.zoom * factor));
    const scale = currentView().scale;
    // Keep the sky point under (sx, sy) where it was. The y terms carry the screen-down / FITS-up flip.
    view.centerX = before.x - (sx - panel.width / 2) / scale;
    view.centerY = before.y + (sy - panel.height / 2) / scale;
    if (view.zoom === 1 && factor < 1 && sx === panel.width / 2 && sy === panel.height / 2) {
      view.centerX = (image.width + 1) / 2;
      view.centerY = (image.height + 1) / 2;
    }
  }

  function panByScreen(dx, dy) {
    const scale = currentView().scale;
    view.centerX -= dx / scale;
    view.centerY += dy / scale;
  }

  function act(change) {
    if (!image) return;
    change();
    invalidate();
    announceSoon();
  }

  // ---- Pointer, wheel and keyboard ----------------------------------------------------------------------------------
  const touches = new Map();
  let pinch = null;

  function localPoint(event) {
    const rect = viewport.getBoundingClientRect();
    return { x: event.clientX - rect.left - viewport.clientLeft, y: event.clientY - rect.top - viewport.clientTop };
  }

  function pinchState() {
    const [a, b] = [...touches.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  viewport.addEventListener("pointerdown", (event) => {
    if (!image || (event.pointerType === "mouse" && event.button !== 0)) return;
    const point = localPoint(event);
    touches.set(event.pointerId, point);
    viewport.setPointerCapture(event.pointerId);
    viewport.toggleAttribute("data-dragging", true);
    if (touches.size === 2) pinch = pinchState();
    if (event.pointerType !== "mouse") pointer = point;
    viewport.focus({ preventScroll: true });
    invalidate();
  });

  viewport.addEventListener("pointermove", (event) => {
    if (!image) return;
    const point = localPoint(event);
    if (touches.has(event.pointerId)) {
      if (touches.size === 1) {
        const previous = touches.get(event.pointerId);
        // A finger on the fully visible image scrolls the page (touch-action: pan-y), so it must not also move the view.
        if (event.pointerType !== "touch" || view.zoom > 1.001) panByScreen(point.x - previous.x, point.y - previous.y);
        touches.set(event.pointerId, point);
      } else if (touches.size === 2 && pinch) {
        touches.set(event.pointerId, point);
        const next = pinchState();
        panByScreen(next.x - pinch.x, next.y - pinch.y);
        if (pinch.distance > 0 && next.distance > 0) zoomAt(next.distance / pinch.distance, next.x, next.y);
        pinch = next;
      }
    }
    pointer = point;
    invalidate();
  });

  function endPointer(event) {
    touches.delete(event.pointerId);
    pinch = touches.size === 2 ? pinchState() : null;
    if (touches.size === 0) viewport.removeAttribute("data-dragging");
    if (event.type === "pointercancel" || event.pointerType !== "mouse") pointer = null;
    invalidate();
  }
  viewport.addEventListener("pointerup", endPointer);
  viewport.addEventListener("pointercancel", endPointer);
  viewport.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse" && !touches.has(event.pointerId)) {
      pointer = null;
      invalidate();
    }
  });

  // Plain scrolling stays page scrolling. Ctrl or Cmd with the wheel (also a trackpad pinch) zooms at the pointer.
  viewport.addEventListener("wheel", (event) => {
    if (!image || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    const point = localPoint(event);
    act(() => zoomAt(Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0025)), point.x, point.y));
  }, { passive: false });

  viewport.addEventListener("keydown", (event) => {
    if (!image || event.ctrlKey || event.metaKey || event.altKey) return;
    const step = panFraction * Math.min(panel.width, panel.height) * (event.shiftKey ? 2.5 : 1);
    const actions = {
      ArrowLeft: () => panByScreen(step, 0), // Move the view left: the image moves right on screen.
      ArrowRight: () => panByScreen(-step, 0),
      ArrowUp: () => panByScreen(0, step),
      ArrowDown: () => panByScreen(0, -step),
      "+": () => zoomAt(zoomStep),
      "=": () => zoomAt(zoomStep),
      "-": () => zoomAt(1 / zoomStep),
      "_": () => zoomAt(1 / zoomStep),
      "0": fit,
      Home: fit,
    };
    const action = actions[event.key];
    if (!action) return; // Tab and everything else keep their normal behaviour, so focus can leave the view.
    event.preventDefault();
    act(action);
  });

  function buttonAction(button, change) {
    button.addEventListener("click", () => {
      if (button.getAttribute("aria-disabled") === "true") return;
      act(change);
    });
  }
  buttonAction(zoomIn, () => zoomAt(zoomStep));
  buttonAction(zoomOut, () => zoomAt(1 / zoomStep));
  buttonAction(fitButton, fit);

  new ResizeObserver(() => {
    if (image) invalidate();
  }).observe(viewport);

  // ---- Loading ------------------------------------------------------------------------------------------------------
  function clearImage(message) {
    image = null;
    pointer = null;
    clearTimeout(announceTimer);
    live.textContent = "";
    canvas.hidden = true;
    empty.hidden = false;
    empty.querySelector("p").textContent = message;
    viewport.removeAttribute("data-loaded");
    viewport.removeAttribute("data-pannable");
    for (const name of Object.keys(out)) {
      if (name === "fovNote" || name === "wcsStatus") out[name].textContent = "";
      else out[name].textContent = "—";
    }
    zoomLabel.textContent = "Zoom unavailable";
    for (const button of [zoomIn, zoomOut, fitButton]) button.setAttribute("aria-disabled", "true");
    provenance.hidden = true;
    hduLabel.hidden = true;
  }

  function whyNotDisplayable(hdu) {
    if (!hdu.image) return "it is not an uncompressed two-dimensional image (" + hdu.axes.length + " axes)";
    if (hdu.bitpix === 64) return "64-bit integer images are not supported";
    return "it exceeds the limit of " + fitsMaxPixels.toLocaleString("en-US") + " pixels or 4,096 pixels per axis";
  }

  function describeSource() {
    return loaded.isExample ? "SPHEREx QR2 example · NASA/IPAC IRSA" : loaded.name + " · local file";
  }

  function fillInformation(hdu, index) {
    const fields = hdu.fields;
    setOut("source", describeSource());
    setOut("obsid", typeof fields.OBSID === "string" && fields.OBSID ? fields.OBSID : "Unavailable");
    setOut("hdu", index + " · " + hdu.name);
    setOut("size", hdu.axes.join(" × ") + " pixels");
    setOut("unit", typeof fields.BUNIT === "string" && fields.BUNIT ? fields.BUNIT : "Unavailable");
    const date = fields["DATE-OBS"];
    setOut("date", typeof date === "string" && date ? date + (typeof fields.TIMESYS === "string" ? " (" + fields.TIMESYS + ")" : "") : "Unavailable");
    provenance.hidden = !loaded.isExample;
  }

  async function showHdu(version) {
    const index = Number(hduSelect.value);
    const hdu = loaded.hdus[index];
    const token = ++hduVersion;
    canvas.hidden = true;
    empty.hidden = false;
    empty.querySelector("p").textContent = "Reading image pixels…";
    image = null;
    setStatus("Reading image pixels…");
    try {
      const bytes = await loaded.file.slice(hdu.dataStart, hdu.dataStart + hdu.byteLength).arrayBuffer();
      if (version !== loadVersion || token !== hduVersion) return;
      const [width, height] = hdu.axes;
      const picture = document.createElement("canvas");
      drawFitsImage(picture, bytes, hdu); // Display stretch only; it is not used for any measurement.
      const read = fitsPixelReader(bytes, hdu);
      const values = new Float64Array(hdu.pixels);
      for (let i = 0; i < values.length; i++) values[i] = read(i);
      if (version !== loadVersion || token !== hduVersion) return;

      const wcs = createWcs(hdu.fields);
      image = { width, height, values, picture, wcs: wcs.ok ? wcs.wcs : null, unit: typeof hdu.fields.BUNIT === "string" ? hdu.fields.BUNIT : "" };
      fillInformation(hdu, index);
      setOut("wcs", wcs.ok ? wcs.wcs.summary : "Unavailable");
      out.wcsStatus.textContent = wcs.ok
        ? wcs.wcs.notes.join(" ")
        : "RA, Dec and field of view are unavailable: " + wcs.reason;
      fit();
      empty.hidden = true;
      canvas.hidden = false;
      canvas.setAttribute("aria-label", "Grayscale image of " + hdu.name + ", " + width + " by " + height + " pixels");
      viewport.toggleAttribute("data-loaded", true);
      panel.width = panel.height = 0; // Force a fresh size measurement.
      resizeCanvas();
      setStatus((loaded.isExample ? "SPHEREx QR2 example" : loaded.name) + " loaded." + (wcs.ok ? "" : " Pixels only: no usable sky coordinates."));
      render();
      announceSoon();
    } catch (error) {
      if (version !== loadVersion || token !== hduVersion) return;
      clearImage("No image is shown. Choose another FITS file or load the SPHEREx example.");
      setStatus((loaded.isExample ? "The SPHEREx example" : loaded.name) + " could not be displayed. " + error.message, true);
    }
  }

  async function openFits(source, name, isExample = false) {
    const version = ++loadVersion;
    hduVersion++;
    loaded = null;
    clearImage("Reading FITS headers…");
    setStatus("Reading FITS headers…");
    try {
      const file = await source;
      if (version !== loadVersion) return;
      const hdus = await readFitsHdus(file);
      if (version !== loadVersion) return;
      const choices = hdus.map((hdu, index) => ({ hdu, index })).filter(({ hdu }) => hdu.renderable);
      if (!choices.length) {
        const reasons = hdus.map((hdu, index) => "HDU " + index + " (" + hdu.name + "): " + whyNotDisplayable(hdu));
        throw new Error("This file has no image HDU that Sky Explorer can display. " + reasons.join("; ") + ".");
      }
      loaded = { file, hdus, name, isExample };
      hduSelect.replaceChildren(...choices.map(({ hdu, index }) => new Option(index + " · " + hdu.name + " (" + hdu.axes.join(" × ") + ")", index)));
      const preferred = choices.findIndex(({ hdu }) => hdu.fields.EXTNAME === "IMAGE");
      hduSelect.selectedIndex = Math.max(0, preferred);
      hduLabel.hidden = choices.length < 2;
      await showHdu(version);
    } catch (error) {
      if (version !== loadVersion) return;
      loaded = null;
      fileInput.value = "";
      clearImage("No image is shown. Choose another FITS file or load the SPHEREx example.");
      setStatus((isExample ? "The SPHEREx example" : name) + " could not be opened. " + error.message, true);
    }
  }

  function loadExample() {
    if (!example) {
      example = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = siteAsset("assets/tools/spherex-example.js");
        script.addEventListener("load", () => {
          try {
            const bytes = Uint8Array.from(atob(spherexExampleData), (character) => character.charCodeAt(0));
            resolve(new File([bytes], "SPHEREx-QR2-D2.fits"));
          } catch {
            reject(new Error("The example file could not be read."));
          }
        }, { once: true });
        script.addEventListener("error", () => reject(new Error("The example file could not be loaded.")), { once: true });
        document.head.append(script);
      }).catch((error) => {
        example = undefined;
        throw error;
      });
    }
    return example;
  }

  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (file) openFits(file, file.name);
  });
  exampleButton.addEventListener("click", () => {
    fileInput.value = "";
    openFits(loadExample(), "SPHEREx-QR2-D2.fits", true);
  });
  hduSelect.addEventListener("change", () => {
    if (loaded) showHdu(loadVersion);
  });
  fileInput.disabled = false;
  exampleButton.disabled = false;
  clearImage("Load the SPHEREx example or choose a FITS file.");
})();
