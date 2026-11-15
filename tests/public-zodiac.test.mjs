// Covers tools/public-zodiac.js: the Sun's longitude (Meeus ch. 25) against published equinox and solstice instants,
// tropical signs, the IAU constellation lookup on the real boundary data, the Sun's constellation and date ranges,
// boundary proximity, ring handling (RA wrap, polar rings), star membership on the Yale catalogue, and birth instants.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const zodiac = require("../tools/public-zodiac.js");
globalThis.window = globalThis.window ?? {};
require("../assets/tools/constellations.js");
require("../assets/tools/bright-stars.js");
const { constellations } = window.AstroNotConstellations;
const yale = window.AstroNotBrightStars;

const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, (message ?? "") + " expected " + expected + " got " + actual);
const circular = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

test("Sun longitude at published equinox and solstice instants (USNO / IMCCE), within 0.02 degrees", () => {
  // March equinox 2000: 2000-03-20 07:35 UTC; June solstice 2023: 2023-06-21 14:58 UTC; December solstice 2024: 2024-12-21 09:20 UTC.
  near(circular(zodiac.sunLongitude(Date.parse("2000-03-20T07:35:00Z")).lambdaDate, 0), 0, 0.02, "2000 equinox");
  near(circular(zodiac.sunLongitude(Date.parse("2023-06-21T14:58:00Z")).lambdaDate, 90), 0, 0.02, "2023 solstice");
  near(circular(zodiac.sunLongitude(Date.parse("2024-12-21T09:20:00Z")).lambdaDate, 270), 0, 0.02, "2024 solstice");
  const { lambdaDate, lambdaJ2000 } = zodiac.sunLongitude(Date.parse("2050-01-01T00:00:00Z"));
  near(circular(lambdaDate, lambdaJ2000), 0.5 * 1.39697, 1e-9, "precession over half a century");
});

test("tropical signs from the longitude and from dates", () => {
  assert.equal(zodiac.tropicalSign(0), 0);
  assert.equal(zodiac.tropicalSign(29.99), 0);
  assert.equal(zodiac.tropicalSign(30), 1);
  assert.equal(zodiac.tropicalSign(359.9), 11);
  assert.equal(zodiac.signNames[zodiac.tropicalSign(zodiac.sunLongitude(Date.parse("2000-04-10T12:00:00Z")).lambdaDate)], "Aries");
  assert.equal(zodiac.signNames[zodiac.tropicalSign(zodiac.sunLongitude(Date.parse("2000-12-05T12:00:00Z")).lambdaDate)], "Sagittarius");
  assert.equal(zodiac.signNames.length, 12);
  assert.equal(zodiac.signRanges.length, 12);
});

test("point in constellation on the real boundaries, including RA wrap and the poles", () => {
  const at = (ra, dec) => zodiac.pointInConstellation(ra, dec, constellations);
  assert.equal(at(247.352, -26.432), "Sco", "Antares");
  assert.equal(at(279.235, 38.784), "Lyr", "Vega");
  assert.equal(at(37.955, 89.264), "UMi", "Polaris");
  assert.equal(at(0, -89.9), "Oct", "south pole");
  assert.equal(at(2.097, 29.090), "And", "Alpheratz");
  assert.equal(at(3.309, 15.184), "Peg", "Algenib");
  assert.equal(at(359.9, 20), "Peg", "just west of RA 0");
  assert.equal(at(180, 0), "Vir");
  assert.equal(at(88.793, 7.407), "Ori", "Betelgeuse");
  for (const constellation of constellations) {
    assert.equal(at(...constellation.label), constellation.desig, "label point of " + constellation.desig);
  }
});

test("the Sun's constellation by the IAU boundaries and its date ranges", () => {
  const sunIn = (iso) => zodiac.sunConstellation(Date.parse(iso + "T12:00:00Z"), constellations).desig;
  assert.equal(sunIn("2000-12-05"), "Oph");
  assert.equal(sunIn("2000-11-25"), "Sco");
  assert.equal(sunIn("2000-08-15"), "Leo");
  assert.equal(sunIn("2000-04-10"), "Psc");
  assert.equal(sunIn("2000-01-10"), "Sgr");
  const oph = zodiac.constellationDates(2000, "Oph", constellations);
  assert.equal(oph.length, 1);
  assert.ok(["2000-11-29", "2000-11-30", "2000-12-01"].includes(oph[0].start), oph[0].start);
  assert.ok(["2000-12-16", "2000-12-17", "2000-12-18"].includes(oph[0].end), oph[0].end);
  const sco = zodiac.constellationDates(2000, "Sco", constellations)[0];
  const scoDays = (Date.parse(sco.end) - Date.parse(sco.start)) / 86_400_000 + 1;
  assert.ok(scoDays >= 6 && scoDays <= 8, "Scorpius days " + scoDays);
  const vir = zodiac.constellationDates(2000, "Vir", constellations)[0];
  assert.ok((Date.parse(vir.end) - Date.parse(vir.start)) / 86_400_000 + 1 >= 43);
  assert.equal(zodiac.constellationDates(2000, "Sgr", constellations).length, 2, "Sagittarius spans the new year");
});

