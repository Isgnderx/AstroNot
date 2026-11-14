// Forced spectrophotometry measurement module (port of spxphot, the Rust reimplementation of the IRSA SPHEREx
// Spectrophotometry Tool).
//
// UI-independent: no DOM access, no network. Loads as a classic browser script (global `AstroNotForcedPhot`) and as a CommonJS
// module. It needs tools/fits-range.js (`AstroNotFitsRange`), tools/epsf.js (`AstroNotEpsf`) and tools/wcs.js
// (`AstroNotWcs`); load them before this file.
//
// PIXEL CONVENTION of the coordinate layer: 0-based, as astropy's origin=0 (first pixel centre = 0.0). FITS keywords are 1-based,
// so the conversion happens at the boundary. This differs from tools/wcs.js, which is 1-based.
(function (root) {
  "use strict";

  // rangeLib and epsfLib are used by the fit and the per-frame pipeline; they are required here so the load order is fixed.
  const rangeLib = typeof module === "object" && module.exports ? require("./fits-range.js") : root.AstroNotFitsRange; // eslint-disable-line no-unused-vars
  const epsfLib = typeof module === "object" && module.exports ? require("./epsf.js") : root.AstroNotEpsf; // eslint-disable-line no-unused-vars
  const wcsLib = typeof module === "object" && module.exports ? require("./wcs.js") : root.AstroNotWcs; // eslint-disable-line no-unused-vars

  // ---- Celestial and spectral WCS (port of wcs.rs) ----------------------------------------------------------------------------
  // Celestial (TAN-SIP) and spectral (-TAB lookup) WCS for SPHEREx images.

  const D2R = Math.PI / 180;

  // Header accessors. `fields` is a plain object whose values are strings (tools/fits-range.js cards) or numbers (JSON).
  // h.get: the raw value, or undefined when absent. h.f64_or(k, d): the value as a number, or d when absent or not numeric.
  // h.f64(k): the value as a number; throws when absent or not numeric.
  function get(fields, key) {
    return fields && Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : undefined;
  }
  function parseNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (text === "") return null;
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
  }
  function f64Or(fields, key, fallback) {
    const number = parseNumber(get(fields, key));
    return number === null ? fallback : number;
  }
  function f64(fields, key) {
    const value = get(fields, key);
    if (value === undefined) throw new Error("missing header key " + key);
    const number = parseNumber(value);
    if (number === null) throw new Error("header key " + key + " is not a number");
    return number;
  }

  // Terms [p, q, c] of one SIP polynomial family (prefix "A", "B", "AP" or "BP"), for 0 <= p + q <= {pre}_ORDER.
  function sipTerms(fields, pre) {
    const order = Math.trunc(f64Or(fields, pre + "_ORDER", -1));
    const v = [];
    for (let p = 0; p <= order; p++) {
      for (let q = 0; q <= order - p; q++) {
        const c = parseNumber(get(fields, pre + "_" + p + "_" + q));
        if (c !== null) v.push([p, q, c]);
      }
    }
    return v;
  }

  // Rust f64::rem_euclid: x % m, plus m when that is negative (so -1e-17 maps to 360, and non-negative x is returned exactly).
  function remEuclid(x, m) {
    const r = x % m;
    return r < 0 ? r + m : r;
  }

  function poly(terms, u, v) {
    let sum = 0;
    for (const [p, q, c] of terms) sum += c * Math.pow(u, p) * Math.pow(v, q);
    return sum;
  }

  // Gnomonic projection with SIP distortion (LONPOLE = 180, the zenithal default).
  function createTanSip(fields) {
    const c1raw = get(fields, "CTYPE1");
    const c1 = c1raw === undefined || c1raw === null ? "" : String(c1raw).trim();
    if (!c1.startsWith("RA---TAN")) throw new Error("unsupported projection " + c1);
    if (Math.abs(f64Or(fields, "LONPOLE", 180) - 180) > 1e-9) throw new Error("LONPOLE != 180 is not supported");
    const cdelt = [f64Or(fields, "CDELT1", 1), f64Or(fields, "CDELT2", 1)];
    const pc = (i, j, d) => f64Or(fields, "PC" + i + "_" + j, d);
    const cd = [
      [f64Or(fields, "CD1_1", pc(1, 1, 1) * cdelt[0]), f64Or(fields, "CD1_2", pc(1, 2, 0) * cdelt[0])],
      [f64Or(fields, "CD2_1", pc(2, 1, 0) * cdelt[1]), f64Or(fields, "CD2_2", pc(2, 2, 1) * cdelt[1])],
    ];
    const det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
    const cdInv = [
      [cd[1][1] / det, -cd[0][1] / det],
      [-cd[1][0] / det, cd[0][0] / det],
    ];
    const sip = c1.endsWith("-SIP") ? { a: sipTerms(fields, "A"), b: sipTerms(fields, "B"), ap: sipTerms(fields, "AP"), bp: sipTerms(fields, "BP") } : null;
    const crpix = [f64(fields, "CRPIX1"), f64(fields, "CRPIX2")]; // 1-based, as in the header
    const ra0 = f64(fields, "CRVAL1") * D2R;
    const dec0 = f64(fields, "CRVAL2") * D2R;

    // 0-based pixel -> intermediate tangent-plane coordinates (radians).
    function pixToPlane(x, y) {
      const u = x + 1 - crpix[0];
      const v = y + 1 - crpix[1];
      let du = 0;
      let dv = 0;
      if (sip) {
        du = poly(sip.a, u, v);
        dv = poly(sip.b, u, v);
      }
      const uu = u + du;
      const vv = v + dv;
      return [(cd[0][0] * uu + cd[0][1] * vv) * D2R, (cd[1][0] * uu + cd[1][1] * vv) * D2R];
    }

    // 0-based pixel -> (RA, Dec) in degrees.
    function pixToWorld(x, y) {
      const [xi, eta] = pixToPlane(x, y);
      const s0 = Math.sin(dec0);
      const c0 = Math.cos(dec0);
      const den = c0 - eta * s0;
      const ra = ra0 + Math.atan2(xi, den);
      const dec = Math.atan2(s0 + eta * c0, Math.sqrt(xi * xi + den * den));
      return [remEuclid(ra / D2R, 360), dec / D2R];
    }

    function worldToPlane(raDeg, decDeg) {
      const ra = raDeg * D2R;
      const dec = decDeg * D2R;
      const s0 = Math.sin(dec0);
      const c0 = Math.cos(dec0);
      const sd = Math.sin(dec);
      const cd2 = Math.cos(dec);
      const da = ra - ra0;
      const cosc = s0 * sd + c0 * cd2 * Math.cos(da);
      return [(cd2 * Math.sin(da)) / cosc, (c0 * sd - s0 * cd2 * Math.cos(da)) / cosc];
    }

    // d(xi, eta)/d(x, y) in radians per pixel, by central differences.
    function jacobianPlane(x, y) {
      const h = 1e-3;
      const [a1, b1] = pixToPlane(x + h, y);
      const [a0, b0] = pixToPlane(x - h, y);
      const [c1x, d1] = pixToPlane(x, y + h);
      const [c0x, d0] = pixToPlane(x, y - h);
      return [
        [(a1 - a0) / (2 * h), (c1x - c0x) / (2 * h)],
        [(b1 - b0) / (2 * h), (d1 - d0) / (2 * h)],
      ];
    }

    // (RA, Dec) degrees -> 0-based pixel. Uses the inverse SIP (AP/BP) as a starting guess, then Newton-iterates the forward
    // model, like astropy's `all_world2pix`, so the result is exact to ~1e-10 px.
    function worldToPix(ra, dec) {
      const [xi, eta] = worldToPlane(ra, dec);
      const xd = xi / D2R;
      const yd = eta / D2R;
      const uu = cdInv[0][0] * xd + cdInv[0][1] * yd;
      const vv = cdInv[1][0] * xd + cdInv[1][1] * yd;
      let u = uu;
      let v = vv;
      if (sip && sip.ap.length > 0) {
        u = uu + poly(sip.ap, uu, vv);
        v = vv + poly(sip.bp, uu, vv);
      }
      let x = u + crpix[0] - 1;
      let y = v + crpix[1] - 1;
      for (let iteration = 0; iteration < 20; iteration++) {
        const [pxi, peta] = pixToPlane(x, y);
        const rx = xi - pxi;
        const ry = eta - peta;
        const j = jacobianPlane(x, y);
        const det2 = j[0][0] * j[1][1] - j[0][1] * j[1][0];
        const dx = (j[1][1] * rx - j[0][1] * ry) / det2;
        const dy = (-j[1][0] * rx + j[0][0] * ry) / det2;
        x += dx;
        y += dy;
        if (Math.abs(dx) < 1e-11 && Math.abs(dy) < 1e-11) break;
      }
      return [x, y];
    }

    // Solid angle of the pixel centred at (x, y), in steradians. Tangent-plane area times the gnomonic area factor
    // (1 + rho^2)^(-3/2).
    function pixelSolidAngle(x, y) {
      const j = jacobianPlane(x, y);
      const [xi, eta] = pixToPlane(x, y);
      const det2 = Math.abs(j[0][0] * j[1][1] - j[0][1] * j[1][0]);
      return det2 / Math.pow(1 + xi * xi + eta * eta, 1.5);
    }

    // Local pixel->sky linear map in arcsec per pixel, with sky axes (east, north). Used to lay out extended (Sersic) models.
    function localAffineArcsec(x, y) {
      const h = 0.5;
      const [r0, d0] = pixToWorld(x, y);
      const toEn = (ra, dec) => {
        let dra = ra - r0;
        if (dra > 180) dra -= 360;
        if (dra < -180) dra += 360;
        return [dra * Math.cos(d0 * D2R) * 3600, (dec - d0) * 3600];
      };
      const [ex1, nx1] = toEn(...pixToWorld(x + h, y));
      const [ex0, nx0] = toEn(...pixToWorld(x - h, y));
      const [ey1, ny1] = toEn(...pixToWorld(x, y + h));
      const [ey0, ny0] = toEn(...pixToWorld(x, y - h));
      return [
        [(ex1 - ex0) / (2 * h), (ey1 - ey0) / (2 * h)],
        [(nx1 - nx0) / (2 * h), (ny1 - ny0) / (2 * h)],
      ];
    }

    return { worldToPix, pixToWorld, pixelSolidAngle, localAffineArcsec };
  }

  // SPHEREx per-pixel wavelength/bandwidth: a bilinear lookup table (FITS Paper III -TAB) with control points in 1-based
  // full-frame pixels. `values[(iy * nx + ix) * 2 + k]`, k = 0 wavelength, 1 bandwidth. `sip` ({ a, b } terms applied before the
  // lookup, astropy-compatible behaviour) is null or absent for none.
  function createWaveTable(xs, ys, values, { sip = null } = {}) {
    if (values.length !== xs.length * ys.length * 2) throw new Error("WCS-WAVE table has inconsistent dimensions");

    function withoutSip() {
      return createWaveTable(xs, ys, values, { sip: null });
    }

    // Reproduce astropy: `WCS(header, key="W", fobj=hdul)` silently applies the image's celestial SIP polynomials to the -TAB
    // pixel coordinates too. The official tool is built on astropy, so we match it by default.
    function withSipFrom(fields) {
      const a = sipTerms(fields, "A");
      const b = sipTerms(fields, "B");
      return createWaveTable(xs, ys, values, { sip: a.length > 0 ? { a, b } : sip });
    }

    // Piecewise-linear inverse of a monotonic index vector (0-based index).
    function fracIndex(grid, p) {
      const n = grid.length;
      const inc = grid[n - 1] >= grid[0];
      let i = 0;
      while (i < n - 2 && ((inc && p > grid[i + 1]) || (!inc && p < grid[i + 1]))) i++;
      return i + (p - grid[i]) / (grid[i + 1] - grid[i]);
    }

    const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

    // `crpix` are the CRPIX1W/CRPIX2W keywords of the image the pixel belongs to (1 for full frames). Returns
    // [wavelength_um, bandwidth_um].
    function evaluate(x0, y0, crpix) {
      // psi = CDELT*(p - CRPIX) + CRVAL with CDELT = CRVAL = 1, p 1-based.
      let u = x0 + 1 - crpix[0];
      let v = y0 + 1 - crpix[1];
      if (sip) {
        const du = poly(sip.a, u, v);
        const dv = poly(sip.b, u, v);
        u += du;
        v += dv;
      }
      const px = u + 1;
      const py = v + 1;
      const nx = xs.length;
      const ny = ys.length;
      const fx = clamp(fracIndex(xs, px), 0, nx - 1);
      const fy = clamp(fracIndex(ys, py), 0, ny - 1);
      const ix = Math.min(Math.floor(fx), nx - 2);
      const iy = Math.min(Math.floor(fy), ny - 2);
      const tx = fx - ix;
      const ty = fy - iy;
      const at = (i, j, k) => values[(j * nx + i) * 2 + k];
      const bil = (k) => at(ix, iy, k) * (1 - tx) * (1 - ty) + at(ix + 1, iy, k) * tx * (1 - ty) + at(ix, iy + 1, k) * (1 - tx) * ty + at(ix + 1, iy + 1, k) * tx * ty;
      return [bil(0), bil(1)];
    }

    return { eval: evaluate, withoutSip, withSipFrom };
  }

  // ---- Forced photometry on one frame (port of phot.rs) -----------------------------------------------------------------------
  // With positions and shapes fixed, the model  data = sum_k F_k * P_k + B  is *linear* in the free parameters (fluxes F_k and
  // background B). Tractor's optimiser converges to the same weighted-least-squares solution; we solve the normal equations
  // directly, which is exact and needs no iteration.
  //
  // Flag words: the Rust uses i64. Here `bits` are BigInt and the output `flags` is a BigInt (bits 32 and 33 do not fit a 32-bit
  // bitwise operator). The FLAGS image holds int32 values (bits <= 29) as Numbers; the per-pixel mask tests below use Number `&`,
  // which is exact because every mask they use (FIT_IGNORE, BAD, SOURCE) is below 2^31, and they are OR-ed into the BigInt result
  // with BigInt(Math.trunc(f)).

  const bits = (() => {
    const TRANSIENT = 1n << 0n;
    const SUR_ERROR = 1n << 2n;
    const NONFUNC = 1n << 6n;
    const MISSING_DATA = 1n << 9n;
    const HOT = 1n << 10n;
    const COLD = 1n << 11n;
    const NONLINEAR = 1n << 15n;
    const PERSIST = 1n << 17n;
    // Pixels with these flags are ignored by the fit (IRSA help page list).
    const OUTLIER = 1n << 19n;
    const SOURCE = 1n << 21n;
    const BLOOM = 1n << 26n;
    const SNOWBALL = 1n << 27n;
    const HALO = 1n << 28n;
    const SATELLITE_HALO = 1n << 29n;
    const CONTAINS_BAD_PIXEL = 1n << 32n;
    const FIT_ERROR = 1n << 33n;

    // Bits that make a pixel "bad" for CONTAINS_BAD_PIXEL. Inferred from 1148 IRSA measurements (3 targets, zero violations):
    // every image flag except SOURCE and OUTLIER.
    const BAD = ((1n << 30n) - 1n) & ~SOURCE & ~OUTLIER;

    const FIT_IGNORE = SUR_ERROR | NONFUNC | MISSING_DATA | HOT | COLD | NONLINEAR | PERSIST | BLOOM | SNOWBALL | HALO | SATELLITE_HALO;

    return { TRANSIENT, SUR_ERROR, NONFUNC, MISSING_DATA, HOT, COLD, NONLINEAR, PERSIST, OUTLIER, SOURCE, BLOOM, SNOWBALL, HALO, SATELLITE_HALO, CONTAINS_BAD_PIXEL, FIT_ERROR, FIT_IGNORE, BAD };
  })();

  // Number copies of the masks used on per-pixel flag values (all below 2^31, see above).
  const FIT_IGNORE_N = Number(bits.FIT_IGNORE);
  const BAD_N = Number(bits.BAD);
  const SOURCE_N = Number(bits.SOURCE);

  // Names of the named bits set in `flags` (a Number or a BigInt), in bit order. FIT_IGNORE and BAD are masks, not flags.
  const FLAG_BITS = Object.entries(bits)
    .filter(([name]) => name !== "FIT_IGNORE" && name !== "BAD")
    .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  function flagNames(flags) {
    const f = typeof flags === "bigint" ? flags : BigInt(Math.trunc(flags));
    return FLAG_BITS.filter(([, bit]) => (f & bit) !== 0n).map(([name]) => name);
  }

  // Params of phot.rs. `fitHalf` (half-size of the square fit region, region is (2r+1)^2) is not part of the defaults: it is derived
  // from fitSize by withFitHalf, as main.rs:574 does. fitShape is "box" | "circle", bkgStat "median" | "mean" | "mode" | "none".
  //   bkgHalf       half-size of the background region.
  //   bkgExcludeR   pixels closer than this to any source are excluded from the background.
  //   qlRadius      radius of the fit-quality aperture.
  //   flagRadius    radius within which pixel flags are propagated to the output.
  //   bkgStat       statistic for the pre-fit background: sigma-clipped median, mean, SExtractor-style mode (2.5 median - 1.5 mean,
  //                 after clipping) or none (no pre-fit background, sky only from the joint fit).
  //   skyFit        also fit a constant sky jointly with the fluxes.
  //   fitShape, fitSize  fit-region shape and size (pixels): a box of side fitSize or a circle of diameter fitSize, centred on the
  //                 source's sub-pixel position. Must fit inside the (2*fitHalf+1)^2 model box.
  //   astropyWave   spxphot's --astropy-wave; the run passes strictWave = !astropyWave (not used by the fit).
  const defaultParams = { fitSize: 13, fitShape: "circle", bkgHalf: 10, bkgExcludeR: 3, bkgStat: "median", skyFit: true, qlRadius: 2.5, flagRadius: 2.5, astropyWave: false };

  function withFitHalf(params) {
    return { ...params, fitHalf: Math.ceil(params.fitSize / 2) + 1 };
  }

  // Rust f64::round (half away from zero); Math.round rounds half up, which differs for negative halves.
  function roundHalfAway(x) {
    return x < 0 ? -Math.round(-x) : Math.round(x);
  }

  // `px` = { image, flags, variance, height }: tools/fits-range.js readRows results { y0, width, data, at(x, y) } (full-width row
  // blocks) and the full-frame height, for clipping.
  // `srcs` = [[x, y], ...] pixel positions (0-based); `models[k]` is the unit-flux model of source k evaluated on the fit box
  // (Float64Array, row-major, (2*fitHalf+1)^2), with box lower-left at (bx, by).
  // Returns { flux, fluxErr, bkgPre, bkgFit, fitQl, flags (BigInt), nPix }. Flux is in (MJy/sr) * pixel, i.e. surface brightness
  // summed; bkgPre is the pre-fit local background (MJy/sr) and bkgFit the fitted residual constant.
  function fitFrame(px, p, srcs, target, models, bx, by) {
    const [tx, ty] = srcs[target];
    const w = px.image.width;
    const rows = px.image.data.length / px.image.width;
    const yLo = px.image.y0;
    const yHi = px.image.y0 + rows;
    const inside = (x, y) => x >= 0 && x < w && y >= yLo && y < yHi && y < px.height;
    const out = { flux: [], fluxErr: [], bkgPre: 0, bkgFit: 0, fitQl: 0, flags: 0n, nPix: 0 };

    // A flags-image value as an integer (Rust `as i64`: truncates, NaN -> 0).
    const flagAt = (x, y) => {
      const f = px.flags.at(x, y);
      return Number.isFinite(f) ? Math.trunc(f) : 0;
    };

    // ---- 1. local background: sigma-clipped median of nearby clean pixels ----
    const cx = roundHalfAway(tx);
    const cy = roundHalfAway(ty);
    const collect = (excludeSource) => {
      const v = [];
      for (let y = cy - p.bkgHalf; y <= cy + p.bkgHalf; y++) {
        for (let x = cx - p.bkgHalf; x <= cx + p.bkgHalf; x++) {
          if (!inside(x, y)) continue;
          const f = flagAt(x, y);
          let bad = FIT_IGNORE_N;
          if (excludeSource) bad |= SOURCE_N;
          if ((f & bad) !== 0) continue;
          const near = srcs.some(([sx, sy]) => {
            const ex = x - sx;
            const ey = y - sy;
            return Math.sqrt(ex * ex + ey * ey) < p.bkgExcludeR;
          });
          const d = px.image.at(x, y);
          if (!near && Number.isFinite(d)) v.push(d);
        }
      }
      return v;
    };
    let bk = collect(true);
    if (bk.length < 10) {
      // Crowded fields (e.g. the Galactic plane) can have ~100% SOURCE pixels.
      bk = collect(false);
    }
    if (p.bkgStat === "none") {
      out.bkgPre = 0;
    } else {
      const st = clippedStat(bk, 3.0, 5, p.bkgStat);
      out.bkgPre = st === null ? 0 : st;
    }

    // ---- 2. weighted linear least squares for fluxes + constant ----
    const k = srcs.length;
    const np = p.skyFit ? k + 1 : k;
    const nSide = 2 * p.fitHalf + 1;
    const ata = new Array(np * np).fill(0);
    const atb = new Array(np).fill(0);
    const row = new Array(np).fill(0);
    const used = [];
    for (let j = 0; j < nSide; j++) {
      for (let i = 0; i < nSide; i++) {
        const x = bx + i;
        const y = by + j;
        if (!inside(x, y)) continue;
        const f = flagAt(x, y);
        const d = px.image.at(x, y);
        const v = px.variance.at(x, y);
        const dx = x - tx;
        const dy = y - ty;
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r <= p.flagRadius) {
          if (f !== 0) out.flags |= BigInt(f);
          if ((f & BAD_N) !== 0) out.flags |= bits.CONTAINS_BAD_PIXEL;
        }
        const inRegion = p.fitShape === "box" ? Math.abs(dx) < p.fitSize / 2.0 && Math.abs(dy) < p.fitSize / 2.0 : r < p.fitSize / 2.0;
        if (!inRegion || (f & FIT_IGNORE_N) !== 0 || !Number.isFinite(d) || !(v > 0.0) || !Number.isFinite(v)) continue;
        const wgt = 1.0 / v;
        const idx = j * nSide + i;
        for (let s = 0; s < models.length; s++) row[s] = models[s][idx];
        if (p.skyFit) row[k] = 1.0;
        const yObs = d - out.bkgPre;
        for (let a = 0; a < np; a++) {
          atb[a] += wgt * row[a] * yObs;
          for (let b = 0; b < np; b++) ata[a * np + b] += wgt * row[a] * row[b];
        }
        used.push([idx, d, v, r]);
      }
    }
    out.nPix = used.length;
    const cov = invertSpd(ata, np);
    if (cov === null) {
      out.flags |= bits.FIT_ERROR;
      out.flux = new Array(k).fill(NaN);
      out.fluxErr = new Array(k).fill(NaN);
      out.fitQl = NaN;
      return out;
    }
    const sol = [];
    for (let a = 0; a < np; a++) {
      let s = 0;
      for (let b = 0; b < np; b++) s += cov[a * np + b] * atb[b];
      sol.push(s);
    }
    out.flux = sol.slice(0, k);
    out.fluxErr = [];
    for (let s = 0; s < k; s++) out.fluxErr.push(Math.sqrt(cov[s * np + s]));
    out.bkgFit = p.skyFit ? sol[k] : 0.0;
    if (out.flux.some((value) => !Number.isFinite(value))) out.flags |= bits.FIT_ERROR;

    // ---- 3. fit quality: < |data - model| / sigma > within qlRadius ----
    let acc = 0;
    let n = 0;
    for (const [idx, d, v, r] of used) {
      if (r <= p.qlRadius) {
        let msum = 0;
        for (let s = 0; s < models.length; s++) msum += out.flux[s] * models[s][idx];
        const m = out.bkgPre + out.bkgFit + msum;
        acc += Math.abs(d - m) / Math.sqrt(v);
        n += 1;
      }
    }
    out.fitQl = n > 0 ? acc / n : NaN;
    return out;
  }

  // `v` is sorted and clipped in place (as the Rust `&mut Vec`). Returns null for an empty sample.
  function clippedStat(v, nsig, iters, st) {
    const med = sigmaClippedMedian(v, nsig, iters);
    if (med === null) return null;
    if (v.length === 0) return med;
    let sum = 0;
    for (const x of v) sum += x;
    const mean = sum / v.length;
    if (st === "mean") return mean;
    if (st === "mode") return 2.5 * med - 1.5 * mean;
    return med;
  }

  function sigmaClippedMedian(v, nsig, iters) {
    if (v.length === 0) return null;
    let med = 0;
    for (let it = 0; it < iters; it++) {
      v.sort((a, b) => a - b); // total_cmp; the samples are finite
      med = medianSorted(v);
      let sum = 0;
      for (const x of v) sum += x;
      const mean = sum / v.length;
      let sq = 0;
      for (const x of v) sq += (x - mean) * (x - mean);
      const sd = Math.sqrt(sq / v.length);
      const before = v.length;
      // v.retain(|x| (x - med).abs() <= nsig * sd), in place
      let kept = 0;
      for (let i = 0; i < v.length; i++) if (Math.abs(v[i] - med) <= nsig * sd) v[kept++] = v[i];
      v.length = kept;
      if (v.length === before || v.length === 0) break;
    }
    return v.length === 0 ? med : medianSorted(v);
  }

  function medianSorted(v) {
    const n = v.length;
    if (n % 2 === 1) return v[(n - 1) / 2]; // Rust n / 2 with integer division
    return 0.5 * (v[n / 2 - 1] + v[n / 2]);
  }

  // Invert a small symmetric positive-definite matrix (Cholesky). Returns null when it is not positive definite.
  function invertSpd(a, n) {
    const l = new Array(n * n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        let t = 0;
        for (let k = 0; k < j; k++) t += l[i * n + k] * l[j * n + k];
        const s = a[i * n + j] - t;
        if (i === j) {
          if (!(s > 0.0)) return null;
          l[i * n + i] = Math.sqrt(s);
        } else {
          l[i * n + j] = s / l[j * n + j];
        }
      }
    }
    const inv = new Array(n * n).fill(0);
    for (let c = 0; c < n; c++) {
      // solve L L^T x = e_c
      const y = new Array(n).fill(0);
      for (let i = 0; i < n; i++) {
        let t = 0;
        for (let k = 0; k < i; k++) t += l[i * n + k] * y[k];
        const s = (i === c ? 1.0 : 0.0) - t;
        y[i] = s / l[i * n + i];
      }
      for (let i = n - 1; i >= 0; i--) {
        let t = 0;
        for (let k = i + 1; k < n; k++) t += l[k * n + i] * inv[k * n + c];
        const s = y[i] - t;
        inv[i * n + c] = s / l[i * n + i];
      }
    }
    return inv;
  }

  const api = { sipTerms, createTanSip, createWaveTable, bits, flagNames, defaultParams, withFitHalf, fitFrame };

  root.AstroNotForcedPhot = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);
