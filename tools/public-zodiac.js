// Sun position, zodiac signs and constellation lookup for the Constellation Finder.
// Pure functions, no DOM: loads as a classic script (global AstroNotPublicZodiac) and as CommonJS for node tests.
//
// - Sun: Meeus, Astronomical Algorithms, chapter 25 (low precision, about 0.01 degree). The apparent longitude of date gives
//   the astrological (tropical) sign; for the IAU constellation the longitude is reduced to J2000 (general precession,
//   50.29 arcsec per Julian year) and converted to equatorial coordinates with the J2000 obliquity, because the boundaries
//   in assets/tools/constellations.js are J2000.
// - Constellation lookup: ray casting in (RA, Dec) on each boundary ring after its RA has been made continuous; the two
//   rings that enclose a celestial pole (Octans, Ursa Minor) are closed along the pole for the inside test only.
(function (root) {
  "use strict";

  const degrees = Math.PI / 180;
  const day = 86_400_000;
  const obliquityJ2000 = 23.4392911;
  const angle = (value) => ((value % 360) + 360) % 360;
  const sine = (value) => Math.sin(value * degrees);
  const cosine = (value) => Math.cos(value * degrees);

  const signNames = ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo", "Libra", "Scorpius", "Sagittarius", "Capricornus", "Aquarius", "Pisces"];
  const signDesigs = ["Ari", "Tau", "Gem", "Cnc", "Leo", "Vir", "Lib", "Sco", "Sgr", "Cap", "Aqr", "Psc"];
  const signFolkNames = ["the Ram", "the Bull", "the Twins", "the Crab", "the Lion", "the Maiden", "the Scales", "the Scorpion", "the Archer", "the Sea-Goat", "the Water Bearer", "the Fishes"];
  // Conventional date ranges of the tropical signs as [[month, day], [month, day]] (the real boundary shifts by a day with
  // the year; the sign itself is always computed from the Sun's longitude).
  const signRanges = [[[3, 21], [4, 19]], [[4, 20], [5, 20]], [[5, 21], [6, 20]], [[6, 21], [7, 22]], [[7, 23], [8, 22]], [[8, 23], [9, 22]],
    [[9, 23], [10, 22]], [[10, 23], [11, 21]], [[11, 22], [12, 21]], [[12, 22], [1, 19]], [[1, 20], [2, 18]], [[2, 19], [3, 20]]];

  // ---- The Sun ----------------------------------------------------------------------------------------------
  const julianCenturies = (timestamp) => (timestamp / day + 2440587.5 - 2451545) / 36525;

  function sunLongitude(timestamp) {
    const T = julianCenturies(timestamp);
    const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
    const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
    const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * sine(M) + (0.019993 - 0.000101 * T) * sine(2 * M) + 0.000289 * sine(3 * M);
    const omega = 125.04 - 1934.136 * T;
    const lambdaDate = angle(L0 + C - 0.00569 - 0.00478 * sine(omega));
    return { lambdaDate, lambdaJ2000: angle(lambdaDate - 1.39697 * T) };
  }

  function equatorialFromLongitude(lambda) {
    const ra = angle(Math.atan2(sine(lambda) * cosine(obliquityJ2000), cosine(lambda)) / degrees);
    const dec = Math.asin(sine(lambda) * sine(obliquityJ2000)) / degrees;
    return { ra, dec };
  }

  function sunEquatorialJ2000(timestamp) {
    return equatorialFromLongitude(sunLongitude(timestamp).lambdaJ2000);
  }

  const tropicalSign = (lambdaDate) => Math.floor(angle(lambdaDate) / 30);

  // ---- Boundary rings -------------------------------------------------------------------------------------------
  // RA made continuous along the ring: consecutive points never jump by more than 180 degrees.
  function unwrapRing(ring) {
    const points = [];
    let previous = null;
    for (const [ra, dec] of ring) {
      let value = ra;
      if (previous !== null) {
        while (value - previous > 180) value -= 360;
        while (previous - value > 180) value += 360;
      }
      points.push([value, dec]);
      previous = value;
    }
    const span = points[points.length - 1][0] - points[0][0];
    const polar = Math.abs(span) >= 359 ? (points.reduce((sum, [, dec]) => sum + dec, 0) > 0 ? "north" : "south") : null;
    return { points, polar };
  }

  const ringCache = new WeakMap();
  function prepared(constellation) {
    if (!ringCache.has(constellation)) {
      ringCache.set(constellation, constellation.polygons.map((ring) => {
        const { points, polar } = unwrapRing(ring);
        const closedPoints = points.slice();
        if (polar) {
          const pole = polar === "north" ? 90 : -90;
          closedPoints.push([points[points.length - 1][0], pole], [points[0][0], pole], points[0]);
        }
        const ras = closedPoints.map(([ra]) => ra);
        const decs = closedPoints.map(([, dec]) => dec);
        return {
          points, polar, test: closedPoints,
          minRa: Math.min(...ras), maxRa: Math.max(...ras), minDec: Math.min(...decs), maxDec: Math.max(...decs),
        };
      }));
    }
    return ringCache.get(constellation);
  }

  // The ring's RA runs continuously (possibly past 360 or below 0); take the turn of `ra` nearest the ring's middle.
  const alignRa = (ring, ra) => ra + 360 * Math.round(((ring.minRa + ring.maxRa) / 2 - ra) / 360);

  function insideRing(ring, ra, dec) {
    if (dec < ring.minDec || dec > ring.maxDec) return false;
    const x = alignRa(ring, ra);
    if (x < ring.minRa || x > ring.maxRa) return false;
    const points = ring.test;
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i];
      const [xj, yj] = points[j];
      if ((yi > dec) !== (yj > dec) && x < ((xj - xi) * (dec - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function pointInConstellation(ra, dec, constellations) {
    for (const constellation of constellations) {
      if (prepared(constellation).some((ring) => insideRing(ring, angle(ra), dec))) return constellation.desig;
    }
    return null;
  }

  // Angular distance (degrees) from a point to the nearest boundary edge of one constellation, in the local plane.
  function boundaryDistance(ra, dec, constellation) {
    let best = Infinity;
    const scale = Math.max(cosine(dec), 1e-6);
    for (const ring of prepared(constellation)) {
      const aligned = alignRa(ring, angle(ra));
      const points = ring.points;
      // A polar ring spans more than one turn of RA, so the point may sit on either turn: try the neighbours too.
      for (const x of ring.polar ? [aligned - 360, aligned, aligned + 360] : [aligned]) {
        for (let i = 1; i < points.length; i++) {
          const [ax, ay] = points[i - 1];
          const [bx, by] = points[i];
          const dx = (bx - ax) * scale;
          const dy = by - ay;
          const px = (x - ax) * scale;
          const py = dec - ay;
          const t = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
          best = Math.min(best, Math.hypot(px - t * dx, py - t * dy));
        }
      }
    }
    return best;
  }

  function nearBoundary(ra, dec, constellations, toleranceDeg = 0.5) {
    const desig = pointInConstellation(ra, dec, constellations);
    if (!desig) return false;
    const constellation = constellations.find((entry) => entry.desig === desig);
    return boundaryDistance(ra, dec, constellation) <= toleranceDeg;
  }

  function sunConstellation(timestamp, constellations) {
    const { lambdaDate, lambdaJ2000 } = sunLongitude(timestamp);
    const { ra, dec } = equatorialFromLongitude(lambdaJ2000);
    const desig = pointInConstellation(ra, dec, constellations);
    const near = desig ? boundaryDistance(ra, dec, constellations.find((entry) => entry.desig === desig)) <= 0.5 : false;
    return { desig, ra, dec, lambdaDate, lambdaJ2000, near };
  }

  const isoDay = (timestamp) => new Date(timestamp).toISOString().slice(0, 10);

  // Days of `year` (noon UTC) on which the Sun is inside the constellation, as merged date ranges.
  function constellationDates(year, desig, constellations) {
    const ranges = [];
    let open = null;
    const last = Date.UTC(year, 11, 31, 12);
    for (let t = Date.UTC(year, 0, 1, 12); t <= last; t += day) {
      const here = sunConstellation(t, constellations).desig === desig;
      if (here && !open) open = { start: isoDay(t), end: isoDay(t) };
      else if (here) open.end = isoDay(t);
      else if (open) { ranges.push(open); open = null; }
    }
    if (open) ranges.push(open);
    return ranges;
  }

  // Points every `stepDeg` along the original edges of a ring, RA continuous, for drawing.
  function densify(ring, stepDeg = 1) {
    const { points } = unwrapRing(ring);
    const out = [points[0]];
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1];
      const [bx, by] = points[i];
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)) / stepDeg));
      for (let k = 1; k <= steps; k++) out.push([ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps]);
    }
    return out;
  }

  // Which constellation each catalogue star falls in, and the brightest star of each constellation.
  function assignStars(stars, constellations) {
    const membership = new Int16Array(stars.length).fill(-1);
    const brightest = new Int32Array(constellations.length).fill(-1);
    const rings = constellations.map(prepared);
    stars.forEach(([ra, dec, mag], index) => {
      for (let c = 0; c < constellations.length; c++) {
        if (rings[c].some((ring) => insideRing(ring, angle(ra), dec))) {
          membership[index] = c;
          if (brightest[c] < 0 || mag < stars[brightest[c]][2]) brightest[c] = index;
          break;
        }
      }
    });
    return { membership, brightest };
  }

  // Birth date (YYYY-MM-DD), optional time (HH:MM) and UTC offset (+HH:MM) to an instant; null when the date is not a real
  // calendar day between 1900 and 2100. Without a time, 12:00 UTC is used.
  function birthInstant(date, time, offset) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? "").trim());
    if (!match) return null;
    const [year, month, dayOfMonth] = match.slice(1).map(Number);
    if (year < 1900 || year > 2100) return null;
    const stamp = Date.UTC(year, month - 1, dayOfMonth, 12);
    if (new Date(stamp).toISOString().slice(0, 10) !== match[0]) return null;
    const clock = /^(\d{2}):(\d{2})$/.exec(String(time ?? "").trim());
    if (!clock) return stamp;
    const zone = /^([+-])(\d{2}):(\d{2})$/.exec(String(offset ?? "+00:00").trim());
    const offsetMinutes = zone ? (Number(zone[2]) * 60 + Number(zone[3])) * (zone[1] === "-" ? -1 : 1) : 0;
    return Date.UTC(year, month - 1, dayOfMonth, Number(clock[1]), Number(clock[2])) - offsetMinutes * 60_000;
  }

  const api = {
    julianCenturies, sunLongitude, sunEquatorialJ2000, tropicalSign, signNames, signDesigs, signFolkNames, signRanges,
    unwrapRing, pointInConstellation, boundaryDistance, nearBoundary, sunConstellation, constellationDates, densify,
    assignStars, birthInstant,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AstroNotPublicZodiac = api;
})(globalThis);
