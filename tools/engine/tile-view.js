// Tiled image view for the AstroNot engine: pans and zooms an image of any size by drawing 256-pixel tiles of the
// pyramid level that matches the zoom, fetched asynchronously from the engine and cached as ImageBitmaps. The coarsest
// level (one tile) is always drawn first, so a gigapixel image appears at once and sharpens as tiles arrive.
// Global `AstroNotTileView`. Geometry (FITS pixel convention, screen <-> FITS) comes from tools/wcs.js.
//
//   const view = AstroNotTileView.create({ viewport, canvas, engine, onChange, onPointer, onDraw });
//   view.setImage(image, { low, high, stretch, lut });   // image from engine.load(); display settings may change later
//   view.setDisplay({ low, high, stretch });  view.fit();  view.zoomAt(2);  view.panByScreen(dx, dy);  view.clear();
//   view.currentView() -> { centerX, centerY, scale, width, height }   (scale: CSS pixels per image pixel)
(function (root) {
  "use strict";
  const { fitScale, screenToFits, fitsToScreen } = root.AstroNotWcs;
  const TILE = 256;
  const MAX_CACHED = 480; // bitmaps kept; 480 x 256 KB = 120 MB at most
  const zoomStep = 2;
  const panFraction = 0.2;

  function create({ viewport, canvas, engine, onChange, onPointer, onDraw, background = "#060709", concurrency }) {
    const context = canvas.getContext("2d");
    const inFlight = new Map(); // key -> true while a tile request is pending
    const cache = new Map(); // key -> ImageBitmap (Map keeps insertion order: LRU by re-insertion)
    const maxInFlight = concurrency || (engine.mode === "worker" ? 6 : 2);
    let image = null; // { handle, width, height, levels, display, rangeKey }
    let display = { low: 0, high: 1, stretch: "linear", lut: null };
    let rangeKey = "";
    let generation = 0; // bumps when the image changes, so late tiles of an old image are dropped
    const view = { zoom: 1, centerX: 1, centerY: 1 };
    const panel = { width: 1, height: 1, ratio: 1 };
    let pointer = null;
    let frame = 0;
    let queue = [];

    // ---- geometry -------------------------------------------------------------------------------------------------
    function fit() {
      if (!image) return;
      view.zoom = 1;
      view.centerX = (image.width + 1) / 2;
      view.centerY = (image.height + 1) / 2;
    }
    function fitPx() {
      return fitScale(image.width, image.height, panel.width, panel.height);
    }
    function currentView() {
      if (!image) return null;
      return { centerX: view.centerX, centerY: view.centerY, scale: fitPx() * view.zoom, width: panel.width, height: panel.height };
    }
    function zoomLimit() {
      const f = fitPx();
      return Math.max(1, Math.max(64, f * 16) / f);
    }
    function clampView() {
      view.zoom = Math.min(zoomLimit(), Math.max(1, view.zoom));
      view.centerX = Math.min(image.width + 0.5, Math.max(0.5, view.centerX));
      view.centerY = Math.min(image.height + 0.5, Math.max(0.5, view.centerY));
    }
    function zoomAt(factor, sx = panel.width / 2, sy = panel.height / 2) {
      if (!image) return;
      const before = screenToFits(currentView(), sx, sy);
      view.zoom = Math.min(zoomLimit(), Math.max(1, view.zoom * factor));
      const scale = currentView().scale;
      view.centerX = before.x - (sx - panel.width / 2) / scale;
      view.centerY = before.y + (sy - panel.height / 2) / scale;
      if (view.zoom === 1 && factor < 1 && sx === panel.width / 2 && sy === panel.height / 2) fit();
    }
    function panByScreen(dx, dy) {
      if (!image) return;
      const scale = currentView().scale;
      view.centerX -= dx / scale;
      view.centerY += dy / scale;
    }
    function resizeCanvas() {
      const width = viewport.clientWidth;
      const height = viewport.clientHeight;
      const ratio = window.devicePixelRatio || 1;
      if (width === panel.width && height === panel.height && ratio === panel.ratio && canvas.width) return;
      panel.width = Math.max(1, width);
      panel.height = Math.max(1, height);
      panel.ratio = ratio;
      canvas.width = Math.max(1, Math.round(panel.width * ratio));
      canvas.height = Math.max(1, Math.round(panel.height * ratio));
    }

    // ---- tiles ----------------------------------------------------------------------------------------------------
    function tileKey(level, tx, ty) {
      return generation + ":" + level + ":" + tx + ":" + ty + ":" + rangeKey;
    }
    function remember(key, bitmap) {
      cache.set(key, bitmap);
      while (cache.size > MAX_CACHED) {
        const [oldest, old] = cache.entries().next().value;
        cache.delete(oldest);
        if (old && old.close) old.close();
      }
    }
    function touch(key) {
      const bitmap = cache.get(key);
      if (bitmap) {
        cache.delete(key);
        cache.set(key, bitmap);
      }
      return bitmap;
    }
    function request(level, tx, ty, priority) {
      const key = tileKey(level, tx, ty);
      if (cache.has(key) || inFlight.has(key)) return;
      queue.push({ key, level, tx, ty, priority, generation });
    }
    function pump() {
      if (!image) return;
      queue.sort((a, b) => a.priority - b.priority);
      while (queue.length && inFlight.size < maxInFlight) {
        const job = queue.shift();
        if (job.generation !== generation || cache.has(job.key)) continue;
        inFlight.set(job.key, true);
        const settings = display;
        engine.tile({ handle: image.handle, level: job.level, x0: job.tx * TILE, y0: job.ty * TILE, w: TILE, h: TILE, low: settings.low, high: settings.high, stretch: settings.stretch, lut: settings.lut })
          .then((bitmap) => {
            inFlight.delete(job.key);
            if (job.generation !== generation || !job.key.endsWith(":" + rangeKey)) {
              if (bitmap.close) bitmap.close();
            } else {
              remember(job.key, bitmap);
              invalidate();
            }
            pump();
          }, () => {
            inFlight.delete(job.key);
            pump();
          });
      }
    }
    function clearTiles() {
      for (const bitmap of cache.values()) if (bitmap.close) bitmap.close();
      cache.clear();
      queue = [];
    }

    // Level whose pixels are at most one device pixel on screen (level 0 when zoomed in past 1:1).
    function pickLevel(scaleCss) {
      const scaleDevice = scaleCss * panel.ratio;
      const wanted = Math.floor(Math.log2(1 / Math.max(scaleDevice, 1e-9)));
      return Math.max(0, Math.min(image.levels.length - 1, wanted));
    }

    function draw() {
      const v = currentView();
      context.setTransform(panel.ratio, 0, 0, panel.ratio, 0, 0);
      context.fillStyle = background;
      context.fillRect(0, 0, panel.width, panel.height);
      const origin = fitsToScreen(v, 0.5, image.height + 0.5); // top-left corner of the picture in CSS pixels
      const pictureWidth = image.width * v.scale;
      const pictureHeight = image.height * v.scale;

      // Base layer: the coarsest level is one tile and is always requested first.
      const coarsest = image.levels.length - 1;
      const baseKey = tileKey(coarsest, 0, 0);
      const base = touch(baseKey);
      const coarse = image.levels[coarsest];
      if (base) {
        context.imageSmoothingEnabled = true;
        // The tile is TILE x TILE but the level occupies only coarse.width x coarse.height of it.
        context.drawImage(base, 0, 0, coarse.width, coarse.height, origin.x, origin.y, pictureWidth, pictureHeight);
      } else {
        request(coarsest, 0, 0, -1);
      }

      const level = pickLevel(v.scale);
      if (level !== coarsest || !base) {
        const dims = image.levels[level];
        const sX = pictureWidth / dims.width; // CSS pixels per level pixel
        const sY = pictureHeight / dims.height;
        const magnification = sX * panel.ratio;
        context.imageSmoothingEnabled = magnification < 3;
        const txMin = Math.max(0, Math.floor((0 - origin.x) / (TILE * sX)));
        const txMax = Math.min(Math.ceil(dims.width / TILE) - 1, Math.floor((panel.width - origin.x) / (TILE * sX)));
        const tyMin = Math.max(0, Math.floor((0 - origin.y) / (TILE * sY)));
        const tyMax = Math.min(Math.ceil(dims.height / TILE) - 1, Math.floor((panel.height - origin.y) / (TILE * sY)));
        const cx = (panel.width / 2 - origin.x) / (TILE * sX);
        const cy = (panel.height / 2 - origin.y) / (TILE * sY);
        for (let ty = tyMin; ty <= tyMax; ty++) {
          for (let tx = txMin; tx <= txMax; tx++) {
            const bitmap = touch(tileKey(level, tx, ty));
            if (bitmap) {
              context.drawImage(bitmap, origin.x + tx * TILE * sX, origin.y + ty * TILE * sY, TILE * sX, TILE * sY);
            } else {
              request(level, tx, ty, Math.hypot(tx + 0.5 - cx, ty + 0.5 - cy));
            }
          }
        }
      }
      context.strokeStyle = "#4a505a";
      context.lineWidth = 1;
      context.strokeRect(origin.x - 0.5, origin.y - 0.5, pictureWidth + 1, pictureHeight + 1);
      if (onDraw) onDraw(context, v, { origin, pictureWidth, pictureHeight, level });
      pump();
    }

    function render() {
      frame = 0;
      if (!image) return;
      resizeCanvas();
      clampView();
      draw();
      if (onChange) onChange(currentView(), { zoom: view.zoom, zoomLimit: zoomLimit(), fitted: view.zoom === 1 && view.centerX === (image.width + 1) / 2 && view.centerY === (image.height + 1) / 2 });
      if (onPointer) onPointer(pointer && currentView() ? { ...pointer, fits: screenToFits(currentView(), pointer.x, pointer.y) } : null);
    }
    function invalidate() {
      if (!frame) frame = requestAnimationFrame(render);
    }

    // ---- interaction ---------------------------------------------------------------------------------------------
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
    const listeners = [];
    function on(target, type, handler, options) {
      target.addEventListener(type, handler, options);
      listeners.push(() => target.removeEventListener(type, handler, options));
    }
    on(viewport, "pointerdown", (event) => {
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
    on(viewport, "pointermove", (event) => {
      if (!image) return;
      const point = localPoint(event);
      if (touches.has(event.pointerId)) {
        if (touches.size === 1) {
          const previous = touches.get(event.pointerId);
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
    on(viewport, "pointerup", endPointer);
    on(viewport, "pointercancel", endPointer);
    on(viewport, "pointerleave", (event) => {
      if (event.pointerType === "mouse" && !touches.has(event.pointerId)) {
        pointer = null;
        invalidate();
      }
    });
    on(viewport, "wheel", (event) => {
      if (!image || !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const point = localPoint(event);
      act(() => zoomAt(Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0025)), point.x, point.y), "wheel");
    }, { passive: false });
    on(viewport, "keydown", (event) => {
      if (!image || event.ctrlKey || event.metaKey || event.altKey) return;
      const step = panFraction * Math.min(panel.width, panel.height) * (event.shiftKey ? 2.5 : 1);
      const actions = {
        ArrowLeft: () => panByScreen(step, 0),
        ArrowRight: () => panByScreen(-step, 0),
        ArrowUp: () => panByScreen(0, step),
        ArrowDown: () => panByScreen(0, -step),
        "+": () => zoomAt(zoomStep), "=": () => zoomAt(zoomStep),
        "-": () => zoomAt(1 / zoomStep), "_": () => zoomAt(1 / zoomStep),
        "0": fit, Home: fit,
      };
      const action = actions[event.key];
      if (!action) return;
      event.preventDefault();
      act(action, "keyboard");
    });
    const observer = new ResizeObserver(() => { if (image) invalidate(); });
    observer.observe(viewport);

    let onAct = null;
    function act(change, reason) {
      if (!image) return;
      change();
      invalidate();
      if (onAct) onAct(reason);
    }

    // ---- public -------------------------------------------------------------------------------------------------------
    function setDisplay(next) {
      display = { ...display, ...next };
      rangeKey = [display.low, display.high, display.stretch, display.lut ? "lut" : "gray"].join("|");
      queue = [];
      invalidate();
    }
    function setImage(next, settings) {
      generation++;
      clearTiles();
      inFlight.clear();
      image = next;
      pointer = null;
      if (settings) setDisplay(settings);
      panel.width = panel.height = 0;
      if (image) fit();
      invalidate();
    }
    function clear() {
      setImage(null);
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
    }
    function destroy() {
      clear();
      observer.disconnect();
      for (const off of listeners) off();
    }

    return {
      get image() { return image; },
      get display() { return display; },
      get zoom() { return view.zoom; },
      setImage, setDisplay, clear, destroy, currentView, zoomLimit, invalidate,
      fit: () => act(fit, "button"), zoomIn: () => act(() => zoomAt(zoomStep), "button"), zoomOut: () => act(() => zoomAt(1 / zoomStep), "button"),
      zoomAt: (factor, sx, sy) => act(() => zoomAt(factor, sx, sy), "program"),
      panByScreen: (dx, dy) => act(() => panByScreen(dx, dy), "program"),
      centerOn: (x, y) => act(() => { view.centerX = x; view.centerY = y; }, "program"),
      set onAct(handler) { onAct = handler; },
      pending: () => queue.length + inFlight.size,
      TILE,
    };
  }

  root.AstroNotTileView = { create, TILE };
})(typeof globalThis === "object" ? globalThis : this);
