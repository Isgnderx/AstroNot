// Per-pixel image operations shared by the AstroNot tools, each with a JavaScript implementation (the reference) and an
// optional Rust/WebAssembly one (rust/crates/fitsdata, installed through tools/fits.js: AstroNotFits.useKernel).
// Global `AstroNotPixels`, also a CommonJS module for tests. UI-independent: it only touches the arrays it is given.
//
//   fillGray / fillDiverging   the RGBA fills of the canvas pictures (Time Machine, Image Differencing, Mosaic Builder, Motion)
//   symmetricLimit             Diff.symmetricLimit without sorting every |difference| (exact order statistic)
//   orderStatistics, moments, percentileClip, sigmaClippedStats    exact statistics of large arrays, no full sort
//   subtractDirect, varianceSum  the elementwise part of tools/difference.js computeDifference on one pixel grid
//   mosaicAccumulator          the per-pixel accumulate and combine loops of tools/mosaic-model.js
//
// The wasm path is used only when a kernel is installed, the array has at least `settings.minPixels` pixels and the
// operation is switched on in `settings.use`; `settings.engine` can force "js" (reference) or "wasm" (tests, benchmarks).
// Results are identical to the JavaScript ones: same expressions in the same order, no reassociated sums.
(function (root) {
  "use strict";

  const settings = {
    engine: "auto", // "auto" | "js" | "wasm" (wasm throws when no kernel is installed)
    minPixels: 1 << 16,
    bandPixels: 1 << 18, // elements copied to wasm memory at a time by the elementwise operations
    use: { paint: true, stats: true, subtract: true, mosaic: true },
  };
  const counters = { paint: 0, stats: 0, subtract: 0, mosaic: 0 };
  const scratch = new Map();

  function kernelOf() {
    const fits = root.AstroNotFits;
    return fits && fits.kernel ? fits.kernel() : null;
  }

  // The kernel to use for an operation on `pixels` elements, or null for the JavaScript path.
  function pick(operation, pixels) {
    if (settings.engine === "js" || !settings.use[operation]) return null;
    const kernel = kernelOf();
    if (settings.engine === "wasm") {
      if (!kernel) throw new Error("The WebAssembly kernel is not installed.");
      return kernel;
    }
    return kernel && pixels >= settings.minPixels ? kernel : null;
  }

  function typeName(array) {
    return Object.prototype.toString.call(array).slice(8, -1);
  }
  const isF64 = (array) => array && typeName(array) === "Float64Array";
  const isU8 = (array) => array && typeName(array) === "Uint8Array";

  // ---- wasm memory helpers --------------------------------------------------------------------------------------------
  // Named scratch regions, reused by every call (grow-only), for the banded elementwise operations.
  function region(kernel, name, bytes) {
    const key = name;
    const held = scratch.get(key);
    if (held && held.kernel === kernel && held.bytes >= bytes) return held.ptr;
    if (held && held.kernel === kernel) kernel.exports.an_free(held.ptr, held.bytes);
    const ptr = kernel.exports.an_alloc(bytes);
    scratch.set(key, { kernel, ptr, bytes });
    return ptr;
  }

  function view(kernel, Type, ptr, length) {
    return new Type(kernel.exports.memory.buffer, ptr, length);
  }

  // Copies `array` (any typed array) into a fresh wasm allocation; the caller frees it with kernel.exports.an_free(ptr, bytes).
  function upload(kernel, array) {
    const bytes = array.byteLength;
    const ptr = kernel.exports.an_alloc(bytes);
    new Uint8Array(kernel.exports.memory.buffer, ptr, bytes).set(new Uint8Array(array.buffer, array.byteOffset, bytes));
    return { ptr, bytes };
  }

  function release(kernel, ...regions) {
    for (const held of regions) if (held) kernel.exports.an_free(held.ptr, held.bytes);
  }

  // ---- Picture fills -------------------------------------------------------------------------------------------------------
  // fillGray: shade = span > 0 ? clamp(255 * (value - low) / span) : 128, rows flipped (FITS row 0 is the bottom of the picture).
  //   mode "valid"  (Image Differencing, Mosaic Builder, Motion): a pixel with valid[i] == 0, or no range, stays transparent.
  //   mode "finite" (Time Machine): a non-finite value is opaque black; `valid` is ignored.
  // `data` is the RGBA array of a fresh ImageData (all zero); `range` is { low, high } or null.
  function fillGrayJs(data, values, valid, width, height, range, mode) {
    const span = range ? range.high - range.low : 0;
    for (let y = 0; y < height; y++) {
      const sourceRow = (height - y - 1) * width; // FITS axis 2 starts at the bottom of the picture.
      for (let x = 0; x < width; x++) {
        const index = sourceRow + x;
        const at = (y * width + x) * 4;
        if (mode === "finite") {
          const value = values[index];
          const shade = Number.isFinite(value) ? (span > 0 ? Math.max(0, Math.min(255, 255 * (value - range.low) / span)) : 128) : 0;
          data[at] = data[at + 1] = data[at + 2] = shade;
          data[at + 3] = 255;
          continue;
        }
        if (!valid[index] || !range) continue; // Transparent: the hatch shows through.
        const shade = span > 0 ? Math.max(0, Math.min(255, 255 * (values[index] - range.low) / span)) : 128;
        data[at] = data[at + 1] = data[at + 2] = shade;
        data[at + 3] = 255;
      }
    }
  }

  function bandRowsFor(width) {
    return Math.max(1, Math.floor(settings.bandPixels / width));
  }

  function fillGrayWasm(kernel, data, values, valid, width, height, range, mode) {
    const { exports } = kernel;
    const rowsMax = Math.min(height, bandRowsFor(width));
    const inValues = region(kernel, "paint-values", rowsMax * width * 8);
    const inValid = region(kernel, "paint-valid", rowsMax * width);
    const output = region(kernel, "paint-out", rowsMax * width * 4);
    const low = range ? range.low : 0;
    const span = range ? range.high - range.low : 0;
    for (let first = 0; first < height; first += rowsMax) {
      const rows = Math.min(rowsMax, height - first);
      const count = rows * width;
      view(kernel, Float64Array, inValues, count).set(values.subarray(first * width, first * width + count));
      if (mode !== "finite") view(kernel, Uint8Array, inValid, count).set(valid.subarray(first * width, first * width + count));
      exports.fd_paint_gray(inValues, mode === "finite" ? 0 : inValid, width, rows, range ? 1 : 0, low, span, mode === "finite" ? 1 : 0, output);
      data.set(new Uint8ClampedArray(exports.memory.buffer, output, count * 4), (height - first - rows) * width * 4);
    }
    counters.paint += width * height;
  }

  function fillGray(data, values, valid, width, height, range, mode = "valid") {
    const kernel = isF64(values) && (mode === "finite" || isU8(valid)) ? pick("paint", width * height) : null;
    if (kernel) fillGrayWasm(kernel, data, values, valid, width, height, range, mode);
    else fillGrayJs(data, values, valid, width, height, range, mode);
  }

  // fillDiverging: colour = table[round(clamp(difference / limit, -1, 1) * 256) + 256] for valid pixels (table: 513 [r, g, b]).
  function fillDivergingJs(data, difference, valid, width, height, limit, table) {
    for (let y = 0; y < height; y++) {
      const sourceRow = (height - y - 1) * width;
      for (let x = 0; x < width; x++) {
        const index = sourceRow + x;
        if (!valid[index]) continue;
        const t = Math.max(-1, Math.min(1, difference[index] / limit));
        const color = table[Math.round(t * 256) + 256];
        const at = (y * width + x) * 4;
        data[at] = color[0];
        data[at + 1] = color[1];
        data[at + 2] = color[2];
        data[at + 3] = 255;
      }
    }
  }

  const flatTables = new WeakMap();
  function flatTable(table) {
    let flat = flatTables.get(table);
    if (!flat) {
      flat = new Uint8Array(513 * 3);
      for (let index = 0; index < 513; index++) flat.set(table[index], index * 3);
      flatTables.set(table, flat);
    }
    return flat;
  }

  function fillDivergingWasm(kernel, data, difference, valid, width, height, limit, table) {
    const { exports } = kernel;
    const rowsMax = Math.min(height, bandRowsFor(width));
    const inValues = region(kernel, "paint-values", rowsMax * width * 8);
    const inValid = region(kernel, "paint-valid", rowsMax * width);
    const output = region(kernel, "paint-out", rowsMax * width * 4);
    const colors = region(kernel, "paint-table", 513 * 3);
    view(kernel, Uint8Array, colors, 513 * 3).set(flatTable(table));
    for (let first = 0; first < height; first += rowsMax) {
      const rows = Math.min(rowsMax, height - first);
      const count = rows * width;
      view(kernel, Float64Array, inValues, count).set(difference.subarray(first * width, first * width + count));
      view(kernel, Uint8Array, inValid, count).set(valid.subarray(first * width, first * width + count));
      exports.fd_paint_diverging(inValues, inValid, width, rows, limit, colors, output);
      data.set(new Uint8ClampedArray(exports.memory.buffer, output, count * 4), (height - first - rows) * width * 4);
    }
    counters.paint += width * height;
  }

  function fillDiverging(data, difference, valid, width, height, limit, table) {
    const kernel = isF64(difference) && isU8(valid) && table.length === 513 ? pick("paint", width * height) : null;
    if (kernel) fillDivergingWasm(kernel, data, difference, valid, width, height, limit, table);
    else fillDivergingJs(data, difference, valid, width, height, limit, table);
  }

  // ---- Order statistics and moments ------------------------------------------------------------------------------------------
  // A value is included when it is finite, valid[i] is non-zero (valid may be null) and lo <= x <= hi, with x = |value| if `abs`.
  function included(values, valid, abs, lo, hi) {
    const picked = [];
    for (let index = 0; index < values.length; index++) {
      const x = abs ? Math.abs(values[index]) : values[index];
      if ((!valid || valid[index] !== 0) && Number.isFinite(x) && x >= lo && x <= hi) picked.push(x);
    }
    return Float64Array.from(picked).sort(); // Typed-array sort is numeric ascending (-0 before +0), like the kernel's key order.
  }

  function momentsJs(values, valid, abs, lo, hi) {
    let count = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    const take = (visit) => {
      for (let index = 0; index < values.length; index++) {
        const x = abs ? Math.abs(values[index]) : values[index];
        if ((!valid || valid[index] !== 0) && Number.isFinite(x) && x >= lo && x <= hi) visit(x);
      }
    };
    take((x) => { count++; sum += x; if (x < min) min = x; if (x > max) max = x; });
    if (count === 0) return { count: 0, sum: 0, mean: NaN, m2: NaN, min: NaN, max: NaN };
    const mean = sum / count;
    let m2 = 0;
    take((x) => { const d = x - mean; m2 += d * d; });
    return { count, sum, mean, m2, min, max };
  }

  // Uploads `values` (and `valid`) once for a whole statistics call; returns { values, valid, free }.
  function resident(kernel, values, valid) {
    const a = upload(kernel, values);
    const b = valid ? upload(kernel, valid) : null;
    return { values: a.ptr, valid: b ? b.ptr : 0, free: () => release(kernel, a, b) };
  }

  const bounds = (lo, hi) => [lo ?? -Infinity, hi ?? Infinity];

  // Moments of the included values: { count, sum, mean, m2 (sum of squared deviations, two pass), min, max }.
  function moments(values, valid = null, { abs = false, lo, hi } = {}) {
    const [low, high] = bounds(lo, hi);
    const kernel = isF64(values) && (!valid || isU8(valid)) ? pick("stats", values.length) : null;
    if (!kernel) return momentsJs(values, valid, abs, low, high);
    const held = resident(kernel, values, valid);
    const out = kernel.alloc(Float64Array, 6);
    try {
      kernel.exports.fd_moments(held.values, held.valid, values.length, abs ? 1 : 0, low, high, out.ptr);
      const [count, sum, mean, m2, min, max] = kernel.read(out);
      counters.stats += values.length;
      return { count, sum, mean, m2, min, max };
    } finally {
      held.free();
      kernel.free(out);
    }
  }

  // Exact order statistics of the included values. `ranksOf(count)` returns the 0-based ranks wanted (it may return fewer than
  // count; ranks outside 0..count-1 give NaN). Returns { count, values: number[] }. No sort of the whole array on the wasm path.
  function orderStatistics(values, valid, { abs = false, lo, hi } = {}, ranksOf) {
    const [low, high] = bounds(lo, hi);
    const kernel = isF64(values) && (!valid || isU8(valid)) ? pick("stats", values.length) : null;
    if (!kernel) {
      const sorted = included(values, valid, abs, low, high);
      return { count: sorted.length, values: ranksOf(sorted.length).map((rank) => (rank >= 0 && rank < sorted.length ? sorted[rank] : NaN)) };
    }
    const held = resident(kernel, values, valid);
    try {
      const count = kernel.exports.fd_count(held.values, held.valid, values.length, abs ? 1 : 0, low, high);
      const ranks = ranksOf(count);
      const wanted = ranks.filter((rank) => rank >= 0 && rank < count);
      const result = new Map();
      if (wanted.length === 1) result.set(wanted[0], kernel.exports.fd_nth(held.values, held.valid, values.length, abs ? 1 : 0, low, high, wanted[0]));
      else for (let first = 0; first < wanted.length; first += 16) {
        const group = wanted.slice(first, first + 16);
        const inRanks = kernel.alloc(Uint32Array, group.length);
        const outValues = kernel.alloc(Float64Array, group.length);
        try {
          view(kernel, Uint32Array, inRanks.ptr, group.length).set(group);
          kernel.exports.fd_nth_multi(held.values, held.valid, values.length, abs ? 1 : 0, low, high, inRanks.ptr, group.length, outValues.ptr);
          kernel.read(outValues).forEach((value, index) => result.set(group[index], value));
        } finally {
          kernel.free(inRanks, outValues);
        }
      }
      counters.stats += values.length;
      return { count, values: ranks.map((rank) => (result.has(rank) ? result.get(rank) : NaN)) };
    } finally {
      held.free();
    }
  }

  // Diff.symmetricLimit without the full sort: the `percentile` (0-100) of |difference| over the valid pixels, or null.
  function symmetricLimit(difference, valid, percentile = 99, fallback = null) {
    if (fallback && !(isF64(difference) && isU8(valid) && pick("stats", difference.length))) return fallback(difference, valid, percentile);
    const { count, values } = orderStatistics(difference, valid, { abs: true }, (n) => [Math.min(n - 1, Math.max(0, Math.ceil(n * percentile / 100) - 1))]);
    return count ? values[0] : null;
  }

  // Percentile clip of a whole image (exact, not sampled): { low, high } from the fractions of the finite values, like
  // Pair.displayRange (low = value at floor(last * lowFraction), high at ceil(last * highFraction); equal -> min and max).
  function percentileClip(values, valid, lowFraction = 0.01, highFraction = 0.99) {
    const { count, values: picked } = orderStatistics(values, valid, {}, (n) => [0, Math.floor((n - 1) * lowFraction), Math.ceil((n - 1) * highFraction), n - 1]);
    if (!count) return null;
    let [first, low, high, last] = picked;
    if (low === high) {
      low = first;
      high = last;
    }
    return { low, high };
  }

  // Iterative sigma clipping about the median (population standard deviation): { count, mean, median, std, low, high, iterations }.
  function sigmaClippedStats(values, valid = null, sigma = 3, maxIterations = 5) {
    const kernel = isF64(values) && (!valid || isU8(valid)) ? pick("stats", values.length) : null;
    if (kernel) {
      const held = resident(kernel, values, valid);
      const out = kernel.alloc(Float64Array, 7);
      try {
        kernel.exports.fd_sigma_clip(held.values, held.valid, values.length, sigma, maxIterations, out.ptr);
        const [count, mean, median, std, low, high, iterations] = kernel.read(out);
        counters.stats += values.length;
        return { count, mean, median, std, low, high, iterations };
      } finally {
        held.free();
        kernel.free(out);
      }
    }
    const medianOf = (sorted) => (sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);
    let lo = -Infinity;
    let hi = Infinity;
    let sorted = included(values, valid, false, lo, hi);
    if (!sorted.length) return { count: 0, mean: NaN, median: NaN, std: NaN, low: lo, high: hi, iterations: 0 };
    const stats = () => {
      const m = momentsJs(values, valid, false, lo, hi);
      return { mean: m.mean, median: medianOf(sorted), std: Math.sqrt(m.m2 / sorted.length) };
    };
    let current = stats();
    let iterations = 0;
    while (iterations < maxIterations) {
      const nextLo = current.median - sigma * current.std;
      const nextHi = current.median + sigma * current.std;
      const next = included(values, valid, false, nextLo, nextHi);
      if (next.length === sorted.length || next.length === 0) break;
      iterations++;
      lo = nextLo;
      hi = nextHi;
      sorted = next;
      current = stats();
    }
    return { count: sorted.length, mean: current.mean, median: current.median, std: current.std, low: lo, high: hi, iterations };
  }

  // ---- Subtraction (the "direct" path of difference.js computeDifference) ---------------------------------------------------------
  // input: { reference: Float64Array, target: Float64Array, referenceMask?: Uint8Array, targetMask?: Uint8Array, factor }.
  // Returns { targetValues (target * factor), state (Diff.status codes), difference (NaN where invalid), valid, referenceValid,
  // targetValid, counts: { total, covered, valid, outside, referenceInvalid, targetInvalid } }.
  function subtractJs({ reference, target, referenceMask = null, targetMask = null, factor }) {
    const count = reference.length;
    const targetValues = new Float64Array(count);
    const state = new Uint8Array(count);
    const difference = new Float64Array(count).fill(NaN);
    const valid = new Uint8Array(count);
    const referenceValid = new Uint8Array(count);
    const targetValid = new Uint8Array(count);
    const counts = { total: count, covered: count, valid: 0, outside: 0, referenceInvalid: 0, targetInvalid: 0 };
    for (let index = 0; index < count; index++) {
      targetValues[index] = target[index] * factor;
      const targetInputBad = !Number.isFinite(target[index]) || Boolean(targetMask && targetMask[index]);
      const referenceBad = !Number.isFinite(reference[index]) || Boolean(referenceMask && referenceMask[index]);
      const targetBad = targetInputBad || !Number.isFinite(targetValues[index]);
      referenceValid[index] = referenceBad ? 0 : 1;
      targetValid[index] = targetBad ? 0 : 1;
      if (referenceBad) {
        state[index] = 2;
        counts.referenceInvalid++;
      } else if (targetBad) {
        state[index] = 3;
        counts.targetInvalid++;
      } else {
        difference[index] = targetValues[index] - reference[index];
        valid[index] = 1;
        counts.valid++;
      }
    }
    return { targetValues, state, difference, valid, referenceValid, targetValid, counts };
  }

  function subtractWasm(kernel, { reference, target, referenceMask = null, targetMask = null, factor }) {
    const { exports } = kernel;
    const count = reference.length;
    const band = Math.min(count, settings.bandPixels);
    const regions = {
      reference: region(kernel, "sub-reference", band * 8), target: region(kernel, "sub-target", band * 8),
      referenceMask: region(kernel, "sub-ref-mask", band), targetMask: region(kernel, "sub-target-mask", band),
      targetOut: region(kernel, "sub-target-out", band * 8), diffOut: region(kernel, "sub-diff-out", band * 8),
      state: region(kernel, "sub-state", band), valid: region(kernel, "sub-valid", band),
      referenceValid: region(kernel, "sub-ref-valid", band), targetValid: region(kernel, "sub-target-valid", band),
      counts: region(kernel, "sub-counts", 5 * 4),
    };
    const targetValues = new Float64Array(count);
    const state = new Uint8Array(count);
    const difference = new Float64Array(count);
    const valid = new Uint8Array(count);
    const referenceValid = new Uint8Array(count);
    const targetValid = new Uint8Array(count);
    const counts = { total: count, covered: 0, valid: 0, outside: 0, referenceInvalid: 0, targetInvalid: 0 };
    for (let first = 0; first < count; first += band) {
      const length = Math.min(band, count - first);
      const at = (from) => [from, from + length];
      view(kernel, Float64Array, regions.reference, length).set(reference.subarray(...at(first)));
      view(kernel, Float64Array, regions.target, length).set(target.subarray(...at(first)));
      if (referenceMask) view(kernel, Uint8Array, regions.referenceMask, length).set(referenceMask.subarray(...at(first)));
      if (targetMask) view(kernel, Uint8Array, regions.targetMask, length).set(targetMask.subarray(...at(first)));
      exports.fd_subtract(regions.reference, regions.target, referenceMask ? regions.referenceMask : 0, targetMask ? regions.targetMask : 0, factor, length,
        regions.targetOut, regions.state, regions.diffOut, regions.valid, regions.referenceValid, regions.targetValid, regions.counts);
      targetValues.set(view(kernel, Float64Array, regions.targetOut, length), first);
      difference.set(view(kernel, Float64Array, regions.diffOut, length), first);
      state.set(view(kernel, Uint8Array, regions.state, length), first);
      valid.set(view(kernel, Uint8Array, regions.valid, length), first);
      referenceValid.set(view(kernel, Uint8Array, regions.referenceValid, length), first);
      targetValid.set(view(kernel, Uint8Array, regions.targetValid, length), first);
      const [covered, validCount, outside, referenceBad, targetBad] = view(kernel, Uint32Array, regions.counts, 5);
      counts.covered += covered;
      counts.valid += validCount;
      counts.outside += outside;
      counts.referenceInvalid += referenceBad;
      counts.targetInvalid += targetBad;
    }
    counters.subtract += count;
    return { targetValues, state, difference, valid, referenceValid, targetValid, counts };
  }

  function subtractDirect(input) {
    const mask = (array) => !array || isU8(array);
    const kernel = isF64(input.reference) && isF64(input.target) && mask(input.referenceMask) && mask(input.targetMask) ? pick("subtract", input.reference.length) : null;
    return kernel ? subtractWasm(kernel, input) : subtractJs(input);
  }

  // Var(difference) = Var(reference) + Var(target * factor) and SNR on valid pixels (others NaN); `withVariance` counts the
  // pixels whose variance is usable. targetVariance is the variance BEFORE the factor is applied (factor * factor is applied here).
  function varianceSumJs(referenceVariance, targetVariance, factor, difference, valid) {
    const count = difference.length;
    const variance = new Float64Array(count).fill(NaN);
    const snr = new Float64Array(count).fill(NaN);
    let withVariance = 0;
    for (let index = 0; index < count; index++) {
      if (!valid[index]) continue;
      const sum = referenceVariance[index] + targetVariance[index] * factor * factor;
      if (Number.isFinite(sum) && sum >= 0 && referenceVariance[index] >= 0) {
        variance[index] = sum;
        withVariance++;
        if (sum > 0) snr[index] = difference[index] / Math.sqrt(sum);
      }
    }
    return { variance, snr, withVariance };
  }

  function varianceSum(referenceVariance, targetVariance, factor, difference, valid) {
    const count = difference.length;
    const kernel = isF64(referenceVariance) && isF64(targetVariance) && isF64(difference) && isU8(valid) ? pick("subtract", count) : null;
    if (!kernel) return varianceSumJs(referenceVariance, targetVariance, factor, difference, valid);
    const { exports } = kernel;
    const band = Math.min(count, settings.bandPixels);
    const a = region(kernel, "var-a", band * 8);
    const b = region(kernel, "var-b", band * 8);
    const d = region(kernel, "var-d", band * 8);
    const v = region(kernel, "var-v", band);
    const outVariance = region(kernel, "var-out", band * 8);
    const outSnr = region(kernel, "var-snr", band * 8);
    const variance = new Float64Array(count);
    const snr = new Float64Array(count);
    let withVariance = 0;
    for (let first = 0; first < count; first += band) {
      const length = Math.min(band, count - first);
      view(kernel, Float64Array, a, length).set(referenceVariance.subarray(first, first + length));
      view(kernel, Float64Array, b, length).set(targetVariance.subarray(first, first + length));
      view(kernel, Float64Array, d, length).set(difference.subarray(first, first + length));
      view(kernel, Uint8Array, v, length).set(valid.subarray(first, first + length));
      withVariance += exports.fd_variance_sum(a, b, factor, d, v, length, outVariance, outSnr);
      variance.set(view(kernel, Float64Array, outVariance, length), first);
      snr.set(view(kernel, Float64Array, outSnr, length), first);
    }
    counters.subtract += count;
    return { variance, snr, withVariance };
  }

  // ---- Mosaic accumulation (tools/mosaic-model.js) -------------------------------------------------------------------------------
  // acc = mosaicAccumulator(total, { mode: "mean" | "inverse-variance", withVarianceSum, histogramLength });
  // acc.add(window, factor) with window = { values, variance (or null), state (Diff.status), cols, rows, gridWidth, c0, r0 }
  //   returns { footprint, valid, invalid, noVariance } for that window;
  // acc.finish() returns { values, valid, variance (or null), coverage (Uint16Array), histogram, validCount } and releases memory.
  function mosaicAccumulatorJs(total, { mode, withVarianceSum, histogramLength }) {
    const sums = new Float64Array(total);
    const weights = mode === "inverse-variance" ? new Float64Array(total) : null;
    const varSum = withVarianceSum && mode === "mean" ? new Float64Array(total) : null;
    const varBad = varSum ? new Uint8Array(total) : null;
    const coverage = new Uint16Array(total);
    return {
      engine: "js",
      add({ values, variance, state, cols, rows, gridWidth, c0, r0 }, factor) {
        const tally = { footprint: 0, valid: 0, invalid: 0, noVariance: 0 };
        for (let row = 0; row < rows; row++) {
          for (let column = 0; column < cols; column++) {
            const at = row * cols + column;
            const out = (r0 + row) * gridWidth + c0 + column;
            const s = state[at];
            if (s === 1) continue;
            tally.footprint++;
            const value = values[at] * factor;
            if (s !== 0 || !Number.isFinite(value)) {
              tally.invalid++;
              continue;
            }
            if (mode === "inverse-variance") {
              const v = variance[at] * factor * factor;
              if (!(Number.isFinite(v) && v > 0)) {
                tally.noVariance++;
                continue;
              }
              const weight = 1 / v;
              sums[out] += weight * value;
              weights[out] += weight;
            } else {
              sums[out] += value;
              if (varSum) {
                const v = variance[at] * factor * factor;
                if (Number.isFinite(v) && v >= 0) varSum[out] += v;
                else varBad[out] = 1;
              }
            }
            coverage[out]++;
            tally.valid++;
          }
        }
        return tally;
      },
      finish() {
        const values = new Float64Array(total).fill(NaN);
        const valid = new Uint8Array(total);
        const variance = withVarianceSum ? new Float64Array(total).fill(NaN) : null;
        const histogram = new Array(histogramLength).fill(0);
        let validCount = 0;
        for (let index = 0; index < total; index++) {
          const count = coverage[index];
          histogram[count]++;
          if (!count) continue;
          valid[index] = 1;
          validCount++;
          if (mode === "inverse-variance") {
            values[index] = sums[index] / weights[index];
            variance[index] = 1 / weights[index];
          } else {
            values[index] = sums[index] / count;
            if (variance && !varBad[index]) variance[index] = varSum[index] / (count * count);
          }
        }
        return { values, valid, variance, coverage, histogram, validCount };
      },
    };
  }

  let liveAccumulator = null; // Only one wasm accumulator is alive at a time; starting another releases an abandoned one.

  function mosaicAccumulatorWasm(kernel, total, options) {
    const { mode, withVarianceSum, histogramLength } = options;
    const { exports } = kernel;
    if (liveAccumulator) liveAccumulator();
    const held = [];
    const zeroed = (bytes) => {
      const ptr = exports.an_alloc(bytes);
      new Uint8Array(exports.memory.buffer, ptr, bytes).fill(0);
      held.push({ ptr, bytes });
      return ptr;
    };
    const sums = zeroed(total * 8);
    const weights = mode === "inverse-variance" ? zeroed(total * 8) : 0;
    const varSum = withVarianceSum && mode === "mean" ? zeroed(total * 8) : 0;
    const varBad = varSum ? zeroed(total) : 0;
    const coverage = zeroed(total * 2);
    const counters32 = zeroed(16);
    const dispose = () => {
      release(kernel, ...held.splice(0));
      if (liveAccumulator === dispose) liveAccumulator = null;
    };
    liveAccumulator = dispose;
    return {
      engine: "wasm",
      add({ values, variance, state, cols, rows, gridWidth, c0, r0 }, factor) {
        const count = cols * rows;
        const inValues = region(kernel, "mosaic-values", count * 8);
        const inVariance = region(kernel, "mosaic-variance", count * 8);
        const inState = region(kernel, "mosaic-state", count);
        view(kernel, Float64Array, inValues, count).set(values);
        if (variance) view(kernel, Float64Array, inVariance, count).set(variance);
        view(kernel, Uint8Array, inState, count).set(state);
        view(kernel, Uint32Array, counters32, 4).fill(0);
        exports.fd_mosaic_accumulate(inValues, variance ? inVariance : 0, inState, cols, rows, gridWidth, c0, r0, factor, mode === "inverse-variance" ? 1 : 0,
          sums, weights, varSum, varBad, coverage, counters32);
        const [footprint, valid, invalid, noVariance] = view(kernel, Uint32Array, counters32, 4);
        return { footprint, valid, invalid, noVariance };
      },
      finish() {
        const values = region(kernel, "mosaic-out-values", total * 8);
        const valid = region(kernel, "mosaic-out-valid", total);
        const variance = withVarianceSum ? region(kernel, "mosaic-out-variance", total * 8) : 0;
        const histogram = zeroed(histogramLength * 4);
        const validCount = exports.fd_mosaic_combine(sums, weights, varSum, varBad, coverage, total, mode === "inverse-variance" ? 1 : 0, values, valid, variance, histogram, histogramLength);
        const result = {
          values: view(kernel, Float64Array, values, total).slice(),
          valid: view(kernel, Uint8Array, valid, total).slice(),
          variance: withVarianceSum ? view(kernel, Float64Array, variance, total).slice() : null,
          coverage: view(kernel, Uint16Array, coverage, total).slice(),
          histogram: Array.from(view(kernel, Uint32Array, histogram, histogramLength)),
          validCount,
        };
        counters.mosaic += total;
        dispose();
        return result;
      },
    };
  }

  function mosaicAccumulator(total, options) {
    const kernel = pick("mosaic", total);
    return kernel ? mosaicAccumulatorWasm(kernel, total, options) : mosaicAccumulatorJs(total, options);
  }

  const api = {
    settings, counters,
    fillGray, fillDiverging, symmetricLimit, orderStatistics, moments, percentileClip, sigmaClippedStats,
    subtractDirect, varianceSum, mosaicAccumulator,
    js: { fillGray: fillGrayJs, fillDiverging: fillDivergingJs, subtractDirect: subtractJs, varianceSum: varianceSumJs },
  };
  root.AstroNotPixels = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);