test("boundary proximity: an equinox noon is near the Pisces/Aries border; mid-July is not", () => {
  const equinox = zodiac.sunConstellation(Date.parse("2000-03-20T12:00:00Z"), constellations);
  assert.equal(zodiac.signNames[zodiac.tropicalSign(equinox.lambdaDate)], "Aries");
  assert.ok(equinox.lambdaDate < 0.5, "noon is a few tenths of a degree past the equinox: " + equinox.lambdaDate);
  const earlier = zodiac.sunConstellation(Date.parse("2000-03-20T05:00:00Z"), constellations);
  assert.equal(zodiac.signNames[zodiac.tropicalSign(earlier.lambdaDate)], "Pisces");
  assert.equal(zodiac.nearBoundary(247.352, -26.432, constellations, 0.5), false, "Antares is well inside Scorpius");
  assert.equal(zodiac.nearBoundary(2.097, 29.090, constellations, 5), true, "Alpheratz lies close to the Pegasus border");
  const july = zodiac.sunConstellation(Date.parse("2000-07-15T12:00:00Z"), constellations);
  assert.equal(july.desig, "Gem");
  assert.equal(july.near, false);
});

test("ring handling: densify keeps edges short, unwrapRing bounds RA steps, Oct and UMi are polar", () => {
  const edge = zodiac.densify([[10, 0], [10, 10], [10, 0]], 1);
  assert.equal(edge.length, 21);
  for (const constellation of constellations) {
    for (const ring of constellation.polygons) {
      const { points, polar } = zodiac.unwrapRing(ring);
      for (let i = 1; i < points.length; i++) assert.ok(Math.abs(points[i][0] - points[i - 1][0]) <= 180, constellation.desig);
      if (constellation.desig === "Oct") assert.equal(polar, "south");
      else if (constellation.desig === "UMi") assert.equal(polar, "north");
      else assert.equal(polar, null, constellation.desig + " should not be polar");
      for (const [a, b] of zodiac.densify(ring, 1).map((p, i, all) => [all[i - 1], p]).slice(1)) {
        assert.ok(Math.abs(b[0] - a[0]) <= 1.0001 && Math.abs(b[1] - a[1]) <= 1.0001, "densified edge too long in " + constellation.desig);
      }
    }
  }
});

test("star membership on the Yale catalogue", () => {
  const { membership, brightest } = zodiac.assignStars(yale, constellations);
  const assigned = membership.filter((value) => value >= 0).length;
  assert.ok(assigned / yale.length >= 0.99, "assigned " + assigned + " of " + yale.length);
  const index = (desig) => constellations.findIndex((entry) => entry.desig === desig);
  const rowNear = (ra, dec) => yale.findIndex(([r, d]) => Math.abs(r - ra) < 0.02 && Math.abs(d - dec) < 0.02);
  assert.equal(membership[rowNear(247.352, -26.432)], index("Sco"), "Antares");
  assert.equal(membership[rowNear(279.235, 38.784)], index("Lyr"), "Vega");
  assert.equal(membership[rowNear(37.955, 89.264)], index("UMi"), "Polaris");
  const [ra, dec, mag] = yale[brightest[index("Ori")]];
  assert.ok(Math.abs(ra - 78.634) < 0.02 && Math.abs(dec + 8.202) < 0.02 && mag < 0.2, "Rigel is Orion's brightest Yale star");
  assert.ok(brightest.every((value, c) => value < 0 || membership[value] === c));
});

test("birth instants: noon UTC by default, time with offset, invalid and out-of-range dates", () => {
  assert.equal(zodiac.birthInstant("2000-03-20", "", "+04:00"), Date.parse("2000-03-20T12:00:00Z"));
  assert.equal(zodiac.birthInstant("2000-03-20", "09:35", "+04:00"), Date.parse("2000-03-20T05:35:00Z"));
  assert.equal(zodiac.birthInstant("2000-03-20", "09:35", "-05:00"), Date.parse("2000-03-20T14:35:00Z"));
  assert.equal(zodiac.birthInstant("2001-02-29", "", "+00:00"), null);
  assert.equal(zodiac.birthInstant("2000-02-29", "", "+00:00"), Date.parse("2000-02-29T12:00:00Z"));
  assert.equal(zodiac.birthInstant("1899-12-31", "", "+00:00"), null);
  assert.equal(zodiac.birthInstant("2101-01-01", "", "+00:00"), null);
  assert.equal(zodiac.birthInstant("", "", "+00:00"), null);
});
