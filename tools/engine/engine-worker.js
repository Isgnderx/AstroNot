// Web Worker that hosts the AstroNot engine core (see engine-core.js). The page talks to it through tools/engine/engine.js.
// Messages in: { id, method, args }. Messages out: { id, progress } (zero or more), then { id, ok, result } or
// { id, ok: false, error }. Tiles are returned as ImageBitmaps (transferred, no copy).
"use strict";
importScripts("../wasm.js", "../fits.js", "./engine-core.js");

const ready = AstroNotEngineCore.create({ wasmUrl: new URL("../wasm/engine.wasm", self.location.href).href });

self.onmessage = async (event) => {
  const { id, method, args } = event.data;
  try {
    const core = await ready;
    let result;
    const transfer = [];
    switch (method) {
      case "ping":
        result = { ok: true, tile: core.TILE };
        break;
      case "open":
        result = await core.openFile(args.file);
        break;
      case "load":
        result = await core.loadImage(args.file, args.hdu, { onProgress: (progress) => self.postMessage({ id, progress }) });
        break;
      case "tile": {
        const rgba = core.renderTile(args.handle, args.level, args.x0, args.y0, args.w, args.h, args.low, args.high, args.stretch, args.lut);
        result = await createImageBitmap(new ImageData(rgba, args.w, args.h));
        transfer.push(result);
        break;
      }
      case "value":
        result = core.value(args.handle, args.column, args.row);
        break;
      case "rect":
        result = core.readRect(args.handle, args.x0, args.y0, args.w, args.h);
        transfer.push(result.buffer);
        break;
      case "histogram":
        result = core.histogram(args.handle, args.level, args.low, args.high, args.bins);
        result.counts = result.counts.slice();
        break;
      case "quantiles":
        result = core.quantileRanks(args.handle, args.ranks);
        break;
      case "sigmaClip":
        result = core.sigmaClip(args.handle, args.options);
        break;
      case "free":
        core.freeImage(args.handle);
        result = true;
        break;
      default:
        throw new Error("Unknown engine method " + method + ".");
    }
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (error) {
    self.postMessage({ id, ok: false, error: String((error && error.message) || error), name: error && error.name });
  }
};
