// FITS World Coordinate System (WCS) and image-view geometry for AstroNot tools.
//
// UI-independent: no DOM access. Loads as a classic browser script (global
// `AstroNotWcs`) and as a CommonJS module (`require("./wcs.js")`), so Sky Explorer,
// Time Machine and Image Differencing can share one coordinate implementation.
//
// SUPPORTED WCS PROFILE (primary WCS only, i.e. keywords without an alternate-version letter)
//   - Two celestial axes: CTYPE1 = "RA---TAN" or "RA---TAN-SIP", CTYPE2 = "DEC--TAN" or "DEC--TAN-SIP".
//   - Reference frame ICRS, written as RADESYS = 'ICRS' or implied by the absence of RADESYS and EQUINOX.
//   - Linear transformation from PCi_j with CDELTi (PC defaults to the identity), or from CDi_j.
//   - CRPIX and CRVAL are required. CRPIX may be negative or lie far outside the image.
//   - LONPOLE (default 180 deg, or 0 deg when CRVAL2 is at least 90 deg).
//   - SIP (Shupe et al. 2005): A/B polynomials of order 0 to 9 from pixel to intermediate coordinates, applied
//     to u = x - CRPIX1 and v = y - CRPIX2, including any A_0_0 and B_0_0 terms. AP/BP are used only as the
//     starting guess of the inverse; the sky-to-pixel direction is solved to machine precision by Newton iteration.
//   - CUNIT, when present, must be "deg".
// Anything else (other projections, galactic or other frames, CROTA-only headers, PV keywords, non-2D WCSAXES,
// alternate WCS) is reported with a reason by createWcs() and is never converted approximately.
//
// PIXEL CONVENTION
//   Pixel coordinates passed to this module are FITS coordinates: continuous, 1-based, with the CENTRE of the first
//   array element at (1, 1). Pixel (n, m) therefore covers x in [n - 0.5, n + 0.5). The image occupies
//   x in [0.5, width + 0.5] and y in [0.5, height + 0.5]. The zero-based array index of a position is
//   floor(x - 0.5), which is the same as astropy's origin=1 convention minus one. FITS axis 2 points up:
//   row index j = 0 is the BOTTOM row of the displayed image. A display canvas has its rows top to bottom, so the
//   canvas coordinate of FITS (x, y) is (x - 0.5, height + 0.5 - y); see fitsToCanvas().
(function (root) {
  "use strict";

  const DEG = Math.PI / 180;
  const RAD = 180 / Math.PI;
  const maxSipOrder = 9;

  function normalizeRa(ra) {
    let value = ra % 360;
    if (value < 0) value += 360;
    return value >= 360 || Object.is(value, -0) ? 0 : value;
  }

  // Great-circle separation in degrees (Vincenty formula, stable at small and antipodal separations).
  function angularSeparation(ra1, dec1, ra2, dec2) {
    const lat1 = dec1 * DEG;
    const lat2 = dec2 * DEG;
    const dLon = (ra2 - ra1) * DEG;
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    const y = Math.cos(lat2) * Math.sin(dLon);
    const z = Math.sin(lat1) * Math.sin(lat2) + Math.cos(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return Math.atan2(Math.hypot(x, y), z) * RAD;
  }

  function isNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function unsupported(reason) {
    return { ok: false, reason };
  }

  function sipTerms(fields, name) {
    const order = fields[name + "_ORDER"];
    if (!Number.isInteger(order) || order < 0 || order > maxSipOrder) {
      throw new Error(name + "_ORDER must be an integer from 0 to " + maxSipOrder + ".");
    }
    const terms = [];
    for (let p = 0; p <= order; p++) {
      for (let q = 0; q <= order - p; q++) {
        const value = fields[name + "_" + p + "_" + q];
        if (value === undefined) continue;
        if (!isNumber(value)) throw new Error(name + "_" + p + "_" + q + " is not a number.");
        terms.push([p, q, value]);
      }
    }
    return { order, terms };
  }

  function polynomial(terms, u, v) {
    let sum = 0;
    for (const [p, q, c] of terms) sum += c * u ** p * v ** q;
    return sum;
  }

  function polynomialDerivatives(terms, u, v) {
    let du = 0;
    let dv = 0;
    for (const [p, q, c] of terms) {
      if (p > 0) du += c * p * u ** (p - 1) * v ** q;
      if (q > 0) dv += c * q * u ** p * v ** (q - 1);
    }
    return [du, dv];
  }

  function makeSip(fields, notes) {
    const hasA = fields.A_ORDER !== undefined;
    const hasB = fields.B_ORDER !== undefined;
    if (hasA !== hasB) throw new Error("SIP needs both A_ORDER and B_ORDER.");
    if (!hasA) throw new Error("CTYPE has the -SIP suffix, but A_ORDER and B_ORDER are missing.");
    const a = sipTerms(fields, "A");
    const b = sipTerms(fields, "B");
    let ap = [];
    let bp = [];
    if (fields.AP_ORDER !== undefined && fields.BP_ORDER !== undefined) {
      ap = sipTerms(fields, "AP").terms;
      bp = sipTerms(fields, "BP").terms;
    } else {
      notes.push("No AP/BP inverse coefficients; sky-to-pixel uses iteration only.");
    }
    return { order: Math.max(a.order, b.order), a: a.terms, b: b.terms, ap, bp };
  }

  // Intermediate world coordinates (deg) on the tangent plane -> celestial (deg). Calabretta & Greisen 2002,
  // zenithal case: the fiducial point is the native pole, so (alpha_p, delta_p) = (CRVAL1, CRVAL2).
  function tanDeproject(x, y, alpha0, delta0, lonpole) {
    const r = Math.hypot(x, y);
    const phi = Math.atan2(x, -y);
    const theta = Math.atan2(RAD, r);
    const dphi = phi - lonpole * DEG;
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    const sinD0 = Math.sin(delta0 * DEG);
    const cosD0 = Math.cos(delta0 * DEG);
    const sinDec = sinT * sinD0 + cosT * cosD0 * Math.cos(dphi);
    const ra = alpha0 + Math.atan2(-cosT * Math.sin(dphi), sinT * cosD0 - cosT * sinD0 * Math.cos(dphi)) * RAD;
    return { ra: normalizeRa(ra), dec: Math.asin(Math.max(-1, Math.min(1, sinDec))) * RAD };
  }

  function tanProject(ra, dec, alpha0, delta0, lonpole) {
    const dAlpha = (ra - alpha0) * DEG;
    const sinD = Math.sin(dec * DEG);
    const cosD = Math.cos(dec * DEG);
    const sinD0 = Math.sin(delta0 * DEG);
    const cosD0 = Math.cos(delta0 * DEG);
    const east = -cosD * Math.sin(dAlpha);
    const north = sinD * cosD0 - cosD * sinD0 * Math.cos(dAlpha);
    const phi = lonpole * DEG + Math.atan2(east, north);
    const sinTheta = sinD * sinD0 + cosD * cosD0 * Math.cos(dAlpha);
    if (!(sinTheta > 1e-9)) return null; // At or beyond 90 deg from the reference point: not on the TAN plane.
    const r = RAD * Math.hypot(east, north) / sinTheta; // R = (180/pi) cot(theta); hypot(east, north) = cos(theta)
    return { x: r * Math.sin(phi), y: -r * Math.cos(phi) };
  }

  // createWcs(fields) -> { ok: true, wcs } or { ok: false, reason }.
  // `fields` maps header keywords to values as produced by readFitsHdus(): numbers, booleans and strings.
  function createWcs(fields) {
    try {
      return buildWcs(fields);
    } catch (error) {
      return unsupported(error.message);
    }
  }

  function buildWcs(fields) {
    if (!fields || typeof fields !== "object") return unsupported("No header was provided.");
    const ctype1 = typeof fields.CTYPE1 === "string" ? fields.CTYPE1.trim().toUpperCase() : "";
    const ctype2 = typeof fields.CTYPE2 === "string" ? fields.CTYPE2.trim().toUpperCase() : "";
    if (!ctype1 && !ctype2) return unsupported("The header has no CTYPE keywords, so it defines no sky coordinates.");
    const match1 = /^RA---([A-Z]{3})(-SIP)?$/.exec(ctype1);
    const match2 = /^DEC--([A-Z]{3})(-SIP)?$/.exec(ctype2);
    if (!match1 || !match2) {
      return unsupported("CTYPE1/CTYPE2 are " + (ctype1 || "missing") + " and " + (ctype2 || "missing") + ". Only RA/Dec axes (RA---TAN, DEC--TAN) are supported.");
    }
    if (match1[1] !== "TAN" || match2[1] !== "TAN") {
      return unsupported("The " + match1[1] + " projection is not supported. Only TAN and TAN-SIP are supported.");
    }
    if (Boolean(match1[2]) !== Boolean(match2[2])) return unsupported("CTYPE1 and CTYPE2 disagree about the -SIP suffix.");
    const sipDeclared = Boolean(match1[2]);

    if (fields.WCSAXES !== undefined && fields.WCSAXES !== 2) return unsupported("WCSAXES is " + fields.WCSAXES + "; only two-axis WCS is supported.");
    for (const key of Object.keys(fields)) {
      if (/^PV[12]_\d+$/.test(key)) return unsupported("PV projection parameters (" + key + ") are not supported.");
    }

    const radesys = typeof fields.RADESYS === "string" ? fields.RADESYS.trim().toUpperCase() : undefined;
    if (radesys !== undefined && radesys !== "ICRS") return unsupported("The reference frame " + radesys + " is not supported. Only ICRS is supported.");
    if (radesys === undefined && fields.EQUINOX !== undefined) return unsupported("RADESYS is missing and EQUINOX is present, which implies FK5 or FK4. Only ICRS is supported.");
    for (const key of ["CUNIT1", "CUNIT2"]) {
      const unit = fields[key];
      if (unit !== undefined && String(unit).trim().toLowerCase() !== "deg") return unsupported(key + " is '" + unit + "'. Only degrees are supported.");
    }

    for (const key of ["CRVAL1", "CRVAL2", "CRPIX1", "CRPIX2"]) {
      if (!isNumber(fields[key])) return unsupported(key + " is missing or not a number.");
    }
    const alpha0 = fields.CRVAL1;
    const delta0 = fields.CRVAL2;
    if (Math.abs(delta0) > 90) return unsupported("CRVAL2 is outside -90 to 90 degrees.");
    const crpix = [fields.CRPIX1, fields.CRPIX2];

    // Matrix M maps (u, v) = pixel - CRPIX onto intermediate world coordinates in degrees.
    const cdKeys = ["CD1_1", "CD1_2", "CD2_1", "CD2_2"];
    const pcKeys = ["PC1_1", "PC1_2", "PC2_1", "PC2_2"];
    const hasCd = cdKeys.some((key) => fields[key] !== undefined);
    const hasPc = pcKeys.some((key) => fields[key] !== undefined);
    let matrix;
    if (hasCd && hasPc) return unsupported("The header mixes CDi_j and PCi_j keywords.");
    if (hasCd) {
      const values = cdKeys.map((key) => fields[key] ?? 0);
      if (!values.every(isNumber)) return unsupported("A CDi_j keyword is not a number.");
      matrix = values;
    } else {
      if (!isNumber(fields.CDELT1) || !isNumber(fields.CDELT2)) {
        return unsupported(fields.CROTA1 !== undefined || fields.CROTA2 !== undefined
          ? "Legacy CROTA keywords without CDELT and PC or CD are not supported."
          : "The header has no CDi_j matrix and no CDELT1/CDELT2 pixel scale.");
      }
      if (fields.CROTA2 !== undefined || fields.CROTA1 !== undefined) {
        if (!hasPc) return unsupported("Legacy CROTA keywords are not supported. Use PCi_j or CDi_j.");
      }
      const pc = [fields.PC1_1 ?? 1, fields.PC1_2 ?? 0, fields.PC2_1 ?? 0, fields.PC2_2 ?? 1];
      if (!pc.every(isNumber)) return unsupported("A PCi_j keyword is not a number.");
      matrix = [fields.CDELT1 * pc[0], fields.CDELT1 * pc[1], fields.CDELT2 * pc[2], fields.CDELT2 * pc[3]];
    }
    const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
    if (!(Math.abs(determinant) > 0) || !Number.isFinite(determinant)) return unsupported("The pixel-to-sky matrix is singular.");
    const inverse = [matrix[3] / determinant, -matrix[1] / determinant, -matrix[2] / determinant, matrix[0] / determinant];

    let lonpole = fields.LONPOLE;
    if (lonpole === undefined) lonpole = delta0 >= 90 ? 0 : 180;
    if (!isNumber(lonpole)) return unsupported("LONPOLE is not a number.");

    const notes = [];
    let sip = null;
    if (sipDeclared) sip = makeSip(fields, notes);
    else if (fields.A_ORDER !== undefined || fields.B_ORDER !== undefined) notes.push("SIP keywords ignored because CTYPE has no -SIP suffix.");

    function pixelToSky(x, y) {
      if (!isNumber(x) || !isNumber(y)) return null;
      let u = x - crpix[0];
      let v = y - crpix[1];
      if (sip) {
        const du = polynomial(sip.a, u, v);
        const dv = polynomial(sip.b, u, v);
        u += du;
        v += dv;
      }
      const sky = tanDeproject(matrix[0] * u + matrix[1] * v, matrix[2] * u + matrix[3] * v, alpha0, delta0, lonpole);
      return isNumber(sky.ra) && isNumber(sky.dec) ? sky : null;
    }

    function skyToPixel(ra, dec) {
      if (!isNumber(ra) || !isNumber(dec) || Math.abs(dec) > 90) return null;
      const plane = tanProject(ra, dec, alpha0, delta0, lonpole);
      if (!plane) return null;
      const f = inverse[0] * plane.x + inverse[1] * plane.y;
      const g = inverse[2] * plane.x + inverse[3] * plane.y;
      if (!sip) return { x: f + crpix[0], y: g + crpix[1] };

      let u = f + polynomial(sip.ap, f, g);
      let v = g + polynomial(sip.bp, f, g);
      if (!sip.ap.length) {
        u = f;
        v = g;
      }
      let converged = false;
      for (let iteration = 0; iteration < 30; iteration++) {
        const residualU = u + polynomial(sip.a, u, v) - f;
        const residualV = v + polynomial(sip.b, u, v) - g;
        const [aU, aV] = polynomialDerivatives(sip.a, u, v);
        const [bU, bV] = polynomialDerivatives(sip.b, u, v);
        const j11 = 1 + aU;
        const j12 = aV;
        const j21 = bU;
        const j22 = 1 + bV;
        const det = j11 * j22 - j12 * j21;
        if (!(Math.abs(det) > 1e-12)) return null;
        const stepU = (j22 * residualU - j12 * residualV) / det;
        const stepV = (-j21 * residualU + j11 * residualV) / det;
        u -= stepU;
        v -= stepV;
        if (Math.abs(stepU) < 1e-11 && Math.abs(stepV) < 1e-11) {
          converged = true;
          break;
        }
      }
      return converged && isNumber(u) && isNumber(v) ? { x: u + crpix[0], y: v + crpix[1] } : null;
    }

    const projection = "TAN" + (sip ? "-SIP" : "");
    return {
      ok: true,
      wcs: {
        projection,
        frame: "ICRS",
        crval: [alpha0, delta0],
        crpix,
        sipOrder: sip ? sip.order : null,
        notes,
        summary: "RA---" + projection + " / DEC--" + projection + ", ICRS" + (sip ? ", SIP order " + sip.order : ""),
        pixelToSky,
        skyToPixel,
      },
    };
  }

  // ---- View geometry -------------------------------------------------------------------------------------------
  // A view is { centerX, centerY, scale, width, height }: the FITS position at the middle of the panel, the number of
  // CSS pixels per image pixel, and the panel size in CSS pixels. Screen x grows right, screen y grows DOWN.

  function fitScale(imageWidth, imageHeight, panelWidth, panelHeight) {
    return Math.min(panelWidth / imageWidth, panelHeight / imageHeight);
  }

  function screenToFits(view, sx, sy) {
    return {
      x: view.centerX + (sx - view.width / 2) / view.scale,
      y: view.centerY - (sy - view.height / 2) / view.scale, // Screen Y down is FITS Y up.
    };
  }

  function fitsToScreen(view, x, y) {
    return {
      x: view.width / 2 + (x - view.centerX) * view.scale,
      y: view.height / 2 - (y - view.centerY) * view.scale,
    };
  }

  // Position inside the canvas that holds the decoded image (row 0 at the top), see the pixel convention above.
  function fitsToCanvas(x, y, imageHeight) {
    return { x: x - 0.5, y: imageHeight + 0.5 - y };
  }

  function insideImage(x, y, imageWidth, imageHeight) {
    return x >= 0.5 && x < imageWidth + 0.5 && y >= 0.5 && y < imageHeight + 0.5;
  }

  // Zero-based array index of a FITS position, or -1 outside the image.
  function pixelIndex(x, y, imageWidth, imageHeight) {
    if (!insideImage(x, y, imageWidth, imageHeight)) return -1;
    const column = Math.min(imageWidth - 1, Math.floor(x - 0.5));
    const row = Math.min(imageHeight - 1, Math.floor(y - 0.5));
    return row * imageWidth + column;
  }

  function visibleExtent(view) {
    const halfWidth = view.width / 2 / view.scale;
    const halfHeight = view.height / 2 / view.scale;
    return {
      xMin: view.centerX - halfWidth,
      xMax: view.centerX + halfWidth,
      yMin: view.centerY - halfHeight,
      yMax: view.centerY + halfHeight,
    };
  }

  // Angular size of the part of the image shown in the view. The horizontal size is the great-circle angle between the
  // left and right boundary points of the horizontal line through the view centre; the vertical size uses the top and
  // bottom points of the vertical line through the centre. Boundaries are clipped to the image, and `clipped` is true
  // when empty panel area was left out. Returns { horizontal, vertical, status } with null members when the measurement
  // is not possible (no WCS, centre outside the image, or a failed transformation); never a pixel count.
  function fieldOfView(wcs, view, imageWidth, imageHeight) {
    const result = { horizontal: null, vertical: null, status: "" };
    if (!wcs) {
      result.status = "No usable WCS";
      return result;
    }
    const extent = visibleExtent(view);
    if (!insideImage(view.centerX, view.centerY, imageWidth, imageHeight)) {
      result.status = "View center is outside the image";
      return result;
    }
    const measure = (a, b, aSky, bSky, clipped) => {
      if (!aSky || !bSky) return null;
      return { degrees: angularSeparation(aSky.ra, aSky.dec, bSky.ra, bSky.dec), clipped, from: a, to: b };
    };
    const xMin = Math.max(extent.xMin, 0.5);
    const xMax = Math.min(extent.xMax, imageWidth + 0.5);
    const yMin = Math.max(extent.yMin, 0.5);
    const yMax = Math.min(extent.yMax, imageHeight + 0.5);
    const left = { x: xMin, y: view.centerY };
    const right = { x: xMax, y: view.centerY };
    const bottom = { x: view.centerX, y: yMin };
    const top = { x: view.centerX, y: yMax };
    result.horizontal = measure(left, right, wcs.pixelToSky(left.x, left.y), wcs.pixelToSky(right.x, right.y), xMin > extent.xMin || xMax < extent.xMax);
    result.vertical = measure(bottom, top, wcs.pixelToSky(bottom.x, bottom.y), wcs.pixelToSky(top.x, top.y), yMin > extent.yMin || yMax < extent.yMax);
    if (!result.horizontal || !result.vertical) result.status = "The WCS transformation failed at the view boundary";
    return result;
  }

  const api = {
    createWcs, normalizeRa, angularSeparation,
    fitScale, screenToFits, fitsToScreen, fitsToCanvas, insideImage, pixelIndex, visibleExtent, fieldOfView,
  };
  root.AstroNotWcs = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);
