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

  const api = { sipTerms, createTanSip, createWaveTable };

  root.AstroNotForcedPhot = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);
