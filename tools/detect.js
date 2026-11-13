// Source detection model for AstroNot (the computation behind the Source Detection workspace).
//
// UI-independent: no DOM access. Loads as a classic browser script (global `AstroNotDetect`) and as a CommonJS module.
// It needs no other file: the caller passes the calibrated pixel array and, when it has one, a WCS object made by
// tools/wcs.js (createWcs(...).wcs) whose pixelToSky(x, y) gives RA/Dec in degrees (ICRS).
//
// METHOD (one clear method: connected pixel segments, optionally split at separate peaks)
//   1. Valid pixels: finite calibrated values. NaN, BLANK (already NaN after tools/fits.js) and infinite values are invalid;
//      zero is a valid value.
//   2. Background and noise, from the valid pixels only:
//        global   one sigma-clipped median (3 sigma, up to 10 passes) and sigma = 1.4826 x MAD of the clipped sample;
//        mesh     the same statistics in boxes of `meshSize` pixels, 3x3 median-filtered, bilinearly interpolated;
//        variance sigma = sqrt(VARIANCE image) pixel by pixel (only when the caller passes one; background stays measured).
//      Pixels whose noise is zero or unknown cannot be tested against a threshold in sigma and are left out.
//   3. Detection image: D = value - background. Optionally smoothed with a Gaussian of the chosen FWHM by NORMALIZED
//      convolution over the valid pixels (so masked pixels neither bias nor shrink the result). The matching noise is
//      propagated exactly for independent pixels: sigma_f^2 = sum(w^2 sigma^2) / (sum w)^2. Pixels where less than 30 % of
//      the kernel falls on valid pixels are not tested.
//   4. Threshold: pixel is "above" when Df > k x sigma_f (mode "sigma") or Df > level (mode "absolute", image units).
//      Above-threshold pixels are grouped into 8-connected segments; segments with fewer than `minPixels` pixels are dropped.
//   5. Deblending: inside a segment, pixels are flooded from the highest value down. Two peaks stay separate when the
//      valley between them is lower than the lower peak by at least valleySigma x sigma_f AND by at least 10 % of that peak's
//      height, and each part has at least `minPixels` pixels above the valley. Otherwise the lower peak is part of the
//      higher one. With deblending off the segment stays one source but is flagged "blended" when it holds such peaks.
//   6. Measurements use the UNSMOOTHED background-subtracted values D inside the segment:
//        x, y     flux-weighted centroid with weights max(D, 0); falls back to the peak pixel when all weights are zero;
//        area     number of segment pixels;           peak  largest D in the segment;
//        flux_sum sum of D over the segment, in the image unit (for surface brightness such as MJy/sr it is NOT a flux
//                 density; multiply by the pixel solid angle yourself if you need one).
//
// PIXEL CONVENTION: positions are FITS pixel numbers: continuous, 1-based, the centre of the first array element is (1, 1).
// Arrays are in FITS order: index = (y - 1) * width + (x - 1), row 0 is the bottom row. Display colours, contrast and zoom
// are never an input.
//
// FLAGS: edge (touches the image border), masked_neighbour (a neighbouring pixel is NaN, BLANK or unusable), saturated (a
// pixel reaches the saturation level, only when one is known) and blended (a second significant peak shares the segment).
//
// Detected candidates are NOT catalog identifications.
(function (root) {
  "use strict";

  const limits = {
    maxPixels: 4194304, // same limit as tools/fits.js
    maxSources: 2000,
    minValidPixels: 100,
    minCoverage: 0.3,
    sampleLimit: 262144,
    clipSigma: 3,
    clipIterations: 10,
    minCellPixels: 25,
    minCellFraction: 0.5,
    relativeValley: 0.1,
    maxSmoothFwhm: 8,
    wasmMinPixels: 0, // measured: the kernel was faster at every size from 16 x 16 to 4,096 x 4,096 pixels, so the limit is not needed; raise it to send small images to JavaScript
  };

  // ---- Optional WebAssembly kernel -----------------------------------------------------------------------------------
  // rust/crates/detect, loaded by the page with AstroNotWasm.load("detect") and handed over with useKernel(). Every loop it
  // replaces is also written in JavaScript below and gives the same numbers (the tests compare them bit for bit), so
  // without a kernel, or for a small image, or when the kernel throws, the JavaScript code runs.
  let kernel = null;

  function useKernel(next) {
    kernel = next && next.exports && typeof next.exports.det_valid === "function" && typeof next.alloc === "function" ? next : null;
    return kernel !== null;
  }

  // hooks.engine: "js" forces JavaScript, "wasm" forces the kernel (when there is one), anything else picks by image size.
  function engineFor(total, hooks) {
    if (!kernel || (hooks && hooks.engine === "js")) return null;
    if (hooks && hooks.engine === "wasm") return kernel;
    return total >= limits.wasmMinPixels ? kernel : null;
  }

  // Buffers that live in WebAssembly memory. Memory can grow during any kernel call, which detaches earlier views, so
  // view() makes a new typed array each time and callers re-fetch after a call.
  function openSession(wk) {
    const regions = [];
    return {
      exports: wk.exports,
      region(Type, length) {
        const region = wk.alloc(Type, length);
        regions.push(region);
        return region;
      },
      view(region) {
        return new region.Type(wk.exports.memory.buffer, region.ptr, region.length);
      },
      release(region) {
        const at = regions.indexOf(region);
        if (at >= 0) regions.splice(at, 1);
        wk.free(region);
      },
      close() {
        wk.free(...regions);
        regions.length = 0;
      },
    };
  }

  const flagNames = ["edge", "masked_neighbour", "saturated", "blended"];
  const flagText = {
    edge: "touches the image border",
    masked_neighbour: "next to NaN, BLANK or unusable pixels",
    saturated: "reaches the saturation level",
    blended: "shares its segment with another significant peak",
  };

  const defaultParams = {
    background: "global", // "global" | "mesh"
    meshSize: 32,
    noise: "measured", // "measured" | "variance"
    thresholdMode: "sigma", // "sigma" | "absolute"
    threshold: 3,
    minPixels: 5,
    smoothFwhm: 0, // pixels; 0 = no smoothing
    deblend: true,
    valleySigma: 3,
    saturation: null, // image units, or null when unknown
  };

  const madToSigma = 1.482602218505602;
  const fwhmToSigma = 1 / 2.3548200450309493;
  const cancelSignal = { cancelled: true };

  function isNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  // ---- Parameters ----------------------------------------------------------------------------------------------------
  function toNumber(value) {
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "") return Number(value.trim());
    return NaN;
  }

  // Returns { ok, params, errors }. Strings from text inputs are accepted. Unknown keys are ignored.
  function validateParams(raw = {}) {
    const params = { ...defaultParams };
    const errors = [];
    const given = (key) => raw[key] !== undefined && raw[key] !== null && raw[key] !== "";
    const number = (key, label, ok, requirement) => {
      if (!given(key)) return;
      const value = toNumber(raw[key]);
      if (!isNumber(value) || !ok(value)) errors.push(label + " must be " + requirement + ".");
      else params[key] = value;
    };
    if (given("background")) {
      if (raw.background === "global" || raw.background === "mesh") params.background = raw.background;
      else errors.push("Background must be global or mesh.");
    }
    if (given("noise")) {
      if (raw.noise === "measured" || raw.noise === "variance") params.noise = raw.noise;
      else errors.push("Noise must be measured or variance.");
    }
    if (given("thresholdMode")) {
      if (raw.thresholdMode === "sigma" || raw.thresholdMode === "absolute") params.thresholdMode = raw.thresholdMode;
      else errors.push("Threshold mode must be sigma or absolute.");
    }
    number("meshSize", "Mesh box size", (value) => Number.isInteger(value) && value >= 8 && value <= 1024, "a whole number of pixels from 8 to 1024");
    number("threshold", "Threshold", (value) => value > 0 && value <= 1e12, "a number greater than zero");
    if (params.thresholdMode === "sigma" && params.threshold > 1000) errors.push("A threshold above 1000 σ detects nothing; enter a value from 0.1 to 1000.");
    number("minPixels", "Minimum connected pixels", (value) => Number.isInteger(value) && value >= 1 && value <= 100000, "a whole number from 1 to 100,000");
    number("smoothFwhm", "Smoothing FWHM", (value) => value === 0 || (value >= 1 && value <= limits.maxSmoothFwhm), "0 (no smoothing) or from 1 to " + limits.maxSmoothFwhm + " pixels");
    number("valleySigma", "Valley depth", (value) => value >= 0 && value <= 1000, "a number from 0 to 1000");
    if (given("saturation")) {
      const value = toNumber(raw.saturation);
      if (!isNumber(value)) errors.push("The saturation level must be a number or empty.");
      else params.saturation = value;
    }
    if (raw.deblend !== undefined) params.deblend = Boolean(raw.deblend);
    return { ok: errors.length === 0, params, errors };
  }

  // ---- Robust statistics ---------------------------------------------------------------------------------------------
  function lowerBound(sorted, lo, hi, value) {
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function upperBound(sorted, lo, hi, value) {
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] <= value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function medianOfSorted(sorted, lo, hi) {
    const n = hi - lo;
    if (n <= 0) return NaN;
    const mid = lo + (n >> 1);
    return n & 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // Median of |x - median| over sorted[lo, hi), by merging the two sides of the median (no second sort).
  function madOfSorted(sorted, lo, hi, median) {
    const n = hi - lo;
    if (n <= 0) return NaN;
    let right = lowerBound(sorted, lo, hi, median);
    let left = right - 1;
    const first = (n - 1) >> 1;
    const second = n >> 1;
    let a = 0;
    let b = 0;
    for (let k = 0; k <= second; k++) {
      const dl = left >= lo ? median - sorted[left] : Infinity;
      const dr = right < hi ? sorted[right] - median : Infinity;
      let d;
      if (dl <= dr) { d = dl; left--; } else { d = dr; right++; }
      if (k === first) a = d;
      if (k === second) b = d;
    }
    return (a + b) / 2;
  }

  // Sigma-clipped median and MAD-based sigma of an ascending-sorted Float64Array.
  function clippedStats(sorted) {
    let lo = 0;
    let hi = sorted.length;
    let median = NaN;
    let sigma = NaN;
    for (let pass = 0; pass <= limits.clipIterations; pass++) {
      if (hi - lo < 1) break;
      median = medianOfSorted(sorted, lo, hi);
      sigma = madToSigma * madOfSorted(sorted, lo, hi, median);
      if (!(sigma > 0) || pass === limits.clipIterations) break;
      const newLo = lowerBound(sorted, lo, hi, median - limits.clipSigma * sigma);
      const newHi = upperBound(sorted, lo, hi, median + limits.clipSigma * sigma);
      if (newLo === lo && newHi === hi) break;
      lo = newLo;
      hi = newHi;
    }
    return { median, sigma, count: hi - lo, total: sorted.length };
  }

  function statsOfValues(array) {
    const sorted = Float64Array.from(array);
    sorted.sort();
    return clippedStats(sorted);
  }

  // Sigma-clipped median and sigma of the valid pixels of `values` (a regular sample when there are many).
  function globalStats(values, valid, validCount) {
    const stride = Math.max(1, Math.ceil(validCount / limits.sampleLimit));
    const sample = new Float64Array(Math.ceil(validCount / stride));
    let n = 0;
    let seen = 0;
    for (let i = 0; i < values.length; i++) {
      if (!valid[i]) continue;
      if (seen++ % stride === 0) sample[n++] = values[i];
    }
    return statsOfValues(sample.subarray(0, n));
  }

  function sampleOf(values, use, limit = 65536) {
    const out = new Float64Array(Math.ceil(values.length / Math.max(1, Math.ceil(values.length / limit))));
    let n = 0;
    const stride = Math.max(1, Math.ceil(values.length / limit));
    for (let i = 0; i < values.length; i += stride) if (!use || use[i]) out[n++] = values[i];
    return out.subarray(0, n);
  }

  function summarize(samples) {
    const kept = new Float64Array(samples.length);
    let n = 0;
    for (let i = 0; i < samples.length; i++) if (Number.isFinite(samples[i])) kept[n++] = samples[i];
    const finite = kept.subarray(0, n).sort();
    if (!finite.length) return null;
    return { median: medianOfSorted(finite, 0, finite.length), min: finite[0], max: finite[finite.length - 1] };
  }

  // ---- Pacing, progress and cancellation -----------------------------------------------------------------------------
  function makePacer(hooks) {
    const tick = hooks.tick || (() => Promise.resolve());
    const cancelled = hooks.cancelled || (() => false);
    let work = 0;
    return {
      async step(units = 1) {
        work += units;
        if (work < 600000) return;
        work = 0;
        if (cancelled()) throw cancelSignal;
        await tick();
        if (cancelled()) throw cancelSignal;
      },
      async stage(name, fraction) {
        work = 0;
        if (cancelled()) throw cancelSignal;
        if (hooks.progress) hooks.progress(name, fraction);
        await tick();
        if (cancelled()) throw cancelSignal;
      },
    };
  }

  // ---- Mesh background -----------------------------------------------------------------------------------------------
  function medianFilterGrid(grid, nx, ny) {
    const out = new Float64Array(grid.length);
    const window = [];
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        window.length = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue;
            const value = grid[yy * nx + xx];
            if (Number.isFinite(value)) window.push(value);
          }
        }
        window.sort((a, b) => a - b);
        out[y * nx + x] = window.length ? medianOfSorted(window, 0, window.length) : NaN;
      }
    }
    return out;
  }

  // Replace missing cells by the mean of their finite neighbours, repeatedly. Returns false when nothing is finite.
  function fillGrid(grid, nx, ny) {
    for (let pass = 0; pass < nx + ny; pass++) {
      let missing = 0;
      const next = Float64Array.from(grid);
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          if (Number.isFinite(grid[y * nx + x])) continue;
          let sum = 0;
          let count = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              const yy = y + dy;
              if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue;
              const value = grid[yy * nx + xx];
              if (Number.isFinite(value)) { sum += value; count++; }
            }
          }
          if (count) next[y * nx + x] = sum / count;
          else missing++;
        }
      }
      grid.set(next);
      if (!missing) return true;
    }
    return grid.some(Number.isFinite);
  }

  // Interpolation weights between box centres. `t` extrapolates linearly in the half box at each border (so a gradient
  // continues to the image edge); `clamped` stays inside [0, 1] and is used for the noise, which must not go negative.
  function interpolationAxis(centres, size) {
    const index0 = new Int32Array(size);
    const index1 = new Int32Array(size);
    const t = new Float64Array(size);
    const clamped = new Float64Array(size);
    const last = centres.length - 1;
    let k = 0;
    for (let p = 0; p < size; p++) {
      if (last === 0) { index0[p] = index1[p] = 0; continue; }
      while (k < last - 1 && p >= centres[k + 1]) k++;
      index0[p] = k;
      index1[p] = k + 1;
      t[p] = (p - centres[k]) / (centres[k + 1] - centres[k]);
      clamped[p] = Math.min(1, Math.max(0, t[p]));
    }
    return { index0, index1, t, clamped };
  }

  // session: { S, R } when the kernel does the box statistics and the interpolation (the result then lives in R.background and
  // R.sigmaMap, in WebAssembly memory), otherwise null.
  async function meshEstimate(values, valid, width, height, box, fallback, pace, session) {
    const nx = Math.ceil(width / box);
    const ny = Math.ceil(height / box);
    let levels = new Float64Array(nx * ny).fill(NaN);
    let sigmas = new Float64Array(nx * ny).fill(NaN);
    const centresX = [];
    const centresY = [];
    let usedCells = 0;
    if (session) {
      const { S, R } = session;
      for (let cy = 0; cy < ny; cy++) centresY.push((cy * box + Math.min(height, cy * box + box) - 1) / 2);
      for (let cx = 0; cx < nx; cx++) centresX.push((cx * box + Math.min(width, cx * box + box) - 1) / 2);
      const levelRegion = S.region(Float64Array, nx * ny);
      const sigmaRegion = S.region(Float64Array, nx * ny);
      usedCells = S.exports.det_mesh_cells(R.values.ptr, R.valid.ptr, width, height, box, levelRegion.ptr, sigmaRegion.ptr);
      levels = Float64Array.from(S.view(levelRegion));
      sigmas = Float64Array.from(S.view(sigmaRegion));
      S.release(levelRegion);
      S.release(sigmaRegion);
    } else {
      const buffer = new Float64Array(box * box);
      for (let cy = 0; cy < ny; cy++) {
        const y0 = cy * box;
        const y1 = Math.min(height, y0 + box);
        centresY.push((y0 + y1 - 1) / 2);
        for (let cx = 0; cx < nx; cx++) {
          const x0 = cx * box;
          const x1 = Math.min(width, x0 + box);
          if (cy === 0) centresX.push((x0 + x1 - 1) / 2);
          let n = 0;
          for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) if (valid[y * width + x]) buffer[n++] = values[y * width + x];
          }
          await pace.step((x1 - x0) * (y1 - y0));
          const area = (x1 - x0) * (y1 - y0);
          if (n < Math.max(limits.minCellPixels, limits.minCellFraction * area)) continue;
          const sub = buffer.subarray(0, n);
          sub.sort();
          const stats = clippedStats(sub);
          levels[cy * nx + cx] = stats.median;
          sigmas[cy * nx + cx] = stats.sigma;
          usedCells++;
        }
      }
    }
    if (!usedCells) {
      levels.fill(fallback.median);
      sigmas.fill(fallback.sigma);
    } else {
      fillGrid(levels, nx, ny);
      fillGrid(sigmas, nx, ny);
    }
    let gridLevels = levels;
    let gridSigmas = sigmas;
    if (nx >= 3 && ny >= 3) {
      gridLevels = medianFilterGrid(levels, nx, ny);
      gridSigmas = medianFilterGrid(sigmas, nx, ny);
    }
    const ax = interpolationAxis(centresX, width);
    const ay = interpolationAxis(centresY, height);
    if (session) {
      const { S, R } = session;
      const inputs = [gridLevels, gridSigmas, ax.index0, ax.index1, ax.t, ax.clamped, ay.index0, ay.index1, ay.t, ay.clamped].map((array) => {
        const region = S.region(array.constructor, array.length);
        S.view(region).set(array);
        return region;
      });
      const [gl, gs, xi0, xi1, xt, xc, yi0, yi1, yt, yc] = inputs;
      S.exports.det_mesh_interp(gl.ptr, gs.ptr, nx, ny, xi0.ptr, xi1.ptr, xt.ptr, xc.ptr, width, yi0.ptr, yi1.ptr, yt.ptr, yc.ptr, height, R.background.ptr, R.sigmaMap.ptr);
      for (const region of inputs) S.release(region);
      return { background: null, sigma: null, cells: nx * ny, usedCells, nx, ny };
    }
    const background = new Float64Array(width * height);
    const sigma = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      const ty = ay.t[y];
      const sy = ay.clamped[y];
      const r0 = ay.index0[y] * nx;
      const r1 = ay.index1[y] * nx;
      for (let x = 0; x < width; x++) {
        const tx = ax.t[x];
        const sx = ax.clamped[x];
        const a = ax.index0[x];
        const b = ax.index1[x];
        const l00 = gridLevels[r0 + a], l01 = gridLevels[r0 + b], l10 = gridLevels[r1 + a], l11 = gridLevels[r1 + b];
        background[row + x] = (l00 * (1 - tx) + l01 * tx) * (1 - ty) + (l10 * (1 - tx) + l11 * tx) * ty;
        const s00 = gridSigmas[r0 + a], s01 = gridSigmas[r0 + b], s10 = gridSigmas[r1 + a], s11 = gridSigmas[r1 + b];
        sigma[row + x] = (s00 * (1 - sx) + s01 * sx) * (1 - sy) + (s10 * (1 - sx) + s11 * sx) * sy;
      }
      await pace.step(width * 4);
    }
    return { background, sigma, cells: nx * ny, usedCells, nx, ny };
  }

  // ---- Smoothing (normalized convolution) ----------------------------------------------------------------------------
  function gaussianKernel(fwhm) {
    const sigma = fwhm * fwhmToSigma;
    const half = Math.max(1, Math.ceil(3 * sigma));
    const kernel = new Float64Array(2 * half + 1);
    let sum = 0;
    for (let k = -half; k <= half; k++) {
      kernel[k + half] = Math.exp(-(k * k) / (2 * sigma * sigma));
      sum += kernel[k + half];
    }
    for (let k = 0; k < kernel.length; k++) kernel[k] /= sum;
    return kernel;
  }

  // out = kernel (x) kernel (x) src, with missing pixels outside the image counting as zero weight. tmp is scratch.
  async function convolve(src, width, height, kernel, tmp, out, pace) {
    const half = (kernel.length - 1) / 2;
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const a = Math.max(0, x - half);
        const b = Math.min(width - 1, x + half);
        let sum = 0;
        for (let xx = a; xx <= b; xx++) sum += kernel[xx - x + half] * src[row + xx];
        tmp[row + x] = sum;
      }
      await pace.step(width * kernel.length);
    }
    const accumulator = new Float64Array(width);
    for (let y = 0; y < height; y++) {
      accumulator.fill(0);
      const a = Math.max(0, y - half);
      const b = Math.min(height - 1, y + half);
      for (let yy = a; yy <= b; yy++) {
        const weight = kernel[yy - y + half];
        const row = yy * width;
        for (let x = 0; x < width; x++) accumulator[x] += weight * tmp[row + x];
      }
      const row = y * width;
      for (let x = 0; x < width; x++) out[row + x] = accumulator[x];
      await pace.step(width * kernel.length);
    }
  }

  // ---- Segmentation --------------------------------------------------------------------------------------------------
  const neighbours = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

  // 8-connected components of the non-zero entries of `mask` (which is consumed). Returns { order, ranges } where each
  // range [start, end) of `order` lists the flat indices of one segment in discovery order.
  async function connectedComponents(mask, width, height, count, pace) {
    const order = new Int32Array(count);
    const ranges = [];
    let length = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const seed = y * width + x;
        if (!mask[seed]) continue;
        const start = length;
        order[length++] = seed;
        mask[seed] = 0;
        for (let head = start; head < length; head++) {
          const p = order[head];
          const px = p % width;
          const py = (p - px) / width;
          for (let n = 0; n < 8; n++) {
            const xx = px + neighbours[n][0];
            const yy = py + neighbours[n][1];
            if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
            const q = yy * width + xx;
            if (mask[q]) {
              mask[q] = 0;
              order[length++] = q;
            }
          }
        }
        ranges.push([start, length]);
      }
      await pace.step(width);
    }
    return { order, ranges };
  }

  // Splits one segment (flat indices) at significant separate peaks. `df` is the detection image, `sigmaAt(p)` the noise of
  // the detection image. Returns { groups: [Int32Array...] } ordered by peak height; one group means no split.
  function analyseSegment(pixels, width, height, df, sigmaAt, params, branchOf) {
    const sorted = Array.from(pixels).sort((a, b) => (df[b] - df[a]) || (a - b));
    const parent = [0];
    const peak = [0];
    const size = [0];
    const find = (id) => {
      while (parent[id] !== id) {
        parent[id] = parent[parent[id]];
        id = parent[id];
      }
      return id;
    };
    for (const p of sorted) {
      const value = df[p];
      const px = p % width;
      const py = (p - px) / width;
      let bestValue = -Infinity;
      let best = 0;
      const seen = [];
      for (let n = 0; n < 8; n++) {
        const xx = px + neighbours[n][0];
        const yy = py + neighbours[n][1];
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
        const q = yy * width + xx;
        const id = branchOf[q];
        if (!id) continue;
        const rootId = find(id);
        if (!seen.includes(rootId)) seen.push(rootId);
        if (df[q] > bestValue) {
          bestValue = df[q];
          best = rootId;
        }
      }
      if (!seen.length) {
        const id = parent.length;
        parent.push(id);
        peak.push(value);
        size.push(1);
        branchOf[p] = id;
        continue;
      }
      let dominant = seen[0];
      for (const id of seen) if (peak[id] > peak[dominant] || (peak[id] === peak[dominant] && id < dominant)) dominant = id;
      const noise = sigmaAt(p);
      for (const id of seen) {
        if (id === dominant) continue;
        const prominence = peak[id] - value;
        const needed = Math.max(params.valleySigma * (noise > 0 ? noise : 0), limits.relativeValley * peak[id]);
        const separate = size[id] >= params.minPixels && size[dominant] >= params.minPixels && prominence >= needed;
        if (!separate) {
          parent[id] = dominant;
          size[dominant] += size[id];
        }
      }
      const target = find(best);
      branchOf[p] = target;
      size[target]++;
    }
    const groupOf = new Map();
    for (const p of sorted) {
      const id = find(branchOf[p]);
      if (!groupOf.has(id)) groupOf.set(id, []);
      groupOf.get(id).push(p);
    }
    const groups = [...groupOf.entries()].sort((a, b) => peak[b[0]] - peak[a[0]]).map((entry) => Int32Array.from(entry[1]));
    return { groups };
  }

  // ---- Units ---------------------------------------------------------------------------------------------------------
  // Does `varianceUnit` describe the square of `unit`? Accepts "MJy2 / sr2", "(MJy/sr)^2", "MJy^2/sr^2" and "MJy2/sr2".
  // A missing variance unit is accepted and reported as assumed. Returns { ok, assumed, reason }.
  function varianceUnitCheck(varianceUnit, unit) {
    const clean = (text) => typeof text === "string" ? text.replace(/\s+/g, "").replace(/\*\*/g, "^") : "";
    const v = clean(varianceUnit);
    const u = clean(unit);
    if (!v) return { ok: true, assumed: true, reason: "The VARIANCE image has no BUNIT; it is assumed to be the square of the image unit." };
    if (!u) return { ok: false, assumed: false, reason: "The image has no BUNIT, so the VARIANCE unit " + v + " cannot be checked." };
    const squared = (text) => text.replace(/\^2/g, "2"); // "MJy^2/sr^2" -> "MJy2/sr2"
    const [num, den] = u.split("/");
    const expanded = new Set([squared(v)]);
    const candidates = new Set(["(" + u + ")2", "(" + u + ")*(" + u + ")", u + "2"]);
    if (num !== undefined) candidates.add(num + "2" + (den !== undefined ? "/" + den + "2" : ""));
    for (const candidate of candidates) if (expanded.has(squared(candidate))) return { ok: true, assumed: false, reason: "" };
    return { ok: false, assumed: false, reason: "The VARIANCE unit " + v + " is not the square of the image unit " + u + "." };
  }

  // ---- Detection -----------------------------------------------------------------------------------------------------
  function fail(code, reason, params) {
    return { ok: false, code, reason, params: params ?? null };
  }

  function pad(number) {
    return "S" + String(number).padStart(3, "0");
  }

  // image: { width, height, values: Float64Array (NaN invalid), variance?: Float64Array, wcs?: { pixelToSky }, unit? }
  // hooks: { tick(): Promise, cancelled(): boolean, progress(stage, fraction) }, all optional.
  async function detectSources(image, rawParams = {}, hooks = {}) {
    const checked = validateParams(rawParams);
    if (!checked.ok) return fail("bad-parameters", checked.errors.join(" "), checked.params);
    const params = checked.params;
    const { width, height, values } = image;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      return fail("bad-image", "The image size is not valid.", params);
    }
    if (width * height > limits.maxPixels) {
      return fail("too-large", "This image has " + (width * height).toLocaleString("en-US") + " pixels; Source Detection reads at most " + limits.maxPixels.toLocaleString("en-US") + ".", params);
    }
    if (!values || values.length !== width * height) {
      return fail("bad-image", "The image array does not match its width and height.", params);
    }
    if (params.noise === "variance" && !(image.variance && image.variance.length === values.length)) {
      return fail("no-variance", "Noise from a VARIANCE image was requested, but the file has no usable VARIANCE image of this size.", params);
    }
    const pace = makePacer(hooks);
    const started = typeof performance === "object" ? performance.now() : Date.now();
    try {
      const wk = engineFor(width * height, hooks);
      if (wk) {
        try {
          return await run(image, params, pace, started, wk);
        } catch (error) {
          if (error === cancelSignal) throw error;
          // The kernel failed (for example no memory for it): the JavaScript code below gives the same result.
        }
      }
      return await run(image, params, pace, started, null);
    } catch (error) {
      if (error === cancelSignal) return fail("cancelled", "The run was replaced by a newer one.", params);
      throw error;
    }
  }

  // wk: the WebAssembly kernel to use, or null for the JavaScript code.
  async function run(image, params, pace, started, wk) {
    const S = wk ? openSession(wk) : null;
    try {
      return await runStages(image, params, pace, started, S);
    } finally {
      if (S) S.close();
    }
  }

  async function runStages(image, params, pace, started, S) {
    const { width, height, values } = image;
    const total = width * height;
    const warnings = [];
    const notes = [];
    // With a session the big arrays below are views of WebAssembly memory (regions in R). A kernel call can move that
    // memory, so refresh() re-creates every view after each call and before the next use.
    const R = {};
    let valid, background, sigmaMap, use, df, sigf, coverage, testable, mask;
    const refresh = () => {
      if (!S) return;
      if (R.valid) valid = S.view(R.valid);
      if (R.background) background = S.view(R.background);
      if (R.sigmaMap) sigmaMap = S.view(R.sigmaMap);
      if (R.use) use = S.view(R.use);
      if (R.df) df = S.view(R.df);
      if (R.sigf) sigf = S.view(R.sigf);
      if (R.coverage) coverage = S.view(R.coverage);
      if (R.testable) testable = S.view(R.testable);
      if (R.mask) mask = S.view(R.mask);
    };
    const scalars = S ? S.region(Float64Array, 8) : null;

    // 1. Valid pixels
    await pace.stage("Reading pixel values…", 0.02);
    let validCount = 0;
    if (S) {
      R.values = S.region(Float64Array, total);
      R.valid = S.region(Uint8Array, total);
      S.view(R.values).set(values);
      validCount = S.exports.det_valid(R.values.ptr, R.valid.ptr, total);
      refresh();
    } else {
      valid = new Uint8Array(total);
      for (let i = 0; i < total; i++) {
        if (Number.isFinite(values[i])) {
          valid[i] = 1;
          validCount++;
        }
      }
    }
    const invalidCount = total - validCount;
    if (validCount === 0) return fail("too-few-pixels", "The image has no valid pixels: every value is NaN, BLANK or infinite.", params);
    if (validCount < limits.minValidPixels) {
      return fail("too-few-pixels", "Only " + validCount + " valid pixels are left (at least " + limits.minValidPixels + " are needed), so background and noise cannot be estimated.", params);
    }
    if (invalidCount > total / 2) warnings.push(Math.round(100 * invalidCount / total) + "% of the pixels are NaN, BLANK or infinite. Background and noise come from the remaining " + validCount.toLocaleString("en-US") + " pixels.");

    // 2. Background and noise
    await pace.stage("Estimating background and noise…", 0.1);
    let global;
    if (S) {
      S.exports.det_global_stats(R.values.ptr, R.valid.ptr, total, validCount, scalars.ptr);
      const out = S.view(scalars);
      global = { median: out[0], sigma: out[1], count: out[2], total: out[3] };
    } else {
      global = globalStats(values, valid, validCount);
    }
    if (global.total < 1000) warnings.push("Background and noise are estimated from only " + global.total + " pixels, so they are uncertain.");
    // sigmaMap: Float32Array of per-pixel noise (before smoothing)
    let backgroundText;
    let mesh = null;
    const meshUseful = params.background === "mesh" && params.meshSize < Math.max(width, height);
    if (S) {
      R.background = S.region(Float64Array, total);
      R.sigmaMap = S.region(Float32Array, total);
    }
    if (meshUseful) {
      mesh = await meshEstimate(values, valid, width, height, params.meshSize, global, pace, S ? { S, R } : null);
      if (S) refresh();
      else {
        background = mesh.background;
        sigmaMap = mesh.sigma;
      }
      backgroundText = "Mesh of " + mesh.nx + " × " + mesh.ny + " boxes of " + params.meshSize + " pixels: sigma-clipped median (3σ, up to 10 passes) in each box, 3 × 3 median filter, bilinear interpolation" + (mesh.usedCells < mesh.cells ? ". " + (mesh.cells - mesh.usedCells) + " of " + mesh.cells + " boxes had too few valid pixels and were filled from their neighbours" : "");
      if (mesh.usedCells < mesh.cells / 2) warnings.push("More than half of the mesh boxes have too few valid pixels, so the background is partly extrapolated.");
    } else {
      if (S) refresh();
      else {
        background = new Float64Array(total);
        sigmaMap = new Float32Array(total);
      }
      background.fill(global.median);
      sigmaMap.fill(global.sigma);
      backgroundText = "One value for the whole image: sigma-clipped median (3σ, up to 10 passes) of " + global.total.toLocaleString("en-US") + " valid pixels";
      if (params.background === "mesh") notes.push("The mesh box (" + params.meshSize + " pixels) is not smaller than the image, so one global value is used.");
    }
    const measuredSigma = summarize(sampleOf(sigmaMap, valid));

    let noiseText;
    let varianceSigma = null;
    if (params.noise === "variance") {
      let usable = 0;
      if (S) {
        const varianceRegion = S.region(Float64Array, total);
        S.view(varianceRegion).set(image.variance);
        usable = S.exports.det_variance_sigma(R.valid.ptr, varianceRegion.ptr, R.sigmaMap.ptr, total);
        S.release(varianceRegion);
        refresh();
      } else {
        for (let i = 0; i < total; i++) {
          const v = image.variance[i];
          if (valid[i] && Number.isFinite(v) && v > 0) {
            sigmaMap[i] = Math.sqrt(v);
            usable++;
          } else {
            sigmaMap[i] = NaN;
          }
        }
      }
      if (usable === 0) return fail("no-noise", "The VARIANCE image has no positive finite value at any valid pixel, so it cannot give the noise.", params);
      varianceSigma = summarize(sampleOf(sigmaMap, valid));
      noiseText = "From the VARIANCE image: σ = √variance pixel by pixel (" + usable.toLocaleString("en-US") + " of " + validCount.toLocaleString("en-US") + " valid pixels have a positive variance)";
      if (usable < validCount) warnings.push((validCount - usable).toLocaleString("en-US") + " valid pixels have zero, negative or non-finite variance and are not tested.");
      if (measuredSigma && measuredSigma.median > 0 && varianceSigma) {
        const ratio = varianceSigma.median / measuredSigma.median;
        if (ratio < 0.5 || ratio > 2) warnings.push("The median σ from the VARIANCE image (" + varianceSigma.median.toPrecision(3) + ") differs from the scatter measured in the pixels (" + measuredSigma.median.toPrecision(3) + ") by a factor of " + (ratio > 1 ? ratio : 1 / ratio).toFixed(1) + ", so the VARIANCE image may not describe the real noise of this image (correlated noise, structure counted as signal, or different units).");
      }
    } else {
      noiseText = (meshUseful ? "Measured in each mesh box" : "Measured in the image") + ": σ = 1.4826 × MAD of the clipped sample";
    }

    // Usable pixels: valid, and (for a threshold in sigma) a positive finite noise.
    const sigmaMode = params.thresholdMode === "sigma";
    let useCount = 0;
    let zeroNoise = 0;
    if (S) {
      R.use = S.region(Uint8Array, total);
      S.exports.det_use_mask(R.valid.ptr, R.sigmaMap.ptr, R.use.ptr, total, sigmaMode ? 1 : 0, scalars.ptr);
      const out = S.view(scalars);
      useCount = out[0];
      zeroNoise = out[1];
      refresh();
    } else {
      use = new Uint8Array(total);
      for (let i = 0; i < total; i++) {
        if (!valid[i]) continue;
        const s = sigmaMap[i];
        if (sigmaMode && !(s > 0 && Number.isFinite(s))) {
          zeroNoise++;
          continue;
        }
        use[i] = 1;
        useCount++;
      }
    }
    if (useCount === 0) {
      return fail("no-noise", params.noise === "variance"
        ? "No valid pixel has a positive noise, so a threshold in σ has no meaning."
        : "The noise of this image is zero: the sigma-clipped scatter (1.4826 × MAD) of the background is 0, as in a noise-free or heavily quantised image. A threshold in σ has no meaning here. Choose an absolute threshold in image units instead.", params);
    }
    if (zeroNoise > 0 && params.noise !== "variance") warnings.push(zeroNoise.toLocaleString("en-US") + " valid pixels lie where the measured noise is zero and are not tested.");
    if (!sigmaMode && !(measuredSigma && measuredSigma.median > 0) && params.noise !== "variance") notes.push("The measured noise is zero, so no signal-to-noise ratio is given; the threshold is the absolute level you chose.");

    // 3. Detection image
    let smoothText = "None";
    const kernelValues = params.smoothFwhm > 0 ? gaussianKernel(params.smoothFwhm) : null;
    if (S) {
      R.df = S.region(Float32Array, total);
      R.sigf = S.region(Float32Array, total);
      R.coverage = S.region(Float32Array, total);
      let kernelPtr = 0;
      let kernel2Ptr = 0;
      if (kernelValues) {
        await pace.stage("Smoothing the detection image…", 0.3);
        const kernelRegion = S.region(Float64Array, kernelValues.length);
        const kernel2Region = S.region(Float64Array, kernelValues.length);
        S.view(kernelRegion).set(kernelValues);
        S.view(kernel2Region).set(kernelValues.map((value) => value * value));
        kernelPtr = kernelRegion.ptr;
        kernel2Ptr = kernel2Region.ptr;
      }
      S.exports.det_detection_image(R.values.ptr, R.background.ptr, R.sigmaMap.ptr, R.use.ptr, total, width, height, kernelPtr, kernel2Ptr, kernelValues ? kernelValues.length : 0, R.df.ptr, R.sigf.ptr, R.coverage.ptr);
      refresh();
    } else {
      df = new Float32Array(total);
      sigf = new Float32Array(total);
      coverage = new Float32Array(total);
      if (kernelValues) {
        await pace.stage("Smoothing the detection image…", 0.3);
        const kernel = kernelValues;
        const kernel2 = kernel.map((value) => value * value);
        const tmp = new Float32Array(total);
        const source = new Float32Array(total);
        for (let i = 0; i < total; i++) source[i] = use[i] ? 1 : 0;
        await convolve(source, width, height, kernel, tmp, coverage, pace);
        for (let i = 0; i < total; i++) source[i] = use[i] ? values[i] - background[i] : 0;
        await convolve(source, width, height, kernel, tmp, df, pace);
        for (let i = 0; i < total; i++) {
          const s = sigmaMap[i];
          source[i] = use[i] && Number.isFinite(s) ? s * s : 0;
        }
        await convolve(source, width, height, kernel2, tmp, sigf, pace);
        for (let i = 0; i < total; i++) {
          const w = coverage[i];
          if (w > 0) {
            df[i] = df[i] / w;
            sigf[i] = Math.sqrt(sigf[i]) / w;
          }
        }
      } else {
        for (let i = 0; i < total; i++) {
          if (use[i]) {
            df[i] = values[i] - background[i];
            sigf[i] = Number.isFinite(sigmaMap[i]) ? sigmaMap[i] : 0;
            coverage[i] = 1;
          }
        }
      }
    }
    if (kernelValues) {
      smoothText = "Gaussian, FWHM " + params.smoothFwhm + " pixels (σ = " + (params.smoothFwhm * fwhmToSigma).toFixed(2) + " pixels, " + kernelValues.length + " × " + kernelValues.length + " pixel kernel), normalized over valid pixels";
    }
    let testableCount = 0;
    if (S) {
      R.testable = S.region(Uint8Array, total);
      testableCount = S.exports.det_testable(R.use.ptr, R.coverage.ptr, R.testable.ptr, total);
      refresh();
    } else {
      testable = new Uint8Array(total);
      for (let i = 0; i < total; i++) {
        if (use[i] && coverage[i] >= limits.minCoverage) {
          testable[i] = 1;
          testableCount++;
        }
      }
    }

    // 4. Threshold and segments
    await pace.stage("Applying the threshold…", 0.5);
    let aboveCount = 0;
    if (S) {
      R.mask = S.region(Uint8Array, total);
      aboveCount = S.exports.det_threshold(R.df.ptr, R.sigf.ptr, R.testable.ptr, R.mask.ptr, total, sigmaMode ? 1 : 0, params.threshold);
      refresh();
    } else {
      mask = new Uint8Array(total);
      for (let i = 0; i < total; i++) {
        if (!testable[i]) continue;
        const above = sigmaMode ? df[i] > params.threshold * sigf[i] : df[i] > params.threshold;
        if (above) {
          mask[i] = 1;
          aboveCount++;
        }
      }
    }
    const thresholdLevels = summarize(sampleOf(sigf, testable).map((s) => sigmaMode ? params.threshold * s : params.threshold));
    const detectionSigma = summarize(sampleOf(sigf, testable));
    const level = summarize(sampleOf(background, valid));
    if (aboveCount > 0.5 * testableCount) warnings.push("More than half of the testable pixels are above the threshold. The background model probably does not describe this image (a gradient, extended emission or a threshold that is too low). Try the mesh background or a higher threshold.");
    await pace.stage("Finding connected pixels…", 0.6);
    let order;
    let foundCount;
    let kept;
    if (S) {
      R.order = S.region(Int32Array, aboveCount);
      R.starts = S.region(Int32Array, aboveCount + 1);
      foundCount = S.exports.det_components(R.mask.ptr, width, height, aboveCount, R.order.ptr, R.starts.ptr);
      refresh();
      const starts = S.view(R.starts);
      kept = [];
      for (let i = 0; i < foundCount; i++) if (starts[i + 1] - starts[i] >= params.minPixels) kept.push([starts[i], starts[i + 1]]);
    } else {
      const found = await connectedComponents(mask, width, height, aboveCount, pace);
      order = found.order;
      foundCount = found.ranges.length;
      kept = found.ranges.filter(([start, end]) => end - start >= params.minPixels);
    }
    if (kept.length > limits.maxSources) {
      return fail("too-many-sources", kept.length.toLocaleString("en-US") + " connected regions exceed the limit of " + limits.maxSources.toLocaleString("en-US") + " candidates. At this threshold the image is mostly noise or structure. Raise the threshold or the minimum number of pixels.", params);
    }

    // 5. Deblending
    await pace.stage("Separating close peaks…", 0.7);
    const groups = [];
    let regionsWithPeaks = 0;
    let measuredTable = null;
    if (S) {
      const keptStart = S.region(Int32Array, kept.length);
      const keptEnd = S.region(Int32Array, kept.length);
      let keptPixels = 0;
      const startView = S.view(keptStart);
      const endView = S.view(keptEnd);
      kept.forEach(([start, end], index) => {
        startView[index] = start;
        endView[index] = end;
        keptPixels += end - start;
      });
      const cap = Math.min(limits.maxSources, keptPixels);
      const groupPixels = S.region(Int32Array, keptPixels);
      const groupStart = S.region(Int32Array, cap + 1);
      const groupBlended = S.region(Uint8Array, cap);
      S.exports.det_deblend(R.order.ptr, aboveCount, keptStart.ptr, keptEnd.ptr, kept.length, width, height, R.df.ptr, R.sigf.ptr, params.valleySigma, params.minPixels, params.deblend ? 1 : 0,
        groupPixels.ptr, groupStart.ptr, groupBlended.ptr, cap, scalars.ptr);
      const info = S.view(scalars);
      const groupCount = info[0];
      regionsWithPeaks = info[1];
      if (groupCount > limits.maxSources) {
        return fail("too-many-sources", groupCount.toLocaleString("en-US") + " candidates exceed the limit of " + limits.maxSources.toLocaleString("en-US") + ". Raise the threshold or the minimum number of pixels.", params);
      }
      await pace.stage("Measuring candidates…", 0.85);
      const table = S.region(Float64Array, groupCount * 12);
      S.exports.det_measure(groupPixels.ptr, groupStart.ptr, groupCount, width, height, R.values.ptr, R.background.ptr, R.df.ptr, R.sigf.ptr, R.use.ptr,
        params.saturation !== null ? 1 : 0, params.saturation !== null ? params.saturation : 0, table.ptr);
      refresh();
      measuredTable = S.view(table).slice();
      const pixelsAll = S.view(groupPixels);
      const starts = S.view(groupStart);
      const blended = S.view(groupBlended);
      for (let g = 0; g < groupCount; g++) groups.push({ pixels: pixelsAll.slice(starts[g], starts[g + 1]), blended: blended[g] === 1 });
    } else {
      let branchOf = null;
      const sigmaAt = (p) => sigf[p];
      for (const [start, end] of kept) {
        const pixels = order.subarray(start, end);
        let split = [pixels];
        let multiPeak = false;
        if (pixels.length >= 2 * params.minPixels) {
          if (!branchOf) branchOf = new Int32Array(total);
          const analysis = analyseSegment(pixels, width, height, df, sigmaAt, params, branchOf);
          multiPeak = analysis.groups.length > 1;
          if (multiPeak && params.deblend) split = analysis.groups;
        }
        if (multiPeak) regionsWithPeaks++;
        for (const group of split) groups.push({ pixels: group, blended: multiPeak });
        await pace.step(pixels.length * 8);
      }
      if (groups.length > limits.maxSources) {
        return fail("too-many-sources", groups.length.toLocaleString("en-US") + " candidates exceed the limit of " + limits.maxSources.toLocaleString("en-US") + ". Raise the threshold or the minimum number of pixels.", params);
      }
      await pace.stage("Measuring candidates…", 0.85);
    }

    // 6. Measurements (the kernel has already measured the groups when measuredTable is set)
    const saturation = params.saturation;
    const wcs = image.wcs ?? null;
    const sources = [];
    for (let g = 0; g < groups.length; g++) {
      const group = groups[g];
      const pixels = group.pixels;
      let sumW = 0, sumX = 0, sumY = 0, flux = 0;
      let peak = -Infinity, peakIndex = pixels[0], bestSignificance = -Infinity;
      let edge = false, maskedNeighbour = false, saturated = false;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      if (measuredTable) {
        const m = g * 12;
        sumW = measuredTable[m]; sumX = measuredTable[m + 1]; sumY = measuredTable[m + 2]; flux = measuredTable[m + 3];
        peak = measuredTable[m + 4]; peakIndex = measuredTable[m + 5]; bestSignificance = measuredTable[m + 6];
        const bits = measuredTable[m + 7];
        edge = (bits & 1) !== 0; maskedNeighbour = (bits & 2) !== 0; saturated = (bits & 4) !== 0;
        minX = measuredTable[m + 8]; maxX = measuredTable[m + 9]; minY = measuredTable[m + 10]; maxY = measuredTable[m + 11];
      } else {
        for (let k = 0; k < pixels.length; k++) {
          const p = pixels[k];
          const px = p % width;
          const py = (p - px) / width;
          const d = values[p] - background[p];
          flux += d;
          const weight = d > 0 ? d : 0;
          sumW += weight;
          sumX += weight * px;
          sumY += weight * py;
          if (d > peak) {
            peak = d;
            peakIndex = p;
          }
          if (sigf[p] > 0) {
            const significance = df[p] / sigf[p];
            if (significance > bestSignificance) bestSignificance = significance;
          }
          if (px === 0 || py === 0 || px === width - 1 || py === height - 1) edge = true;
          if (saturation !== null && values[p] >= saturation) saturated = true;
          if (!maskedNeighbour) {
            for (let n = 0; n < 8; n++) {
              const xx = px + neighbours[n][0];
              const yy = py + neighbours[n][1];
              if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
              if (!use[yy * width + xx]) {
                maskedNeighbour = true;
                break;
              }
            }
          }
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;
        }
      }
      const peakX = peakIndex % width;
      const peakY = (peakIndex - peakX) / width;
      const x = (sumW > 0 ? sumX / sumW : peakX) + 1;
      const y = (sumW > 0 ? sumY / sumW : peakY) + 1;
      let ra = null;
      let dec = null;
      if (wcs) {
        try {
          const sky = wcs.pixelToSky(x, y);
          if (sky && Number.isFinite(sky.ra) && Number.isFinite(sky.dec)) {
            ra = sky.ra;
            dec = sky.dec;
          }
        } catch {
          ra = dec = null;
        }
      }
      const flags = [];
      if (edge) flags.push("edge");
      if (maskedNeighbour) flags.push("masked_neighbour");
      if (saturated) flags.push("saturated");
      if (group.blended) flags.push("blended");
      sources.push({
        id: "", number: 0, x, y, ra, dec, area: pixels.length, peak, fluxSum: flux,
        significance: bestSignificance > -Infinity ? bestSignificance : null,
        peakX: peakX + 1, peakY: peakY + 1, peakValue: values[peakIndex], background: background[peakIndex],
        flags, pixels, centroidFallback: !(sumW > 0), bbox: { xMin: minX + 1, xMax: maxX + 1, yMin: minY + 1, yMax: maxY + 1 },
      });
    }
    const rank = (source) => source.significance ?? source.peak;
    sources.sort((a, b) => (rank(b) - rank(a)) || (a.y - b.y) || (a.x - b.x));
    const labels = new Int32Array(total);
    sources.forEach((source, index) => {
      source.number = index + 1;
      source.id = pad(index + 1);
      for (const p of source.pixels) labels[p] = source.number;
    });

    const elapsed = (typeof performance === "object" ? performance.now() : Date.now()) - started;
    return {
      ok: true,
      params,
      width, height, unit: image.unit ?? "",
      method: "Connected pixels above a threshold" + (params.smoothFwhm > 0 ? " in a smoothed image" : "") + (params.deblend ? ", close peaks split" : ", close peaks not split"),
      background: {
        method: meshUseful ? "mesh" : "global", description: backgroundText,
        level: level ? level.median : null, levelMin: level ? level.min : null, levelMax: level ? level.max : null,
        globalMedian: global.median, globalSigma: global.sigma, clippedPixels: global.count, sampledPixels: global.total,
        cells: mesh ? mesh.cells : 1,
      },
      noise: {
        method: params.noise, description: noiseText,
        sigma: measuredSigma ? measuredSigma.median : null,
        sigmaFromVariance: varianceSigma ? varianceSigma.median : null,
        sigmaMin: (params.noise === "variance" ? varianceSigma : measuredSigma)?.min ?? null,
        sigmaMax: (params.noise === "variance" ? varianceSigma : measuredSigma)?.max ?? null,
        sigmaMedian: (params.noise === "variance" ? varianceSigma : measuredSigma)?.median ?? null,
        detectionSigma: detectionSigma ? detectionSigma.median : null,
      },
      smoothing: smoothText,
      threshold: {
        mode: params.thresholdMode, value: params.threshold,
        levelMedian: thresholdLevels ? thresholdLevels.median : null,
        levelMin: thresholdLevels ? thresholdLevels.min : null,
        levelMax: thresholdLevels ? thresholdLevels.max : null,
        unit: image.unit ?? "",
      },
      counts: {
        total, valid: validCount, invalid: invalidCount, untestable: validCount - testableCount, testable: testableCount,
        aboveThreshold: aboveCount, regionsFound: foundCount, regionsTooSmall: foundCount - kept.length,
        regionsKept: kept.length, regionsWithSeveralPeaks: regionsWithPeaks, candidates: sources.length,
        flagged: sources.filter((source) => source.flags.length).length,
      },
      sources, labels, warnings, notes,
      engine: S ? "wasm" : "js",
      elapsedMs: elapsed,
    };
  }

  // ---- Export --------------------------------------------------------------------------------------------------------
  const csvColumns = ["source_id", "x_pixel", "y_pixel", "ra", "dec", "area_pixels", "peak", "flux_sum", "flags", "source_file", "obs_id", "hdu", "pixel_origin"];

  // RFC 4180 quoting. Text that a spreadsheet could take for a formula gets a leading apostrophe.
  function csvText(value) {
    let text = value === null || value === undefined ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
  }

  function csvNumber(value, digits) {
    return isNumber(value) ? String(Number(value.toPrecision(digits))) : "";
  }

  // meta: { sourceFile, obsId, hduIndex }. options: { onlySky }. One row per candidate; ra and dec are empty without a WCS.
  function buildCsv(result, meta, options = {}) {
    const lines = [csvColumns.join(",")];
    for (const source of result.sources) {
      if (options.onlySky && source.ra === null) continue;
      const hasSky = source.ra !== null && source.dec !== null;
      lines.push([
        csvText(source.id),
        source.x.toFixed(4),
        source.y.toFixed(4),
        hasSky ? source.ra.toFixed(8) : "",
        hasSky ? source.dec.toFixed(8) : "",
        String(source.area),
        csvNumber(source.peak, 9),
        csvNumber(source.fluxSum, 9),
        csvText(source.flags.join(";")),
        csvText(meta.sourceFile),
        csvText(meta.obsId),
        meta.hduIndex === null || meta.hduIndex === undefined ? "" : String(meta.hduIndex),
        "1",
      ].join(","));
    }
    return lines.join("\r\n") + "\r\n";
  }

  // A JSON description of the run that goes with the CSV: source file, HDU, units, method and every parameter.
  function buildMetadata(result, meta) {
    const p = result.params;
    return {
      tool: "AstroNot Source Detection",
      note: "Detected candidates only. They are not catalog identifications.",
      source: {
        file: meta.sourceFile ?? null, obs_id: meta.obsId ?? null, hdu_index: meta.hduIndex ?? null, hdu_name: meta.hduName ?? null,
        hdu_index_base: 0, width: result.width, height: result.height, bunit: result.unit || null, wcs: meta.wcsSummary ?? null,
      },
      pixel_origin: 1,
      pixel_convention: "x_pixel and y_pixel are FITS pixel numbers: continuous, 1-based, the centre of the first array element is (1, 1).",
      coordinates: "ra and dec are degrees, ICRS, computed from the centroid with the image WCS; empty when the image has no usable WCS.",
      columns: {
        area_pixels: "Number of pixels in the segment.",
        peak: "Largest background-subtracted pixel value in the segment, in the image unit (unsmoothed).",
        flux_sum: "Sum of the background-subtracted pixel values in the segment, in the image unit. For surface-brightness units this is not a flux density.",
        flags: "Semicolon-separated: " + flagNames.join(", ") + ".",
      },
      method: result.method,
      parameters: {
        background: p.background, mesh_box_pixels: p.background === "mesh" ? p.meshSize : null,
        noise: p.noise, threshold_mode: p.thresholdMode, threshold: p.threshold,
        threshold_unit: p.thresholdMode === "sigma" ? "sigma above the local background" : (result.unit || "image unit") + " above the local background",
        minimum_connected_pixels: p.minPixels, smoothing_fwhm_pixels: p.smoothFwhm, deblend: p.deblend,
        valley_sigma: p.deblend ? p.valleySigma : null, saturation_level: p.saturation,
      },
      background: result.background.description,
      noise: result.noise.description,
      threshold_level_median: result.threshold.levelMedian,
      counts: result.counts,
      warnings: result.warnings,
    };
  }

  const api = {
    limits, defaultParams, flagNames, flagText, csvColumns,
    validateParams, detectSources, varianceUnitCheck, buildCsv, buildMetadata,
    clippedStats, statsOfValues, gaussianKernel, useKernel,
    // "wasm" when a kernel is installed (it is used for images of at least limits.wasmMinPixels pixels), else "js".
    engine: () => (kernel ? "wasm" : "js"),
  };
  root.AstroNotDetect = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);
