// AstroNot engine core: drives rust/crates/engine (tools/wasm/engine.wasm), the kernel that OWNS large images.
// A FITS image HDU is streamed from the File band by band straight into a float32 image in wasm memory; the pyramid,
// statistics, quantiles and display tiles are computed there, and only small results (tiles, numbers) come back.
// Environment-agnostic: runs inside tools/engine/engine-worker.js, on the main thread (file:// pages, where workers are
// not allowed) and in Node tests. Global `AstroNotEngineCore`, also a CommonJS module.
//
//   const core = await AstroNotEngineCore.create({ wasmUrl });     // or createCore(kernel) with a loaded kernel
//   const hdus = await core.openFile(file);                          // tools/fits.js readFitsHdus, plain objects
//   const image = await core.loadImage(file, hdus[1], { onProgress }) // { handle, width, height, levels, scan, quantiles, timing }
//   core.renderTile(handle, level, x0, y0, w, h, low, high, stretch, lut) -> Uint8ClampedArray (RGBA, canvas row order)
//   core.value(handle, column, row) / readRect / histogram / quantileRanks / sigmaClip / freeImage
(function (root) {
  "use strict";

  const TILE = 256; // pyramid levels stop when both sides fit in one tile; tile requests use the same size
  const BAND_BYTES = 32 << 20; // bytes of raw FITS data read and decoded at a time
  const DISPLAY_FRACTIONS = [0.001, 0.01, 0.05, 0.5, 0.95, 0.99, 0.999];
  const STRETCH = { linear: 0, sqrt: 1, asinh: 2, log: 3 };

  const now = () => (typeof performance === "object" ? performance.now() : Date.now());

  function calibration(hdu) {
    const scale = hdu.fields.BSCALE ?? 1;
    const zero = hdu.fields.BZERO ?? 0;
    const blank = hdu.bitpix > 0 ? hdu.fields.BLANK : undefined;
    if (!Number.isFinite(scale) || !Number.isFinite(zero)) throw new Error("The image has invalid FITS scaling metadata (BSCALE/BZERO).");
    return { scale, zero, blank: typeof blank === "number" ? blank : undefined };
  }

  // The HDU description that crosses a postMessage boundary: everything readFitsHdus() produced, as plain data.
  function plainHdu(hdu, index) {
    return { index, name: hdu.name, fields: { ...hdu.fields }, cards: [...hdu.cards], axes: [...hdu.axes], bitpix: hdu.bitpix, pixels: hdu.pixels, dataStart: hdu.dataStart, byteLength: hdu.byteLength, image: hdu.image, renderable: hdu.renderable };
  }

  function createCore(kernel) {
    const E = kernel.exports;
    const memory = () => E.memory.buffer;
    const regions = new Map(); // named grow-only scratch regions in wasm memory
    function region(name, bytes) {
      const held = regions.get(name);
      if (held && held.bytes >= bytes) return held.ptr;
      if (held) E.an_free(held.ptr, held.bytes);
      const ptr = E.an_alloc(bytes);
      regions.set(name, { ptr, bytes });
      return ptr;
    }
    function dropRegion(name) {
      const held = regions.get(name);
      if (held) {
        E.an_free(held.ptr, held.bytes);
        regions.delete(name);
      }
    }
    const images = new Map();

    async function openFile(file) {
      const reader = root.readFitsHdus;
      if (typeof reader !== "function") throw new Error("tools/fits.js is not loaded: readFitsHdus is missing.");
      const hdus = await reader(file);
      return hdus.map(plainHdu);
    }

    function describeLevels(handle) {
      const levels = [];
      for (let level = 0; level < E.img_levels(handle); level++) levels.push({ width: E.img_level_width(handle, level), height: E.img_level_height(handle, level) });
      return levels;
    }

    function scan(handle) {
      const out = region("scan", 6 * 8);
      if (E.img_scan(handle, out) !== 0) throw new Error("Unknown image handle " + handle + ".");
      const [finite, nan, min, max, mean, std] = new Float64Array(memory(), out, 6);
      return { finite, nan, min, max, mean, std };
    }

    function quantileRanks(handle, ranks) {
      const n = ranks.length;
      const inPtr = region("ranks-in", n * 8);
      const outPtr = region("ranks-out", n * 8);
      new Float64Array(memory(), inPtr, n).set(ranks);
      const interpolated = E.img_quantile_ranks(handle, inPtr, n, outPtr);
      if (interpolated < 0) throw new Error("Unknown image handle " + handle + ".");
      return { values: new Float64Array(memory(), outPtr, n).slice(), interpolated };
    }

    // Values at the display fractions, with the conventions of tools/pixels.js percentileClip: a low cut uses the value at
    // floor((n - 1) * f), a high cut (f > 0.5) the value at ceil((n - 1) * f). Keys are the fractions as strings.
    function displayQuantiles(handle, finite) {
      const quantiles = {};
      if (!finite) {
        for (const f of DISPLAY_FRACTIONS) quantiles[f] = NaN;
        return quantiles;
      }
      const last = finite - 1;
      const ranks = DISPLAY_FRACTIONS.map((f) => (f > 0.5 ? Math.ceil(last * f) : Math.floor(last * f)));
      const { values } = quantileRanks(handle, ranks);
      DISPLAY_FRACTIONS.forEach((f, i) => { quantiles[f] = values[i]; });
      return quantiles;
    }

    // Streams one image HDU of `file` into a new resident image. onProgress({ phase, done, total }) is called per band.
    async function loadImage(file, hdu, { onProgress, signal } = {}) {
      if (!hdu || !hdu.image) throw new Error("This HDU is not an uncompressed two-dimensional image.");
      const [width, height] = hdu.axes;
      const { scale, zero, blank } = calibration(hdu);
      const bytesPer = Math.abs(hdu.bitpix) / 8;
      const rowBytes = width * bytesPer;
      const megabytes = (width * height * 4 / 1048576).toFixed(0);
      const handle = E.img_create(width, height);
      if (!handle) throw new Error("Not enough memory in this browser tab for a " + width.toLocaleString("en-US") + " × " + height.toLocaleString("en-US") + " image (" + megabytes + " MB as float32).");
      const timing = { read: 0, decode: 0, pyramid: 0, stats: 0, total: 0 };
      const started = now();
      try {
        const bandRows = Math.max(1, Math.floor(BAND_BYTES / rowBytes));
        for (let row = 0; row < height; row += bandRows) {
          if (signal && signal.aborted) throw Object.assign(new Error("Loading was cancelled."), { name: "AbortError" });
          const rows = Math.min(bandRows, height - row);
          const start = hdu.dataStart + row * rowBytes;
          const t0 = now();
          const buffer = await file.slice(start, start + rows * rowBytes).arrayBuffer();
          if (buffer.byteLength !== rows * rowBytes) throw new Error("The file ends before the image data is complete.");
          const t1 = now();
          const ptr = region("band", buffer.byteLength);
          new Uint8Array(memory(), ptr, buffer.byteLength).set(new Uint8Array(buffer));
          const code = E.img_decode_rows(handle, ptr, row, rows, hdu.bitpix, scale, zero, blank !== undefined ? 1 : 0, blank ?? 0);
          if (code !== 0) throw new Error("The image could not be decoded (BITPIX " + hdu.bitpix + ", code " + code + ").");
          const t2 = now();
          timing.read += t1 - t0;
          timing.decode += t2 - t1;
          if (onProgress) onProgress({ phase: "decode", done: row + rows, total: height });
        }
        dropRegion("band");
        let t = now();
        const levelCount = E.img_build_pyramid(handle, TILE);
        timing.pyramid = now() - t;
        if (onProgress) onProgress({ phase: "pyramid", done: levelCount, total: levelCount });
        t = now();
        const stats = scan(handle);
        const quantiles = displayQuantiles(handle, stats.finite);
        timing.stats = now() - t;
        timing.total = now() - started;
        const image = { handle, width, height, levels: describeLevels(handle), scan: stats, quantiles, timing, unit: typeof hdu.fields.BUNIT === "string" ? hdu.fields.BUNIT : "", bitpix: hdu.bitpix };
        images.set(handle, image);
        return image;
      } catch (error) {
        E.img_free(handle);
        dropRegion("band");
        throw error;
      }
    }

    // RGBA tile in canvas row order (see rust/crates/engine). `stretch` is a name or number; `lut` null or 768 RGB bytes.
    function renderTile(handle, level, x0, y0, w, h, low, high, stretch = "linear", lut = null) {
      const mode = typeof stretch === "number" ? stretch : STRETCH[stretch] ?? 0;
      const outPtr = region("tile", w * h * 4);
      let lutPtr = 0;
      if (lut) {
        lutPtr = region("lut", 768);
        new Uint8Array(memory(), lutPtr, 768).set(lut);
      }
      if (E.img_render_tile(handle, level, x0, y0, w, h, low, high, mode, lutPtr, outPtr) !== 0) throw new Error("Unknown image handle or level.");
      return new Uint8ClampedArray(memory(), outPtr, w * h * 4).slice();
    }

    // Calibrated value at 0-based array column/row of level 0 (NaN when undefined or outside).
    function value(handle, column, row) {
      const image = images.get(handle);
      if (!image || column < 0 || row < 0 || column >= image.width || row >= image.height) return NaN;
      const ptr = E.img_level_ptr(handle, 0);
      return new Float32Array(memory(), ptr + 4 * (row * image.width + column), 1)[0];
    }

    function readRect(handle, x0, y0, w, h) {
      const outPtr = region("rect", w * h * 4);
      if (E.img_read_rect(handle, x0, y0, w, h, outPtr) < 0) throw new Error("The rectangle is outside the image.");
      return new Float32Array(memory(), outPtr, w * h).slice();
    }

    function histogram(handle, level, low, high, bins) {
      const outPtr = region("histogram", (bins + 2) * 4);
      const counted = E.img_histogram(handle, level, low, high, bins, outPtr);
      if (counted < 0) throw new Error("Unknown image handle or level.");
      const counts = new Uint32Array(memory(), outPtr, bins + 2).slice();
      return { below: counts[0], above: counts[bins + 1], counts: counts.subarray(1, bins + 1), counted };
    }

    function sigmaClip(handle, { samples = 1 << 20, sigma = 3, iterations = 5 } = {}) {
      const out = region("clip", 7 * 8);
      if (E.img_sigma_clip(handle, samples, sigma, iterations, out) !== 0) throw new Error("Unknown image handle " + handle + ".");
      const [count, mean, median, std, low, high, done] = new Float64Array(memory(), out, 7);
      return { count, mean, median, std, low, high, iterations: done, sampled: true };
    }

    function freeImage(handle) {
      images.delete(handle);
      E.img_free(handle);
    }

    return { kernel, openFile, loadImage, renderTile, value, readRect, histogram, quantileRanks, sigmaClip, scan, freeImage, images, TILE, STRETCH };
  }

  async function create({ wasmUrl, kernel } = {}) {
    const loaded = kernel || (root.AstroNotWasm ? await root.AstroNotWasm.load("engine", { url: wasmUrl }) : null);
    if (!loaded || !loaded.exports.img_create) throw new Error("The AstroNot engine (tools/wasm/engine.wasm) is not available in this browser.");
    return createCore(loaded);
  }

  const api = { create, createCore, plainHdu, calibration, TILE, STRETCH, DISPLAY_FRACTIONS };
  root.AstroNotEngineCore = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);
