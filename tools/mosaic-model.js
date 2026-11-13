// Mosaic model for AstroNot Mosaic Builder.
//
// UI-independent: no DOM access. Loads as a classic browser script (global `AstroNotMosaic`) and as a CommonJS module.
// It needs tools/wcs.js (global `AstroNotWcs`), tools/pair.js (global `AstroNotPair`) and tools/difference.js (global
// `AstroNotDifference`) for every sky, unit and resampling computation. The bilinear reprojection is the one of
// difference.js (`reprojectBilinear`), called on the output grid; nothing of those files is copied or changed here.
//
// WHAT IT DOES
//   Combines two or more FITS images that overlap on the sky into one image on a common TAN grid.
//   - Inputs: { name, meta (pair.describeObservation), width, height, values (calibrated Float64Array, NaN = invalid),
//     wcs (wcs.js object or null), wcsReason, unit (BUNIT), fields (HDU header fields), variance?, varianceUnit?,
//     mask? (Uint8Array, non-zero = masked), fingerprint?, wavelengthAt? ((ra, dec) => { micron, bandwidth } | null),
//     wavelength? (summary of pair.wavelengthSummary) }.
//   - Units: every input must have the same BUNIT, or differ only by a Jy prefix (kJy/sr, MJy/sr: converted explicitly with
//     the factor shown). Values are treated as SURFACE BRIGHTNESS (or another intensive quantity): resampling interpolates
//     and averages them; it never sums them. Flux per pixel, counts, DN, electrons and Jy/beam would need an area (or beam)
//     scaling that this tool does not do, so they are refused with the reason.
//   - Bands: SPHEREx cutouts carry a per-pixel wavelength lookup; the wavelength of every input is evaluated at the SAME
//     sky positions (the overlap) and must agree within one bandwidth. Files with a FILTER or BAND keyword must agree on it.
//   - Output grid: either `auto` (TAN projection centred on the union of the input footprints, north up, pixel scale =
//     the finest input scale unless set, size from the footprint union) or `reference` (the WCS of one input, extended by
//     whole pixels so that input is not resampled where it lies on the grid). RA 0/360 wrap and rotated inputs are
//     handled because every footprint is projected through the WCS; the size and a memory estimate are checked BEFORE any
//     array is allocated, and a smaller field or a coarser scale is suggested when a limit is exceeded.
//   - Resampling: bilinear interpolation of surface brightness through both WCS (the sampling of reproject_interp with
//     order='bilinear'). When the output pixels are more than 1.25 times the input pixels, n x n bilinear samples inside
//     each output pixel are averaged (n = ceil of the ratio, at most 8) so that fine inputs are not aliased; a pixel is then
//     valid only when every sample is valid.
//   - Combination: `mean` (equal weights) or `inverse-variance` (weights 1 / variance of the reprojected input; needs a
//     variance image with matching units in every input). A pixel is valid where at least one input contributes. The
//     coverage map counts the contributing inputs; pixels covered by none stay NaN and are masked.
//   - Variance of the result: 1 / sum(w) for inverse-variance weights; sum(variance) / n^2 for the equal-weight mean (when
//     every input has variance). These assume independent errors; bilinear resampling correlates neighbouring pixels.
//
// PIXEL CONVENTION: arrays are FITS order (row 0 is the bottom row, x runs fastest); positions given to wcs.js are FITS
// coordinates (1-based pixel centres). Display colours never enter any computation here.
(function (root) {
  "use strict";

  const wcsLib = typeof module === "object" && module.exports ? require("./wcs.js") : root.AstroNotWcs;
  const pairLib = typeof module === "object" && module.exports ? require("./pair.js") : root.AstroNotPair;
  const diffLib = typeof module === "object" && module.exports ? require("./difference.js") : root.AstroNotDifference;

  const limits = {
    maxInputs: 24,
    maxPixels: 4194304, // Same as the FITS Viewer: the result must open there.
    maxAxis: 4096,
    memoryBytes: 256 * 1024 * 1024,
  };
  const supersampleRatio = 1.25; // Output pixel / input pixel above which sub-samples are averaged.
  const maxSupersample = 8;
  const maxFieldDegrees = 75; // Farthest footprint point from the tangent point.
  const bandRows = 30000; // Output pixels per reprojection step (keeps the page responsive).

  function isNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function refuse(code, reason, extra = {}) {
    return Object.assign({ ok: false, code, reason }, extra);
  }

  function significant(value, digits = 4) {
    return Number(value.toPrecision(digits));
  }

  // ---- Units ---------------------------------------------------------------------------------------------------------
  // kind: "surface-brightness" (per steradian or per angular area), "intensive" (another per-area quantity, e.g. K),
  // "extensive" (per pixel, counts, bare Jy: needs area scaling), "beam" (Jy/beam), or "missing".
  function classifyUnit(unit) {
    const canonical = diffLib.canonicalUnit(unit);
    if (!canonical) return { kind: "missing", unit: null, ok: false, reason: "BUNIT is missing, so the physical quantity is not known." };
    const perPixel = /(^|[/\s*])(pix|pixel|pixels|px)(\b|$)/i.test(canonical);
    const counts = /^(DN|ADU|adu|count|counts|ct|electrons?|e-|photons?)(\b|\/s|$)/.test(canonical);
    const bareJy = /^[GMkmuμµn]?Jy$/.test(canonical);
    if (perPixel || counts || bareJy) {
      return {
        kind: "extensive", unit: canonical, ok: false,
        reason: "The unit " + canonical + " is a flux or count per pixel (or per image), not a surface brightness. Resampling it needs an area scaling that this tool does not do, so only surface-brightness units such as MJy/sr are supported.",
      };
    }
    if (/\/\s*beam\b/i.test(canonical)) {
      return { kind: "beam", unit: canonical, ok: false, reason: "The unit " + canonical + " depends on the beam area, which can differ between inputs. Convert to a surface brightness (for example MJy/sr) first." };
    }
    if (/(\/|^)\(?(sr|str|arcsec|arcmin|deg)(\^?2|\*\*2|2)?\)?/i.test(canonical) || /\bsr\b/.test(canonical)) {
      return { kind: "surface-brightness", unit: canonical, ok: true, reason: "" };
    }
    return { kind: "intensive", unit: canonical, ok: true, reason: "The unit " + canonical + " is not recognised as a surface brightness. It is averaged as an intensive (per-area) quantity; check that this is correct for your data." };
  }

  // Unit plan for all inputs: the output unit is the unit of the first input; every other input is converted to it.
  function planUnits(inputs) {
    const first = classifyUnit(inputs[0].unit);
    const names = (index) => inputs[index].name ?? "input " + (index + 1);
    for (let index = 0; index < inputs.length; index++) {
      const kind = classifyUnit(inputs[index].unit);
      if (kind.kind === "missing") return refuse("unit-missing", names(index) + ": " + kind.reason + " Inputs without a BUNIT cannot be shown to be in the same unit.", { input: index });
      if (!kind.ok) return refuse("unit-unsupported", names(index) + ": " + kind.reason, { input: index });
    }
    const unit = diffLib.canonicalUnit(inputs[0].unit);
    const factors = [];
    const notes = [];
    for (let index = 0; index < inputs.length; index++) {
      const conversion = diffLib.unitConversion(inputs[index].unit, inputs[0].unit);
      if (!conversion.ok) {
        return refuse("unit-mismatch", names(index) + " is in " + diffLib.canonicalUnit(inputs[index].unit) + " but " + names(0) + " is in " + unit + ". Only identical units or Jy prefixes (for example kJy/sr and MJy/sr) are converted; other units are not combined.", { input: index });
      }
      factors.push(conversion.factor);
      if (conversion.state === "scaled") notes.push(names(index) + ": converted from " + diffLib.canonicalUnit(inputs[index].unit) + " to " + unit + " (× " + significant(conversion.factor, 6) + ").");
    }
    if (first.kind === "intensive") notes.push(first.reason);
    return { ok: true, unit, unitText: String(inputs[0].unit).trim(), factors, notes, kind: first.kind };
  }

  // ---- Duplicates ----------------------------------------------------------------------------------------------------
  function fingerprintOf(input) {
    return input.fingerprint ?? pairLib.fingerprintValues(input.values);
  }

  function findDuplicate(inputs) {
    for (let a = 0; a < inputs.length; a++) {
      for (let b = a + 1; b < inputs.length; b++) {
        const first = inputs[a];
        const second = inputs[b];
        if (fingerprintOf(first) === fingerprintOf(second)) {
          return { a, b, reason: (first.name ?? "Input " + (a + 1)) + " and " + (second.name ?? "Input " + (b + 1)) + " contain identical pixel values, so they are the same observation. A duplicate would count twice in the average; remove one of them." };
        }
        const m1 = first.meta ?? {};
        const m2 = second.meta ?? {};
        if (m1.obsId && m1.obsId === m2.obsId && m1.detector === m2.detector && m1.hduName === m2.hduName && first.width === second.width && first.height === second.height) {
          const t1 = m1.time && m1.time.valid ? m1.time.mjd : null;
          const t2 = m2.time && m2.time.valid ? m2.time.mjd : null;
          if (t1 === t2) {
            // Same observation, detector and HDU. A cutout of another position would have another WCS, so look at it.
            const sameSky = first.wcs && second.wcs && pairLib.gridCompatibility(first, second, 0.01).ok;
            if (sameSky) return { a, b, reason: (first.name ?? "Input " + (a + 1)) + " and " + (second.name ?? "Input " + (b + 1)) + " are the same observation (" + m1.obsId + ", detector " + m1.detector + ") on the same pixel grid. Remove one of them." };
          }
        }
      }
    }
    return null;
  }

  // ---- Bands ---------------------------------------------------------------------------------------------------------
  // Wavelength sampler for one input from its per-pixel lookup (SPHEREx WCS-WAVE): (ra, dec) => { micron, bandwidth } | null.
  function wavelengthSampler(table, fields, wcs) {
    if (!table || !fields || !wcs) return null;
    return (ra, dec) => {
      const at = wcs.skyToPixel(ra, dec);
      return at ? pairLib.wavelengthAt(table, fields, at.x, at.y) : null;
    };
  }

  function insideInput(input, ra, dec) {
    const at = input.wcs.skyToPixel(ra, dec);
    return at && wcsLib.insideImage(at.x, at.y, input.width, input.height) ? at : null;
  }

  // Compares the spectral coverage of all inputs. The wavelength of two inputs is evaluated at the same sky positions
  // (a lattice over each overlap), and they agree when the largest difference is within the larger of the two bandwidths.
  // Inputs that do not overlap are compared at their centres. Returns { state: "same" | "different" | "unknown", pairs, notes }.
  function checkBands(inputs) {
    const notes = [];
    const pairs = [];
    let different = null;
    let known = 0;
    const filterOf = (input) => (input.meta && input.meta.filter) ? String(input.meta.filter).trim() : null;
    const filters = inputs.map(filterOf);
    if (filters.every(Boolean) && new Set(filters).size > 1) {
      return { state: "different", pairs, notes, reason: "The inputs name different bands or filters (" + [...new Set(filters)].join(", ") + "). A mosaic combines images of the same band." };
    }
    for (let a = 0; a < inputs.length; a++) {
      for (let b = a + 1; b < inputs.length; b++) {
        const first = inputs[a];
        const second = inputs[b];
        if (!first.wavelengthAt || !second.wavelengthAt || !first.wcs || !second.wcs) continue;
        known++;
        let worst = -1;
        let limit = 0;
        let samples = 0;
        const steps = 11;
        for (let row = 0; row < steps; row++) {
          for (let column = 0; column < steps; column++) {
            const sky = first.wcs.pixelToSky(0.5 + (column + 0.5) / steps * first.width, 0.5 + (row + 0.5) / steps * first.height);
            if (!sky || !insideInput(second, sky.ra, sky.dec)) continue;
            const one = first.wavelengthAt(sky.ra, sky.dec);
            const two = second.wavelengthAt(sky.ra, sky.dec);
            if (!one || !two) continue;
            samples++;
            const gap = Math.abs(one.micron - two.micron);
            if (gap > worst) {
              worst = gap;
              limit = Math.max(one.bandwidth, two.bandwidth);
            }
          }
        }
        let basis = "overlap";
        if (!samples) {
          basis = "centres";
          const ca = first.wcs.pixelToSky((first.width + 1) / 2, (first.height + 1) / 2);
          const cb = second.wcs.pixelToSky((second.width + 1) / 2, (second.height + 1) / 2);
          const one = ca && first.wavelengthAt(ca.ra, ca.dec);
          const two = cb && second.wavelengthAt(cb.ra, cb.dec);
          if (!one || !two) continue;
          worst = Math.abs(one.micron - two.micron);
          limit = Math.max(one.bandwidth, two.bandwidth);
        }
        const entry = { a, b, maxDifference: worst, limit, basis, same: worst <= limit };
        pairs.push(entry);
        if (!entry.same && !different) different = entry;
      }
    }
    if (different) {
      const names = [inputs[different.a].name ?? "input " + (different.a + 1), inputs[different.b].name ?? "input " + (different.b + 1)];
      return {
        state: "different", pairs, notes,
        reason: names[0] + " and " + names[1] + " differ by up to " + significant(different.maxDifference, 3) + " μm in wavelength " +
          (different.basis === "overlap" ? "at the same sky positions" : "at their centres") + ", more than one bandwidth (" + significant(different.limit, 3) +
          " μm). They are different spectral bands, so their brightness is not directly comparable and a mosaic would mix wavelengths.",
      };
    }
    if (known) {
      const worst = Math.max(...pairs.map((entry) => entry.maxDifference));
      notes.push("Wavelength was evaluated at the same sky positions in every overlapping pair; the largest difference is " + significant(worst, 3) + " μm, within one bandwidth.");
      return { state: "same", pairs, notes };
    }
    notes.push("The wavelength of the inputs could not be compared (no per-pixel wavelength table or BAND/FILTER keyword in every input), so their spectral coverage is not verified.");
    return { state: "unknown", pairs, notes };
  }

  // ---- Footprints and the output grid -------------------------------------------------------------------------------------
  // Sky points along the pixel edges of an input (x and y from 0.5 to size + 0.5). Null when the WCS fails.
  function footprintSky(input, perSide = 24) {
    const points = [];
    const { width, height, wcs } = input;
    const add = (x, y) => {
      const sky = wcs.pixelToSky(x, y);
      if (!sky) return false;
      points.push(sky);
      return true;
    };
    // Sequential around the boundary (bottom, right, top, left), so the points also draw the outline.
    for (let step = 0; step < perSide; step++) if (!add(0.5 + step / perSide * width, 0.5)) return null;
    for (let step = 0; step < perSide; step++) if (!add(width + 0.5, 0.5 + step / perSide * height)) return null;
    for (let step = 0; step < perSide; step++) if (!add(width + 0.5 - step / perSide * width, height + 0.5)) return null;
    for (let step = 0; step < perSide; step++) if (!add(0.5, height + 0.5 - step / perSide * height)) return null;
    return points;
  }

  function unitVector(ra, dec) {
    const a = ra * Math.PI / 180;
    const d = dec * Math.PI / 180;
    return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
  }

  function meanDirection(points) {
    let x = 0;
    let y = 0;
    let z = 0;
    for (const point of points) {
      const [ux, uy, uz] = unitVector(point.ra, point.dec);
      x += ux;
      y += uy;
      z += uz;
    }
    const norm = Math.hypot(x, y, z);
    if (!(norm > 1e-9)) return null;
    return { ra: wcsLib.normalizeRa(Math.atan2(y, x) * 180 / Math.PI), dec: Math.asin(Math.max(-1, Math.min(1, z / norm))) * 180 / Math.PI };
  }

  const gridKeys = /^(WCSAXES|CTYPE[12]|CUNIT[12]|CRPIX[12]|CRVAL[12]|CDELT[12]|CD[12]_[12]|PC[12]_[12]|LONPOLE|LATPOLE|RADESYS|EQUINOX|A_\d+_\d+|B_\d+_\d+|AP_\d+_\d+|BP_\d+_\d+|[AB]P?_ORDER|A_DMAX|B_DMAX)$/;

  function northUpFields(ra, dec, crpix, scaleDegrees) {
    return {
      WCSAXES: 2, CTYPE1: "RA---TAN", CTYPE2: "DEC--TAN", CUNIT1: "deg", CUNIT2: "deg",
      CRVAL1: ra, CRVAL2: dec, CRPIX1: crpix[0], CRPIX2: crpix[1],
      CD1_1: -scaleDegrees, CD1_2: 0, CD2_1: 0, CD2_2: scaleDegrees, LONPOLE: 180, RADESYS: "ICRS",
    };
  }

  // Approximate memory needed (bytes) for a mosaic of `width x height` pixels from the given inputs.
  function estimateMemory(width, height, inputs, options = {}) {
    const pixels = width * height;
    const withVariance = Boolean(options.variance);
    const perPixel =
      8 /* mosaic */ + 1 /* mask */ + 2 /* coverage */ + (withVariance ? 8 : 0) +
      (options.mode === "inverse-variance" ? 8 : 0) + (withVariance && options.mode !== "inverse-variance" ? 8 : 0) +
      8 /* two preview pictures */ + (8 + 1 + 2 + (withVariance ? 8 : 0)) /* FITS export buffer */;
    let inputBytes = 0;
    for (const input of inputs) inputBytes += input.width * input.height * (8 + (input.variance ? 8 : 0) + (input.mask ? 1 : 0));
    return { outputBytes: pixels * perPixel, inputBytes, bytes: pixels * perPixel + inputBytes, perPixel };
  }

  function megabytes(bytes) {
    return (Math.round(bytes / 104857.6) / 10).toLocaleString("en-US") + " MB";
  }

  function roundUp3(value) {
    const magnitude = 10 ** (Math.floor(Math.log10(value)) - 2);
    return Math.ceil(value / magnitude - 1e-9) * magnitude;
  }

  // What would make an oversize output fit: a coarser scale (auto grid; sizes taken from the footprint union) and a smaller
  // central field (sizes as requested).
  function suggestForSize(width, height, autoSize, scaleArcsec, inputs, options, cap) {
    const fits = (w, h) => w >= 1 && h >= 1 && w <= limits.maxAxis && h <= limits.maxAxis && w * h <= limits.maxPixels &&
      estimateMemory(w, h, inputs, options).bytes <= cap;
    const suggestion = { scaleArcsec: null, scaleSize: null, field: null };
    if (!options.referenceGrid && isNumber(scaleArcsec)) {
      let candidate = scaleArcsec * Math.max(1, autoSize.width / limits.maxAxis, autoSize.height / limits.maxAxis, Math.sqrt(autoSize.width * autoSize.height / limits.maxPixels));
      for (let tries = 0; tries < 400; tries++) {
        candidate = roundUp3(candidate);
        const w = Math.max(1, Math.ceil(autoSize.width * scaleArcsec / candidate - 1e-9));
        const h = Math.max(1, Math.ceil(autoSize.height * scaleArcsec / candidate - 1e-9));
        if (fits(w, h)) {
          suggestion.scaleArcsec = Number(candidate.toPrecision(3));
          suggestion.scaleSize = { width: w, height: h };
          break;
        }
        candidate *= 1.02;
      }
    }
    let shrink = Math.min(1, limits.maxAxis / width, limits.maxAxis / height, Math.sqrt(limits.maxPixels / (width * height)));
    for (let tries = 0; tries < 200; tries++) {
      const w = Math.max(1, Math.floor(width * shrink));
      const h = Math.max(1, Math.floor(height * shrink));
      if (fits(w, h)) {
        suggestion.field = { width: w, height: h };
        break;
      }
      shrink *= 0.95;
    }
    return suggestion;
  }

  // planGrid(inputs, options)
  //   options: { gridMode: "auto" | "reference", referenceIndex, scaleArcsec (auto only), width, height (centred override),
  //              variance (bool, for the memory estimate), mode, maxPixels, memoryBytes }
  // Returns { ok: true, grid } or { ok: false, code, reason, suggestion? }. grid = { width, height, wcs, wcsFields, scaleArcsec,
  // center: { ra, dec }, mode, referenceIndex, pixels, memory, inputScales, finestScale, outlines (per input, output FITS
  // coordinates) }. No pixel array is allocated.
  function planGrid(inputs, options = {}) {
    const cap = options.memoryBytes ?? limits.memoryBytes;
    const maxPixels = options.maxPixels ?? limits.maxPixels;
    for (let index = 0; index < inputs.length; index++) {
      if (!inputs[index].wcs) {
        return refuse("no-wcs", (inputs[index].name ?? "Input " + (index + 1)) + " has no usable WCS" + (inputs[index].wcsReason ? " (" + inputs[index].wcsReason + ")" : "") + ", so it cannot be placed on the sky.", { input: index });
      }
    }
    const skies = [];
    for (let index = 0; index < inputs.length; index++) {
      const points = footprintSky(inputs[index]);
      if (!points) return refuse("footprint", (inputs[index].name ?? "Input " + (index + 1)) + ": the WCS failed at the image boundary, so its sky footprint is unknown.", { input: index });
      skies.push(points);
    }
    const all = skies.flat();
    const scales = inputs.map((input) => pairLib.pixelScaleArcsec(input.wcs, input.width, input.height));
    if (scales.some((scale) => !isNumber(scale) || !(scale > 0))) return refuse("scale-unavailable", "The pixel scale of an input could not be computed from its WCS.");
    const finest = Math.min(...scales);
    const reference = options.gridMode === "reference";
    let fields;
    let scale;
    let wcs;
    let width;
    let height;
    let center;
    const overrideWidth = options.width ? Number(options.width) : null;
    const overrideHeight = options.height ? Number(options.height) : null;
    for (const [label, value] of [["width", overrideWidth], ["height", overrideHeight]]) {
      if (value !== null && !(Number.isInteger(value) && value >= 1)) return refuse("bad-size", "The output " + label + " must be a whole number of pixels, at least 1.");
    }

    if (reference) {
      const index = options.referenceIndex ?? 0;
      const base = inputs[index];
      if (!base || !base.fields) return refuse("no-reference", "The reference input has no header, so its WCS cannot be reused as the output grid.");
      if (options.scaleArcsec) return refuse("scale-fixed", "The pixel scale is fixed by the reference WCS (" + significant(scales[index], 4) + " arcsec). Switch to the automatic grid to choose a scale.");
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      for (const sky of all) {
        const at = base.wcs.skyToPixel(sky.ra, sky.dec);
        if (!at) return refuse("field-too-large", "Part of the footprint union cannot be mapped onto the reference WCS (it lies too far from the reference field).");
        x0 = Math.min(x0, at.x); x1 = Math.max(x1, at.x); y0 = Math.min(y0, at.y); y1 = Math.max(y1, at.y);
      }
      let shiftX = Math.floor(x0 - 0.5 + 1e-6);
      let shiftY = Math.floor(y0 - 0.5 + 1e-6);
      width = Math.max(1, Math.ceil(x1 - 0.5 - shiftX - 1e-6));
      height = Math.max(1, Math.ceil(y1 - 0.5 - shiftY - 1e-6));
      scale = scales[index];
      if (overrideWidth || overrideHeight) {
        const newWidth = overrideWidth ?? width;
        const newHeight = overrideHeight ?? height;
        shiftX += Math.round((width - newWidth) / 2);
        shiftY += Math.round((height - newHeight) / 2);
        width = newWidth;
        height = newHeight;
      }
      fields = {};
      for (const key of Object.keys(base.fields)) if (gridKeys.test(key) && base.fields[key] !== undefined) fields[key] = base.fields[key];
      fields.CRPIX1 = base.fields.CRPIX1 - shiftX;
      fields.CRPIX2 = base.fields.CRPIX2 - shiftY;
      if (fields.WCSAXES === undefined) fields.WCSAXES = 2;
      const made = wcsLib.createWcs(fields);
      if (!made.ok) return refuse("bad-reference", "The reference WCS cannot be reused: " + made.reason);
      wcs = made.wcs;
      const middle = wcs.pixelToSky((width + 1) / 2, (height + 1) / 2);
      center = middle ?? meanDirection(all);
    } else {
      scale = options.scaleArcsec ? Number(options.scaleArcsec) : finest;
      if (!isNumber(scale) || !(scale > 0)) return refuse("bad-scale", "The output pixel scale must be a number greater than zero (arcsec per pixel).");
      const degrees = scale / 3600;
      center = meanDirection(all);
      if (!center) return refuse("field-too-large", "The footprints surround the sky so evenly that no common tangent point exists. Choose inputs from one region.");
      let bounds = null;
      for (let pass = 0; pass < 4; pass++) {
        const trial = wcsLib.createWcs(northUpFields(center.ra, center.dec, [0, 0], degrees));
        if (!trial.ok) return refuse("bad-grid", trial.reason);
        bounds = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
        for (const sky of all) {
          const far = wcsLib.angularSeparation(center.ra, center.dec, sky.ra, sky.dec);
          const at = far < maxFieldDegrees ? trial.wcs.skyToPixel(sky.ra, sky.dec) : null;
          if (!at) {
            return refuse("field-too-large", "The inputs span more than " + maxFieldDegrees + "° from their common centre, which a single TAN grid cannot represent. Choose inputs from a smaller region.");
          }
          bounds.x0 = Math.min(bounds.x0, at.x); bounds.x1 = Math.max(bounds.x1, at.x);
          bounds.y0 = Math.min(bounds.y0, at.y); bounds.y1 = Math.max(bounds.y1, at.y);
        }
        const middle = trial.wcs.pixelToSky((bounds.x0 + bounds.x1) / 2, (bounds.y0 + bounds.y1) / 2);
        if (!middle) return refuse("bad-grid", "The footprint centre could not be computed.");
        center = middle;
      }
      // Final bounds around the final tangent point.
      const final = wcsLib.createWcs(northUpFields(center.ra, center.dec, [0, 0], degrees)).wcs;
      bounds = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
      for (const sky of all) {
        const at = final.skyToPixel(sky.ra, sky.dec);
        if (!at) return refuse("field-too-large", "The footprints cannot be projected onto one TAN grid.");
        bounds.x0 = Math.min(bounds.x0, at.x); bounds.x1 = Math.max(bounds.x1, at.x);
        bounds.y0 = Math.min(bounds.y0, at.y); bounds.y1 = Math.max(bounds.y1, at.y);
      }
      width = Math.max(1, Math.ceil(bounds.x1 - bounds.x0 - 1e-6));
      height = Math.max(1, Math.ceil(bounds.y1 - bounds.y0 - 1e-6));
      const autoWidth = width;
      const autoHeight = height;
      if (overrideWidth) width = overrideWidth;
      if (overrideHeight) height = overrideHeight;
      const crpix = [(width + 1) / 2 - (bounds.x0 + bounds.x1) / 2, (height + 1) / 2 - (bounds.y0 + bounds.y1) / 2];
      fields = northUpFields(center.ra, center.dec, crpix, degrees);
      const made = wcsLib.createWcs(fields);
      if (!made.ok) return refuse("bad-grid", made.reason);
      wcs = made.wcs;
      if (!Number.isFinite(width) || !Number.isFinite(height)) return refuse("field-too-large", "The output size could not be computed.");
      // Keep what the footprint union alone would need, to explain a user override.
      options = Object.assign({}, options, { autoSize: { width: autoWidth, height: autoHeight } });
    }

    const memory = estimateMemory(width, height, inputs, { variance: options.variance, mode: options.mode, referenceGrid: reference });
    const base = { width, height, scaleArcsec: scale, pixels: width * height, memory, center, mode: reference ? "reference" : "auto" };
    if (memory.inputBytes > cap) {
      return refuse("inputs-too-large", "The selected inputs alone need about " + megabytes(memory.inputBytes) + " of memory, above the " + megabytes(cap) + " limit. Remove an input or choose smaller image HDUs.", { grid: base });
    }
    const exceeds = [];
    if (width > limits.maxAxis || height > limits.maxAxis) exceeds.push("an axis is longer than " + limits.maxAxis.toLocaleString("en-US") + " pixels");
    if (width * height > maxPixels) exceeds.push("it has more than " + maxPixels.toLocaleString("en-US") + " pixels");
    if (memory.bytes > cap) exceeds.push("it needs about " + megabytes(memory.bytes) + " of memory (limit " + megabytes(cap) + ")");
    if (exceeds.length) {
      const suggestion = suggestForSize(width, height, options.autoSize ?? { width, height }, scale, inputs, { variance: options.variance, mode: options.mode, referenceGrid: reference }, cap);
      return refuse("too-large", "The mosaic would be " + width.toLocaleString("en-US") + " × " + height.toLocaleString("en-US") + " pixels at " + significant(scale, 4) + " arcsec per pixel: " + exceeds.join(" and ") + ". " +
        (suggestion.scaleArcsec ? "A coarser scale of " + suggestion.scaleArcsec + " arcsec per pixel gives " + suggestion.scaleSize.width + " × " + suggestion.scaleSize.height + " pixels. " : "") +
        (suggestion.field ? "Or limit the field to the central " + suggestion.field.width + " × " + suggestion.field.height + " pixels." : "Choose fewer or smaller inputs."),
      { grid: base, suggestion });
    }

    const outlines = skies.map((points) => points.map((sky) => {
      const at = wcs.skyToPixel(sky.ra, sky.dec);
      return at ? [at.x, at.y] : null;
    }).filter(Boolean));
    return {
      ok: true,
      grid: Object.assign(base, {
        wcs, wcsFields: fields, referenceIndex: reference ? (options.referenceIndex ?? 0) : null,
        inputScales: scales, finestScale: finest, outlines, autoSize: options.autoSize ?? null,
      }),
    };
  }

  // ---- Footprint summary for the list ---------------------------------------------------------------------------------------
  // Centre, size (arcmin along the image axes), position angle of +y east of north, pixel scale and corner sky range.
  function describeFootprint(input) {
    if (!input.wcs) return null;
    const { wcs, width, height } = input;
    const cx = (width + 1) / 2;
    const cy = (height + 1) / 2;
    const centre = wcs.pixelToSky(cx, cy);
    const up = wcs.pixelToSky(cx, cy + 1);
    if (!centre || !up) return null;
    const dRa = ((up.ra - centre.ra + 540) % 360 - 180) * Math.cos(centre.dec * Math.PI / 180);
    const angle = Math.atan2(dRa, up.dec - centre.dec) * 180 / Math.PI; // position angle of +y, east of north
    const left = wcs.pixelToSky(0.5, cy);
    const right = wcs.pixelToSky(width + 0.5, cy);
    const bottom = wcs.pixelToSky(cx, 0.5);
    const top = wcs.pixelToSky(cx, height + 0.5);
    const sep = (a, b) => (a && b ? wcsLib.angularSeparation(a.ra, a.dec, b.ra, b.dec) * 60 : null);
    return {
      center: centre, widthArcmin: sep(left, right), heightArcmin: sep(bottom, top),
      rotationDegrees: Math.round(angle * 100) / 100, scaleArcsec: pairLib.pixelScaleArcsec(wcs, width, height),
    };
  }

  // Pairs of inputs whose footprints overlap, with the connected groups they form. Sampled (15 x 15 per image), so a very
  // thin overlap can be missed; the coverage map of a built mosaic is the exact answer.
  function connectivity(inputs) {
    const count = inputs.length;
    const parent = Array.from({ length: count }, (_, index) => index);
    const find = (index) => (parent[index] === index ? index : (parent[index] = find(parent[index])));
    const pairs = [];
    for (let a = 0; a < count; a++) {
      for (let b = a + 1; b < count; b++) {
        if (!inputs[a].wcs || !inputs[b].wcs) continue;
        const overlap = pairLib.skyOverlap(inputs[a], inputs[b], 15);
        if (overlap.state !== "none" && overlap.state !== "unavailable") {
          pairs.push({ a, b, state: overlap.state, shareA: overlap.referenceCovered, shareB: overlap.comparisonCovered });
          parent[find(a)] = find(b);
        }
      }
    }
    const groups = new Map();
    for (let index = 0; index < count; index++) {
      const key = find(index);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(index);
    }
    return { pairs, groups: [...groups.values()] };
  }

  // ---- Reprojection onto the output grid ----------------------------------------------------------------------------------
  function samplingFor(outputScale, inputScale) {
    const ratio = outputScale / inputScale;
    const n = ratio > supersampleRatio ? Math.min(maxSupersample, Math.ceil(ratio - 1e-9)) : 1;
    return { ratio, n, undersampled: ratio > maxSupersample };
  }

  // Reprojects a window (columns c0..c0+cols-1, rows r0..r0+rows-1 of the output grid, zero based) of `source` using
  // difference.js. Returns { values, variance, state } for the window, with n x n sub-samples per output pixel when n > 1.
  // state: Diff.status.valid (0), outside (1), targetInvalid (3).
  function reprojectWindow(source, grid, c0, r0, cols, rows, n) {
    const count = cols * rows;
    const make = (dx, dy) => diffLib.reprojectBilinear(source, {
      width: cols, height: rows,
      wcs: { pixelToSky: (x, y) => grid.wcs.pixelToSky(x + c0 + dx, y + r0 + dy) },
      kernelBase: { wcs: grid.wcs, x: c0, y: r0, dx, dy }, // The same offsets, in a form the WebAssembly kernel can apply.
    });
    if (n === 1) return make(0, 0);
    const values = new Float64Array(count);
    const variance = source.variance ? new Float64Array(count) : null;
    const state = new Uint8Array(count);
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        const part = make((a + 0.5) / n - 0.5, (b + 0.5) / n - 0.5);
        for (let index = 0; index < count; index++) {
          const s = part.status[index];
          if (s !== diffLib.status.valid) {
            // Any sample outside the input makes the whole pixel "outside"; an invalid neighbour makes it invalid.
            if (s === diffLib.status.outside) state[index] = diffLib.status.outside;
            else if (state[index] !== diffLib.status.outside) state[index] = diffLib.status.targetInvalid;
            continue;
          }
          values[index] += part.values[index];
          if (variance) variance[index] += part.variance[index];
        }
      }
    }
    const total = n * n;
    for (let index = 0; index < count; index++) {
      if (state[index] === diffLib.status.valid) {
        values[index] /= total;
        // Samples of one input are correlated, so the variance of the average lies between mean/total and mean. The upper
        // value (the mean of the sample variances) is used: it never overstates the weight of the input.
        if (variance) variance[index] /= total;
      } else {
        values[index] = NaN;
        if (variance) variance[index] = NaN;
      }
    }
    return { values, variance, status: state };
  }

  function bounding(outline, grid) {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const [x, y] of outline) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const margin = 3 + 0.03 * Math.max(x1 - x0, y1 - y0);
    return {
      c0: Math.max(0, Math.floor(x0 - 1 - margin)), c1: Math.min(grid.width - 1, Math.ceil(x1 - 1 + margin)),
      r0: Math.max(0, Math.floor(y0 - 1 - margin)), r1: Math.min(grid.height - 1, Math.ceil(y1 - 1 + margin)),
    };
  }

  function sourceOf(input, variance) {
    // keepInKernel: every window of this input reuses one upload into the WebAssembly kernel (see difference.js useKernel).
    return { width: input.width, height: input.height, wcs: input.wcs, values: input.values, variance, mask: input.mask, keepInKernel: true };
  }

  // difference.js accepts "(MJy/sr)^2" and "MJy^2/sr^2"; SPHEREx writes the variance unit as "MJy2 / sr2". That spelling of the
  // square of a Jy-family unit is accepted here as well, so the real cutouts can be weighted.
  function varianceUnitCheck(varianceUnit, unit) {
    const base = diffLib.varianceUnitCheck(varianceUnit, unit);
    if (base.ok) return base;
    const v = diffLib.canonicalUnit(varianceUnit);
    const u = diffLib.canonicalUnit(unit);
    const parts = u && /^([GMkmuμµn]?Jy)(?:\/(.+))?$/.exec(u);
    if (v && parts) {
      const squared = parts[1] + "2" + (parts[2] ? "/" + parts[2] + "2" : "");
      if (v === squared) return { ok: true, assumed: false, reason: "" };
    }
    return base;
  }

  // ---- Variance availability ------------------------------------------------------------------------------------------------
  function varianceAvailability(inputs) {
    const reasons = [];
    for (let index = 0; index < inputs.length; index++) {
      const input = inputs[index];
      const name = input.name ?? "Input " + (index + 1);
      if (!input.variance) {
        reasons.push(name + " has no VARIANCE image");
        continue;
      }
      if (input.variance.length !== input.width * input.height) {
        reasons.push(name + ": the variance image does not match the image size");
        continue;
      }
      const check = varianceUnitCheck(input.varianceUnit, input.unit);
      if (!check.ok) reasons.push(name + ": " + check.reason);
    }
    return reasons.length ? { ok: false, reason: "Inverse-variance weighting needs a VARIANCE image in matching units in every input. " + reasons.join("; ") + "." } : { ok: true, reason: "" };
  }

  // ---- The mosaic ----------------------------------------------------------------------------------------------------------
  // Every check that needs no pixel computation: input count and arrays, duplicates, units, bands, variance availability and
  // the output grid with its size and memory limits. Returns { ok: false, code, reason, ... } or
  // { ok: true, inputs (normalised), mode, units, bands, available, useVariance, plan, grid }.
  function preflight(inputs, options = {}) {
    if (!Array.isArray(inputs) || inputs.length < 2) return refuse("too-few", "A mosaic needs at least two input images.");
    if (inputs.length > limits.maxInputs) return refuse("too-many", "A mosaic accepts at most " + limits.maxInputs + " inputs.");
    const double = (array) => (array && !(array instanceof Float64Array) ? Float64Array.from(array) : array);
    inputs = inputs.map((input, index) => Object.assign({}, input, {
      name: input.name ?? "Input " + (index + 1), values: double(input.values), variance: double(input.variance),
    }));
    for (const input of inputs) {
      if (!(input.values && input.values.length === input.width * input.height && input.width > 0 && input.height > 0)) {
        return refuse("bad-array", input.name + ": the pixel array does not match its size.");
      }
    }
    const mode = options.mode === "inverse-variance" ? "inverse-variance" : "mean";

    const duplicate = findDuplicate(inputs);
    if (duplicate) return refuse("duplicate", duplicate.reason, { inputs: [duplicate.a, duplicate.b] });

    const units = planUnits(inputs);
    if (!units.ok) return units;

    const bands = checkBands(inputs);
    if (bands.state === "different") return refuse("band-mismatch", bands.reason, { bands });

    const available = varianceAvailability(inputs);
    if (mode === "inverse-variance" && !available.ok) return refuse("no-variance", available.reason);
    const useVariance = available.ok;

    const plan = planGrid(inputs, Object.assign({}, options, { variance: useVariance, mode }));
    if (!plan.ok) return plan;
    return { ok: true, inputs, mode, units, bands, available, useVariance, plan, grid: plan.grid };
  }

  // Generator: yields { phase, done, total, label } progress objects and returns the outcome
  // ({ ok: false, code, reason, ... } or { ok: true, result }). mosaicSteps does all the work, so the page can run it in slices
  // and a test can run it to the end.
  //   options: { mode: "mean" | "inverse-variance", gridMode, referenceIndex, scaleArcsec, width, height, maxPixels, memoryBytes }
  function* mosaicSteps(inputs, options = {}) {
    const checked = preflight(inputs, options);
    if (!checked.ok) return checked;
    inputs = checked.inputs;
    const { mode, units, bands, useVariance, grid } = checked;
    yield { phase: "plan", done: 0, total: 1, label: "Output grid planned: " + grid.width + " × " + grid.height + " pixels." };

    const total = grid.width * grid.height;
    const sums = new Float64Array(total);
    const weights = mode === "inverse-variance" ? new Float64Array(total) : null;
    const varSum = useVariance && mode === "mean" ? new Float64Array(total) : null;
    const varBad = varSum ? new Uint8Array(total) : null;
    const coverage = new Uint16Array(total);
    const records = [];

    // Work plan, to report progress.
    const windows = inputs.map((input, index) => {
      const box = bounding(grid.outlines[index], grid);
      const cols = Math.max(0, box.c1 - box.c0 + 1);
      const rowsPerStep = Math.max(1, Math.floor(bandRows / Math.max(1, cols)));
      const steps = box.r1 >= box.r0 && cols > 0 ? Math.ceil((box.r1 - box.r0 + 1) / rowsPerStep) : 0;
      return { box, cols, rowsPerStep, steps };
    });
    const totalSteps = windows.reduce((sum, entry) => sum + entry.steps, 0) || 1;
    let doneSteps = 0;
    const warnings = [];
    const notes = units.notes.concat(bands.notes);
    const resamplingNotes = [];

    for (let index = 0; index < inputs.length; index++) {
      const input = inputs[index];
      const factor = units.factors[index];
      const window = windows[index];
      const sampling = samplingFor(grid.scaleArcsec, grid.inputScales[index]);
      const scaledVariance = useVariance ? input.variance : null;
      const source = sourceOf(input, scaledVariance);
      const record = {
        index, name: input.name, obsId: input.meta?.obsId ?? null, hduIndex: input.meta?.hduIndex ?? null, hduName: input.meta?.hduName ?? null,
        originalUnit: diffLib.canonicalUnit(input.unit), unitFactor: factor, scaleArcsec: grid.inputScales[index], samples: sampling.n,
        time: input.meta?.time ?? null, wavelength: input.wavelength ?? null,
        footprintPixels: 0, validPixels: 0, invalidPixels: 0, noVariancePixels: 0, outline: grid.outlines[index],
        footprint: describeFootprint(input),
      };
      if (sampling.n > 1) {
        resamplingNotes.push(record.name + ": the output pixels (" + significant(grid.scaleArcsec, 3) + " arcsec) are " + significant(sampling.ratio, 3) + " times larger than the input pixels (" + significant(record.scaleArcsec, 3) + " arcsec), so " + sampling.n + " × " + sampling.n + " bilinear samples are averaged inside every output pixel.");
        if (sampling.undersampled) warnings.push(record.name + ": the output pixels are more than " + maxSupersample + " times larger than the input pixels, so even " + maxSupersample + " × " + maxSupersample + " samples under-sample the input. Use a finer output scale.");
      }
      if (window.steps) {
        for (let r = window.box.r0; r <= window.box.r1; r += window.rowsPerStep) {
          const rows = Math.min(window.rowsPerStep, window.box.r1 - r + 1);
          const part = reprojectWindow(source, grid, window.box.c0, r, window.cols, rows, sampling.n);
          for (let row = 0; row < rows; row++) {
            for (let column = 0; column < window.cols; column++) {
              const at = row * window.cols + column;
              const out = (r + row) * grid.width + window.box.c0 + column;
              const state = part.status[at];
              if (state === diffLib.status.outside) continue;
              record.footprintPixels++;
              const value = part.values[at] * factor;
              if (state !== diffLib.status.valid || !Number.isFinite(value)) {
                record.invalidPixels++;
                continue;
              }
              if (mode === "inverse-variance") {
                const variance = part.variance[at] * factor * factor;
                if (!(Number.isFinite(variance) && variance > 0)) {
                  record.noVariancePixels++;
                  continue;
                }
                const weight = 1 / variance;
                sums[out] += weight * value;
                weights[out] += weight;
              } else {
                sums[out] += value;
                if (varSum) {
                  const variance = part.variance[at] * factor * factor;
                  if (Number.isFinite(variance) && variance >= 0) varSum[out] += variance;
                  else varBad[out] = 1;
                }
              }
              coverage[out]++;
              record.validPixels++;
            }
          }
          doneSteps++;
          yield { phase: "reproject", done: doneSteps, total: totalSteps, label: "Reprojecting " + record.name + " (" + (index + 1) + " of " + inputs.length + ")…" };
        }
      }
      diffLib.releaseKernelCache();
      records.push(record);
    }

    // Combine.
    const values = new Float64Array(total).fill(NaN);
    const valid = new Uint8Array(total);
    const variance = useVariance ? new Float64Array(total).fill(NaN) : null;
    const histogram = new Array(inputs.length + 1).fill(0);
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
    yield { phase: "combine", done: totalSteps, total: totalSteps, label: "Combined." };

    const empty = validCount === 0;
    const overlapPixels = histogram.slice(2).reduce((sum, value) => sum + value, 0);
    const maxCoverage = histogram.reduce((last, value, count) => (value ? count : last), 0);
    const links = connectivity(inputs);
    if (links.groups.length > 1) {
      warnings.push("The inputs fall into " + links.groups.length + " groups that do not overlap each other on the sky (" + links.groups.map((group) => group.map((index) => index + 1).join(", ")).join(" | ") + "). Pixels between them are invalid, and there is no overlap to check the groups against each other.");
    }
    if (!empty && overlapPixels === 0 && inputs.length > 1) {
      warnings.push("No output pixel is covered by more than one input, so nothing was averaged and the inputs were not checked against each other.");
    }
    const noVariance = records.reduce((sum, record) => sum + record.noVariancePixels, 0);
    if (noVariance) warnings.push(noVariance.toLocaleString("en-US") + " input pixels with a missing, zero or negative variance were left out of the inverse-variance average.");
    if (mode === "mean" && !useVariance) notes.push("Variance of the mosaic is unavailable: not every input has a VARIANCE image in matching units.");
    warnings.push("Pixels are interpolated bilinearly, which smooths each input and correlates the noise of neighbouring pixels. Pixels next to a NaN or masked input pixel, and the outermost half pixel of every input, are invalid.");

    const wavelengths = records.map((record) => record.wavelength).filter(Boolean);
    const unitText = units.unitText;
    return {
      ok: true,
      result: {
        kind: "mosaic",
        mode, modeLabel: mode === "inverse-variance" ? "Inverse-variance weighted mean" : "Mean (equal weights)",
        width: grid.width, height: grid.height, wcs: grid.wcs, wcsFields: grid.wcsFields, unit: units.unit, unitText,
        scaleArcsec: grid.scaleArcsec, center: grid.center, gridMode: grid.mode, referenceIndex: grid.referenceIndex, autoSize: grid.autoSize,
        values, valid, coverage, variance,
        inputs: records, bands, units: { unit: units.unit, factors: units.factors, kind: units.kind },
        counts: { total, valid: validCount, invalid: total - validCount, overlap: overlapPixels, single: histogram[1] ?? 0, maxCoverage, histogram },
        empty, emptyReason: empty ? "No output pixel received a valid value from any input." : "",
        connectivity: links,
        varianceMode: variance ? (mode === "inverse-variance" ? "1 / Σw, independent errors" : "Σσ² / n², independent errors") : null,
        resampling: {
          method: "bilinear",
          description: "Bilinear interpolation of each input's calibrated surface-brightness values at the output pixel centres, through both WCS (the sampling of reproject_interp with order='bilinear'). Values are interpolated and averaged, never summed.",
          notes: resamplingNotes,
          footprint: "the four neighbouring input pixel centres must lie inside the input; a pixel whose stencil touches a NaN or masked pixel is invalid",
        },
        weights: mode === "inverse-variance" ? "1 / variance of the reprojected input pixel" : "equal",
        wavelengthRange: wavelengths.length ? { min: Math.min(...wavelengths.map((w) => w.min)), max: Math.max(...wavelengths.map((w) => w.max)) } : null,
        memory: grid.memory,
        warnings, notes,
        summary: (mode === "inverse-variance" ? "Inverse-variance weighted mean" : "Equal-weight mean") + " of " + inputs.length + " inputs on a " + grid.width + " × " + grid.height + " pixel " +
          (grid.mode === "reference" ? "grid taken from the WCS of " + inputs[grid.referenceIndex].name : "north-up TAN grid centred on the footprint union") + ".",
      },
    };
  }

  function buildMosaic(inputs, options) {
    const run = mosaicSteps(inputs, options);
    let step = run.next();
    while (!step.done) step = run.next();
    return step.value;
  }

  // Same computation in slices: awaits `pause()` after every step so the page can paint, and stops when `cancelled()` is true.
  async function buildMosaicAsync(inputs, options, hooks = {}) {
    const run = mosaicSteps(inputs, options);
    let step = run.next();
    let last = 0;
    while (!step.done) {
      if (hooks.cancelled && hooks.cancelled()) return { ok: false, code: "cancelled", reason: "The mosaic was cancelled." };
      const now = typeof performance === "object" ? performance.now() : Date.now();
      if (hooks.onProgress && now - last > 40) hooks.onProgress(step.value);
      if (hooks.pause && now - last > 40) {
        await hooks.pause();
        last = typeof performance === "object" ? performance.now() : Date.now();
      }
      step = run.next();
    }
    if (hooks.cancelled && hooks.cancelled()) return { ok: false, code: "cancelled", reason: "The mosaic was cancelled." };
    return step.value;
  }

  // What every input contributes at one output pixel (zero based column and row): the position in the input file, the value
  // converted to the mosaic unit (bilinear, as in the mosaic) and its state. Uses the same reprojection as the mosaic.
  function pixelContributions(result, inputs, column, row) {
    const grid = { wcs: result.wcs };
    const sky = result.wcs.pixelToSky(column + 1, row + 1);
    return inputs.map((input, index) => {
      const record = result.inputs[index];
      const at = sky && input.wcs ? input.wcs.skyToPixel(sky.ra, sky.dec) : null;
      const inside = at && wcsLib.insideImage(at.x, at.y, input.width, input.height);
      const source = sourceOf(input, result.variance ? input.variance : null);
      const part = reprojectWindow(source, grid, column, row, 1, 1, samplingFor(result.scaleArcsec, record.scaleArcsec).n);
      const state = part.status[0];
      const factor = result.units.factors[index];
      const value = part.values[0] * factor;
      const variance = part.variance ? part.variance[0] * factor * factor : null;
      return {
        index, name: input.name, obsId: record.obsId,
        position: at && isNumber(at.x) ? { x: at.x, y: at.y, inside: Boolean(inside) } : null,
        state, value: state === diffLib.status.valid && Number.isFinite(value) ? value : null,
        variance: variance !== null && Number.isFinite(variance) ? variance : null,
        reason: state === diffLib.status.valid ? "Contributes" : state === diffLib.status.outside ? "Outside this input" : "Touches a NaN or masked pixel",
      };
    });
  }

  function pixelAt(result, column, row) {
    if (!(column >= 0 && column < result.width && row >= 0 && row < result.height)) return null;
    const index = row * result.width + column;
    const pick = (array) => (array && Number.isFinite(array[index]) ? array[index] : null);
    return { index, column, row, value: pick(result.values), variance: pick(result.variance), coverage: result.coverage[index], valid: result.valid[index] === 1 };
  }

  // ---- FITS export ---------------------------------------------------------------------------------------------------------
  function ascii(text) {
    return String(text).replace(/[^\x20-\x7e]/g, "?");
  }

  function fitsCard(key, value, comment = "") {
    let text = key.padEnd(8, " ");
    if (value === undefined) return (text + ascii(comment)).padEnd(80, " ").slice(0, 80);
    text += "= ";
    if (typeof value === "string") {
      const clipped = ascii(value).slice(0, 68).replaceAll("'", "''");
      text += "'" + clipped.padEnd(8, " ") + "'";
    } else if (typeof value === "boolean") {
      text += (value ? "T" : "F").padStart(20, " ");
    } else {
      if (!Number.isFinite(value)) throw new Error("Header value of " + key + " is not finite.");
      text += String(value).replace("e", "E").padStart(20, " ");
    }
    if (comment && text.length < 76) text += " / " + ascii(comment);
    return text.padEnd(80, " ").slice(0, 80);
  }

  function historyCards(text) {
    const cards = [];
    const clean = ascii(text);
    for (let start = 0; start < clean.length; start += 70) cards.push(fitsCard("HISTORY", undefined, clean.slice(start, start + 70)));
    return cards;
  }

  function headerBytes(cards) {
    const text = cards.concat(["END".padEnd(80, " ")]).join("");
    return new TextEncoder().encode(text.padEnd(Math.ceil(text.length / 2880) * 2880, " "));
  }

  function dataBlock(bytes) {
    const out = new Uint8Array(Math.ceil(bytes.length / 2880) * 2880);
    out.set(bytes);
    return out;
  }

  // The mosaic as a FITS file: the primary HDU holds the mosaic image (float64, NaN where invalid) with the output WCS,
  // BUNIT and the provenance (inputs, mode, resampling); extensions MASK (0 valid, 1 invalid), COVERAGE (number of inputs with
  // a valid value, int16) and, when available, VARIANCE (unit^2).
  function buildMosaicFits(result, options = {}) {
    const wcsCards = Object.keys(result.wcsFields).filter((key) => gridKeys.test(key) && result.wcsFields[key] !== undefined).map((key) => fitsCard(key, result.wcsFields[key]));
    const when = options.date ?? new Date().toISOString().replace(/\.\d+Z$/, "");
    const times = result.inputs.map((record) => (record.time && record.time.valid ? record.time.mjd : null)).filter((value) => value !== null);
    const provenance = [
      fitsCard("CREATOR", "AstroNot Mosaic Builder", "software"),
      fitsCard("DATE", when, "file creation (UTC)"),
      fitsCard("COMBINE", result.mode === "inverse-variance" ? "INVVAR" : "MEAN", result.modeLabel),
      fitsCard("NINPUTS", result.inputs.length, "number of input images"),
      fitsCard("RESAMPLE", "BILINEAR", "surface brightness interpolated, not summed"),
      fitsCard("PIXSCALE", result.scaleArcsec, "output pixel scale, arcsec"),
      fitsCard("GRIDMODE", result.gridMode === "reference" ? "REFERENCE" : "AUTO-TAN", result.gridMode === "reference" ? "WCS of input " + (result.referenceIndex + 1) : "north-up TAN on footprint union"),
      fitsCard("MAXCOV", result.counts.maxCoverage, "largest number of inputs at a pixel"),
    ];
    if (result.wavelengthRange) {
      provenance.push(fitsCard("WAVEMIN", result.wavelengthRange.min, "um, lowest input wavelength"), fitsCard("WAVEMAX", result.wavelengthRange.max, "um, highest input wavelength"));
    }
    if (times.length) {
      provenance.push(fitsCard("MJD-BEG", Math.min(...times), "earliest input observation"), fitsCard("MJD-END", Math.max(...times), "latest input observation"));
    }
    result.inputs.forEach((record, index) => {
      const number = String(index + 1).padStart(2, "0");
      provenance.push(fitsCard("SRCFIL" + number, record.name ?? "unavailable", "input file"));
      provenance.push(fitsCard("SRCOBS" + number, record.obsId ?? "unavailable", "input observation ID"));
      if (record.hduIndex !== null && record.hduIndex !== undefined) provenance.push(fitsCard("SRCHDU" + number, record.hduIndex, "input HDU index"));
    });
    const history = [
      ...historyCards("AstroNot Mosaic Builder: " + result.summary),
      ...historyCards("Unit " + result.unitText + ": values are surface brightness, interpolated and averaged, never summed."),
      ...historyCards("Weights: " + result.weights + ". Pixels covered by no input are NaN and MASK is 1."),
      ...historyCards("Bilinear resampling smooths each input and correlates neighbouring pixel noise."),
    ];
    result.inputs.forEach((record, index) => {
      const factor = record.unitFactor !== 1 ? ", converted from " + record.originalUnit + " x " + Number(record.unitFactor.toPrecision(6)) : "";
      const stamp = record.time && record.time.valid ? " " + record.time.iso : "";
      history.push(...historyCards("Input " + (index + 1) + ": " + (record.name ?? "unavailable") + ", observation " + (record.obsId ?? "unavailable") + stamp + ", " + record.validPixels + " valid pixels" + factor));
    });
    const imageCards = (name, bitpix, bunit, primary) => [
      ...(primary
        ? [fitsCard("SIMPLE", true), fitsCard("BITPIX", bitpix), fitsCard("NAXIS", 2), fitsCard("NAXIS1", result.width), fitsCard("NAXIS2", result.height), fitsCard("EXTEND", true)]
        : [fitsCard("XTENSION", "IMAGE"), fitsCard("BITPIX", bitpix), fitsCard("NAXIS", 2), fitsCard("NAXIS1", result.width), fitsCard("NAXIS2", result.height), fitsCard("PCOUNT", 0), fitsCard("GCOUNT", 1)]),
      fitsCard("EXTNAME", name), ...(bunit ? [fitsCard("BUNIT", bunit)] : []), ...wcsCards,
    ];
    const count = result.width * result.height;
    const doubles = (array) => {
      const bytes = new Uint8Array(count * 8);
      const view = new DataView(bytes.buffer);
      for (let index = 0; index < count; index++) view.setFloat64(index * 8, array[index], false);
      return dataBlock(bytes);
    };
    const parts = [];
    parts.push(headerBytes(imageCards("MOSAIC", -64, result.unitText, true).concat(provenance, history)), doubles(result.values));
    const mask = new Uint8Array(count);
    for (let index = 0; index < count; index++) mask[index] = result.valid[index] ? 0 : 1;
    parts.push(headerBytes(imageCards("MASK", 8, undefined, false).concat(historyCards("0 = valid mosaic pixel, 1 = invalid (no input contributed)"))), dataBlock(mask));
    const covBytes = new Uint8Array(count * 2);
    const covView = new DataView(covBytes.buffer);
    for (let index = 0; index < count; index++) covView.setInt16(index * 2, result.coverage[index], false);
    parts.push(headerBytes(imageCards("COVERAGE", 16, undefined, false).concat(historyCards("Number of input images with a valid value at the pixel (0 = none)"))), dataBlock(covBytes));
    if (result.variance) {
      parts.push(headerBytes(imageCards("VARIANCE", -64, "(" + result.unitText + ")^2", false).concat(historyCards("Variance of the mosaic: " + result.varianceMode + ". Bilinear resampling correlates neighbouring pixels."))), doubles(result.variance));
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
    limits, preflight, classifyUnit, planUnits, findDuplicate, wavelengthSampler, checkBands, footprintSky, planGrid, estimateMemory,
    describeFootprint, connectivity, varianceAvailability, mosaicSteps, buildMosaic, buildMosaicAsync, pixelContributions, pixelAt,
    samplingFor, buildMosaicFits, varianceUnitCheck,
  };
  root.AstroNotMosaic = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);
