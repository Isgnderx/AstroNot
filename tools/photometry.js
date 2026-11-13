// Aperture flux density for Spectrophotometry (AstroNot). Measures one sky position in calibrated SPHEREx-style images.
//
// UI-independent: no DOM access. Loads as a classic browser script (global `AstroNotPhotometry`) and as a CommonJS module.
// It needs tools/wcs.js (global `AstroNotWcs`) for every sky and pixel computation and tools/pair.js (global `AstroNotPair`)
// for the per-pixel wavelength lookup (WCS-WAVE) and the observation time.
//
// WHAT IT COMPUTES  (the method is called "aperture-photometry"; the result is an Aperture flux density)
//   F_nu[Jy] = 1e6 * f * SUM_i  w_i * (I_i - b) * Omega_i          (f = 1 for MJy/sr, see unitScale)
//   - I_i   calibrated pixel value in MJy/sr (BSCALE/BZERO already applied by fits.js; NaN and BLANK are invalid).
//   - b     background in the same unit: the (sigma-clipped) median or mean of the valid pixels of an annulus around the
//           target, or 0 when the user asks for no background subtraction.
//   - Omega_i  solid angle of pixel i in sr, from the WCS: the area on the sky of the quadrilateral through the four pixel
//           corners (x +- 0.5, y +- 0.5), spherical excess exactly. No constant pixel size is assumed.
//   - w_i   EXACT overlap of pixel i with the circular aperture, 0..1 (analytic circle/square intersection, not sampled).
//           The aperture is a circle in pixel space centred on the WCS pixel position of the target.
//   Invalid pixels (NaN, BLANK, or flagged with a bit the archive tool also ignores) are LEFT OUT of the sum; they are not
//   replaced. Their share of the aperture area is reported (maskedShare), the share that falls off the image is reported
//   (offImageShare), and coverage = 1 - both. A measurement with coverage below the minimum is refused.
//
// ERROR (fluxErrMicroJy)
//   Only from a VARIANCE image whose unit is the square of the image unit. Then
//     Var[F_Jy] = (1e6 f)^2 * ( SUM w_i^2 Omega_i^2 var_i  +  (SUM w_i Omega_i)^2 * var_b )
//   assuming independent pixel noise, with var_b = k * mean(var of the annulus pixels used) / N (k = pi/2 for a median, 1 for
//   a mean; N = annulus pixels used). It contains no calibration, aperture-correction, PSF-mismatch or correlated-noise
//   term. Without a usable VARIANCE image the error is null (an empty CSV field), never zero.
//
// WAVELENGTH
//   From the actual per-pixel spectral WCS of the image (the WCS-WAVE lookup table, read with pair.js) at the target pixel.
//   If the table is missing, unreadable or does not cover the pixel, the result is NOT a spectrum point (spectrumPoint false).
//   File names and detector numbers are never used as wavelengths.
//
// PIXEL CONVENTION: FITS (see wcs.js). Positions are continuous and 1-based; pixel (col, row) with zero-based array indices
// has its centre at FITS (col + 1, row + 1) and covers x in [col + 0.5, col + 1.5]. Arrays are in FITS order (row 0 = bottom).
(function (root) {
  "use strict";

  const wcsLib = typeof module === "object" && module.exports ? require("./wcs.js") : root.AstroNotWcs;
  const pairLib = typeof module === "object" && module.exports ? require("./pair.js") : root.AstroNotPair;
  const { angularSeparation, insideImage } = wcsLib;

  const method = "aperture-photometry";
  const methodLabel = "Aperture flux density";
  const containsBadPixel = 4294967296; // 2^32, CONTAINS_BAD_PIXEL of the archive spectrophotometry output.
  const maxRadiusPixels = 200;

  // ---- The shared CSV contract (Spectrum Lab and Light Curve read it) ---------------------------------------------------
  const csvColumns = ["source_id", "obs_id", "mjd", "ra", "dec", "wavelength", "lambda_width", "flux", "flux_err", "flags", "method"];
  const csvExtraColumns = [
    "x_image", "y_image", "detector", "aperture_radius_pix", "annulus_inner_pix", "annulus_outer_pix",
    "background_mjy_sr", "aperture_coverage", "masked_fraction", "status", "mjd_source", "file",
  ];

  const defaults = Object.freeze({
    radius: 2.5, innerRadius: 4, outerRadius: 7, radiusUnit: "pixel",
    minCoverage: 0.9, minAnnulusPixels: 20,
    background: "median", clipSigma: 3, clipIterations: 5,
    maskFlags: true, excludeSourceFromAnnulus: false,
  });

  // ---- FLAGS --------------------------------------------------------------------------------------------------------------
  // Bit positions of the SPHEREx Level 2 FLAGS image as published in the IRSA SPHEREx Spectrophotometry documentation
  // (https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/sp.html). The FLAGS header of a file lists its own MP_* bits and,
  // when present, those definitions replace these (flagDefinitions).
  const documentedFlags = [
    ["TRANSIENT", 0, "Transient detected, for example a cosmic-ray hit"], ["OVERFLOW", 1, "Nearing saturation"],
    ["SUR_ERROR", 2, "Possible errors in onboard processing"], ["PHANTOM", 4, "Phantom pixel"], ["REFERENCE", 5, "Reference pixel"],
    ["NONFUNC", 6, "Dead pixel, permanently unusable"], ["DICHROIC", 7, "Low efficiency due to the dichroic"],
    ["MISSING_DATA", 9, "Onboard data lost"], ["HOT", 10, "Hot, noisy pixel"], ["COLD", 11, "Cold, unresponsive pixel"],
    ["FULLSAMPLE", 12, "Full sample history is available"], ["PHANMISS", 14, "Phantom correction was not applied"],
    ["NONLINEAR", 15, "Nonlinearity correction cannot be applied reliably"], ["PERSIST", 17, "Persistent charge above threshold"],
    ["OUTLIER", 19, "Flagged outlier"], ["CROSSTALK", 20, "Crosstalk"], ["SOURCE", 21, "Pixel mapped to a known source"],
    ["GHOST", 22, "Ghost"], ["STREAK", 25, "Streak"], ["BLOOM", 26, "Bloom"], ["SNOWBALL", 27, "Snowball"], ["HALO", 28, "Halo"],
    ["SATELLITE_HALO", 29, "Satellite halo"],
  ].map(([name, bit, text]) => ({ name, bit, text }));

  // Pixels the archive's forced photometry ignores while fitting. Aperture photometry leaves the same pixels out.
  const excludedFlagNames = ["SUR_ERROR", "NONFUNC", "MISSING_DATA", "HOT", "COLD", "NONLINEAR", "PERSIST", "BLOOM", "SNOWBALL", "HALO", "SATELLITE_HALO"];
  const sourceFlagName = "SOURCE";

  // Flag definitions of a FLAGS HDU header (`cards`: the 80-character cards from readFitsHdus). Cards look like
  // "HIERARCH MP_OVERFLOW = 1 / ..." or "MP_HOT  = 10 / ...". Unlisted bits keep the documented name.
  function flagDefinitions(cards) {
    const byName = new Map(documentedFlags.map((entry) => [entry.name, { ...entry }]));
    let fromHeader = 0;
    for (const card of cards || []) {
      const match = /^(?:HIERARCH\s+)?MP_([A-Z0-9_]+)\s*=\s*(\d+)/.exec(card);
      if (!match) continue;
      const bit = Number(match[2]);
      if (!(bit >= 0 && bit <= 31)) continue;
      const known = byName.get(match[1]);
      byName.set(match[1], { name: match[1], bit, text: known ? known.text : "Defined in the FLAGS header" });
      fromHeader++;
    }
    return { definitions: [...byName.values()], fromHeader };
  }

  function bitMask(definitions, names) {
    let mask = 0;
    for (const name of names) {
      const entry = definitions.find((item) => item.name === name);
      if (entry) mask = (mask | (1 << entry.bit)) >>> 0;
    }
    return mask >>> 0;
  }

  // Readable names for an integer flag value, including the bits the archive adds to the measurement.
  function describeFlags(value, definitions = documentedFlags) {
    const out = [];
    const total = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    const low = total % 4294967296;
    const high = Math.floor(total / 4294967296);
    for (let bit = 0; bit < 32; bit++) {
      if (Math.floor(low / 2 ** bit) % 2 !== 1) continue;
      const entry = definitions.find((item) => item.bit === bit);
      out.push({ bit, name: entry ? entry.name : "BIT" + bit, text: entry ? entry.text : "Bit " + bit + " is not described in this file" });
    }
    if (high & 1) out.push({ bit: 32, name: "CONTAINS_BAD_PIXEL", text: "A pixel of the aperture was left out as invalid" });
    if (high & 2) out.push({ bit: 33, name: "FIT_ERROR", text: "Error in fitting" });
    return out;
  }

  // ---- Units ---------------------------------------------------------------------------------------------------------------
  const prefixFactor = { G: 1e9, M: 1e6, k: 1e3, "": 1, m: 1e-3, u: 1e-6, "μ": 1e-6, "µ": 1e-6, n: 1e-9 };

  // Unit of the image values -> factor to MJy/sr. Only Jy-per-steradian units with an SI prefix are converted; case is kept
  // because "mJy" and "MJy" differ by 10^9.
  function unitScale(unit) {
    const text = pairLib.normalizeUnit(unit);
    if (!text) return { ok: false, factor: NaN, unit: null, prefix: null, reason: "BUNIT is missing, so the pixel unit is not known and no flux is computed." };
    const match = /^([GMkmuμµn]?)Jy(?:\/sr|[ .]sr\^?-1)$/.exec(text);
    if (!match) {
      return { ok: false, factor: NaN, unit: text, prefix: null, reason: "BUNIT is '" + text + "'. Only surface-brightness units of the form MJy/sr (or another prefix of Jy/sr) are converted to Jy; other units are not guessed." };
    }
    return { ok: true, factor: prefixFactor[match[1]] / 1e6, unit: text, prefix: match[1], reason: "" };
  }

  // Does `varianceUnit` describe the square of the image unit (prefix of Jy/sr squared)? { ok, assumed, reason }
  function varianceUnitCheck(varianceUnit, scale) {
    const v = pairLib.normalizeUnit(varianceUnit);
    if (!v) return { ok: true, assumed: true, reason: "The VARIANCE image has no BUNIT; it is assumed to be the square of the image unit." };
    const p = scale.prefix;
    const accepted = new Set([p + "Jy2/sr2", p + "Jy^2/sr^2", "(" + scale.unit + ")^2", scale.unit + "^2", "(" + scale.unit + ")2"]);
    return accepted.has(v)
      ? { ok: true, assumed: false, reason: "" }
      : { ok: false, assumed: false, reason: "The VARIANCE unit '" + v + "' is not the square of the image unit '" + scale.unit + "', so no error is computed." };
  }

  // ---- Geometry ----------------------------------------------------------------------------------------------------------------
  // Area of the part of a circle (radius r, centre at the origin) inside [0, a] x [0, b], a and b >= 0.
  function cornerArea(r, a, b) {
    if (!(r > 0) || !(a > 0) || !(b > 0)) return 0;
    const reach = Math.min(a, r);
    const antiderivative = (x) => 0.5 * (x * Math.sqrt(Math.max(0, r * r - x * x)) + r * r * Math.asin(Math.min(1, x / r)));
    if (b >= r) return antiderivative(reach);
    const crossing = Math.sqrt(r * r - b * b); // up to here the strip is cut by the horizontal edge y = b
    if (reach <= crossing) return b * reach;
    return b * crossing + antiderivative(reach) - antiderivative(crossing);
  }

  function signedCornerArea(r, x, y) {
    return Math.sign(x) * Math.sign(y) * cornerArea(r, Math.abs(x), Math.abs(y));
  }

  // Exact area of the intersection of the circle (radius r, centre at the origin) with the rectangle [x0, x1] x [y0, y1].
  function circleRectangleArea(r, x0, x1, y0, y1) {
    return signedCornerArea(r, x1, y1) - signedCornerArea(r, x0, y1) - signedCornerArea(r, x1, y0) + signedCornerArea(r, x0, y0);
  }

  // Pixels of a width x height image that a circle of radius r (pixels) centred at FITS (cx, cy) touches, with the exact
  // overlap weight w of each: [{ column, row, index, w, distance }] (column and row are zero-based array indices).
  function apertureWeights(cx, cy, r, width, height) {
    const out = [];
    if (!(r > 0)) return out;
    const columnLow = Math.max(0, Math.floor(cx - r - 0.5) - 1);
    const columnHigh = Math.min(width - 1, Math.ceil(cx + r - 0.5) + 1);
    const rowLow = Math.max(0, Math.floor(cy - r - 0.5) - 1);
    const rowHigh = Math.min(height - 1, Math.ceil(cy + r - 0.5) + 1);
    for (let row = rowLow; row <= rowHigh; row++) {
      for (let column = columnLow; column <= columnHigh; column++) {
        const x0 = column + 0.5 - cx;
        const x1 = column + 1.5 - cx;
        const y0 = row + 0.5 - cy;
        const y1 = row + 1.5 - cy;
        const nearX = x0 > 0 ? x0 : x1 < 0 ? -x1 : 0;
        const nearY = y0 > 0 ? y0 : y1 < 0 ? -y1 : 0;
        if (nearX * nearX + nearY * nearY >= r * r) continue;
        const farX = Math.max(Math.abs(x0), Math.abs(x1));
        const farY = Math.max(Math.abs(y0), Math.abs(y1));
        const w = farX * farX + farY * farY <= r * r ? 1 : Math.min(1, Math.max(0, circleRectangleArea(r, x0, x1, y0, y1)));
        if (w > 0) out.push({ column, row, index: row * width + column, w, distance: Math.hypot(column + 1 - cx, row + 1 - cy) });
      }
    }
    return out;
  }

  function unitVector(ra, dec) {
    const lon = ra * Math.PI / 180;
    const lat = dec * Math.PI / 180;
    return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  }

  function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }

  // Spherical triangle area (steradian), Van Oosterom and Strakhov.
  function triangleArea(a, b, c) {
    return 2 * Math.atan2(Math.abs(dot(a, cross(b, c))), 1 + dot(a, b) + dot(b, c) + dot(c, a));
  }

  // Solid angle (sr) of a pixel from the WCS: the quadrilateral through the pixel corners, as two spherical triangles.
  // NaN when a corner has no sky position.
  function pixelSolidAngle(wcs, column, row) {
    const corners = [[column + 0.5, row + 0.5], [column + 1.5, row + 0.5], [column + 1.5, row + 1.5], [column + 0.5, row + 1.5]].map(([x, y]) => {
      const sky = wcs.pixelToSky(x, y);
      return sky ? unitVector(sky.ra, sky.dec) : null;
    });
    if (corners.some((corner) => !corner)) return NaN;
    return triangleArea(corners[0], corners[1], corners[2]) + triangleArea(corners[0], corners[2], corners[3]);
  }

  // Local pixel scale in arcsec (geometric mean of the two axes) at a FITS position.
  function localPixelScaleArcsec(wcs, x, y) {
    const origin = wcs.pixelToSky(x, y);
    const east = wcs.pixelToSky(x + 1, y);
    const north = wcs.pixelToSky(x, y + 1);
    if (!origin || !east || !north) return null;
    const along = angularSeparation(origin.ra, origin.dec, east.ra, east.dec) * 3600;
    const up = angularSeparation(origin.ra, origin.dec, north.ra, north.dec) * 3600;
    return Math.sqrt(along * up);
  }

  // ---- Statistics --------------------------------------------------------------------------------------------------------------
  function median(values) {
    const sorted = Array.from(values).sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function mean(values) {
    let sum = 0;
    for (const value of values) sum += value;
    return sum / values.length;
  }

  function standardDeviation(values, center) {
    let sum = 0;
    for (const value of values) sum += (value - center) ** 2;
    return Math.sqrt(sum / values.length);
  }

  // Iterative sigma clipping about the median with the population standard deviation, as astropy sigma_clip defaults.
  // Returns the indices that survive.
  function sigmaClip(values, sigma = defaults.clipSigma, iterations = defaults.clipIterations) {
    let kept = Array.from(values.keys());
    for (let round = 0; round < iterations && kept.length > 1; round++) {
      const current = kept.map((index) => values[index]);
      const center = median(current);
      const spread = standardDeviation(current, mean(current));
      const next = kept.filter((index) => Math.abs(values[index] - center) <= sigma * spread);
      if (next.length === kept.length) break;
      kept = next;
    }
    return kept;
  }

  // ---- The flux formula (pure) ----------------------------------------------------------------------------------------------------
  // samples: [{ value, weight, omega, variance? }] of VALID pixels, value and background in the image unit, omega in sr,
  // `scale` the factor from the image unit to MJy/sr. Returns the sum in Jy and microJy.
  function fluxFromSamples(samples, background, scale = 1) {
    let sum = 0;
    for (const sample of samples) sum += sample.weight * (sample.value - background) * sample.omega;
    const jy = 1e6 * scale * sum;
    return { jy, microJy: jy * 1e6 };
  }

  // ---- Inputs ---------------------------------------------------------------------------------------------------------------------
  function parseCoordinate(text, kind) {
    const label = kind === "ra" ? "RA" : "Dec";
    const clean = String(text ?? "").trim();
    if (!clean) return { ok: false, reason: label + " is empty." };
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(clean)) {
      return { ok: false, reason: label + " '" + clean + "' is not a decimal number of degrees (ICRS). Sexagesimal input is not accepted." };
    }
    const value = Number(clean);
    if (kind === "ra" && !(value >= 0 && value < 360)) return { ok: false, reason: "RA must be at least 0 and below 360 degrees." };
    if (kind === "dec" && !(value >= -90 && value <= 90)) return { ok: false, reason: "Dec must be from -90 to 90 degrees." };
    return { ok: true, value };
  }

  function parsePositive(text, label, { allowZero = false, max = Infinity } = {}) {
    const clean = String(text ?? "").trim();
    if (!/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(clean)) return { ok: false, reason: label + " must be a number (" + (allowZero ? "zero or more" : "above zero") + ")." };
    const value = Number(clean);
    if (!(allowZero ? value >= 0 : value > 0) || !(value <= max)) return { ok: false, reason: label + " must be " + (allowZero ? "zero or more" : "above zero") + (max < Infinity ? " and at most " + max : "") + "." };
    return { ok: true, value };
  }

  function checkParams(input) {
    const params = { ...defaults, ...input };
    const reasons = [];
    if (!["pixel", "arcsec"].includes(params.radiusUnit)) reasons.push("The radius unit must be pixel or arcsec.");
    if (!["median", "mean", "none"].includes(params.background)) reasons.push("The background method must be median, mean or none.");
    for (const [key, label] of [["radius", "The aperture radius"]]) {
      if (!(typeof params[key] === "number" && params[key] > 0)) reasons.push(label + " must be above zero.");
    }
    if (params.background !== "none") {
      if (!(typeof params.innerRadius === "number" && params.innerRadius > 0)) reasons.push("The annulus inner radius must be above zero.");
      else if (typeof params.radius === "number" && params.innerRadius < params.radius) reasons.push("The annulus must start at or outside the aperture (inner radius at least the aperture radius).");
      if (!(typeof params.outerRadius === "number" && params.outerRadius > params.innerRadius)) reasons.push("The annulus outer radius must be larger than the inner radius.");
    }
    if (!(params.minCoverage > 0 && params.minCoverage <= 1)) reasons.push("The minimum aperture coverage must be above 0 and at most 1.");
    if (!(Number.isInteger(params.minAnnulusPixels) && params.minAnnulusPixels >= 1)) reasons.push("The minimum number of annulus pixels must be a whole number, at least 1.");
    return { params, reasons };
  }

  // ---- Time ------------------------------------------------------------------------------------------------------------------------
  // MJD (UTC) of the measurement: the mid-exposure time (MJD-AVG / DATE-AVG) when the header has it, otherwise the exposure
  // start (DATE-OBS / MJD-OBS). Other time scales are not converted, so no value is given for them.
  function observationEpoch(fields) {
    const header = fields || {};
    const middle = pairLib.parseObservationTime({ "DATE-OBS": header["DATE-AVG"], "MJD-OBS": header["MJD-AVG"], TIMESYS: header.TIMESYS });
    if (middle.valid && middle.scale === "UTC") return { mjd: middle.mjd, source: "MJD-AVG", reason: "" };
    const start = pairLib.parseObservationTime(header);
    if (start.valid && start.scale === "UTC") return { mjd: start.mjd, source: "MJD-OBS", reason: "" };
    return { mjd: null, source: "", reason: start.valid ? "The time scale is " + start.scale + ", which is not converted to UTC." : start.reason };
  }

  // HIERARCH OMEGA_MEDIAN of the image header, in arcsec^2: the median pixel solid angle that the pipeline wrote. Used only to
  // cross-check the WCS solid angle; it is never an input of the flux.
  function headerSolidAngleArcsec2(cards) {
    for (const card of cards || []) {
      const match = /^(?:HIERARCH\s+)?OMEGA_MEDIAN\s*=\s*([-+0-9.eE]+)/.exec(card);
      if (match && Number.isFinite(Number(match[1]))) return Number(match[1]);
    }
    return null;
  }

  // ---- The measurement ------------------------------------------------------------------------------------------------------------
  function significant(value, digits = 4) {
    return Number(value.toPrecision(digits));
  }

  function fail(base, status, reason) {
    return Object.assign(base, { measured: false, spectrumPoint: false, status, reasons: base.reasons.concat(reason), notSpectrumReason: reason });
  }

  // observation = {
  //   name, width, height, values (Float64Array, NaN invalid), unit (BUNIT), wcs (wcs.js object or null), wcsReason, fields (header),
  //   variance? (Float64Array), varianceUnit?, flags? (Uint32Array/Int32Array), flagDefinitions? ([{name, bit}]), waveTable? (pair.parseWaveTable),
  //   cards? (header cards for the solid-angle cross-check)
  // }
  // target = { ra, dec } ICRS degrees. input = parameters (see defaults). options.solidAngleSr replaces the WCS solid angle with
  // one constant (for tests and for checking against a documented constant; never used by the app).
  function measureAperture(observation, target, input = {}, options = {}) {
    const { params, reasons: paramReasons } = checkParams(input);
    const fields = observation.fields || {};
    const base = {
      name: observation.name ?? "", method, methodLabel, params, target: { ra: target.ra, dec: target.dec },
      status: "", reasons: [], measured: false, spectrumPoint: false, notSpectrumReason: "",
      position: null, inImage: false, aperture: null, annulus: null, background: null, flux: null, fluxErrMicroJy: null, fluxErrReason: "",
      wavelength: null, wavelengthReason: "", flags: 0, flagNames: [], epoch: observationEpoch(fields),
      omega: null, pixels: [], conversions: [],
    };
    if (paramReasons.length) return fail(base, "invalid-parameters", paramReasons.join(" "));
    if (!(Number.isFinite(target.ra) && Number.isFinite(target.dec))) return fail(base, "invalid-parameters", "The target position is not a pair of finite coordinates.");
    if (!observation.wcs) return fail(base, "no-wcs", "No usable sky coordinates: " + (observation.wcsReason || "the WCS is unavailable") + ".");
    const scale = unitScale(observation.unit);
    if (!scale.ok) return fail(base, "unit-unsupported", scale.reason);

    const { width, height, values, wcs } = observation;
    const position = wcs.skyToPixel(target.ra, target.dec);
    if (!position) return fail(base, "off-image", "The target cannot be projected onto this image (it is too far from the image tangent point).");
    base.position = { x: position.x, y: position.y };
    base.inImage = insideImage(position.x, position.y, width, height);
    if (!base.inImage) {
      return fail(base, "off-image", "The target falls at pixel (" + significant(position.x, 6) + ", " + significant(position.y, 6) + "), outside this " + width + " × " + height + " pixel image.");
    }

    // Radii in pixels.
    let factor = 1;
    const pixelScale = localPixelScaleArcsec(wcs, position.x, position.y);
    if (params.radiusUnit === "arcsec") {
      if (!pixelScale) return fail(base, "no-wcs", "The pixel scale at the target could not be computed from the WCS, so radii in arcsec cannot be converted.");
      factor = 1 / pixelScale;
    }
    const radius = params.radius * factor;
    const inner = params.background === "none" ? 0 : params.innerRadius * factor;
    const outer = params.background === "none" ? 0 : params.outerRadius * factor;
    if (radius > maxRadiusPixels || outer > maxRadiusPixels) return fail(base, "invalid-parameters", "Radii above " + maxRadiusPixels + " pixels are not supported.");
    base.pixelScaleArcsec = pixelScale;

    // Pixel validity.
    const flags = observation.flags || null;
    const definitions = observation.flagDefinitions || documentedFlags;
    const ignoredMask = params.maskFlags && flags ? bitMask(definitions, excludedFlagNames) : 0;
    const sourceMask = flags ? bitMask(definitions, [sourceFlagName]) : 0;
    const flagOf = (index) => (flags ? flags[index] >>> 0 : 0);
    const pixelState = (index) => {
      if (!Number.isFinite(values[index])) return "nan";
      if (ignoredMask && (flagOf(index) & ignoredMask)) return "flag";
      return "valid";
    };
    const omegaCache = new Map();
    const omegaOf = (column, row, index) => {
      if (options.solidAngleSr !== undefined) return options.solidAngleSr;
      let value = omegaCache.get(index);
      if (value === undefined) {
        value = pixelSolidAngle(wcs, column, row);
        omegaCache.set(index, value);
      }
      return value;
    };

    // Aperture.
    const weights = apertureWeights(position.x, position.y, radius, width, height);
    const fullArea = Math.PI * radius * radius;
    let inImageArea = 0;
    let validArea = 0;
    let nanArea = 0;
    let flagArea = 0;
    let omegaArea = 0;
    let flagBits = 0;
    let anyExcluded = false;
    const samples = [];
    const pixels = [];
    let varianceGaps = 0;
    for (const entry of weights) {
      inImageArea += entry.w;
      const state = pixelState(entry.index);
      const omega = state === "valid" ? omegaOf(entry.column, entry.row, entry.index) : NaN;
      const pixelFlags = flagOf(entry.index);
      flagBits = (flagBits | pixelFlags) >>> 0;
      let status = state;
      if (state === "valid" && !Number.isFinite(omega)) status = "no-solid-angle";
      const info = { column: entry.column, row: entry.row, x: entry.column + 1, y: entry.row + 1, index: entry.index, w: entry.w, value: values[entry.index], flags: pixelFlags, omega, status };
      pixels.push(info);
      if (status === "valid") {
        validArea += entry.w;
        const variance = observation.variance ? observation.variance[entry.index] : undefined;
        if (observation.variance && !(Number.isFinite(variance) && variance >= 0)) varianceGaps++;
        samples.push({ value: values[entry.index], weight: entry.w, omega, variance });
      } else {
        anyExcluded = true;
        if (status === "nan") nanArea += entry.w;
        else if (status === "flag") flagArea += entry.w;
        else nanArea += entry.w;
      }
    }
    for (const sample of samples) omegaArea += sample.weight * sample.omega;
    const coverage = validArea / fullArea;
    base.aperture = {
      radiusPixels: radius, radiusArcsec: pixelScale ? radius * pixelScale : null, area: fullArea,
      coverage, maskedShare: (nanArea + flagArea) / fullArea, nanShare: nanArea / fullArea, flagShare: flagArea / fullArea,
      offImageShare: Math.max(0, (fullArea - inImageArea) / fullArea), pixelCount: weights.length, validPixelCount: samples.length,
      solidAngleSr: omegaArea, minCoverage: params.minCoverage,
    };
    base.pixels = pixels;
    base.flags = flagBits + (anyExcluded ? containsBadPixel : 0);
    base.flagNames = describeFlags(base.flags, definitions);
    if (!samples.length) return fail(base, "insufficient-coverage", "No valid pixel remains in the aperture (every pixel is NaN, flagged or has no sky position).");
    if (coverage < params.minCoverage) {
      return fail(base, "insufficient-coverage", "Only " + (coverage * 100).toFixed(1) + "% of the aperture area has valid pixels, below the minimum of " + (params.minCoverage * 100).toFixed(0) + "%.");
    }

    // Background.
    let background = 0;
    let backgroundVariance = 0;
    base.annulus = null;
    if (params.background === "none") {
      base.background = { value: 0, method: "none", scatter: null, standardError: null, usedPixels: 0 };
      base.reasons.push("No background was subtracted: the pixel values are used as they are.");
    } else {
      const apertureIndices = new Set(weights.map((entry) => entry.index));
      const ring = apertureWeights(position.x, position.y, outer, width, height).filter((entry) => {
        const centreDistance = entry.distance;
        return centreDistance >= inner && centreDistance <= outer && !apertureIndices.has(entry.index);
      });
      const candidates = [];
      let ringNan = 0;
      let ringFlag = 0;
      let ringSource = 0;
      for (const entry of ring) {
        const state = pixelState(entry.index);
        if (state === "nan") { ringNan++; continue; }
        if (state === "flag") { ringFlag++; continue; }
        if (params.excludeSourceFromAnnulus && sourceMask && (flagOf(entry.index) & sourceMask)) { ringSource++; continue; }
        candidates.push(entry.index);
      }
      const inputValues = candidates.map((index) => values[index]);
      base.annulus = {
        innerPixels: inner, outerPixels: outer, innerArcsec: pixelScale ? inner * pixelScale : null, outerArcsec: pixelScale ? outer * pixelScale : null,
        pixelCount: ring.length, validCount: candidates.length, nanCount: ringNan, flagCount: ringFlag, sourceCount: ringSource,
        usedCount: 0, clippedCount: 0, minPixels: params.minAnnulusPixels,
      };
      if (candidates.length < params.minAnnulusPixels) {
        return fail(base, "insufficient-background", "The annulus has " + candidates.length + " valid pixels (" + ring.length + " inside the image), fewer than the minimum of " + params.minAnnulusPixels + ".");
      }
      const survivors = sigmaClip(inputValues, params.clipSigma, params.clipIterations);
      const used = survivors.map((position2) => inputValues[position2]);
      if (used.length < params.minAnnulusPixels) {
        return fail(base, "insufficient-background", "After " + params.clipSigma + "-sigma clipping only " + used.length + " annulus pixels remain, fewer than the minimum of " + params.minAnnulusPixels + ".");
      }
      background = params.background === "median" ? median(used) : mean(used);
      const scatter = standardDeviation(used, mean(used));
      const k = params.background === "median" ? Math.PI / 2 : 1;
      base.annulus.usedCount = used.length;
      base.annulus.clippedCount = candidates.length - used.length;
      base.background = { value: background, method: params.background + (params.clipSigma ? " (" + params.clipSigma + "σ clipped)" : ""), scatter, standardError: scatter * Math.sqrt(k / used.length), usedPixels: used.length };
      if (observation.variance) {
        const annulusVariance = survivors.map((position2) => observation.variance[candidates[position2]]).filter((value) => Number.isFinite(value) && value >= 0);
        if (annulusVariance.length) backgroundVariance = k * mean(annulusVariance) / used.length;
        else backgroundVariance = NaN;
      }
    }

    // Flux.
    const total = fluxFromSamples(samples, background, scale.factor);
    base.flux = { jy: total.jy, microJy: total.microJy, unit: "μJy", imageUnit: scale.unit, imageUnitFactor: scale.factor };
    base.omega = { medianSr: median(samples.map((sample) => sample.omega)), source: options.solidAngleSr !== undefined ? "constant supplied by the caller" : "WCS pixel corners" };
    const headerOmega = headerSolidAngleArcsec2(observation.cards);
    if (headerOmega !== null && options.solidAngleSr === undefined) {
      const wcsArcsec2 = base.omega.medianSr * (180 / Math.PI * 3600) ** 2;
      base.omega.headerArcsec2 = headerOmega;
      base.omega.wcsArcsec2 = wcsArcsec2;
      base.omega.ratioToHeader = wcsArcsec2 / headerOmega;
    }
    base.conversions = [
      scale.factor === 1 ? "BUNIT '" + scale.unit + "' is MJy/sr: no unit scaling." : "BUNIT '" + scale.unit + "' → MJy/sr: × " + significant(scale.factor, 6) + ".",
      "Fν[Jy] = 10⁶ × Σ wᵢ × (Iᵢ − b) × Ωᵢ, with Iᵢ and b in MJy/sr and Ωᵢ in sr.",
      "1 Jy = 10⁶ μJy.",
      "Ωᵢ: pixel solid angle from the " + base.omega.source + ", median " + significant(base.omega.medianSr, 6) + " sr.",
    ];

    // Error.
    if (!observation.variance) {
      base.fluxErrReason = "No VARIANCE image: the uncertainty is unavailable.";
    } else {
      const check = varianceUnitCheck(observation.varianceUnit, scale);
      if (!check.ok) base.fluxErrReason = check.reason;
      else if (varianceGaps > 0) base.fluxErrReason = varianceGaps + " aperture pixel" + (varianceGaps === 1 ? " has" : "s have") + " no valid variance, so the uncertainty is unavailable.";
      else if (!Number.isFinite(backgroundVariance)) base.fluxErrReason = "The annulus pixels have no valid variance, so the uncertainty is unavailable.";
      else {
        let apertureVariance = 0;
        for (const sample of samples) apertureVariance += (sample.weight * sample.omega) ** 2 * sample.variance;
        const variance = apertureVariance + omegaArea * omegaArea * backgroundVariance;
        const sigmaJy = 1e6 * scale.factor * Math.sqrt(variance);
        base.fluxErrMicroJy = sigmaJy * 1e6;
        base.fluxErrReason = "Propagated from the VARIANCE image (independent pixel noise" + (params.background === "none" ? "" : " plus the error of the background level") + "); calibration and correlated noise are not included." + (check.assumed ? " " + check.reason : "");
      }
    }

    // Wavelength.
    const lookup = observation.waveTable ? pairLib.wavelengthAt(observation.waveTable, fields, position.x, position.y) : null;
    if (lookup) {
      let low = lookup.micron;
      let high = lookup.micron;
      for (const entry of pixels) {
        const here = pairLib.wavelengthAt(observation.waveTable, fields, entry.x, entry.y);
        if (here) { low = Math.min(low, here.micron); high = Math.max(high, here.micron); }
      }
      base.wavelength = { micron: lookup.micron, bandwidth: lookup.bandwidth, rangeMin: low, rangeMax: high };
    } else {
      base.wavelengthReason = observation.waveTable
        ? "The WCS-WAVE lookup table does not cover the target pixel (or its header terms are not supported), so the wavelength is unknown."
        : "This file has no readable WCS-WAVE wavelength table, so the wavelength at the target pixel is unknown.";
    }

    base.measured = true;
    base.status = coverage < 1 - 1e-9 ? "partial-aperture" : "ok";
    if (base.status === "partial-aperture") {
      const parts = [];
      if (base.aperture.offImageShare > 1e-9) parts.push((base.aperture.offImageShare * 100).toFixed(1) + "% lies off the image");
      if (base.aperture.maskedShare > 1e-9) parts.push((base.aperture.maskedShare * 100).toFixed(1) + "% is masked");
      base.reasons.push("Partial aperture: " + (parts.join(" and ") || "less than the whole area is covered") + ". Left-out pixels are not replaced, so the flux is not corrected for them.");
    }
    base.spectrumPoint = Boolean(base.wavelength);
    base.notSpectrumReason = base.spectrumPoint ? "" : base.wavelengthReason + " The flux is shown, but it is not a point of a spectrum.";
    return base;
  }

  // ---- CSV (the shared contract) --------------------------------------------------------------------------------------------------------
  // MJD needs nine decimals (about 0.1 ms); the other numbers keep 12 significant digits.
  function csvField(value, column) {
    if (value === null || value === undefined) return "";
    const text = typeof value === "number"
      ? (Number.isFinite(value) ? String(column === "mjd" ? Number(value.toFixed(9)) : Number(value.toPrecision(12))) : "")
      : String(value);
    return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
  }

  // One CSV row (an object) for a measurement, or null when it is not a spectrum point.
  // context = { sourceId, obsId, detector, fileName }
  function csvRow(measurement, context) {
    if (!measurement || !measurement.measured || !measurement.spectrumPoint) return null;
    const a = measurement.aperture;
    return {
      source_id: context.sourceId, obs_id: context.obsId ?? "", mjd: measurement.epoch.mjd,
      ra: measurement.target.ra, dec: measurement.target.dec,
      wavelength: measurement.wavelength.micron, lambda_width: measurement.wavelength.bandwidth,
      flux: measurement.flux.microJy, flux_err: measurement.fluxErrMicroJy, flags: measurement.flags, method,
      x_image: measurement.position.x, y_image: measurement.position.y, detector: context.detector ?? "",
      aperture_radius_pix: a.radiusPixels, annulus_inner_pix: measurement.annulus ? measurement.annulus.innerPixels : "",
      annulus_outer_pix: measurement.annulus ? measurement.annulus.outerPixels : "",
      background_mjy_sr: measurement.background.value * measurement.flux.imageUnitFactor, aperture_coverage: a.coverage, masked_fraction: a.maskedShare,
      status: measurement.status, mjd_source: measurement.epoch.source, file: context.fileName ?? "",
    };
  }

  // CSV text of rows from csvRow(): the contract columns first, then the extra columns. Sorted by wavelength.
  function toCsv(rows) {
    const columns = csvColumns.concat(csvExtraColumns);
    const sorted = rows.slice().sort((a, b) => a.wavelength - b.wavelength);
    return [columns.join(",")].concat(sorted.map((row) => columns.map((column) => csvField(row[column], column)).join(","))).join("\r\n") + "\r\n";
  }

  const api = {
    method, methodLabel, csvColumns, csvExtraColumns, defaults, documentedFlags, excludedFlagNames, containsBadPixel, maxRadiusPixels,
    flagDefinitions, bitMask, describeFlags, unitScale, varianceUnitCheck,
    circleRectangleArea, apertureWeights, pixelSolidAngle, localPixelScaleArcsec, sigmaClip, median, mean,
    fluxFromSamples, parseCoordinate, parsePositive, checkParams, observationEpoch, headerSolidAngleArcsec2,
    measureAperture, csvField, csvRow, toCsv,
  };
  root.AstroNotPhotometry = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);
