// Loader for the Rust/WebAssembly kernels (see rust/README.md). Global AstroNotWasm, also CommonJS for node tests.
// load(name) resolves to a kernel { exports, put, alloc, read, free } or null when WebAssembly or the file is
// unavailable; callers MUST keep a JS fallback. Bytes come from, in order: tools/wasm/<name>.wasm.js (a base64
// global, works from file://), a fetch of tools/wasm/<name>.wasm (http/https), or the file on disk (node).
(function (root) {
  "use strict";
  const scriptUrl = typeof document !== "undefined" && document.currentScript ? document.currentScript.src : null;
  const cache = new Map();

  function base64ToBytes(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // Wraps instance exports with helpers to move typed arrays in and out of wasm memory.
  // Memory can grow after any call, so views are always re-created from exports.memory.buffer.
  function wrap(name, exports) {
    const memory = exports.memory;
    return {
      name,
      exports,
      // Copies a typed array into wasm memory; returns { ptr, bytes }. Release with free().
      put(array) {
        const bytes = array.byteLength;
        const ptr = exports.an_alloc(bytes);
        new Uint8Array(memory.buffer, ptr, bytes).set(new Uint8Array(array.buffer, array.byteOffset, bytes));
        return { ptr, bytes };
      },
      // Allocates room for `length` elements of Type (for example Float64Array); returns { ptr, bytes, length, Type }.
      alloc(Type, length) {
        const bytes = length * Type.BYTES_PER_ELEMENT;
        return { ptr: exports.an_alloc(bytes), bytes, length, Type };
      },
      // Copy of a region as a new typed array (stays valid after later allocations or memory growth).
      read(region, Type = region.Type, length = region.length) {
        return new Type(memory.buffer, region.ptr, length).slice();
      },
      free(...regions) {
        for (const region of regions) if (region) exports.an_free(region.ptr, region.bytes);
      },
    };
  }

  async function bytesFor(name, options) {
    const embedded = root.AstroNotWasmBytes && root.AstroNotWasmBytes[name];
    if (embedded) return base64ToBytes(embedded);
    // A page knows the file from this script's URL; a worker (no document) passes the URL in `options.url`.
    const url = options.url || (scriptUrl && /^https?:/.test(scriptUrl) ? new URL("wasm/" + name + ".wasm", scriptUrl).href : null);
    if (url && /^https?:/.test(url) && typeof fetch === "function") {
      const response = await fetch(url);
      if (!response.ok) throw new Error("HTTP " + response.status);
      return new Uint8Array(await response.arrayBuffer());
    }
    if (typeof process === "object" && process.versions && process.versions.node && typeof require === "function") {
      return require("node:fs").readFileSync(require("node:path").join(__dirname, "wasm", name + ".wasm"));
    }
    return null;
  }

  // load(name, { url }) -> kernel or null. `url` is the full address of the .wasm file (needed inside a Web Worker).
  function load(name, options = {}) {
    if (typeof WebAssembly !== "object") return Promise.resolve(null);
    if (!cache.has(name)) {
      cache.set(name, bytesFor(name, options)
        .then(async (bytes) => (bytes ? wrap(name, (await WebAssembly.instantiate(bytes, {})).instance.exports) : null))
        .catch(() => null));
    }
    return cache.get(name);
  }

  const api = { load, base64ToBytes };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.AstroNotWasm = api;
})(typeof globalThis === "object" ? globalThis : this);
