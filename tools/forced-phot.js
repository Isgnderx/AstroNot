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

  // rangeLib and epsfLib are used by the per-frame pipeline; they are required here so the load order is fixed.
  const rangeLib = typeof module === "object" && module.exports ? require("./fits-range.js") : root.AstroNotFitsRange;
  const epsfLib = typeof module === "object" && module.exports ? require("./epsf.js") : root.AstroNotEpsf;
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

  // ---- Frames, calibration cache and the run (port of archive.rs / main.rs) ---------------------------------------------------
  // Frames come from an Observation Search result list (tools/observation-csv.js rows) instead of spxphot's TAP query; every target
  // is a member of every frame, and the on-image test per target does the rest.

  const S3_BASE = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/";
  const IRSA_PREFIX = "https://irsa.ipac.caltech.edu/ibe/data/spherex/";
  const METHOD = "forced-epsf";

  // Rust str::trim_start_matches / trim_end_matches (they remove every repetition of the pattern).
  function trimStartMatches(s, pat) {
    while (pat && s.startsWith(pat)) s = s.slice(pat.length);
    return s;
  }
  function trimEndMatches(s, pat) {
    while (pat && s.endsWith(pat)) s = s.slice(0, s.length - pat.length);
    return s;
  }

  // Frame (archive.rs) from an Observation Search row. `uri` is the path after IRSA_PREFIX ("dr1/level2/..."); `collection` is the
  // SIA obs_collection ("spherex_dr1", "spherex_qr3_deep"), falling back to "spherex_" + release for rows without it; `deep` and
  // `dataCollection` are Frame::deep() and Frame::data_collection(); `mjd` is t_min (NaN when absent, as the Rust parse fallback).
  // Returns null when the row is not a SPHEREx level-2 FITS file on IRSA.
  function frameFromImportRow(row) {
    if (!row || !row.product) return null;
    const href = typeof row.product === "string" ? row.product : String(row.product.href);
    if (!href.startsWith(IRSA_PREFIX) || !href.endsWith(".fits")) return null;
    const uri = href.slice(IRSA_PREFIX.length);
    const collection = row.collection ? String(row.collection) : row.release ? "spherex_" + row.release : "";
    if (collection === "") return null;
    return {
      uri,
      url: S3_BASE + uri,
      obsId: row.obsId,
      collection,
      dataCollection: trimEndMatches(trimStartMatches(collection, "spherex_"), "_deep"),
      deep: collection.endsWith("_deep"),
      detector: Number.isInteger(row.detector) ? row.detector : null,
      mjd: typeof row.start === "number" && Number.isFinite(row.start) ? row.start : NaN,
    };
  }

  // QueryOpts (archive.rs) applied to a frame list instead of the TAP query: deep frames only with `deep` (the query's
  // `collection NOT LIKE '%deep%'`), `detectors` (empty = all), and MJD bounds on the frame start (`time_bounds_lower`; a frame
  // without a start time fails either bound, as SQL NULL does). Each excluded frame is counted under the first filter it fails.
  function selectFrames(frames, { deep = false, detectors = [], mjdMin = null, mjdMax = null } = {}) {
    const excluded = { deep: 0, detector: 0, mjd: 0 };
    const kept = [];
    for (const f of frames) {
      if (!deep && String(f.collection).includes("deep")) excluded.deep++;
      else if (detectors.length > 0 && !detectors.includes(f.detector)) excluded.detector++;
      else if ((mjdMin !== null && !(f.mjd >= mjdMin)) || (mjdMax !== null && !(f.mjd <= mjdMax))) excluded.mjd++;
      else kept.push(f);
    }
    return { frames: kept, excluded };
  }

  // Rust str::parse::<f64>: decimal and exponent forms, inf/infinity/nan; nothing else (Number() would also take "", "0x10").
  function parseRustF64(s) {
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s);
    if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
    if (/^[+-]?nan$/i.test(s)) return NaN;
    return null;
  }

  // Validate a Sersic shape. Returns { ok: true, shape: null } for Re < 1" (point source, as IRSA does).
  function validateShape(n, re, q, pa) {
    if (!(n >= 0.5 && n <= 6.0)) return { ok: false, reason: "Sersic index must be within 0.5..6" };
    if (!(q > 0.0 && q <= 1.0)) return { ok: false, reason: "axis ratio must be in (0, 1]" };
    if (!(pa >= -360.0 && pa <= 360.0)) return { ok: false, reason: "position angle must be within -360..360" };
    if (re >= 20.0) return { ok: false, reason: "effective radius must be < 20 arcsec" };
    return { ok: true, shape: re >= 1.0 ? { n, reArcsec: re, axisRatio: q, paDeg: pa } : null };
  }

  // Records of a CSV text as the Rust csv crate reads them: RFC 4180 quoting, CRLF or LF, a leading BOM stripped, blank lines skipped.
  function csvRecords(text) {
    const records = [];
    let record = [];
    let field = "";
    let quoted = false;
    let touched = false; // the current record has content (a blank line has none)
    const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const endRecord = () => {
      if (touched) {
        record.push(field);
        records.push(record);
      }
      record = [];
      field = "";
      touched = false;
    };
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quoted) {
        if (c === '"' && s[i + 1] === '"') {
          field += '"';
          i++;
        } else if (c === '"') {
          quoted = false;
        } else {
          field += c;
        }
      } else if (c === '"') {
        quoted = true;
        touched = true;
      } else if (c === ",") {
        record.push(field);
        field = "";
        touched = true;
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && s[i + 1] === "\n") i++;
        endRecord();
      } else {
        field += c;
        touched = true;
      }
    }
    endRecord();
    return records;
  }

  // Port of read_targets for a targets file: columns ra, dec[, name][, sersic_n, re_arcsec, axis_ratio, pa_deg] (case-insensitive),
  // 1..20 rows. Returns { ok: true, targets: [{ name, ra, dec, shape }] } or { ok: false, reason } with the Rust messages.
  function parseTargetsCsv(text) {
    const records = csvRecords(String(text));
    const hdr = (records[0] || []).map((s) => s.trim().toLowerCase());
    const col = (n) => {
      const i = hdr.indexOf(n);
      return i < 0 ? null : i;
    };
    const ciRa = col("ra");
    if (ciRa === null) return { ok: false, reason: "targets need an 'ra' column" };
    const ciDec = col("dec");
    if (ciDec === null) return { ok: false, reason: "targets need a 'dec' column" };
    const v = [];
    for (let i = 1; i < records.length; i++) {
      const r = records[i];
      if (r.length !== records[i - 1].length) {
        return { ok: false, reason: "found record with " + r.length + " fields, but the previous record has " + records[i - 1].length + " fields" };
      }
      const f = (c) => (c === null || r[c] === undefined ? null : parseRustF64(r[c].trim()));
      const sersic = [f(col("sersic_n")), f(col("re_arcsec")), f(col("axis_ratio")), f(col("pa_deg"))];
      let shape = null;
      if (sersic.every((x) => x !== null)) {
        const checked = validateShape(...sersic);
        if (!checked.ok) return checked;
        shape = checked.shape;
      }
      const ra = parseRustF64(r[ciRa].trim());
      const dec = parseRustF64(r[ciDec].trim());
      if (ra === null || dec === null) return { ok: false, reason: "invalid float literal" };
      const ciName = col("name");
      v.push({ name: ciName !== null ? r[ciName] : "src" + i, ra, dec, shape });
    }
    if (v.length === 0 || v.length > 20) return { ok: false, reason: "targets file must have 1..=20 rows (got " + v.length + ")" };
    return { ok: true, targets: v };
  }

  // ---- calibration cache ----
  // Rust tokio OnceCell: get_or_try_init runs one initialiser at a time; a failed one leaves the cell empty for the next caller.
  function onceCell() {
    return { initialized: false, value: undefined, pending: null };
  }
  async function getOrTryInit(cell, init) {
    for (;;) {
      if (cell.initialized) return cell.value;
      if (cell.pending) {
        try {
          await cell.pending;
        } catch (e) {
          // that initialiser failed; try our own
        }
        continue;
      }
      cell.pending = init().then(
        (value) => {
          cell.value = value;
          cell.initialized = true;
          cell.pending = null;
          return value;
        },
        (e) => {
          cell.pending = null;
          throw e;
        }
      );
      return cell.pending;
    }
  }

  // `layouts` (not in the Rust) remembers, per data collection, where the IMAGE header of a remote frame starts (see imageHdu).
  function createCalibCache() {
    const epsfCells = new Map();
    const waveCells = new Map();
    const cell = (m, k) => {
      if (!m.has(k)) m.set(k, onceCell());
      return m.get(k);
    };

    const cache = { epsfDownloads: 0, layouts: new Map(), get };

    // Get the ePSF set and wavelength table for this frame. Keys are the calibration UUIDs recorded in the IMAGE header HISTORY, so
    // each distinct calibration is downloaded once per run, not once per frame.
    async function get(source, image, afterVariance) {
      const det = image.header.get("DETECTOR") ?? "?";
      const ek = det + ":" + (image.header.calibId("epsf") ?? "");
      const wk = det + ":" + (image.header.calibId("spectral_wcs") ?? "");
      const ec = cell(epsfCells, ek);
      const wc = cell(waveCells, wk);
      if (ec.initialized && wc.initialized) return { epsf: ec.value, wave: wc.value };
      // Walk the remaining HDUs (ZODI, EPSF, WCS-WAVE) of this file. The Rust stops at any error; here only a real end of file stops
      // the walk quietly, so a network failure is reported as itself.
      const tail = new Map();
      let off = afterVariance;
      for (let i = 0; i < 4; i++) {
        let h;
        try {
          h = await rangeLib.hduAt(source, off);
        } catch (e) {
          if (e && e.code === "EOF") break;
          throw e;
        }
        off = h.end;
        tail.set(h.name, h);
        if (h.name === "WCS-WAVE") break;
      }
      const epsf = await getOrTryInit(ec, async () => {
        const h = tail.get("EPSF");
        if (!h) {
          const e = new Error("frame has no EPSF extension (pre-QR3 data?)");
          e.code = "NO_EPSF";
          throw e;
        }
        const bytes = await rangeLib.readTableBytes(source, h);
        cache.epsfDownloads++;
        return epsfLib.parseEpsf(h.header, rangeLib.createBinTable(h.header, bytes));
      });
      const wave = await getOrTryInit(wc, async () => {
        const h = tail.get("WCS-WAVE");
        if (!h) throw new Error("frame has no WCS-WAVE extension");
        const bytes = await rangeLib.readTableBytes(source, h);
        const t = rangeLib.createBinTable(h.header, bytes);
        return createWaveTable(t.get(0, "X"), t.get(0, "Y"), t.get(0, "VALUES")).withSipFrom(image.header.cards);
      });
      return { epsf, wave };
    }

    return cache;
  }

  // The IMAGE HDU of a frame. spxphot reads the PRIMARY header and then the IMAGE header after it. For remote sources the IMAGE
  // header offset learned from the first frame of a data collection is tried first, with one bounded read; it is accepted only when
  // that read holds a complete IMAGE extension header (XTENSION and EXTNAME 'IMAGE') of the remembered NAXIS1/NAXIS2/BITPIX, and
  // otherwise the PRIMARY-then-IMAGE walk runs. Only the IMAGE offset is remembered: the FLAGS extension is RICE-compressed with a
  // per-frame heap size, so the offsets of VARIANCE and later HDUs differ between frames, and readRows needs their headers anyway.
  // Memory sources (local files) never use the memo.
  async function imageHdu(source, frame, cache) {
    const key = frame && frame.dataCollection;
    const useMemo = source.kind !== "memory" && cache && cache.layouts && key;
    const memo = useMemo ? cache.layouts.get(key) : undefined;
    if (memo) {
      let header = null;
      try {
        header = rangeLib.parseHeader(await source.read(memo.headerOffset, rangeLib.BLOCK * 16));
      } catch (e) {
        if (!e || e.code !== "EOF") throw e;
      }
      if (
        header &&
        header.get("XTENSION") === "IMAGE" &&
        header.get("EXTNAME") === "IMAGE" &&
        header.get("NAXIS1") === memo.naxis1 &&
        header.get("NAXIS2") === memo.naxis2 &&
        header.get("BITPIX") === memo.bitpix
      ) {
        const dataOffset = memo.headerOffset + header.size;
        const dataSize = header.dataSize();
        return { name: "IMAGE", header, dataOffset, dataSize, end: dataOffset + dataSize };
      }
    }
    const primary = await rangeLib.hduAt(source, 0);
    const image = await rangeLib.hduAt(source, primary.end);
    if (useMemo && image.name === "IMAGE") {
      const h = image.header;
      cache.layouts.set(key, { headerOffset: primary.end, naxis1: h.get("NAXIS1"), naxis2: h.get("NAXIS2"), bitpix: h.get("BITPIX") });
    }
    return image;
  }

  // Fractional systematic error added in quadrature; inferred from IRSA output, where flux_err^2 = flux_err_tractor^2 + (0.03 flux)^2
  // to <0.1%.
  const SYS_FRAC = 0.03;

  // Rust `f64 as u8`: truncates and saturates, NaN -> 0.
  function asU8(x) {
    if (Number.isNaN(x)) return 0;
    return Math.min(Math.max(Math.trunc(x), 0), 255);
  }

  // Measure every target that falls on one frame (port of process_frame; every target is a member). `params` must carry fitHalf
  // (withFitHalf). Returns spxphot's Row objects: label, ra, dec, lambda, lambda_width, flux, flux_err (statistical error with a 3%
  // systematic floor in quadrature, IRSA's flux_err), flux_err_tractor (pure statistical error of the linear fit), flags (a Number;
  // every flag bit is below 2^34, so it is exact), fit_ql, flux_bkg (background under the source, MJy/sr), lvf_id, det_id, deep_flg,
  // mjd, data_collection, x_image, y_image, n_pix.
  async function measureFrame({ source, frame, targets, params, cache, strictWave = true }) {
    const p = params.fitHalf === undefined ? withFitHalf(params) : params;
    const members = targets.map((_, i) => i);

    const image = await imageHdu(source, frame, cache);
    const ih = image.header;
    const w = ih.int("NAXIS1");
    const h = ih.int("NAXIS2");
    const wcs = createTanSip(ih.cards);

    // pixel positions of all members on this frame
    const pos = members.map((i) => wcs.worldToPix(targets[i].ra, targets[i].dec));
    const on = ([x, y]) => x >= -0.5 && y >= -0.5 && x < w - 0.5 && y < h - 0.5;
    if (!pos.some(on)) return [];
    const reach = Math.max(p.bkgHalf, p.fitHalf) + 1;
    const ys = pos.filter(on).map((q) => roundHalfAway(q[1]));
    const y0 = Math.max(Math.min(...ys) - reach, 0);
    const y1 = Math.min(Math.max(...ys) + reach, h - 1);
    const nrows = y1 - y0 + 1;

    // overlap header discovery with data reads
    const [imgRows, flagsHdu] = await Promise.all([rangeLib.readRows(source, image, y0, nrows), rangeLib.hduAt(source, image.end)]);
    const [flagRows, varHdu] = await Promise.all([rangeLib.readRows(source, flagsHdu, y0, nrows), rangeLib.hduAt(source, flagsHdu.end)]);
    const [varRows, calib] = await Promise.all([rangeLib.readRows(source, varHdu, y0, nrows), cache.get(source, image, varHdu.end)]);

    const px = { image: imgRows, flags: flagRows, variance: varRows, height: h };
    const det = asU8(ih.num("DETECTOR", frame.detector === null || frame.detector === undefined ? 0 : frame.detector));
    // cutout pixel -> parent (full-frame) 0-based pixel, via the 'A' WCS
    const ax = ih.num("CRPIX1A", 1.0);
    const ay = ih.num("CRPIX2A", 1.0);
    const wcrpix = [ih.num("CRPIX1W", 1.0), ih.num("CRPIX2W", 1.0)];
    const lvf = Math.trunc(ih.num("EXPIDN", 0.0));
    const mjd = ih.num("MJD-AVG", frame.mjd);

    const nSide = 2 * p.fitHalf + 1;
    const rows = [];
    pos.forEach(([tx, ty], k) => {
      if (!on([tx, ty])) return;
      const t = targets[members[k]];
      const bx = roundHalfAway(tx) - p.fitHalf;
      const by = roundHalfAway(ty) - p.fitHalf;
      const parentX = tx + 1.0 - ax;
      const parentY = ty + 1.0 - ay;
      const epsf = calib.epsf.nearest(parentX, parentY);
      // every member whose PSF touches this fit box is fit jointly
      const srcs = [[tx, ty]];
      const idx = [members[k]];
      pos.forEach((q, j) => {
        if (j !== k && Math.abs(q[0] - tx) <= p.fitHalf + 4 && Math.abs(q[1] - ty) <= p.fitHalf + 4) {
          srcs.push(q);
          idx.push(members[j]);
        }
      });
      const models = srcs.map(([sx, sy], s) => {
        const shape = targets[idx[s]].shape;
        if (!shape) {
          const m = calib.epsf.render(epsf, sx, sy, bx, by, nSide, nSide);
          let sum = 0;
          for (let i = 0; i < m.length; i++) sum += m[i];
          if (sum > 0.0) for (let i = 0; i < m.length; i++) m[i] /= sum;
          return m;
        }
        return epsfLib.createSersic(shape).render(epsf, wcs.localAffineArcsec(sx, sy), sx, sy, bx, by, nSide, nSide);
      });
      const fit = fitFrame(px, p, srcs, 0, models, bx, by);
      const omega = wcs.pixelSolidAngle(tx, ty); // sr
      const toUjy = omega * 1e12; // (MJy/sr) * sr -> MJy -> uJy
      const [wave, band] = strictWave ? calib.wave.withoutSip().eval(parentX, parentY, [1.0, 1.0]) : calib.wave.eval(tx, ty, wcrpix);
      const [ra, dec] = wcs.pixToWorld(tx, ty);
      const flux = fit.flux[0] * toUjy;
      const err = fit.fluxErr[0] * toUjy;
      const sys = SYS_FRAC * flux;
      rows.push({
        label: t.name,
        ra,
        dec,
        lambda: wave,
        lambda_width: band,
        flux,
        flux_err: Math.sqrt(err * err + sys * sys),
        flux_err_tractor: err,
        flags: Number(fit.flags),
        fit_ql: fit.fitQl,
        flux_bkg: fit.bkgPre + fit.bkgFit, // MJy/sr, as in the IRSA output
        lvf_id: lvf,
        det_id: det,
        deep_flg: Boolean(frame.deep),
        mjd,
        data_collection: frame.dataCollection,
        x_image: parentX,
        y_image: parentY,
        n_pix: fit.nPix,
      });
    });
    return rows;
  }

  // Angular separation of two targets in degrees (used by spxphot to size cutout-service requests).
  function angularSep(a, b) {
    const r1 = a.ra * D2R;
    const d1 = a.dec * D2R;
    const r2 = b.ra * D2R;
    const d2 = b.dec * D2R;
    const c = Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(r1 - r2);
    return Math.acos(Math.min(Math.max(c, -1.0), 1.0)) / D2R;
  }

  // Rust f64::total_cmp: -NaN < -inf < ... < -0 < +0 < ... < inf < NaN.
  const f64Buffer = new Float64Array(1);
  const i64View = new BigInt64Array(f64Buffer.buffer);
  function totalKey(x) {
    f64Buffer[0] = x;
    const l = i64View[0];
    return l < 0n ? l ^ 0x7fffffffffffffffn : l;
  }
  function totalCmp(a, b) {
    const ka = totalKey(a);
    const kb = totalKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  }

  // The run (main.rs): measure every frame concurrently with `concurrency` workers. Frames repeating an earlier uri are measured once
  // (the `members` map). A frame that throws is counted as failed, except a missing EPSF extension, which is skipped with its reason,
  // as is a frame on which no target falls. With `signal` aborted no new frame is started; frames in flight finish. Rows outside
  // filters.wvlMin/wvlMax are dropped, and the rest are sorted by label, then wavelength.
  async function runForcedPhotometry({
    frames,
    targets,
    params = defaultParams,
    filters = {},
    concurrency = 6,
    openSource = (frame) => rangeLib.createHttpSource(frame.url),
    onProgress = () => {},
    signal = null,
  }) {
    const t0 = Date.now();
    const p = withFitHalf(params);
    const strictWave = !p.astropyWave;
    const cache = createCalibCache();

    // 1. which frames cover which targets: every target is a member of every frame.
    const list = [];
    const members = new Map();
    for (const f of frames) {
      if (members.has(f.uri)) continue;
      members.set(
        f.uri,
        targets.map((_, i) => i)
      );
      list.push(f);
    }

    // 2. measure every frame concurrently
    let results = [];
    const skipped = [];
    const failed = [];
    let measured = 0;
    let done = 0;
    let next = 0;
    let cancelled = false;
    async function worker() {
      while (next < list.length) {
        if (signal && signal.aborted) {
          cancelled = true;
          return;
        }
        const f = list[next++];
        try {
          const source = await openSource(f);
          const rows = await measureFrame({ source, frame: f, targets, params: p, cache, strictWave });
          if (rows.length === 0) {
            skipped.push({ uri: f.uri, reason: "target off image" });
          } else {
            measured++;
            for (const r of rows) results.push(r);
          }
        } catch (e) {
          if (e && e.code === "NO_EPSF") skipped.push({ uri: f.uri, reason: e.message });
          else failed.push({ uri: f.uri, error: e && e.message ? e.message : String(e) });
        }
        done++;
        onProgress({ done, total: list.length, measured, failed: failed.length });
      }
    }
    const workers = [];
    for (let i = 0; i < Math.min(Math.max(1, concurrency), list.length); i++) workers.push(worker());
    await Promise.all(workers);
    if (signal && signal.aborted && done < list.length) cancelled = true;

    const wvlMin = filters.wvlMin ?? null;
    const wvlMax = filters.wvlMax ?? null;
    results = results.filter((r) => (wvlMin === null || r.lambda >= wvlMin) && (wvlMax === null || r.lambda <= wvlMax));
    results.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : totalCmp(a.lambda, b.lambda)));

    return {
      rows: results,
      report: { frames: list.length, measured, skipped, failed, epsfDownloads: cache.epsfDownloads, cancelled, seconds: (Date.now() - t0) / 1000 },
    };
  }

  // ---- CSV outputs ----
  const irsaColumns = ["label", "ra", "dec", "lambda", "lambda_width", "flux", "flux_err", "flux_err_tractor", "flags", "fit_ql", "flux_bkg", "lvf_id", "det_id", "deep_flg", "mjd", "data_collection", "x_image", "y_image", "n_pix"];
  const spectrumLabColumns = ["source_id", "obs_id", "mjd", "ra", "dec", "wavelength", "lambda_width", "flux", "flux_err", "flags", "method", "lvf_id", "det_id", "x_image", "y_image", "fit_ql", "flux_bkg", "data_collection"];

  function csvField(value) {
    const s = String(value);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  // Numbers as spxphot's csv writer prints them for the values that occur (shortest round-trip; NaN, inf, -inf).
  function rustNumber(x) {
    if (Number.isNaN(x)) return "NaN";
    if (x === Infinity) return "inf";
    if (x === -Infinity) return "-inf";
    return String(x);
  }
  // Spectrum Lab: non-finite numbers are left empty (the contract reader treats empty as missing).
  function finiteOrEmpty(x) {
    return typeof x === "number" && Number.isFinite(x) ? String(x) : "";
  }

  // spxphot's output CSV (its 19 columns, IRSA's names).
  function rowsToIrsaCsv(rows) {
    const lines = [irsaColumns.join(",")];
    for (const r of rows) lines.push(irsaColumns.map((c) => csvField(typeof r[c] === "number" ? rustNumber(r[c]) : r[c])).join(","));
    return lines.join("\n") + "\n";
  }

  // The Spectrum Lab contract columns (tools/photometry.js csvColumns; wavelength um, flux uJy), then this method's extras. obs_id
  // is the IRSA exposure ID (lvf_id).
  function rowsToSpectrumLabCsv(rows) {
    const lines = [spectrumLabColumns.join(",")];
    for (const r of rows) {
      const cells = [
        csvField(r.label),
        String(r.lvf_id),
        finiteOrEmpty(r.mjd),
        finiteOrEmpty(r.ra),
        finiteOrEmpty(r.dec),
        finiteOrEmpty(r.lambda),
        finiteOrEmpty(r.lambda_width),
        finiteOrEmpty(r.flux),
        finiteOrEmpty(r.flux_err),
        String(r.flags),
        METHOD,
        String(r.lvf_id),
        String(r.det_id),
        finiteOrEmpty(r.x_image),
        finiteOrEmpty(r.y_image),
        finiteOrEmpty(r.fit_ql),
        finiteOrEmpty(r.flux_bkg),
        csvField(r.data_collection),
      ];
      lines.push(cells.join(","));
    }
    return lines.join("\n") + "\n";
  }

  const api = {
    sipTerms,
    createTanSip,
    createWaveTable,
    bits,
    flagNames,
    defaultParams,
    withFitHalf,
    fitFrame,
    S3_BASE,
    IRSA_PREFIX,
    METHOD,
    SYS_FRAC,
    frameFromImportRow,
    selectFrames,
    validateShape,
    parseTargetsCsv,
    createCalibCache,
    measureFrame,
    angularSep,
    runForcedPhotometry,
    irsaColumns,
    rowsToIrsaCsv,
    rowsToSpectrumLabCsv,
  };

  root.AstroNotForcedPhot = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);
