// Page-side client of the AstroNot engine. Global `AstroNotEngine`.
//
//   const engine = await AstroNotEngine.connect();      // a Web Worker when the page allows one, otherwise the same core inline
//   engine.mode                                         // "worker" | "inline"
//   const hdus = await engine.open(file);
//   const image = await engine.load(file, hdu, { onProgress });
//   const bitmap = await engine.tile({ handle, level, x0, y0, w, h, low, high, stretch, lut });   // ImageBitmap
//   await engine.value(handle, column, row); engine.rect(...); engine.histogram(...); engine.quantiles(handle, ranks); engine.free(handle)
//
// Pages opened from file:// cannot start workers, and the worker cannot fetch engine.wasm there either, so such a page
// includes tools/wasm/engine.wasm.js (the module as base64) and the core runs on the main thread. Everything stays async.
(function (root) {
  "use strict";
  const scriptUrl = typeof document === "object" && document.currentScript ? document.currentScript.src : null;
  const base = scriptUrl || (typeof location === "object" ? location.href : "");

  function workerClient(worker) {
    let nextId = 1;
    const pending = new Map();
    worker.addEventListener("message", (event) => {
      const { id, progress, ok, result, error, name } = event.data;
      const entry = pending.get(id);
      if (!entry) return;
      if (progress) {
        if (entry.onProgress) entry.onProgress(progress);
        return;
      }
      pending.delete(id);
      if (ok) entry.resolve(result);
      else entry.reject(Object.assign(new Error(error), { name: name || "Error" }));
    });
    worker.addEventListener("error", (event) => {
      for (const entry of pending.values()) entry.reject(new Error("The engine worker failed: " + (event.message || "unknown error")));
      pending.clear();
    });
    function call(method, args = {}, onProgress) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject, onProgress });
        worker.postMessage({ id, method, args });
      });
    }
    return {
      mode: "worker",
      ping: () => call("ping"),
      open: (file) => call("open", { file }),
      load: (file, hdu, { onProgress } = {}) => call("load", { file, hdu }, onProgress),
      tile: (args) => call("tile", args),
      value: (handle, column, row) => call("value", { handle, column, row }),
      rect: (handle, x0, y0, w, h) => call("rect", { handle, x0, y0, w, h }),
      histogram: (handle, level, low, high, bins) => call("histogram", { handle, level, low, high, bins }),
      quantiles: (handle, ranks) => call("quantiles", { handle, ranks: Array.from(ranks) }),
      sigmaClip: (handle, options) => call("sigmaClip", { handle, options }),
      free: (handle) => call("free", { handle }),
      terminate: () => worker.terminate(),
    };
  }

  function inlineClient(core) {
    const defer = (fn) => new Promise((resolve, reject) => setTimeout(() => { try { resolve(fn()); } catch (error) { reject(error); } }, 0));
    return {
      mode: "inline",
      open: (file) => core.openFile(file),
      load: (file, hdu, options) => core.loadImage(file, hdu, options),
      tile: async (args) => {
        const rgba = core.renderTile(args.handle, args.level, args.x0, args.y0, args.w, args.h, args.low, args.high, args.stretch, args.lut);
        return createImageBitmap(new ImageData(rgba, args.w, args.h));
      },
      value: (handle, column, row) => Promise.resolve(core.value(handle, column, row)),
      rect: (handle, x0, y0, w, h) => defer(() => core.readRect(handle, x0, y0, w, h)),
      histogram: (handle, level, low, high, bins) => defer(() => core.histogram(handle, level, low, high, bins)),
      quantiles: (handle, ranks) => defer(() => core.quantileRanks(handle, ranks)),
      sigmaClip: (handle, options) => defer(() => core.sigmaClip(handle, options)),
      free: (handle) => Promise.resolve(core.freeImage(handle)),
      terminate: () => {},
    };
  }

  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      script.addEventListener("load", resolve, { once: true });
      script.addEventListener("error", () => reject(new Error("Could not load " + url)), { once: true });
      document.head.append(script);
    });
  }

  // Starts the worker and waits for its first answer (the wasm module loads in the meantime); rejects on timeout or error.
  async function startWorker(timeoutMs) {
    const worker = new Worker(new URL("engine-worker.js", base).href);
    const client = workerClient(worker);
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("The engine worker did not answer.")), timeoutMs));
    try {
      await Promise.race([client.ping(), timeout]);
    } catch (error) {
      worker.terminate();
      throw error;
    }
    return client;
  }

  async function connect({ timeoutMs = 8000, allowWorker = true } = {}) {
    if (allowWorker && typeof Worker === "function" && /^https?:/.test(base)) {
      try {
        return await startWorker(timeoutMs);
      } catch (error) {
        console.warn("AstroNot engine: worker unavailable, running inline.", error);
      }
    }
    if (!root.AstroNotEngineCore) await loadScript(new URL("engine-core.js", base).href);
    if (!(root.AstroNotWasmBytes && root.AstroNotWasmBytes.engine) && !/^https?:/.test(base)) {
      await loadScript(new URL("../wasm/engine.wasm.js", base).href).catch(() => {});
    }
    const core = await root.AstroNotEngineCore.create({ wasmUrl: new URL("../wasm/engine.wasm", base).href });
    return inlineClient(core);
  }

  root.AstroNotEngine = { connect };
})(typeof globalThis === "object" ? globalThis : this);
