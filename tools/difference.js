// Image Differencing computation for AstroNot (and the input of Motion Detector).
//
// UI-independent: no DOM access. Loads as a classic browser script (global `AstroNotDifference`) and as a CommonJS module.
// It needs tools/wcs.js (global `AstroNotWcs`) and tools/pair.js (global `AstroNotPair`) for every sky and grid computation.
//
// WHAT IT DOES
//   delta = target - reference, on the pixel grid of the REFERENCE image, for the pixels that are valid in both images.
//   - Units are checked first. Only identical units, or Jy-family units that differ by an SI prefix (kJy/sr, MJy/sr ...),
//     are accepted; the target is converted to the reference unit. Anything else is refused with the reason.
//   - The two images must cover the same sky and have usable WCS (TAN or TAN-SIP, ICRS; see wcs.js). Equal array sizes are
//     never taken as proof: one common grid is verified from the WCS (every sample pixel at the same sky position within
//     0.01 pixel). On a verified grid the arrays are subtracted as they are ("pixel difference").
//   - On different grids the target is REPROJECTED onto the reference grid by bilinear interpolation of its pixel values
//     (the same sampling as reproject_interp(order='bilinear') of astropy-reproject; surface-brightness values such as
//     MJy/sr are interpolated, not summed). The reference is never resampled. Reprojection is refused when the target
//     pixels are much smaller than the reference pixels (aliasing) or when the footprints do not overlap.
//   - Invalid pixels stay invalid in the result: outside the target footprint, NaN or masked in the reference, NaN or
//     masked in the target (for a reprojected target: any pixel whose interpolation stencil touches an invalid pixel).
//     Zero is a valid value. The result keeps the reason for each pixel in `status`.
//   - Variance: when BOTH images have a variance array in matching units, Var(delta) = Var(target) + Var(reference) for
//     independent errors. A reprojected target contributes sum(w_i^2 Var_i) of its bilinear weights w_i, which is exact for
//     one output pixel when input pixels are independent, but neighbouring output pixels share input pixels (they are
//     correlated) and interpolation smooths the noise, so sums over several pixels must not use these variances as if
//     they were independent. Without variance for both images the variance and SNR arrays are null.
//   - No PSF matching is applied. An optional global median offset removal (background) is applied only when asked for.
//
// PIXEL CONVENTION: arrays are FITS order (row 0 is the bottom row, x runs fastest); positions passed to wcs.js are FITS
// coordinates (1-based pixel centres). Display colours and contrast are never an input of this module.
(function (root) {
  "use strict";

  const wcsLib = typeof module === "object" && module.exports ? require("./wcs.js") : root.AstroNotWcs;
  const pairLib = typeof module === "object" && module.exports ? require("./pair.js") : root.AstroNotPair;

  const status = { valid: 0, outside: 1, referenceInvalid: 2, targetInvalid: 3 };
  const statusText = [
    "Valid",
    "Outside the area covered by the target",
    "Reference pixel is NaN, BLANK or masked",
    "Target pixel is NaN, BLANK or masked",
  ];
  const gridTolerancePixels = 0.01; // Largest WCS offset still treated as one common grid.
  const finestSourceRatio = 0.8; // Target pixel scale / reference pixel scale below this is refused (aliasing).
  const snapPixels = 1e-7;
  const edgePixels = 1e-6;
  const direction = { label: "Δ = target − reference", ascii: "target - reference" };

  function isNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function refuse(code, reason) {
    return { ok: false, code, reason };
  }

  // ---- Units ---------------------------------------------------------------------------------------------------------
  // Case is kept: "MJy" and "mJy" differ by a factor of 10^9.
  function canonicalUnit(unit) {
    if (typeof unit !== "string") return null;
    const text = unit.trim().replace(/\s*(\*\*|[/*^])\s*/g, (match, operator) => operator === "**" ? "^" : operator).replace(/\s+/g, " ");
    return text || null;
  }

  const prefixFactor = { G: 1e9, M: 1e6, k: 1e3, "": 1, m: 1e-3, u: 1e-6, "μ": 1e-6, "µ": 1e-6, n: 1e-9 };

  function jyParts(canonical) {
    const match = /^([GMkmuμµn]?)Jy(?:\/(.+))?$/.exec(canonical);
    return match ? { factor: prefixFactor[match[1]], per: match[2] ?? "" } : null;
  }

  // Factor that turns a value in `from` into a value in `to`: { ok, factor, state, reason }.
  // state: "same", "scaled" (Jy prefix), "unknown" (a unit is missing) or "different".
  function unitConversion(from, to) {
    const a = canonicalUnit(from);
    const b = canonicalUnit(to);
    if (!a || !b) {
      return { ok: false, state: "unknown", factor: NaN, reason: "BUNIT is missing in " + (!a && !b ? "both images" : !a ? "the target" : "the reference") + ", so the units are not known to match." };
    }
    if (a === b) return { ok: true, state: "same", factor: 1, reason: "" };
    const first = jyParts(a);
    const second = jyParts(b);
    if (first && second && first.per === second.per) {
      return { ok: true, state: "scaled", factor: first.factor / second.factor, reason: "The target is converted from " + a + " to " + b + " (× " + Number((first.factor / second.factor).toPrecision(6)) + ")." };
    }
    return {
      ok: false, state: "different", factor: NaN,
      reason: "The target is in " + a + " and the reference in " + b + ". Only identical units or Jy prefixes (for example kJy/sr and MJy/sr) are converted; other units are not compared.",
    };
  }

  // Does `varianceUnit` describe the square of `unit`? Returns { ok, assumed, reason }. A missing variance BUNIT is accepted
  // as "assumed to be the image unit squared" and reported as such.
  function varianceUnitCheck(varianceUnit, unit) {
    const v = canonicalUnit(varianceUnit);
    const u = canonicalUnit(unit);
    if (!v) return { ok: true, assumed: true, reason: "The variance HDU has no BUNIT; it is assumed to be the square of the image unit." };
    if (!u) return { ok: false, assumed: false, reason: "The image has no BUNIT, so the variance unit " + v + " cannot be checked." };
    const candidates = new Set(["(" + u + ")^2", u + "^2", "(" + u + ")2", u + "2", "(" + u + ")*(" + u + ")"]);
    const parts = jyParts(u);
    if (parts) {
      // MJy^2/sr^2 style
      const prefix = u.slice(0, u.indexOf("Jy"));
      candidates.add(prefix + "Jy^2" + (parts.per ? "/" + parts.per + "^2" : ""));
      // SPHEREx cutouts write the variance unit without the caret: "MJy2 / sr2".
      candidates.add(prefix + "Jy2" + (parts.per ? "/" + parts.per + "2" : ""));
    }
    return candidates.has(v)
      ? { ok: true, assumed: false, reason: "" }
      : { ok: false, assumed: false, reason: "The variance unit " + v + " is not the square of the image unit " + u + "." };
  }

  // ---- Reprojection ----------------------------------------------------------------------------------------------------
  // Bilinear resampling of source.values onto grid ({ width, height, wcs }) through both WCS. The output pixel (column, row)
  // has its centre at FITS (column + 1, row + 1); its sky position is mapped into the source and the four surrounding
  // source pixel centres are blended. source = { width, height, wcs, values, variance?, mask? }.
  // Returns { values, variance, status } with status 0 (ok), 1 (centre outside the source: a bilinear value needs all four
  // neighbours inside, so the usable footprint ends at the outermost pixel centres) or 3 (a neighbour with non-zero weight
  // is NaN or masked).
  // Dispatches to the Rust/WebAssembly kernel (see useKernel) when one is installed, the image is big enough to win and both
  // WCS can be handed over; otherwise, and whenever the kernel fails, the JavaScript implementation below runs. Same results.
  function reprojectBilinear(source, grid) {
    const fast = kernel.module && kernelEligible(source, grid) ? reprojectWithKernel(source, grid) : null;
    if (fast) {
      kernel.calls.wasm++;
      return fast;
    }
    kernel.calls.js++;
    return reprojectBilinearJs(source, grid);
  }

  function reprojectBilinearJs(source, grid) {
    const { width: nx, height: ny } = source;
    const count = grid.width * grid.height;
    const values = new Float64Array(count).fill(NaN);
    const variance = source.variance ? new Float64Array(count).fill(NaN) : null;
    const state = new Uint8Array(count).fill(status.outside);
    const usable = (index) => Number.isFinite(source.values[index]) && !(source.mask && source.mask[index]);
    for (let row = 0; row < grid.height; row++) {
      for (let column = 0; column < grid.width; column++) {
        const out = row * grid.width + column;
        const sky = grid.wcs.pixelToSky(column + 1, row + 1);
        const at = sky && source.wcs.skyToPixel(sky.ra, sky.dec);
        if (!at || !isNumber(at.x) || !isNumber(at.y)) continue;
        if (at.x < 1 - edgePixels || at.x > nx + edgePixels || at.y < 1 - edgePixels || at.y > ny + edgePixels) continue;
        const sx = Math.min(nx, Math.max(1, at.x));
        const sy = Math.min(ny, Math.max(1, at.y));
        let fx = sx - Math.floor(sx);
        let fy = sy - Math.floor(sy);
        let i0 = Math.floor(sx) - 1;
        let j0 = Math.floor(sy) - 1;
        if (fx < snapPixels) fx = 0;
        else if (fx > 1 - snapPixels) { fx = 0; i0++; }
        if (fy < snapPixels) fy = 0;
        else if (fy > 1 - snapPixels) { fy = 0; j0++; }
        i0 = Math.min(i0, nx - 1);
        j0 = Math.min(j0, ny - 1);
        const i1 = Math.min(i0 + 1, nx - 1);
        const j1 = Math.min(j0 + 1, ny - 1);
        const taps = [
          [j0 * nx + i0, (1 - fx) * (1 - fy)],
          [j0 * nx + i1, fx * (1 - fy)],
          [j1 * nx + i0, (1 - fx) * fy],
          [j1 * nx + i1, fx * fy],
        ];
        let sum = 0;
        let spread = source.variance ? 0 : NaN;
        let good = true;
        for (const [index, weight] of taps) {
          if (weight <= 0) continue;
          if (!usable(index)) { good = false; break; }
          sum += weight * source.values[index];
          if (source.variance) {
            const each = source.variance[index];
            spread = Number.isFinite(each) && each >= 0 && Number.isFinite(spread) ? spread + weight * weight * each : NaN;
          }
        }
        if (!good) { state[out] = status.targetInvalid; continue; }
        state[out] = status.valid;
        values[out] = sum;
        if (variance) variance[out] = spread;
      }
    }
    return { values, variance, status: state };
  }

  // ---- Optional WebAssembly accelerator (rust/crates/reproject) ---------------------------------------------------------------
  // useKernel(await AstroNotWasm.load("reproject")) installs it; useKernel(null) removes it. Nothing else changes: every
  // function stays synchronous and works without it. A call goes to wasm only when the output window has at least
  // `minPixels` pixels (below that the copy into wasm memory costs more than the loop saves; see tests/reproject-wasm.test.mjs
  // for the measured crossover) and both WCS carry `params` (wcs.js objects do; hand-made wcs objects stay in JS).
  const kernelChunkPixels = 1 << 20; // Output rows go through wasm memory in pieces of about this many pixels.
  const defaultMinPixels = 64; // Measured crossover: wasm is already faster at 8 x 8 output pixels (scripts/bench-reproject.mjs).
  const kernel = { module: null, minPixels: defaultMinPixels, uploadRatio: 128, exact: false, cache: null, calls: { wasm: 0, js: 0 } };

  function useKernel(module, options = {}) {
    releaseKernelCache();
    const usable = module && module.exports && typeof module.exports.reproject_bilinear === "function" && module.exports.memory;
    kernel.module = usable ? module : null;
    kernel.minPixels = options.minPixels ?? defaultMinPixels;
    // exact: true repeats the trigonometric sky round trip of wcs.js per pixel (slower); the default maps the pixel by one
    // rotation (same map, equal to rounding). See rust/crates/reproject.
    kernel.exact = options.exact === true;
    return Boolean(usable);
  }

  function kernelStatus() {
    return { active: Boolean(kernel.module), minPixels: kernel.minPixels, calls: { wasm: kernel.calls.wasm, js: kernel.calls.js } };
  }

  function kernelRegion(array) {
    const exports = kernel.module.exports;
    const bytes = array.byteLength;
    const ptr = exports.an_alloc(bytes);
    if (!ptr) throw new Error("WebAssembly memory is exhausted.");
    new Uint8Array(exports.memory.buffer, ptr, bytes).set(new Uint8Array(array.buffer, array.byteOffset, bytes));
    return { ptr, bytes };
  }

  function kernelFree(...regions) {
    for (const region of regions) if (region) kernel.module.exports.an_free(region.ptr, region.bytes);
  }

  // A mosaic reprojects many windows of one source: with `source.keepInKernel` the uploaded arrays are kept (one source at
  // a time) until releaseKernelCache() or another source arrives.
  function releaseKernelCache() {
    const cache = kernel.cache;
    kernel.cache = null;
    if (cache && kernel.module) kernelFree(...cache.regions);
  }

  function kernelGrid(grid) {
    return grid.kernelBase || { wcs: grid.wcs, x: 0, y: 0, dx: 0, dy: 0 };
  }

  function kernelEligible(source, grid) {
    const base = kernelGrid(grid);
    const count = grid.width * grid.height;
    const nx = source.width;
    const ny = source.height;
    const sized = (array, type) => array instanceof type && array.length === nx * ny;
    if (!(count >= kernel.minPixels && count > 0 && grid.width <= 0xffffffff)) return false;
    if (!(Number.isInteger(nx) && Number.isInteger(ny) && nx > 0 && ny > 0 && nx <= 0xffffffff && ny <= 0xffffffff)) return false;
    // The source is copied into wasm memory (4 GB limit for the whole module): refuse sources above about 1.5 GB, and a small
    // window of a large source, where copying the source costs more than the loop saves (measured, see scripts/bench-reproject.mjs).
    const sourceBytes = nx * ny * (8 + (source.variance ? 8 : 0) + (source.mask ? 1 : 0));
    if (sourceBytes >= 0x60000000) return false;
    const reused = source.keepInKernel === true || (kernel.cache && kernel.cache.source === source);
    if (!reused && count * kernel.uploadRatio < nx * ny * (source.variance ? 2 : 1)) return false;
    return source.wcs && source.wcs.params instanceof Float64Array && base.wcs && base.wcs.params instanceof Float64Array
      && Number.isInteger(base.x) && Number.isInteger(base.y)
      && sized(source.values, Float64Array)
      && (!source.variance || sized(source.variance, Float64Array))
      && (!source.mask || sized(source.mask, Uint8Array));
  }

  function reprojectWithKernel(source, grid) {
    const exports = kernel.module.exports;
    const base = kernelGrid(grid);
    const { width, height } = grid;
    const count = width * height;
    const values = new Float64Array(count);
    const variance = source.variance ? new Float64Array(count) : null;
    const state = new Uint8Array(count);
    const keep = source.keepInKernel === true;
    let cache = kernel.cache;
    if (cache && !(cache.source === source && cache.values === source.values && cache.variance === (source.variance || null) && cache.mask === (source.mask || null))) {
      releaseKernelCache();
      cache = null;
    }
    const temporary = []; // Everything allocated in wasm memory for this call is freed in `finally` (except a kept source).
    const take = (bytes) => {
      const region = { ptr: exports.an_alloc(bytes), bytes };
      if (!region.ptr) throw new Error("WebAssembly memory is exhausted.");
      temporary.push(region);
      return region;
    };
    try {
      if (!cache) {
        const pointers = [kernelRegion(source.values)];
        temporary.push(pointers[0]);
        pointers.push(source.variance ? kernelRegion(source.variance) : null);
        temporary.push(pointers[1]);
        pointers.push(source.mask ? kernelRegion(source.mask) : null);
        temporary.push(pointers[2]);
        cache = { pointers };
        if (keep) {
          // Hand the regions over to the cache so `finally` does not free them.
          kernel.cache = { source, values: source.values, variance: source.variance || null, mask: source.mask || null, regions: pointers.filter(Boolean), pointers };
          temporary.length = 0;
        }
      }
      const [valueRegion, varianceRegion, maskRegion] = cache.pointers;
      const chunkRows = Math.max(1, Math.min(height, Math.floor(kernelChunkPixels / width)));
      const chunkPixels = chunkRows * width;
      const params = [kernelRegion(source.wcs.params), kernelRegion(base.wcs.params)];
      temporary.push(...params);
      const outValues = take(chunkPixels * 8);
      const outVariance = variance ? take(chunkPixels * 8) : null;
      const outState = take(chunkPixels);
      for (let row = 0; row < height; row += chunkRows) {
        const rows = Math.min(chunkRows, height - row);
        const code = exports.reproject_bilinear(
          params[0].ptr, source.wcs.params.length, params[1].ptr, base.wcs.params.length,
          source.width, source.height, valueRegion.ptr, varianceRegion ? varianceRegion.ptr : 0, maskRegion ? maskRegion.ptr : 0,
          width, rows, base.x, base.dx, base.y + row, base.dy,
          outValues.ptr, outVariance ? outVariance.ptr : 0, outState.ptr, kernel.exact ? 1 : 0,
        );
        if (code !== 0) return null;
        const n = rows * width;
        const memory = exports.memory.buffer; // Re-read: memory may have grown.
        values.set(new Float64Array(memory, outValues.ptr, n), row * width);
        if (variance) variance.set(new Float64Array(memory, outVariance.ptr, n), row * width);
        state.set(new Uint8Array(memory, outState.ptr, n), row * width);
      }
      return { values, variance, status: state };
    } catch (error) {
      return null; // Any wasm failure (for example out of memory) falls back to the JavaScript loop.
    } finally {
      kernelFree(...temporary);
    }
  }

  // ---- Alignment decision --------------------------------------------------------------------------------------------
  // How the target gets onto the reference grid, or why it cannot. Inputs carry { width, height, wcs, wcsReason }.
  // Returns { ok: true, mode: "direct" | "reproject", grid, overlap, ... } or { ok: false, code, reason }.
  function planAlignment(reference, target, options = {}) {
    for (const [name, image] of [["reference", reference], ["target", target]]) {
      if (!image.wcs) {
        return refuse("no-wcs", "The " + name + " image has no usable WCS" + (image.wcsReason ? " (" + image.wcsReason + ")" : "") + ". Equal array sizes alone do not show that two images cover the same sky, so a difference needs a WCS in both images, or an input that is already aligned with a WCS.");
      }
    }
    const overlap = pairLib.skyOverlap(reference, target);
    if (overlap.state === "none") return refuse("no-overlap", "The two images do not overlap on the sky, so there is nothing to subtract.");
    const grid = pairLib.gridCompatibility(reference, target, gridTolerancePixels);
    if (grid.ok) return { ok: true, mode: "direct", grid, overlap };
    if (options.alignment === "require-same-grid") {
      return refuse("grid-differs", "The images are not on one pixel grid: " + grid.reason + " Reprojection is switched off, so the difference was not computed.");
    }
    const referenceScale = pairLib.pixelScaleArcsec(reference.wcs, reference.width, reference.height);
    const targetScale = pairLib.pixelScaleArcsec(target.wcs, target.width, target.height);
    if (referenceScale === null || targetScale === null) return refuse("scale-unavailable", "The pixel scale of an image could not be computed from its WCS, so the target cannot be reprojected.");
    if (targetScale / referenceScale < finestSourceRatio) {
      return refuse("target-finer", "The target pixels (" + Number(targetScale.toPrecision(4)) + " arcsec) are much smaller than the reference pixels (" + Number(referenceScale.toPrecision(4)) + " arcsec). Bilinear reprojection would alias the target; an area-conserving reprojection is needed, which this tool does not provide. Use the finer image as the reference.");
    }
    return { ok: true, mode: "reproject", grid, overlap, referenceScale, targetScale };
  }

  // ---- The difference ------------------------------------------------------------------------------------------------
  function median(values) {
    const sorted = Float64Array.from(values).sort();
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function observationRecord(image, convertedFactor, unit) {
    const meta = image.meta ?? {};
    return {
      name: image.name ?? null,
      obsId: meta.obsId ?? null,
      time: meta.time ?? null,
      band: meta.wavelength ?? null,
      detector: meta.detector ?? null,
      originalUnit: image.unit ?? meta.unit ?? null,
      unit,
      unitFactor: convertedFactor,
      hduIndex: meta.hduIndex ?? null,
      hduName: meta.hduName ?? null,
      meta,
    };
  }

  // computeDifference(reference, target, options)
  //   reference, target: { name?, meta? (pair.describeObservation), width, height, values (Float64Array, calibrated),
  //                        wcs (wcs.js object or null), wcsReason?, unit (BUNIT), fingerprint?, fields? (HDU header fields),
  //                        variance? (Float64Array in unit^2), varianceUnit?, mask? (Uint8Array, non-zero = masked) }
  //   options: { alignment: "reproject" (default) | "require-same-grid", background: "none" (default) | "median",
  //              assumeSameUnit: false }
  // Returns { ok: false, code, reason } or { ok: true, result }. `result` is the structure that Motion Detector reuses:
  //   kind, sign ("target-minus-reference"), label, mode ("pixel-difference" | "reprojected-difference"),
  //   width, height, wcs, wcsFields, unit,
  //   reference { obsId, time, unit, values, valid, ... }, target { obsId, time, originalUnit, unit, values (on the
  //   reference grid, converted to `unit`), valid, ... },
  //   difference (Float64Array, NaN where invalid), valid (Uint8Array, 1 = valid), status (per-pixel reason code),
  //   overlap (Uint8Array, 1 = reference pixel lies inside the area covered by the target), variance, snr (or null),
  //   counts, empty, emptyReason, resampling (null or details), background, psf, warnings, notes, summary.
  function computeDifference(reference, target, options = {}) {
    if (!reference || !target) return refuse("missing-input", "Both a reference and a target image are needed.");
    const double = (array) => array && !(array instanceof Float64Array) ? Float64Array.from(array) : array;
    reference = Object.assign({}, reference, { values: double(reference.values), variance: double(reference.variance) });
    target = Object.assign({}, target, { values: double(target.values), variance: double(target.variance) });
    for (const [name, image] of [["reference", reference], ["target", target]]) {
      if (!(image.values && image.values.length === image.width * image.height && image.width > 0 && image.height > 0)) {
        return refuse("bad-array", "The " + name + " pixel array does not match its size.");
      }
    }
    const fingerprintOf = (image) => image.fingerprint ?? pairLib.fingerprintValues(image.values);
    if (fingerprintOf(reference) === fingerprintOf(target)) {
      return refuse("duplicate", "The reference and the target contain identical pixel values, so they are the same observation and the difference would be zero everywhere. Choose a different observation.");
    }

    // 1. Units.
    const conversion = unitConversion(target.unit, reference.unit);
    let unitNote = conversion.reason;
    let unitAssumed = false;
    let factor = conversion.factor;
    if (!conversion.ok) {
      if (conversion.state === "unknown" && options.assumeSameUnit) {
        factor = 1;
        unitAssumed = true;
        unitNote = "BUNIT is missing, so the two images are ASSUMED to be in the same unit. This was chosen by the user and is not verified.";
      } else {
        return refuse(conversion.state === "unknown" ? "unit-missing" : "unit-mismatch", conversion.reason);
      }
    }
    const unit = (typeof reference.unit === "string" && reference.unit.trim()) || (typeof target.unit === "string" && target.unit.trim()) || null;

    // 2. Alignment.
    const plan = planAlignment(reference, target, options);
    if (!plan.ok) return plan;

    const count = reference.width * reference.height;
    const warnings = [];
    const notes = [];
    if (unitNote) (unitAssumed ? warnings : notes).push(unitNote);

    let targetValues;
    let targetVariance = null;
    let targetState;
    let resampling = null;
    if (plan.mode === "direct") {
      targetValues = new Float64Array(count);
      for (let index = 0; index < count; index++) targetValues[index] = target.values[index] * factor;
      if (target.variance) {
        targetVariance = new Float64Array(count);
        for (let index = 0; index < count; index++) targetVariance[index] = target.variance[index] * factor * factor;
      }
      targetState = new Uint8Array(count);
      for (let index = 0; index < count; index++) {
        if (!Number.isFinite(target.values[index]) || (target.mask && target.mask[index])) targetState[index] = status.targetInvalid;
      }
    } else {
      const moved = reprojectBilinear(target, reference);
      targetValues = moved.values;
      for (let index = 0; index < count; index++) targetValues[index] *= factor;
      if (moved.variance) {
        targetVariance = moved.variance;
        for (let index = 0; index < count; index++) targetVariance[index] *= factor * factor;
      }
      targetState = moved.status;
      resampling = {
        method: "bilinear",
        description: "Bilinear interpolation of the target pixel values at the reference pixel centres, through both WCS (as reproject_interp with order 'bilinear').",
        parameters: { order: "bilinear", pixelValues: "surface brightness, interpolated (not flux-conserving)", footprint: "all four neighbouring target pixel centres inside the target image", invalidRule: "a pixel whose interpolation stencil touches a NaN or masked target pixel is invalid" },
        gridOffsetBeforeArcsec: plan.grid.maxOffsetArcsec ?? null,
        gridOffsetBeforePixels: plan.grid.maxOffsetPixels ?? null,
        targetPixelScaleArcsec: plan.targetScale,
        referencePixelScaleArcsec: plan.referenceScale,
        correlation: "Neighbouring reprojected pixels share target pixels, so their noise is correlated and smoothed. Per-pixel variances are propagated with the bilinear weights; sums or averages over several pixels cannot treat them as independent.",
      };
      warnings.push("The target was reprojected onto the reference grid with bilinear interpolation. This smooths the target and correlates its pixel noise, so small differences near sources can reflect the resampling, not the sky.");
      if (plan.targetScale / plan.referenceScale > 1.25) {
        warnings.push("The target pixels are larger than the reference pixels, so the reprojected target has less detail than the reference.");
      }
    }

    // 3. Pixel states and the difference.
    const stateOut = new Uint8Array(count);
    const overlapMask = new Uint8Array(count);
    const referenceValid = new Uint8Array(count);
    const targetValid = new Uint8Array(count);
    const difference = new Float64Array(count).fill(NaN);
    const valid = new Uint8Array(count);
    const counts = { total: count, covered: 0, valid: 0, outside: 0, referenceInvalid: 0, targetInvalid: 0 };
    for (let index = 0; index < count; index++) {
      const referenceBad = !Number.isFinite(reference.values[index]) || Boolean(reference.mask && reference.mask[index]);
      const targetBad = targetState[index] !== status.valid || !Number.isFinite(targetValues[index]);
      referenceValid[index] = referenceBad ? 0 : 1;
      targetValid[index] = targetBad ? 0 : 1;
      let code = status.valid;
      if (targetState[index] === status.outside) code = status.outside;
      else if (referenceBad) code = status.referenceInvalid;
      else if (targetBad) code = status.targetInvalid;
      stateOut[index] = code;
      if (code !== status.outside) {
        overlapMask[index] = 1;
        counts.covered++;
      }
      if (code === status.valid) {
        difference[index] = targetValues[index] - reference.values[index];
        valid[index] = 1;
        counts.valid++;
      } else if (code === status.outside) counts.outside++;
      else if (code === status.referenceInvalid) counts.referenceInvalid++;
      else counts.targetInvalid++;
    }

    // 4. Optional background (global median offset). Applied to the difference only.
    let background = { method: "none", description: "No background correction.", value: null, pixels: 0 };
    if (options.background === "median") {
      const picked = [];
      for (let index = 0; index < count; index++) if (valid[index]) picked.push(difference[index]);
      if (picked.length) {
        const offset = median(picked);
        for (let index = 0; index < count; index++) if (valid[index]) difference[index] -= offset;
        background = { method: "median", description: "The median of Δ over all valid pixels was subtracted (a single constant for the whole image).", value: offset, unit, pixels: picked.length };
        warnings.push("A global median offset of " + Number(offset.toPrecision(6)) + (unit ? " " + unit : "") + " was removed from Δ. The uncertainty of that offset is not propagated, and real changes that cover much of the image are absorbed.");
      } else {
        background = { method: "median", description: "Requested, but there are no valid pixels.", value: null, unit, pixels: 0 };
      }
    }

    // 5. Variance and SNR when both images have a usable variance.
    let variance = null;
    let snr = null;
    let varianceNote = "";
    const referenceVarianceOk = Boolean(reference.variance && reference.variance.length === count);
    const targetVarianceOk = Boolean(targetVariance);
    if (reference.variance && target.variance) {
      const checks = [varianceUnitCheck(reference.varianceUnit, reference.unit), varianceUnitCheck(target.varianceUnit, target.unit)];
      const failed = checks.find((entry) => !entry.ok);
      if (failed || !referenceVarianceOk) {
        varianceNote = failed ? failed.reason : "The reference variance array does not match the image size.";
      } else {
        variance = new Float64Array(count).fill(NaN);
        snr = new Float64Array(count).fill(NaN);
        let withVariance = 0;
        for (let index = 0; index < count; index++) {
          if (!valid[index]) continue;
          const sum = reference.variance[index] + targetVariance[index];
          if (Number.isFinite(sum) && sum >= 0 && reference.variance[index] >= 0) {
            variance[index] = sum;
            withVariance++;
            if (sum > 0) snr[index] = difference[index] / Math.sqrt(sum);
          }
        }
        varianceNote = "Var(Δ) = Var(target) + Var(reference), assuming independent errors in the two images" +
          (resampling ? "; the target variance is propagated through the bilinear weights" : "") +
          ". " + withVariance + " of " + counts.valid + " valid pixels have a usable variance." +
          (checks.some((entry) => entry.assumed) ? " A variance BUNIT was missing and the image unit squared was assumed." : "");
        if (!withVariance) { variance = null; snr = null; }
      }
    } else {
      varianceNote = !reference.variance && !target.variance ? "Neither image has a variance array, so the SNR is unavailable."
        : "Only the " + (reference.variance ? "reference" : "target") + " has a variance array, so Var(Δ) and the SNR are unavailable.";
    }
    if (resampling && variance) notes.push("Variance of the reprojected target uses Σw²·Var of the bilinear weights; neighbouring pixels remain correlated.");

    // 6. Assemble.
    const empty = counts.valid === 0;
    const emptyReason = !empty ? "" : counts.covered === 0
      ? "No reference pixel lies inside the area covered by the target."
      : "The images overlap, but every overlapping pixel is NaN, BLANK or masked in at least one of them.";
    const mode = plan.mode === "direct" ? "pixel-difference" : "reprojected-difference";
    const summary = plan.mode === "direct"
      ? "Pixel difference on one verified pixel grid (largest WCS offset " + Number(plan.grid.maxOffsetPixels.toPrecision(2)) + " pixel); no resampling."
      : "Target reprojected onto the reference grid (bilinear), then subtracted.";
    const interpretation = "Pixel difference. Residuals can come from background, PSF and pixel-scale differences, and its scientific meaning depends on the band, the calibration and the quality of the alignment." + (options.background === "median" ? "" : " No PSF matching or background correction was applied.");
    return {
      ok: true,
      result: {
        kind: "image-difference",
        sign: "target-minus-reference",
        label: direction.label,
        mode, summary, interpretation,
        width: reference.width, height: reference.height,
        wcs: reference.wcs, wcsFields: reference.fields ?? null, unit,
        reference: Object.assign(observationRecord(reference, 1, canonicalUnit(reference.unit)), { values: reference.values, valid: referenceValid }),
        target: Object.assign(observationRecord(target, factor, unit), { values: targetValues, valid: targetValid, sourceValues: target.values }),
        difference, valid, status: stateOut, overlap: overlapMask,
        variance, snr, varianceNote,
        counts, empty, emptyReason,
        alignment: { mode: plan.mode, gridCheck: plan.grid, skyOverlap: plan.overlap },
        resampling, background,
        psf: { matched: false, description: "No PSF matching was applied." },
        unitCheck: { state: unitAssumed ? "assumed" : conversion.state, factor, note: unitNote },
        warnings, notes,
      },
    };
  }

  // Short text for one pixel of a result: { reference, target, difference, variance, snr, reason } as numbers or null.
  function pixelAt(result, column, row) {
    if (!(column >= 0 && column < result.width && row >= 0 && row < result.height)) return null;
    const index = row * result.width + column;
    const pick = (array) => array && Number.isFinite(array[index]) ? array[index] : null;
    return {
      index, column, row,
      reference: pick(result.reference.values), target: pick(result.target.values),
      difference: pick(result.difference), variance: pick(result.variance), snr: pick(result.snr),
      status: result.status[index], reason: statusText[result.status[index]], valid: result.valid[index] === 1,
    };
  }

  // ---- Display helpers (never used by computeDifference) --------------------------------------------------------------
  const divergingStops = [
    [-1, [33, 102, 172]], [-0.5, [103, 169, 207]], [0, [247, 247, 247]], [0.5, [239, 138, 98]], [1, [178, 24, 43]],
  ];

  // Colour of a signed value for a zero-centred scale: t = value / limit, clipped to -1..1. Zero is the neutral centre,
  // negative values are blue and positive values red; the scale is symmetric by construction.
  function divergingColor(t) {
    const x = Math.max(-1, Math.min(1, t));
    for (let index = 1; index < divergingStops.length; index++) {
      const [high, highColor] = divergingStops[index];
      const [low, lowColor] = divergingStops[index - 1];
      if (x <= high) {
        const f = (x - low) / (high - low);
        return lowColor.map((channel, k) => Math.round(channel + f * (highColor[k] - channel)));
      }
    }
    return divergingStops.at(-1)[1].slice();
  }

  // Symmetric limit L for a zero-centred scale: the given percentile (0-100) of |Δ| over the valid pixels, or null when
  // there are none. Zero when every valid difference is zero.
  function symmetricLimit(difference, valid, percentile = 99) {
    const magnitudes = [];
    for (let index = 0; index < difference.length; index++) if (valid[index] && Number.isFinite(difference[index])) magnitudes.push(Math.abs(difference[index]));
    if (!magnitudes.length) return null;
    magnitudes.sort((a, b) => a - b);
    return magnitudes[Math.min(magnitudes.length - 1, Math.max(0, Math.ceil(magnitudes.length * percentile / 100) - 1))];
  }

  // ---- FITS export -----------------------------------------------------------------------------------------------------
  const wcsKeywords = /^(WCSAXES|CTYPE[12]|CUNIT[12]|CRPIX[12]|CRVAL[12]|CDELT[12]|CD[12]_[12]|PC[12]_[12]|LONPOLE|LATPOLE|RADESYS|EQUINOX|A_\d+_\d+|B_\d+_\d+|AP_\d+_\d+|BP_\d+_\d+|[AB]P?_ORDER|A_DMAX|B_DMAX)$/;

  function fitsCard(key, value, comment = "") {
    let text = key.padEnd(8, " ");
    if (value === undefined) return (text + comment).padEnd(80, " ").slice(0, 80);
    text += "= ";
    if (typeof value === "string") text += "'" + value.replaceAll("'", "''").padEnd(8, " ") + "'";
    else if (typeof value === "boolean") text += (value ? "T" : "F").padStart(20, " ");
    else text += String(value).replace("e", "E").padStart(20, " ");
    if (comment && text.length < 76) text += " / " + comment;
    return text.padEnd(80, " ").slice(0, 80);
  }

  function fitsBlocks(cards) {
    const text = cards.concat(["END".padEnd(80, " ")]).join("");
    return new TextEncoder().encode(text.padEnd(Math.ceil(text.length / 2880) * 2880, " "));
  }

  function dataBlock(bytes) {
    const out = new Uint8Array(Math.ceil(bytes.length / 2880) * 2880);
    out.set(bytes);
    return out;
  }

  function timeText(entry) {
    return entry && entry.time && entry.time.valid ? entry.time.iso : null;
  }

  // The result as a FITS file: an empty primary HDU, a DIFFERENCE image (float64, NaN where invalid) on the reference grid
  // with the reference WCS keywords, BUNIT, the direction and both observation IDs, a MASK image (0 = valid pixel,
  // 1 = invalid) and, when available, a VARIANCE image in unit^2.
  function buildDifferenceFits(result) {
    const grid = result.wcsFields ?? {};
    const wcsCards = Object.keys(grid).filter((key) => wcsKeywords.test(key) && (typeof grid[key] !== "undefined")).map((key) => fitsCard(key, grid[key]));
    const history = (line) => fitsCard("HISTORY", undefined, line);
    const describe = (entry) => (entry.obsId ?? "unavailable") + (timeText(entry) ? " " + timeText(entry) : "");
    const extra = [
      fitsCard("DIFFDIR", "TARGET-REFERENCE", "Delta = target - reference"),
      fitsCard("DIFFMODE", result.mode === "pixel-difference" ? "PIXEL-DIFF" : "BILINEAR-REPROJ", result.mode),
      fitsCard("REFOBS", result.reference.obsId ?? "unavailable", "reference observation ID"),
      fitsCard("TGTOBS", result.target.obsId ?? "unavailable", "target observation ID"),
      fitsCard("BGMETHOD", result.background.method.toUpperCase(), "background correction"),
      ...(result.background.value === null || result.background.value === undefined ? [] : [fitsCard("BGVALUE", result.background.value, "subtracted offset, in BUNIT")]),
      history("AstroNot Image Differencing: delta = target - reference on the reference grid."),
      history("Reference " + describe(result.reference)),
      history("Target " + describe(result.target)),
      history("Pixels invalid in either image are NaN; HDU MASK is 1 there."),
      history(result.resampling ? "Target bilinearly reprojected onto the reference grid." : "No resampling; both images share one verified grid."),
    ];
    const imageCards = (name, bitpix, bunit) => [
      fitsCard("XTENSION", "IMAGE"), fitsCard("BITPIX", bitpix), fitsCard("NAXIS", 2),
      fitsCard("NAXIS1", result.width), fitsCard("NAXIS2", result.height), fitsCard("PCOUNT", 0), fitsCard("GCOUNT", 1),
      fitsCard("EXTNAME", name), ...(bunit ? [fitsCard("BUNIT", bunit)] : []), ...wcsCards,
    ];
    const count = result.width * result.height;
    const parts = [fitsBlocks([fitsCard("SIMPLE", true), fitsCard("BITPIX", 8), fitsCard("NAXIS", 0), fitsCard("EXTEND", true)])];

    const doubles = (array) => {
      const bytes = new Uint8Array(count * 8);
      const view = new DataView(bytes.buffer);
      for (let index = 0; index < count; index++) view.setFloat64(index * 8, array[index], false);
      return dataBlock(bytes);
    };
    parts.push(fitsBlocks(imageCards("DIFFERENCE", -64, result.unit ?? undefined).concat(extra)), doubles(result.difference));
    const mask = new Uint8Array(count);
    for (let index = 0; index < count; index++) mask[index] = result.valid[index] ? 0 : 1;
    parts.push(fitsBlocks(imageCards("MASK", 8, undefined).concat([history("0 = valid, 1 = invalid (outside overlap, NaN or masked)")])), dataBlock(mask));
    if (result.variance) {
      parts.push(fitsBlocks(imageCards("VARIANCE", -64, result.unit ? "(" + result.unit + ")^2" : undefined).concat([history("Var(delta) = Var(target) + Var(reference), independent errors")])), doubles(result.variance));
    }
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  const api = {
    status, statusText, direction, gridTolerancePixels,
    canonicalUnit, unitConversion, varianceUnitCheck,
    reprojectBilinear, reprojectBilinearJs, useKernel, kernelStatus, releaseKernelCache, planAlignment, computeDifference, pixelAt,
    divergingColor, symmetricLimit, buildDifferenceFits,
  };
  root.AstroNotDifference = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);
