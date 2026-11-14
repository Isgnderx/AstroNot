// PSF models for Forced Spectrophotometry: SPHEREx ePSF evaluation and the Sersic galaxy model.
//
// UI-independent: no DOM access, no network. Loads as a classic browser script (global `AstroNotEpsf`) and as a CommonJS module.
// It is a line-by-line port of spxphot's psf.rs, sersic.rs and archive.rs::parse_epsf (names and comments kept so the two can be
// diffed). It needs no other module: parseEpsf takes an already-built table from tools/fits-range.js (createBinTable).
//
// ePSF EVALUATION, matching photutils `ImagePSF.evaluate`
//   photutils fits `scipy.interpolate.RectBivariateSpline(kx=3, ky=3, s=0)` to the oversampled ePSF grid. With s=0 that is the unique
//   *not-a-knot* bicubic interpolant, which is separable: interpolate along x for every row, then along y. Because the spline is linear
//   in the data, interpolation at a point `t` is a dot product with a weight vector w(t); we precompute the matrix that maps data ->
//   second derivatives once per grid size.
//
// SERSIC MODEL
//   The ePSF is the pixel-convolved PSF sampled every 1/ovs native pixel. If we sample the galaxy on a grid aligned with that lattice
//   (offsets of k/ovs from native pixel centres), the convolution needs no interpolation:
//     model(c) = sum_u frac(u) * ovs^2 * ePSF[(c - u) * ovs + centre]
//   where frac(u) is the fraction of total galaxy flux in fine cell u.
//
// DATA SHAPES
//   An ePSF is { nx, ny, oversample, data: Float64Array } with data row-major [y][x]. A zone is { x, y, epsf } with (x, y) the zone
//   centre, 0-based full-frame. render() returns a Float64Array of length w * h, row-major, exactly as the Rust Vec<f64>.
(function (root) {
  "use strict";

  // ---- Not-a-knot spline ---------------------------------------------------------------------------------------------------
  // Linear operator for 1D not-a-knot cubic spline interpolation on x = 0..n-1.
  function createSpline1D(n) {
    if (!(n >= 4)) throw new Error("cubic spline needs >= 4 points");
    // System A M = B y
    const a = new Float64Array(n * n);
    const b = new Float64Array(n * n);
    // not-a-knot at x1: M0 - 2 M1 + M2 = 0 (third derivative continuous)
    a[0] = 1.0;
    a[1] = -2.0;
    a[2] = 1.0;
    for (let i = 1; i < n - 1; i++) {
      a[i * n + i - 1] = 1.0;
      a[i * n + i] = 4.0;
      a[i * n + i + 1] = 1.0;
      b[i * n + i - 1] = 6.0;
      b[i * n + i] = -12.0;
      b[i * n + i + 1] = 6.0;
    }
    const r = (n - 1) * n;
    a[r + n - 3] = 1.0;
    a[r + n - 2] = -2.0;
    a[r + n - 1] = 1.0;
    // k[i][j]: d M_i / d y_j (M = second derivatives at the knots)
    const k = solveDense(a, b, n);

    // Weight vector w with S(t) = w . y. Returns false outside [0, n-1] (photutils returns fill_value = 0 there).
    function weights(t, w) {
      if (!(t >= 0 && t <= n - 1)) return false;
      const i = Math.min(Math.floor(t), n - 2);
      const s = t - i;
      const ca = ((1.0 - s) * (1.0 - s) * (1.0 - s) - (1.0 - s)) / 6.0;
      const cb = (s * s * s - s) / 6.0;
      for (let j = 0; j < n; j++) {
        w[j] = ca * k[i * n + j] + cb * k[(i + 1) * n + j];
      }
      w[i] += 1.0 - s;
      w[i + 1] += s;
      return true;
    }

    return { n, weights };
  }

  // Solve A X = B for dense n x n (Gaussian elimination with partial pivoting). Works in place on a and b, which it owns.
  function solveDense(a, b, n) {
    for (let c = 0; c < n; c++) {
      // Rust max_by keeps the last of equal maxima, hence >=.
      let p = c;
      for (let i = c + 1; i < n; i++) {
        if (Math.abs(a[i * n + c]) >= Math.abs(a[p * n + c])) p = i;
      }
      if (p !== c) {
        for (let j = 0; j < n; j++) {
          let t = a[c * n + j];
          a[c * n + j] = a[p * n + j];
          a[p * n + j] = t;
          t = b[c * n + j];
          b[c * n + j] = b[p * n + j];
          b[p * n + j] = t;
        }
      }
      const d = a[c * n + c];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = a[r * n + c] / d;
        if (f === 0.0) continue;
        for (let j = 0; j < n; j++) {
          a[r * n + j] -= f * a[c * n + j];
          b[r * n + j] -= f * b[c * n + j];
        }
      }
    }
    for (let r = 0; r < n; r++) {
      const d = a[r * n + r];
      for (let j = 0; j < n; j++) {
        b[r * n + j] /= d;
      }
    }
    return b;
  }

  // ---- ePSF zones ----------------------------------------------------------------------------------------------------------
  // All zones of a detector plus the spline operators. zones: [{ x, y, epsf }], (x, y) 0-based full-frame.
  function createEpsfSet(zones) {
    if (!zones.length) throw new Error("an ePSF set needs at least one zone");
    const { nx, ny } = zones[0].epsf;
    const sx = createSpline1D(nx);
    const sy = createSpline1D(ny);

    // Zone whose centre is nearest to (x, y), as in the IRSA PSF tutorial.
    function nearest(x, y) {
      let best = zones[0];
      let bestD = (best.x - x) ** 2 + (best.y - y) ** 2;
      for (let i = 1; i < zones.length; i++) {
        const z = zones[i];
        const d = (z.x - x) ** 2 + (z.y - y) ** 2;
        if (d < bestD) {
          best = z;
          bestD = d;
        }
      }
      return best.epsf;
    }

    // Render the ePSF for a point source at (x0, y0) onto native pixels [xa, xa+w) x [ya, ya+h). Equivalent to
    // `ImagePSF(data, oversampling).evaluate(X, Y, 1, x0, y0)`.
    function render(e, x0, y0, xa, ya, w, h) {
      const ox = (e.nx - 1.0) / 2.0;
      const oy = (e.ny - 1.0) / 2.0;
      // x-direction weights per output column
      const wx = new Array(w);
      for (let c = 0; c < w; c++) {
        const t = e.oversample * ((xa + c) - x0) + ox;
        const v = new Float64Array(e.nx);
        wx[c] = sx.weights(t, v) ? v : null;
      }
      const out = new Float64Array(w * h);
      const wy = new Float64Array(e.ny);
      const col = new Float64Array(e.ny);
      for (let c = 0; c < w; c++) {
        const wxc = wx[c];
        if (wxc === null) continue;
        // interpolate every oversampled row at this column's x
        for (let j = 0; j < e.ny; j++) {
          const base = j * e.nx;
          let sum = 0;
          for (let i = 0; i < e.nx; i++) sum += e.data[base + i] * wxc[i];
          col[j] = sum;
        }
        for (let r = 0; r < h; r++) {
          const t = e.oversample * ((ya + r) - y0) + oy;
          if (sy.weights(t, wy)) {
            let sum = 0;
            for (let j = 0; j < e.ny; j++) sum += col[j] * wy[j];
            out[r * w + c] = sum;
          }
        }
      }
      return out;
    }

    return { zones, nearest, render };
  }

  // Port of archive.rs::parse_epsf. header: the EPSF HDU header; table: createBinTable(header, bytes).
  function parseEpsf(h, t) {
    const ovs = h.num("OVSMPX", 1.0);
    if (Math.abs(h.num("OVSMPY", ovs) - ovs) > 0.0) {
      throw new Error("anisotropic ePSF oversampling is not supported");
    }
    // TDIMn = '(33,33)'
    const col = t.columns.findIndex((c) => c.name.toUpperCase() === "EPSF");
    if (col < 0) throw new Error("no EPSF column");
    const tdim = h.str("TDIM" + (col + 1)) ?? "";
    const dims = tdim
      .replace(/^[()]+/, "")
      .replace(/[()]+$/, "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^\+?\d+$/.test(s))
      .map(Number);
    let nx;
    let ny;
    if (dims.length === 2) {
      [nx, ny] = dims;
    } else {
      nx = ny = Math.floor(Math.sqrt(t.columns[col].repeat));
    }
    const zones = [];
    for (let r = 0; r < t.rows; r++) {
      zones.push({
        x: t.scalar(r, "XCENTER"),
        y: t.scalar(r, "YCENTER"),
        epsf: { nx, ny, oversample: ovs, data: t.get(r, "EPSF") },
      });
    }
    return createEpsfSet(zones);
  }

  // ---- Sersic --------------------------------------------------------------------------------------------------------------
  const minPositive = 2.2250738585072014e-308; // f64::MIN_POSITIVE
  function bN(n) {
    // Ciotti & Bertin (1999) asymptotic expansion; accurate for n >= 0.36.
    return 2.0 * n - 1.0 / 3.0
      + 4.0 / (405.0 * n)
      + 46.0 / (25515.0 * n * n)
      + 131.0 / (1148175.0 * (n * n * n));
  }

  const lanczos = [
    0.9999999999998099,
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9.984369578019572e-6,
    1.5056327351493116e-7,
  ];

  function lnGamma(x) {
    // Lanczos approximation (g = 7, n = 9).
    x = x - 1.0;
    let a = lanczos[0];
    const t = x + 7.5;
    for (let i = 1; i < lanczos.length; i++) {
      a += lanczos[i] / (x + i);
    }
    return 0.5 * Math.log(2.0 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }

  // Sersic galaxy model. paDeg is east of north.
  function createSersic({ n, reArcsec, axisRatio, paDeg }) {
    // Surface brightness at elliptical radius r (arcsec) for unit total flux.
    function sb(r) {
      const re = reArcsec;
      const q = axisRatio;
      const b = bN(n);
      // L = 2 pi n q Re^2 e^b b^-2n Gamma(2n) * Ie   ->  Ie = 1 / that
      const lnL = Math.log(2.0 * Math.PI * n * q * re * re) + b - 2.0 * n * Math.log(b)
        + lnGamma(2.0 * n);
      return Math.exp(-b * (Math.pow(r / re, 1.0 / n) - 1.0) - lnL);
    }

    function radius(east, north) {
      const rad = paDeg * (Math.PI / 180.0);
      const s = Math.sin(rad);
      const c = Math.cos(rad);
      const a = east * s + north * c; // along major axis
      const b = -east * c + north * s; // along minor axis
      const bq = b / axisRatio;
      return Math.sqrt(a * a + bq * bq);
    }

    // Render the PSF-convolved model on native pixels [xa, xa+w) x [ya, ya+h) for a galaxy centred at (x0, y0). `affine` maps pixel
    // offsets to (east, north) arcsec. Total flux of the (untruncated) model is 1.
    function render(e, affine, x0, y0, xa, ya, w, h) {
      const ovs = Math.round(e.oversample);
      const cx = Math.trunc((e.nx - 1) / 2);
      const cy = Math.trunc((e.ny - 1) / 2);
      const reachX = Math.trunc(cx / ovs) + 1; // PSF half-width in native pixels
      const reachY = Math.trunc(cy / ovs) + 1;
      const det = Math.abs(affine[0][0] * affine[1][1] - affine[0][1] * affine[1][0]); // arcsec^2 / px^2
      const cell = 1.0 / ovs;
      // fine grid covering the box plus the PSF reach
      const fx0 = (xa - reachX) * ovs;
      const fx1 = (xa + w + reachX) * ovs;
      const fy0 = (ya - reachY) * ovs;
      const fy1 = (ya + h + reachY) * ovs;
      const nfx = fx1 - fx0;
      const frac = new Float64Array(nfx * (fy1 - fy0));
      for (let fy = fy0; fy < fy1; fy++) {
        for (let fx = fx0; fx < fx1; fx++) {
          const px = fx * cell;
          const py = fy * cell;
          const dx = px - x0;
          const dy = py - y0;
          // supersample cells near the centre where the profile is cuspy
          let ss;
          if (Math.abs(dx) < 2.0 * cell && Math.abs(dy) < 2.0 * cell) ss = 16;
          else if (Math.abs(dx) < 1.0 && Math.abs(dy) < 1.0) ss = 4;
          else ss = 1;
          let acc = 0.0;
          for (let sj = 0; sj < ss; sj++) {
            for (let si = 0; si < ss; si++) {
              const ox = dx + ((si + 0.5) / ss - 0.5) * cell;
              const oy = dy + ((sj + 0.5) / ss - 0.5) * cell;
              const east = affine[0][0] * ox + affine[0][1] * oy;
              const north = affine[1][0] * ox + affine[1][1] * oy;
              acc += sb(radius(east, north));
            }
          }
          frac[(fy - fy0) * nfx + (fx - fx0)] = acc / (ss * ss) * det * cell * cell;
        }
      }
      // one fine node contributes E[...] summed over a single lattice phase ~ sum(E)/ovs^2
      let total = 0;
      for (let i = 0; i < e.data.length; i++) total += e.data[i];
      const scale = (ovs * ovs) / Math.max(total, minPositive);
      const out = new Float64Array(w * h);
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
          const pfx = (xa + c) * ovs;
          const pfy = (ya + r) * ovs;
          let acc = 0.0;
          for (let j = 0; j < e.ny; j++) {
            const fy = pfy - (j - cy);
            const row = fy - fy0;
            for (let i = 0; i < e.nx; i++) {
              const fx = pfx - (i - cx);
              acc += frac[row * nfx + (fx - fx0)] * e.data[j * e.nx + i];
            }
          }
          out[r * w + c] = acc * scale;
        }
      }
      return out;
    }

    return { n, reArcsec, axisRatio, paDeg, sb, radius, render };
  }

  const api = { createSpline1D, createEpsfSet, parseEpsf, createSersic, bN, lnGamma };
  root.AstroNotEpsf = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);
