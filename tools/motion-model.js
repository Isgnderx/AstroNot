// Motion Detector model for AstroNot: moving-object CANDIDATES from several aligned observations of one field.
//
// UI-independent: no DOM access. Loads as a classic browser script (global `AstroNotMotion`) and as a CommonJS module.
// It needs tools/wcs.js (global `AstroNotWcs`), tools/pair.js (global `AstroNotPair`) and tools/difference.js
// (global `AstroNotDifference`); it does not copy any of their logic. Alignment, units, masks and the signed difference
// come from difference.js, observation time from pair.js, sky and pixel positions from wcs.js.
//
// WHAT IT DOES (and what it does not)
//   - One epoch is the REFERENCE. Every other epoch is subtracted from it with difference.js: delta = epoch - reference,
//     on the reference pixel grid. A source that is present at position A in the reference and at position B in an epoch
//     leaves a NEGATIVE residual at A (the reference has flux the epoch lacks) and a POSITIVE residual at B.
//   - Local extrema of delta above a threshold are found (detectResiduals). The threshold method is named in the result:
//     local robust scatter (MAD), global robust scatter, signed SNR from the variance images, or an absolute value in the
//     unit of the images. Peaks near the image edge, near NaN/masked pixels, or outside the overlap are not examined.
//   - A negative and a positive residual closer than a search radius and farther apart than a minimum separation are
//     paired (pairResiduals). A pair is rejected when the original images show a bright source at the midpoint in BOTH
//     epochs (a shifted static star), or when the lobes are closer than the minimum separation (a registration or PSF
//     residual of a static source). Unpaired residuals (brightness changes, transients) are counted, never reported as
//     moving objects. Pairs that share one reference position in several epochs are linked into one candidate.
//   - A candidate holds one position per epoch on the reference grid. Positions from the detection can be corrected or
//     typed by the user; the detected values are kept next to the edited ones. Sky positions come from the reference WCS
//     (all positions are on the reference grid), the position in each epoch's own file from that epoch's WCS.
//   - fitTrack() turns the positions and observation times into a displacement (arcsec, position angle east of north)
//     and, when times allow, a rate in arcsec/hour and arcsec/day: two positions give the end-to-end rate, three or more
//     a linear least-squares fit with residuals and a formal rate uncertainty. A missing or equal time leaves the rate
//     EMPTY with the reason; it is never guessed.
//
// This is a candidate finder. A candidate is not a confirmed moving object: residual pairs also come from variable
// stars, bad alignment, PSF and background differences, saturated or blended sources and artifacts, and no
// position uncertainty is propagated into the rates.
//
// CONVENTIONS
//   Pixel positions: FITS (continuous, 1-based, first pixel centre at (1, 1)), as in wcs.js, on the REFERENCE grid.
//   Position angle: degrees from north through east (north 0, east 90), in [0, 360).
//   East and north offsets are on the great-circle arc from the origin position: east = separation x sin(PA),
//   north = separation x cos(PA). East is the direction of increasing RA, so the 0/360 degree RA boundary and the
//   poles need no special case.
(function (root) {
  "use strict";

  const wcsLib = typeof module === "object" && module.exports ? require("./wcs.js") : root.AstroNotWcs;
  const pairLib = typeof module === "object" && module.exports ? require("./pair.js") : root.AstroNotPair;
  const diffLib = typeof module === "object" && module.exports ? require("./difference.js") : root.AstroNotDifference;
  const { angularSeparation } = wcsLib;

  const DEG = Math.PI / 180;
  const RAD = 180 / Math.PI;
  const secondsPerDay = 86400;

  const defaults = {
    alignment: "reproject",
    mode: "local-mad", // local-mad | global-mad | snr | absolute
    threshold: 5,
    margin: 2, // pixels of valid data required around a peak (2 means a 5 x 5 block)
    localRadius: 15,
    maxPeaks: 300,
    minSeparationPixels: 2.5,
    maxSeparationPixels: 15,
    linkTolerancePixels: 2,
    staticRatio: 0.8,
    persistRatio: 0.5, // a source that is at least this strong in the OTHER image at a lobe is present in both epochs, not moving
    maxAmplitudeRatio: 3, // the two lobes of a moving source carry the same flux; a larger imbalance is a brightness change
    maxCandidates: 50,
    maxLinearityPixels: 2, // with three or more timed positions the track must be a straight line at a steady rate within this, or 15% of the displacement
    maxLinearityFraction: 0.15,
    crowdedFraction: 0.01, // more peaks than this share of the valid pixels means the residuals are not moving objects
  };

  const modeText = {
    "local-mad": "local robust scatter (1.4826 x MAD of Δ in a 31 × 31 pixel window without its central 5 × 5 block)",
    "global-mad": "global robust scatter (1.4826 x MAD of all valid Δ pixels)",
    snr: "signed SNR = Δ / sqrt(Var(target) + Var(reference))",
    absolute: "absolute |Δ| in the unit of the images",
  };

  function isNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function significant(value, digits = 4) {
    return isNumber(value) ? Number(value.toPrecision(digits)) : null;
  }

  function normalizeDegrees(angle) {
    const value = angle % 360;
    return value < 0 ? value + 360 : value >= 360 ? 0 : value;
  }

  // ---- Sky geometry ------------------------------------------------------------------------------------------------
  // Great-circle separation (arcsec), position angle of `to` seen from `from` (degrees east of north) and the east and
  // north components of that arc in arcsec. The angle is null when the two positions coincide.
  function bearing(from, to) {
    const separation = angularSeparation(from.ra, from.dec, to.ra, to.dec) * 3600;
    if (!(separation > 1e-9)) return { separation: 0, pa: null, east: 0, north: 0 };
    const dLon = (to.ra - from.ra) * DEG;
    const phi0 = from.dec * DEG;
    const phi1 = to.dec * DEG;
    const y = Math.sin(dLon) * Math.cos(phi1);
    const x = Math.cos(phi0) * Math.sin(phi1) - Math.sin(phi0) * Math.cos(phi1) * Math.cos(dLon);
    const pa = normalizeDegrees(Math.atan2(y, x) * RAD);
    return { separation, pa, east: separation * Math.sin(pa * DEG), north: separation * Math.cos(pa * DEG) };
  }

  const compass = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  function compassDirection(pa) {
    return isNumber(pa) ? compass[Math.round(normalizeDegrees(pa) / 45) % 8] : null;
  }

  // ---- Track: displacement and rate -------------------------------------------------------------------------------
  // points: [{ id, ra, dec, order, time }] where time is a pair.js time ({ valid, mjd, scale, precision }) or null and
  // `order` is the epoch order used when the times cannot order the positions (the reference epoch first).
  // Returns { ok, n, chronological, ordered, displacement, rate, rateReason, notes } or { ok: false, reason }.
  function fitTrack(points) {
    const input = Array.isArray(points) ? points : [];
    const usable = input.filter((point) => point && isNumber(point.ra) && isNumber(point.dec));
    if (usable.length < 2) {
      return { ok: false, n: usable.length, reason: usable.length ? "A displacement needs at least two positions." : "No position has been marked yet." };
    }
    const notes = [];
    if (usable.length < input.length) notes.push((input.length - usable.length) + " position(s) without valid sky coordinates were left out.");

    const timed = usable.every((point) => point.time && point.time.valid && isNumber(point.time.mjd));
    const scaleAgrees = timed && usable.every((point) => point.time.scale === usable[0].time.scale);
    const chronological = timed && scaleAgrees;
    const ordered = usable.slice().sort(chronological
      ? (a, b) => a.time.mjd - b.time.mjd || (a.order ?? 0) - (b.order ?? 0)
      : (a, b) => (a.order ?? 0) - (b.order ?? 0));
    const origin = ordered[0];
    const offsets = ordered.map((point) => bearing(origin, point));
    const last = offsets[offsets.length - 1];
    const displacement = {
      fromId: origin.id, toId: ordered[ordered.length - 1].id,
      arcsec: last.separation, pa: last.pa, east: last.east, north: last.north,
      direction: compassDirection(last.pa),
    };
    if (!chronological) notes.push("The positions are ordered by epoch, not by time, so the direction is measured from the first epoch in the list.");

    const base = { ok: true, n: usable.length, chronological, ordered: ordered.map((point) => point.id), displacement, notes, rate: null, rateReason: "" };

    // Why no rate, if there is none.
    if (!timed) {
      const missing = usable.filter((point) => !(point.time && point.time.valid)).map((point) => point.id);
      base.rateReason = "Observation time unavailable for " + missing.join(", ") + ", so no rate was computed. The displacement is still measured.";
      return base;
    }
    if (!scaleAgrees) {
      base.rateReason = "The observation times use different time scales (" + [...new Set(usable.map((point) => point.time.scale))].join(", ") + "), so no rate was computed.";
      return base;
    }
    const t0 = ordered[0].time.mjd;
    const hours = ordered.map((point) => (point.time.mjd - t0) * 24);
    const spanHours = hours[hours.length - 1];
    if (!(spanHours * 3600 >= 1)) {
      base.rateReason = "Δt is zero: the first and last position have the same observation time, so no rate was computed.";
      return base;
    }
    if (usable.some((point) => point.time.precision === "day")) notes.push("An observation time has only date precision, so Δt is uncertain by up to a day.");
    base.deltaTHours = spanHours;
    base.deltaTDays = spanHours / 24;

    const n = ordered.length;
    const distinct = new Set(hours.map((hour) => Math.round(hour * 3600))).size;
    let east;
    let north;
    let method;
    let dof = 0;
    let sigmaEast = null;
    let sigmaNorth = null;
    let residuals = ordered.map((point) => ({ id: point.id, east: 0, north: 0, norm: 0 }));
    if (n === 2 || distinct < 3) {
      east = (last.east - offsets[0].east) / spanHours;
      north = (last.north - offsets[0].north) / spanHours;
      method = n === 2 ? "two-point" : "end-to-end";
      if (n > 2) {
        residuals = null;
        notes.push("Fewer than three distinct observation times, so the rate is the end-to-end value and has no fit residuals.");
      }
    } else {
      const meanT = hours.reduce((sum, hour) => sum + hour, 0) / n;
      const meanE = offsets.reduce((sum, offset) => sum + offset.east, 0) / n;
      const meanN = offsets.reduce((sum, offset) => sum + offset.north, 0) / n;
      let stt = 0;
      let ste = 0;
      let stn = 0;
      for (let index = 0; index < n; index++) {
        const dt = hours[index] - meanT;
        stt += dt * dt;
        ste += dt * (offsets[index].east - meanE);
        stn += dt * (offsets[index].north - meanN);
      }
      east = ste / stt;
      north = stn / stt;
      method = "linear fit";
      dof = n - 2;
      let sse = 0;
      let ssn = 0;
      residuals = ordered.map((point, index) => {
        const re = offsets[index].east - (meanE + east * (hours[index] - meanT));
        const rn = offsets[index].north - (meanN + north * (hours[index] - meanT));
        sse += re * re;
        ssn += rn * rn;
        return { id: point.id, east: re, north: rn, norm: Math.hypot(re, rn) };
      });
      sigmaEast = Math.sqrt(sse / dof / stt);
      sigmaNorth = Math.sqrt(ssn / dof / stt);
      if (dof === 1) notes.push("The fit has one degree of freedom, so its uncertainty and residuals are only a rough check.");
    }
    const speed = Math.hypot(east, north);
    base.rate = {
      method, east, north, speed,
      perDay: speed * 24, eastPerDay: east * 24, northPerDay: north * 24,
      pa: speed > 1e-12 ? normalizeDegrees(Math.atan2(east, north) * RAD) : null,
      direction: speed > 1e-12 ? compassDirection(Math.atan2(east, north) * RAD) : null,
      dof, sigmaEast, sigmaNorth,
      sigmaSpeed: sigmaEast !== null && speed > 1e-12 ? Math.hypot(east * sigmaEast, north * sigmaNorth) / speed : null,
      residuals,
      residualRms: residuals ? Math.sqrt(residuals.reduce((sum, item) => sum + item.norm * item.norm, 0) / n) : null,
    };
    if (sigmaEast === null) notes.push("No rate uncertainty: with two positions there is nothing to fit, and position errors are not propagated.");
    return base;
  }

  // ---- Residual detection in a difference image ----------------------------------------------------------------------
  function sortedMedian(sorted) {
    const n = sorted.length;
    if (!n) return NaN;
    const middle = n >> 1;
    return n % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  // 1.4826 x the median absolute deviation of an array of numbers; NaN when there are fewer than two.
  function robustSigma(values) {
    if (!values || values.length < 2) return NaN;
    const sorted = Float64Array.from(values).sort();
    const center = sortedMedian(sorted);
    const deviations = Float64Array.from(sorted, (value) => Math.abs(value - center)).sort();
    return 1.4826 * sortedMedian(deviations);
  }

  const neighbours = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

  // Optional WebAssembly kernel (rust/crates/detect, loaded by the page with AstroNotWasm.load("detect")). It runs the same
  // residual search as the JavaScript below, operation for operation, so both give identical peaks (tests/detect-wasm.test.mjs
  // compares them). Without a kernel, or when it throws, the JavaScript code runs.
  let kernel = null;

  function useKernel(next) {
    kernel = next && next.exports && typeof next.exports.det_motion_scan === "function" && typeof next.alloc === "function" ? next : null;
    return kernel !== null;
  }

  // Regions of WebAssembly memory for one detectResiduals call. Memory can grow during a kernel call, so views are made fresh.
  function openKernelSession(wk) {
    const regions = [];
    const make = (Type, length) => {
      const region = wk.alloc(Type, length);
      regions.push(region);
      return region;
    };
    return {
      exports: wk.exports,
      alloc: make,
      put(Type, array) {
        const region = make(Type, array.length);
        new Type(wk.exports.memory.buffer, region.ptr, region.length).set(array);
        return region;
      },
      view: (region) => new region.Type(wk.exports.memory.buffer, region.ptr, region.length),
      close() {
        wk.free(...regions);
        regions.length = 0;
      },
    };
  }

  // detectResiduals(diff, options): local maxima (positive residuals) and minima (negative residuals) of delta.
  // `diff` is the `result` of difference.js. options: { mode, threshold, margin, localRadius, maxPeaks }.
  // Each peak: { column, row, x, y (FITS; centroid of the lobe in a 7 x 7 block), sign, value (Δ at the peak pixel), score,
  // sigma, significance, sigmaMethod }. `significance` is |score| / sigma (|Δ| in the unit for mode "absolute").
  function detectResiduals(diff, options = {}) {
    const wk = options.engine === "js" ? null : kernel;
    if (wk) {
      const session = openKernelSession(wk);
      try {
        return findResiduals(diff, options, session);
      } catch (error) {
        // The kernel failed (for example no memory for it): the JavaScript code gives the same result.
      } finally {
        session.close();
      }
    }
    return findResiduals(diff, options, null);
  }

  // K: a kernel session, or null for the JavaScript code.
  function findResiduals(diff, options, K) {
    const opts = Object.assign({}, defaults, options);
    if (!diff || !diff.difference || !diff.valid) return { ok: false, reason: "There is no difference image." };
    if (!(isNumber(opts.threshold) && opts.threshold > 0)) return { ok: false, reason: "The threshold must be a number greater than zero." };
    if (opts.mode === "snr" && !diff.snr) return { ok: false, reason: "SNR is unavailable for this difference: " + (diff.varianceNote || "a variance image is needed in both files") + " Choose a scatter-based threshold or an absolute one." };
    if (!modeText[opts.mode]) return { ok: false, reason: "Unknown threshold method " + opts.mode + "." };
    const { width, height } = diff;
    const margin = Math.max(1, Math.floor(opts.margin));
    const score = opts.mode === "snr" ? diff.snr : diff.difference;
    // The kernel needs whole-number window sizes; anything else keeps the JavaScript code.
    const useKernelNow = Boolean(K) && Number.isInteger(opts.localRadius) && opts.localRadius >= 0 && Number.isInteger(margin) && Number.isFinite(opts.threshold);
    let usable = null;
    let finiteDelta = [];
    let kernelRegions = null;
    let kernelSigma = NaN;
    let kernelUsable = 0;
    if (useKernelNow) {
      const count = width * height;
      const valid = K.put(Uint8Array, diff.valid);
      const difference = K.put(Float64Array, diff.difference);
      const scoreRegion = score === diff.difference ? difference : K.put(Float64Array, score);
      const usableRegion = K.alloc(Uint8Array, count);
      const out = K.alloc(Float64Array, 4);
      K.exports.det_motion_prepare(valid.ptr, difference.ptr, scoreRegion.ptr, count, opts.mode === "snr" ? 1 : 0, opts.mode === "snr" || opts.mode === "absolute" ? 0 : 1, usableRegion.ptr, out.ptr);
      const result = K.view(out);
      kernelUsable = result[0];
      finiteDelta = { length: result[1] };
      kernelSigma = result[2];
      kernelRegions = { difference, scoreRegion, usableRegion, out };
    } else {
      usable = new Uint8Array(width * height);
      finiteDelta = [];
      for (let index = 0; index < usable.length; index++) {
        if (diff.valid[index] && Number.isFinite(score[index]) && Number.isFinite(diff.difference[index])) {
          usable[index] = 1;
          if (opts.mode !== "snr") finiteDelta.push(diff.difference[index]);
        }
      }
    }
    if (!finiteDelta.length && opts.mode !== "snr") {
      return { ok: true, peaks: [], mode: opts.mode, method: modeText[opts.mode], sigmaGlobal: null, excluded: { nearInvalid: 0, truncated: 0, unavailableScatter: 0 }, usablePixels: 0, unit: diff.unit ?? null, note: "There are no valid pixels in the difference image." };
    }
    const sigmaGlobal = opts.mode === "snr" || opts.mode === "absolute" ? 1 : kernelRegions ? kernelSigma : robustSigma(finiteDelta);
    const scatterBased = opts.mode === "local-mad" || opts.mode === "global-mad";
    if (scatterBased && !(sigmaGlobal > 0)) {
      return { ok: true, peaks: [], mode: opts.mode, method: modeText[opts.mode], sigmaGlobal: 0, excluded: { nearInvalid: 0, truncated: 0, unavailableScatter: 0 }, usablePixels: finiteDelta.length, unit: diff.unit ?? null, note: "The scatter of Δ is zero, so a significance cannot be computed. Use the absolute threshold." };
    }
    // Pre-filter: pixels this small cannot pass. Local scatter may be lower than the global one, so it uses 2 sigma.
    const pre = opts.mode === "local-mad" ? 2 * sigmaGlobal : opts.mode === "global-mad" ? opts.threshold * sigmaGlobal : opts.threshold;
    const excluded = { nearInvalid: 0, truncated: 0, unavailableScatter: 0 };
    const found = [];

    if (kernelRegions) {
      const modeCode = { "local-mad": 0, "global-mad": 1, snr: 2, absolute: 3 }[opts.mode];
      const counts = K.alloc(Float64Array, 2);
      const ptr = K.exports.det_motion_scan(kernelRegions.usableRegion.ptr, kernelRegions.difference.ptr, kernelRegions.scoreRegion.ptr, width, height, modeCode, opts.threshold, margin, opts.localRadius, sigmaGlobal, pre, counts.ptr);
      const summary = K.view(counts);
      const n = summary[0];
      excluded.nearInvalid = summary[1];
      const records = new Float64Array(K.exports.memory.buffer, ptr, n * 10).slice();
      K.exports.an_free(ptr, n * 80);
      const methodText = ["local robust scatter", "global robust scatter (too few pixels nearby)", "global robust scatter (local scatter is zero)"];
      const fixedText = opts.mode === "global-mad" ? "global robust scatter" : opts.mode === "snr" ? "SNR from the variance images" : "absolute threshold";
      for (let k = 0; k < n; k++) {
        const r = k * 10;
        found.push({
          column: records[r], row: records[r + 1], x: records[r + 2], y: records[r + 3], sign: records[r + 4],
          value: records[r + 5], score: records[r + 6], sigma: records[r + 7], significance: records[r + 8],
          sigmaMethod: records[r + 9] < 3 ? methodText[records[r + 9]] : fixedText,
        });
      }
    }

    const isExtremum = (column, row, sign) => {
      const index = row * width + column;
      const value = score[index] * sign;
      for (const [dx, dy] of neighbours) {
        const c = column + dx;
        const r = row + dy;
        if (c < 0 || r < 0 || c >= width || r >= height) continue;
        const other = r * width + c;
        if (!usable[other]) continue;
        const compare = score[other] * sign;
        const before = other < index;
        if (before ? !(value > compare) : !(value >= compare)) return false;
      }
      return true;
    };

    const clear = (column, row) => {
      if (column < margin || row < margin || column >= width - margin || row >= height - margin) return false;
      for (let dy = -margin; dy <= margin; dy++) for (let dx = -margin; dx <= margin; dx++) if (!usable[(row + dy) * width + column + dx]) return false;
      return true;
    };

    const localSigma = (column, row) => {
      const radius = opts.localRadius;
      const samples = [];
      for (let r = Math.max(0, row - radius); r <= Math.min(height - 1, row + radius); r++) {
        for (let c = Math.max(0, column - radius); c <= Math.min(width - 1, column + radius); c++) {
          if (Math.abs(c - column) <= 2 && Math.abs(r - row) <= 2) continue;
          const index = r * width + c;
          if (usable[index]) samples.push(diff.difference[index]);
        }
      }
      if (samples.length < 50) return { sigma: sigmaGlobal, method: "global robust scatter (too few pixels nearby)", fallback: true };
      const sigma = robustSigma(samples);
      return sigma > 0 ? { sigma, method: "local robust scatter", fallback: false } : { sigma: sigmaGlobal, method: "global robust scatter (local scatter is zero)", fallback: true };
    };

    for (let row = 0; row < height && !kernelRegions; row++) {
      for (let column = 0; column < width; column++) {
        const index = row * width + column;
        if (!usable[index]) continue;
        const value = score[index];
        if (Math.abs(value) < pre || value === 0) continue;
        const sign = value > 0 ? 1 : -1;
        if (!isExtremum(column, row, sign)) continue;
        if (!clear(column, row)) {
          excluded.nearInvalid++;
          continue;
        }
        let sigma = 1;
        let sigmaMethod = modeText[opts.mode];
        if (opts.mode === "local-mad") {
          const local = localSigma(column, row);
          sigma = local.sigma;
          sigmaMethod = local.method;
        } else if (opts.mode === "global-mad") {
          sigma = sigmaGlobal;
          sigmaMethod = "global robust scatter";
        } else if (opts.mode === "snr") sigmaMethod = "SNR from the variance images";
        else sigmaMethod = "absolute threshold";
        const significance = Math.abs(value) / sigma;
        if (!(significance >= opts.threshold)) continue;

        // Centroid of the lobe: 7 x 7 block, weights = the part of Δ with the sign of the peak that rises more than one sigma
        // above zero (a floor that keeps the noise from pulling the centroid toward the middle of the block).
        let sw = 0;
        let sx = 0;
        let sy = 0;
        for (let dy = -3; dy <= 3; dy++) {
          for (let dx = -3; dx <= 3; dx++) {
            const c = column + dx;
            const r = row + dy;
            if (c < 0 || r < 0 || c >= width || r >= height) continue;
            const at = r * width + c;
            if (!usable[at]) continue;
            const weight = Math.max(0, sign * diff.difference[at] - (opts.mode === "snr" || opts.mode === "absolute" ? 0 : sigma));
            sw += weight;
            sx += weight * (c + 1);
            sy += weight * (r + 1);
          }
        }
        found.push({
          column, row, x: sw > 0 ? sx / sw : column + 1, y: sw > 0 ? sy / sw : row + 1, sign,
          value: diff.difference[index], score: value, sigma, significance, sigmaMethod,
        });
      }
    }
    found.sort((a, b) => b.significance - a.significance);
    if (found.length > opts.maxPeaks) {
      excluded.truncated = found.length - opts.maxPeaks;
      found.length = opts.maxPeaks;
    }
    return {
      ok: true, peaks: found, mode: opts.mode, method: modeText[opts.mode], threshold: opts.threshold, sigmaGlobal: opts.mode === "snr" ? null : sigmaGlobal,
      excluded, usablePixels: kernelRegions ? kernelUsable : usable.reduce((sum, flag) => sum + flag, 0), unit: diff.unit ?? null, note: "",
    };
  }

  // ---- Centroid of a source in one image --------------------------------------------------------------------------------
  // image: { width, height, values, valid } on the reference grid. Starts from the brightest valid pixel within
  // `searchRadius` of (x, y) and returns the background-subtracted centroid of the 7 x 7 block around it. The background is
  // the median of the valid pixels in the surrounding 13 x 13 block without its central 5 x 5. When no flux is found the
  // input position is returned unchanged with refined: false and the reason.
  function refineCentroid(image, x, y, options = {}) {
    const searchRadius = options.searchRadius ?? 2;
    const { width, height, values, valid } = image;
    const column = Math.round(x) - 1;
    const row = Math.round(y) - 1;
    const same = (reason) => ({ x, y, refined: false, reason });
    if (!(column >= 0 && row >= 0 && column < width && row < height)) return same("The position is outside the image.");
    let best = -1;
    for (let dy = -searchRadius; dy <= searchRadius; dy++) {
      for (let dx = -searchRadius; dx <= searchRadius; dx++) {
        const c = column + dx;
        const r = row + dy;
        if (c < 0 || r < 0 || c >= width || r >= height) continue;
        const index = r * width + c;
        if (!valid[index] || !Number.isFinite(values[index])) continue;
        if (best < 0 || values[index] > values[best]) best = index;
      }
    }
    if (best < 0) return same("There are no valid pixels next to the position.");
    const pc = best % width;
    const pr = Math.floor(best / width);
    const ring = [];
    for (let r = Math.max(0, pr - 6); r <= Math.min(height - 1, pr + 6); r++) {
      for (let c = Math.max(0, pc - 6); c <= Math.min(width - 1, pc + 6); c++) {
        if (Math.abs(c - pc) <= 2 && Math.abs(r - pr) <= 2) continue;
        const index = r * width + c;
        if (valid[index] && Number.isFinite(values[index])) ring.push(values[index]);
      }
    }
    if (ring.length < 8) return same("Too few valid pixels around the position to estimate the background.");
    ring.sort((a, b) => a - b);
    const background = sortedMedian(Float64Array.from(ring));
    let sw = 0;
    let sx = 0;
    let sy = 0;
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const c = pc + dx;
        const r = pr + dy;
        if (c < 0 || r < 0 || c >= width || r >= height) continue;
        const index = r * width + c;
        if (!valid[index] || !Number.isFinite(values[index])) continue;
        const weight = Math.max(0, values[index] - background);
        sw += weight;
        sx += weight * (c + 1);
        sy += weight * (r + 1);
      }
    }
    if (!(sw > 0)) return same("No flux above the local background was found next to the position.");
    return { x: sx / sw, y: sy / sw, refined: true, peakValue: values[best], background, reason: "" };
  }

  // ---- Pairing and linking --------------------------------------------------------------------------------------------
  function localBackground(image, x, y, radius = 6) {
    const column = Math.round(x) - 1;
    const row = Math.round(y) - 1;
    const samples = [];
    for (let r = Math.max(0, row - radius); r <= Math.min(image.height - 1, row + radius); r++) {
      for (let c = Math.max(0, column - radius); c <= Math.min(image.width - 1, column + radius); c++) {
        const index = r * image.width + c;
        if (image.valid[index] && Number.isFinite(image.values[index])) samples.push(image.values[index]);
      }
    }
    if (samples.length < 8) return null;
    samples.sort((a, b) => a - b);
    return sortedMedian(Float64Array.from(samples));
  }

  function brightestNear(image, x, y, radius = 1) {
    const column = Math.round(x) - 1;
    const row = Math.round(y) - 1;
    let best = null;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const c = column + dx;
        const r = row + dy;
        if (c < 0 || r < 0 || c >= image.width || r >= image.height) continue;
        const index = r * image.width + c;
        if (!image.valid[index] || !Number.isFinite(image.values[index])) continue;
        if (best === null || image.values[index] > best) best = image.values[index];
      }
    }
    return best;
  }

  // A static source seen with a small registration or PSF mismatch leaves a dipole whose two lobes sit on the flanks of
  // the source, so BOTH original images are bright at the midpoint. A moving object leaves nothing at the midpoint when the
  // lobes are far enough apart. Returns { static: boolean, ratioReference, ratioEpoch } or null when it cannot be judged.
  function midpointCheck(pair, images, ratio) {
    if (!images || !images.reference || !images.epoch) return null;
    const mid = { x: (pair.positive.x + pair.negative.x) / 2, y: (pair.positive.y + pair.negative.y) / 2 };
    const measure = (image, lobe) => {
      const bg = localBackground(image, mid.x, mid.y);
      const atMid = brightestNear(image, mid.x, mid.y);
      const atLobe = brightestNear(image, lobe.x, lobe.y);
      if (bg === null || atMid === null || atLobe === null) return null;
      const lobeHeight = atLobe - bg;
      return lobeHeight > 0 ? (atMid - bg) / lobeHeight : null;
    };
    const ratioReference = measure(images.reference, pair.negative);
    const ratioEpoch = measure(images.epoch, pair.positive);
    if (ratioReference === null || ratioEpoch === null) return null;
    return { static: ratioReference >= ratio && ratioEpoch >= ratio, ratioReference, ratioEpoch };
  }

  // At the positive lobe the epoch image shows the source and the reference image should show only background; at the negative
  // lobe the reverse. When the other image is already bright there (more than `ratio` of the source height above the local
  // background) the source exists in both epochs and the residual is a brightness, PSF or alignment change, not a move.
  // Returns { positive, negative } ratios (null when they cannot be judged) and whether the pair fails the check.
  function persistenceCheck(pair, images, ratio) {
    if (!images || !images.reference || !images.epoch) return null;
    const measure = (own, other, lobe) => {
      const bg = localBackground(own, lobe.x, lobe.y);
      const otherBg = localBackground(other, lobe.x, lobe.y);
      const height = brightestNear(own, lobe.x, lobe.y);
      const otherHeight = brightestNear(other, lobe.x, lobe.y);
      if (bg === null || otherBg === null || height === null || otherHeight === null) return null;
      const source = height - bg;
      return source > 0 ? (otherHeight - otherBg) / source : null;
    };
    const positive = measure(images.epoch, images.reference, pair.positive);
    const negative = measure(images.reference, images.epoch, pair.negative);
    return { positive, negative, persistent: (positive !== null && positive > ratio) || (negative !== null && negative > ratio) };
  }

  // pairResiduals(peaks, options): options { minSeparationPixels, maxSeparationPixels, images: { reference, epoch }, pixelScale }.
  // Returns { pairs, rejected, unpaired: { positive, negative } }. Each pair: { positive, negative, separationPixels,
  // separationArcsec, amplitudeRatio, neighbours, flags }.
  function pairResiduals(peaks, options = {}) {
    const opts = Object.assign({}, defaults, options);
    const positive = peaks.filter((peak) => peak.sign > 0);
    const negative = peaks.filter((peak) => peak.sign < 0);
    const combos = [];
    for (const p of positive) {
      for (const n of negative) {
        const separation = Math.hypot(p.x - n.x, p.y - n.y);
        if (separation <= opts.maxSeparationPixels) combos.push({ p, n, separation, weight: Math.min(p.significance, n.significance) + 0.001 * (p.significance + n.significance) });
      }
    }
    combos.sort((a, b) => b.weight - a.weight);
    const used = new Set();
    const pairs = [];
    const rejected = [];
    for (const combo of combos) {
      if (used.has(combo.p) || used.has(combo.n)) continue;
      used.add(combo.p);
      used.add(combo.n);
      const neighbourCount = (peak, others, partner) => others.filter((other) => other !== partner && Math.hypot(peak.x - other.x, peak.y - other.y) <= opts.maxSeparationPixels).length;
      const record = {
        positive: combo.p, negative: combo.n, separationPixels: combo.separation,
        separationArcsec: isNumber(opts.pixelScale) ? combo.separation * opts.pixelScale : null,
        amplitudeRatio: Math.abs(combo.p.value) / Math.abs(combo.n.value),
        neighbours: { positive: neighbourCount(combo.p, negative, combo.n), negative: neighbourCount(combo.n, positive, combo.p) },
        flags: [],
      };
      if (combo.separation < opts.minSeparationPixels) {
        rejected.push(Object.assign(record, { reason: "The lobes are only " + significant(combo.separation, 3) + " pixels apart, below the minimum of " + opts.minSeparationPixels + " pixels. This is the typical shape of a registration or PSF residual of a static source, so it was not made a candidate." }));
        continue;
      }
      if (record.amplitudeRatio > opts.maxAmplitudeRatio || record.amplitudeRatio < 1 / opts.maxAmplitudeRatio) {
        rejected.push(Object.assign(record, { reason: "The two residuals differ in amplitude by a factor of " + significant(Math.max(record.amplitudeRatio, 1 / record.amplitudeRatio), 3) + " (limit " + opts.maxAmplitudeRatio + "). A moving source leaves lobes of equal size, so this is more likely a brightness change next to another source." }));
        continue;
      }
      const check = midpointCheck(record, opts.images, opts.staticRatio);
      if (check && check.static) {
        rejected.push(Object.assign(record, { reason: "Both original images are bright at the midpoint between the two lobes (" + Math.round(check.ratioReference * 100) + "% and " + Math.round(check.ratioEpoch * 100) + "% of the lobe height above the background), so this looks like a static source with a small shift, not a moving one." }));
        continue;
      }
      const persist = persistenceCheck(record, opts.images, opts.persistRatio);
      if (persist && persist.persistent) {
        rejected.push(Object.assign(record, { reason: "The source is already bright in the other image at " + (persist.positive !== null && persist.positive > opts.persistRatio ? "the positive lobe (" + Math.round(persist.positive * 100) + "% of its height in the reference)" : "the negative lobe (" + Math.round(persist.negative * 100) + "% of its height in the epoch)") + ", so it exists in both epochs. This is a brightness, PSF or alignment change of a static source, not a move." }));
        continue;
      }
      record.persistence = persist;
      record.midpoint = check;
      if (!check) record.flags.push("The original images could not be checked at the midpoint (too few valid pixels), so a shifted static source is not excluded.");
      if (record.neighbours.positive + record.neighbours.negative > 0) record.flags.push("Other residuals of the opposite sign lie within the search radius (" + record.neighbours.negative + " near the positive one, " + record.neighbours.positive + " near the negative one); the pairing may be ambiguous.");
      pairs.push(record);
    }
    return { pairs, rejected, unpaired: { positive: positive.filter((peak) => !used.has(peak)), negative: negative.filter((peak) => !used.has(peak)) } };
  }

  // The lobes of a close pair distort each other in the difference image (the wing of one lobe subtracts from the other), so
  // the position of each lobe is re-measured in the ORIGINAL image that shows the source: the negative lobe in the reference,
  // the positive lobe in the epoch. This also makes every position traceable to a source image. When that fails the
  // difference-image centroid is kept and labelled.
  function refinePair(pair, images, pixelScale) {
    for (const [peak, image] of [[pair.negative, images.reference], [pair.positive, images.epoch]]) {
      peak.xDelta = peak.x;
      peak.yDelta = peak.y;
      const refined = refineCentroid(image, peak.x, peak.y);
      if (refined.refined) {
        peak.x = refined.x;
        peak.y = refined.y;
        peak.positionMethod = "centroid in the " + (peak === pair.negative ? "reference" : "epoch") + " image";
      } else {
        peak.positionMethod = "centroid of Δ (" + refined.reason + ")";
      }
    }
    pair.separationPixels = Math.hypot(pair.positive.x - pair.negative.x, pair.positive.y - pair.negative.y);
    pair.separationArcsec = isNumber(pixelScale) ? pair.separationPixels * pixelScale : null;
    return pair;
  }

  // linkPairs(byEpoch, options): byEpoch is { epochId: [pair, ...] }. Pairs of different epochs whose NEGATIVE residuals
  // (the reference position) lie within `linkTolerancePixels` belong to one candidate. Returns
  // [{ reference: { x, y }, members: { epochId: pair }, extra: { epochId: n } }].
  function linkPairs(byEpoch, options = {}) {
    const tolerance = options.linkTolerancePixels ?? defaults.linkTolerancePixels;
    const all = [];
    for (const [epochId, list] of Object.entries(byEpoch)) for (const pair of list) all.push({ epochId, pair });
    all.sort((a, b) => Math.min(b.pair.positive.significance, b.pair.negative.significance) - Math.min(a.pair.positive.significance, a.pair.negative.significance));
    const clusters = [];
    for (const item of all) {
      const at = item.pair.negative;
      let cluster = clusters.find((entry) => Math.hypot(entry.reference.x - at.x, entry.reference.y - at.y) <= tolerance);
      if (!cluster) {
        cluster = { reference: { x: at.x, y: at.y }, members: {}, extra: {} };
        clusters.push(cluster);
      }
      if (cluster.members[item.epochId]) {
        cluster.extra[item.epochId] = (cluster.extra[item.epochId] ?? 0) + 1;
        continue;
      }
      cluster.members[item.epochId] = item.pair;
      const list = Object.values(cluster.members).map((pair) => pair.negative);
      cluster.reference = { x: list.reduce((sum, peak) => sum + peak.x, 0) / list.length, y: list.reduce((sum, peak) => sum + peak.y, 0) / list.length };
    }
    return clusters;
  }

  // ---- Epochs and the series -------------------------------------------------------------------------------------------
  // buildEpoch(hdu, hduIndex, values, extra): the object that analyzeSeries() and difference.js expect. `hdu` is an HDU of
  // fits.js readFitsHdus(); `values` its calibrated pixels (BSCALE/BZERO applied, BLANK as NaN).
  // extra: { id, name, wavelength, variance, varianceUnit, manualTime (a pair.manualObservationTime result) }.
  function buildEpoch(hdu, hduIndex, values, extra = {}) {
    const created = wcsLib.createWcs(hdu.fields);
    const [width, height] = hdu.axes;
    const meta = pairLib.describeObservation(hdu, hduIndex, { wavelength: extra.wavelength ?? null, manualTime: extra.manualTime ?? null });
    return {
      id: extra.id ?? null, name: extra.name ?? "", hdu, hduIndex, width, height, values,
      wcs: created.ok ? created.wcs : null, wcsReason: created.ok ? "" : created.reason,
      unit: typeof hdu.fields.BUNIT === "string" ? hdu.fields.BUNIT.trim() : "",
      fields: hdu.fields, meta, wavelength: extra.wavelength ?? null,
      variance: extra.variance ?? null, varianceUnit: extra.varianceUnit,
      fingerprint: pairLib.fingerprintValues(values),
    };
  }

  // A time typed by the user for an epoch whose header has none (pair.manualObservationTime). Returns the new meta or an error.
  function withManualTime(epoch, text) {
    const manual = pairLib.manualObservationTime(text, epoch.meta.processed ?? null);
    if (!manual.valid) return { ok: false, reason: manual.reason };
    epoch.meta = pairLib.describeObservation(epoch.hdu, epoch.hduIndex, { wavelength: epoch.wavelength, manualTime: manual });
    return { ok: true, meta: epoch.meta };
  }

  function epochTime(epoch) {
    const time = epoch && epoch.meta ? epoch.meta.time : null;
    return time && time.valid ? time : null;
  }

  // The epoch that is the default reference: the earliest valid time, else the first.
  function defaultReference(epochs) {
    let best = -1;
    epochs.forEach((epoch, index) => {
      const time = epochTime(epoch);
      if (time && (best < 0 || time.mjd < epochTime(epochs[best]).mjd)) best = index;
    });
    return best >= 0 ? best : 0;
  }

  function describeThreshold(opts, unit) {
    return opts.mode === "absolute" ? "|Δ| ≥ " + opts.threshold + (unit ? " " + unit : "")
      : opts.threshold + (opts.mode === "snr" ? " (SNR)" : " × scatter");
  }

  // analyzeSeries(epochs, options) -> { ok, reason } or the full analysis:
  //   { ok: true, reference (epoch), referenceId, entries: [{ id, epoch, isReference, included, reason, diff, image, detection,
  //     pairs, rejected, unpaired }], candidates, settings, notes, counts }
  // epochs: objects from buildEpoch() (ids must be unique). options: defaults above plus { referenceId, assumeSameUnit }.
  function analyzeSeries(epochs, options = {}) {
    const opts = Object.assign({}, defaults, options);
    if (!Array.isArray(epochs) || epochs.length < 2) return { ok: false, reason: "At least two observations are needed: one reference and one more epoch." };
    const ids = epochs.map((epoch) => epoch.id);
    if (new Set(ids).size !== ids.length || ids.some((id) => !id)) return { ok: false, reason: "Every epoch needs a unique id." };
    const referenceIndex = opts.referenceId ? epochs.findIndex((epoch) => epoch.id === opts.referenceId) : defaultReference(epochs);
    if (referenceIndex < 0) return { ok: false, reason: "The chosen reference is not among the loaded observations." };
    const reference = epochs[referenceIndex];
    if (!reference.wcs) return { ok: false, reason: "The reference " + (reference.meta.obsId ?? reference.name) + " has no usable WCS (" + reference.wcsReason + "), so positions cannot be converted to the sky." };
    const pixelScale = pairLib.pixelScaleArcsec(reference.wcs, reference.width, reference.height);
    const notes = [];
    const entries = [];
    const byEpoch = {};
    const counts = { epochs: epochs.length, used: 0, pairs: 0, rejected: 0, unpairedPositive: 0, unpairedNegative: 0, nearInvalid: 0 };

    for (const epoch of epochs) {
      const entry = { id: epoch.id, epoch, isReference: epoch === reference, included: false, reason: "", diff: null, image: null, detection: null, pairs: [], rejected: [], unpaired: { positive: [], negative: [] } };
      entries.push(entry);
      if (entry.isReference) {
        entry.included = true;
        counts.used++;
        continue;
      }
      const outcome = diffLib.computeDifference(reference, epoch, { alignment: opts.alignment, background: "none", assumeSameUnit: Boolean(opts.assumeSameUnit) });
      if (!outcome.ok) {
        entry.reason = outcome.reason;
        continue;
      }
      const diff = outcome.result;
      entry.diff = diff;
      entry.image = { width: diff.width, height: diff.height, values: diff.target.values, valid: diff.target.valid };
      if (diff.empty) {
        entry.reason = diff.emptyReason;
        continue;
      }
      entry.included = true;
      counts.used++;
      const detection = detectResiduals(diff, opts);
      entry.detection = detection;
      if (!detection.ok) {
        entry.reason = detection.reason;
        entry.included = false;
        counts.used--;
        continue;
      }
      counts.nearInvalid += detection.excluded.nearInvalid;
      const label = epoch.meta.obsId ?? epoch.name;
      const rw = reference.meta.wavelength;
      const ew = epoch.meta.wavelength;
      if (rw && ew) {
        const gap = Math.abs(rw.center.micron - ew.center.micron);
        const limit = Math.max(rw.center.bandwidth, ew.center.bandwidth);
        entry.bandGapMicron = gap;
        if (gap > limit) notes.push(label + " was observed at " + significant(ew.center.micron, 4) + " μm at the image center and the reference at " + significant(rw.center.micron, 4) + " μm, more than one bandwidth (" + significant(limit, 2) + " μm) apart. Stars change brightness with wavelength, so residuals around every star are expected and many false candidates can follow.");
      }
      if (detection.peaks.length > opts.crowdedFraction * detection.usablePixels) {
        entry.crowded = true;
        notes.push("The difference with " + label + " has " + detection.peaks.length + " residual peaks above the threshold in " + detection.usablePixels.toLocaleString("en-US") + " valid pixels. That is a lot: the residuals are probably dominated by alignment, PSF, band or background differences, not by moving objects. Expect false candidates, or raise the threshold.");
      }
      const paired = pairResiduals(detection.peaks, Object.assign({}, opts, {
        pixelScale, images: { reference: { width: diff.width, height: diff.height, values: diff.reference.values, valid: diff.reference.valid }, epoch: entry.image },
      }));
      for (const pair of paired.pairs) refinePair(pair, { reference: { width: diff.width, height: diff.height, values: diff.reference.values, valid: diff.reference.valid }, epoch: entry.image }, pixelScale);
      entry.pairs = paired.pairs;
      entry.rejected = paired.rejected;
      entry.unpaired = paired.unpaired;
      byEpoch[epoch.id] = paired.pairs;
      counts.pairs += paired.pairs.length;
      counts.rejected += paired.rejected.length;
      counts.unpairedPositive += paired.unpaired.positive.length;
      counts.unpairedNegative += paired.unpaired.negative.length;
    }
    entries.find((entry) => entry.isReference).image = (() => {
      const other = entries.find((entry) => entry.diff);
      return other ? { width: other.diff.width, height: other.diff.height, values: other.diff.reference.values, valid: other.diff.reference.valid } : null;
    })();
    if (counts.used < 2) notes.push("No other observation could be subtracted from the reference, so there is nothing to search. See the reason for each observation.");

    const clusters = linkPairs(byEpoch, opts);
    let candidates = clusters.map((cluster, index) => {
      const epochIds = Object.keys(cluster.members);
      const positions = {};
      positions[reference.id] = { x: cluster.reference.x, y: cluster.reference.y, method: "detected", note: "Mean position of the negative residual in " + epochIds.length + " difference image(s), " + cluster.members[epochIds[0]].negative.positionMethod };
      const detail = [];
      for (const epochId of epochIds) {
        const pair = cluster.members[epochId];
        positions[epochId] = { x: pair.positive.x, y: pair.positive.y, method: "detected", note: "Positive residual, " + pair.positive.positionMethod + "; peak Δ = +" + significant(pair.positive.value, 4) + (pair.positive.significance ? " (" + significant(pair.positive.significance, 3) + " σ)" : "") };
        const label = epochs.find((epoch) => epoch.id === epochId);
        detail.push((label ? label.meta.obsId ?? label.name : epochId) + ": " + significant(pair.separationPixels, 3) + " px" + (pair.separationArcsec !== null ? " (" + significant(pair.separationArcsec, 3) + "″)" : "") + " between the negative and the positive residual");
      }
      const flags = [];
      for (const epochId of epochIds) for (const flag of cluster.members[epochId].flags) flags.push(epochId + ": " + flag);
      for (const [epochId, extra] of Object.entries(cluster.extra)) flags.push(epochId + ": " + extra + " more residual pair(s) fall on the same reference position; the strongest was used.");
      const strength = Math.max(...epochIds.map((epochId) => Math.min(cluster.members[epochId].positive.significance, cluster.members[epochId].negative.significance)));
      return {
        id: "C" + (index + 1), origin: "detected", status: "candidate", positions,
        detected: JSON.parse(JSON.stringify(positions)),
        reasons: [
          "Candidate because a negative residual (the reference has flux the epoch lacks) and a positive residual (the epoch has flux the reference lacks) form a pair in " + epochIds.length + " of " + (counts.epochs - 1) + " difference image(s).",
          ...detail,
        ],
        warnings: flags,
        strength, epochsSeen: epochIds.length,
      };
    });
    // Residual pairs that happen to share a reference position but whose later positions are scattered are not a moving object.
    // With three or more timed positions the straight-line fit must hold; the dropped ones are counted and reported.
    counts.nonLinear = 0;
    const draft = { reference, entries };
    candidates = candidates.filter((candidate) => {
      if (Object.keys(candidate.positions).length < 3) return true;
      const { track } = evaluateCandidate(draft, candidate);
      if (!(track.ok && track.rate && track.rate.residuals)) return true;
      if (track.rate.residualRms > Math.max(opts.maxLinearityPixels * pixelScale, opts.maxLinearityFraction * track.displacement.arcsec)) {
        counts.nonLinear++;
        return false;
      }
      return true;
    });
    if (counts.nonLinear) notes.push(counts.nonLinear + " residual group(s) with three or more positions were dropped because the positions do not lie on a straight line at a steady rate (residual rms above " + opts.maxLinearityPixels + " pixels or " + Math.round(opts.maxLinearityFraction * 100) + "% of the displacement).");
    candidates.sort((a, b) => b.epochsSeen - a.epochsSeen || b.strength - a.strength);
    counts.candidatesFound = candidates.length;
    if (candidates.length > opts.maxCandidates) {
      notes.push(candidates.length + " candidates were found; only the " + opts.maxCandidates + " seen in the most epochs and with the strongest residuals are listed. Raise the threshold to narrow the list.");
      candidates.length = opts.maxCandidates;
    }
    candidates.forEach((candidate, index) => { candidate.id = "C" + (index + 1); });

    const settings = {
      referenceId: reference.id, referenceObsId: reference.meta.obsId ?? null, alignment: opts.alignment, mode: opts.mode, method: modeText[opts.mode],
      threshold: opts.threshold, thresholdText: describeThreshold(opts, reference.unit),
      minSeparationPixels: opts.minSeparationPixels, maxSeparationPixels: opts.maxSeparationPixels, linkTolerancePixels: opts.linkTolerancePixels,
      pixelScaleArcsec: pixelScale, unit: reference.unit || null, direction: "Δ = epoch − reference",
    };
    return { ok: true, reference, referenceId: reference.id, entries, candidates, settings, notes, counts };
  }

  // A candidate typed or clicked by the user (no detection behind it).
  function newCandidate(series, number) {
    return { id: "M" + number, origin: "manual", status: "candidate", positions: {}, detected: {}, reasons: ["Marked by hand. No residual pair was detected for it."], warnings: [], strength: 0, epochsSeen: 0 };
  }

  // Sets one position of a candidate. The first time a detected position is changed, the detected value stays in
  // candidate.detected; the review status is never touched here.
  function setPosition(candidate, epochId, position) {
    candidate.positions[epochId] = Object.assign({}, position);
    return candidate;
  }

  // The positions of a candidate with sky coordinates, the position in each epoch's own file, the time, the fit and the
  // offsets: { points, track, issues }. `series` is analyzeSeries()'s result.
  function evaluateCandidate(series, candidate) {
    const wcs = series.reference.wcs;
    const issues = [];
    const points = [];
    series.entries.forEach((entry, index) => {
      const position = candidate.positions[entry.id];
      if (!position || !isNumber(position.x) || !isNumber(position.y)) return;
      const sky = wcs.pixelToSky(position.x, position.y);
      const epoch = entry.epoch;
      let source = null;
      if (sky && epoch.wcs) {
        const at = epoch.wcs.skyToPixel(sky.ra, sky.dec);
        if (at && wcsLib.insideImage(at.x, at.y, epoch.width, epoch.height)) source = { x: at.x, y: at.y };
      }
      const time = epochTime(epoch);
      points.push({
        id: entry.id, epoch, entry, x: position.x, y: position.y, ra: sky ? sky.ra : NaN, dec: sky ? sky.dec : NaN,
        source, time, method: position.method, note: position.note ?? "", edited: Boolean(candidate.detected[entry.id]) && (candidate.detected[entry.id].x !== position.x || candidate.detected[entry.id].y !== position.y),
        order: entry.isReference ? -1 : index,
      });
    });
    const track = fitTrack(points.map((point) => ({ id: point.id, ra: point.ra, dec: point.dec, time: point.time, order: point.order })));
    // Offsets from the first position of the track and fit residuals, per point.
    if (track.ok) {
      const origin = points.find((point) => point.id === track.ordered[0]);
      for (const point of points) {
        const offset = bearing(origin, point);
        point.east = offset.east;
        point.north = offset.north;
        const residual = track.rate && track.rate.residuals ? track.rate.residuals.find((item) => item.id === point.id) : null;
        point.residual = residual ? residual.norm : null;
      }
    }
    for (const point of points) if (!point.source) issues.push(point.id + ": the position lies outside the epoch's own image (the reference grid extends past it).");
    return { points, track, issues };
  }

  // ---- CSV export -------------------------------------------------------------------------------------------------------
  const reviewText = { candidate: "candidate", keep: "keep for review", dismissed: "dismissed" };

  function csvCell(value) {
    if (value === null || value === undefined) return "";
    let text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : String(value);
    if (typeof value === "string" && /^[=+\-@\t\r]/.test(text) && !/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text)) text = "'" + text;
    return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
  }

  function fixed(value, digits) {
    return isNumber(value) ? Number(value.toFixed(digits)) : null;
  }

  const csvColumns = [
    "candidate_id", "review_status", "origin", "epoch_id", "role", "observation_id", "file", "hdu", "time_utc", "mjd", "time_scale", "time_source",
    "x_reference_grid", "y_reference_grid", "position_method", "ra_deg", "dec_deg", "source_x", "source_y",
    "east_arcsec", "north_arcsec", "fit_residual_arcsec",
    "n_positions", "displacement_arcsec", "displacement_pa_deg", "delta_t_hours", "rate_arcsec_per_hour", "rate_arcsec_per_day", "rate_pa_deg", "rate_method",
    "rate_sigma_east_arcsec_per_hour", "rate_sigma_north_arcsec_per_hour", "rate_unavailable_reason",
    "difference_direction", "reference_observation_id", "detection_method", "threshold", "candidate_reasons",
  ];

  // One row per candidate position. Candidate columns repeat on every row of the candidate. Review choices are in
  // `review_status` only; positions and times are never changed by them. A candidate is a candidate, not a detection.
  function candidatesCsv(series, candidates) {
    const rows = [csvColumns.map(csvCell).join(",")];
    for (const candidate of candidates) {
      const evaluated = evaluateCandidate(series, candidate);
      const { track, points } = evaluated;
      const rate = track.ok ? track.rate : null;
      for (const point of points) {
        const time = point.time;
        const cells = [
          candidate.id, reviewText[candidate.status] ?? candidate.status, candidate.origin, point.id, point.entry.isReference ? "reference" : "epoch",
          point.epoch.meta.obsId ?? "", point.epoch.name ?? "", point.epoch.meta.hduIndex !== null && point.epoch.meta.hduIndex !== undefined ? point.epoch.meta.hduIndex + " " + (point.epoch.meta.hduName ?? "") : "",
          time ? time.iso : "", time ? fixed(time.mjd, 8) : null, time ? time.scale : "", time ? time.sourceLabel : "",
          fixed(point.x, 3), fixed(point.y, 3), point.method, fixed(point.ra, 8), fixed(point.dec, 8),
          point.source ? fixed(point.source.x, 3) : null, point.source ? fixed(point.source.y, 3) : null,
          fixed(point.east, 4), fixed(point.north, 4), fixed(point.residual, 4),
          points.length, track.ok ? fixed(track.displacement.arcsec, 4) : null, track.ok ? fixed(track.displacement.pa, 3) : null,
          track.ok && track.deltaTHours !== undefined ? fixed(track.deltaTHours, 6) : null,
          rate ? significant(rate.speed, 6) : null, rate ? significant(rate.perDay, 6) : null, rate ? fixed(rate.pa, 3) : null, rate ? rate.method : "",
          rate ? significant(rate.sigmaEast, 4) : null, rate ? significant(rate.sigmaNorth, 4) : null,
          track.ok ? track.rateReason : track.reason,
          diffLib.direction.ascii, series.settings.referenceObsId ?? "", series.settings.method, series.settings.thresholdText,
          candidate.reasons.join(" | "),
        ];
        rows.push(cells.map(csvCell).join(","));
      }
    }
    return rows.join("\r\n") + "\r\n";
  }

  const api = {
    defaults, modeText, csvColumns,
    bearing, compassDirection, fitTrack, robustSigma,
    detectResiduals, refineCentroid, pairResiduals, linkPairs, useKernel,
    buildEpoch, withManualTime, epochTime, defaultReference, analyzeSeries,
    newCandidate, setPosition, evaluateCandidate, candidatesCsv, csvCell,
  };
  root.AstroNotMotion = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);
