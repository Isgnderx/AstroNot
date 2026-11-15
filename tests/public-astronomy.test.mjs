import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const astronomy = require("../tools/public-astronomy.js");

test("local observation times use the chosen city and handle daylight-saving changes", () => {
  assert.equal(astronomy.cityTime("2026-11-15", 22, "Asia/Baku"), Date.parse("2026-11-15T18:00:00Z"));
  assert.equal(astronomy.cityTime("2026-07-14", 22, "Europe/London"), Date.parse("2026-07-14T21:00:00Z"));
  assert.equal(astronomy.cityTime("2026-01-14", 22, "Europe/London"), Date.parse("2026-01-14T22:00:00Z"));
  const skipped = astronomy.cityTime("2026-03-08", 2.5, "America/New_York");
  assert.equal(astronomy.cityClock(skipped, "America/New_York"), "03:30");
  assert.equal(astronomy.cityTime("2026-11-01", 1.5, "America/New_York"), Date.parse("2026-11-01T05:30Z"));
});

test("the local sky projects the celestial pole and an equatorial star on the meridian", () => {
  const toSky = astronomy.skyTransform(Date.parse("2000-01-01T12:00:00Z"), 40, 0);
  const pole = astronomy.skyAngles(toSky(0, 90));
  assert.ok(Math.abs(pole.altitude - 40) < 1e-8);
  assert.ok(Math.abs(pole.azimuth) < 1e-8);
  const crossing = astronomy.skyAngles(toSky(280.46061837, 0));
  assert.ok(Math.abs(crossing.altitude - 50) < 1e-8);
  assert.ok(Math.abs(crossing.azimuth - 180) < 1e-8);
  for (const { anchor, paths } of astronomy.constellations) {
    assert.ok(paths.flat().includes(anchor));
    assert.ok(paths.flat().every((star) => Number.isFinite(astronomy.guideStars[star]?.[0])));
  }
});

test("approximate lunar phases agree with USNO examples across the calendar year", () => {
  // https://aa.usno.navy.mil/calculated/moon/phases?year=2026
  const samples = [
    ["2026-01-01", 180, "2026-01-03T10:03Z", "Full Moon"],
    ["2026-03-15", 0, "2026-03-19T01:23Z", "New Moon"],
    ["2026-07-14", 90, "2026-07-21T11:05Z", "First quarter"],
    ["2026-12-28", 270, "2026-12-30T18:59Z", "Last quarter"],
  ];
  for (const [start, phase, expected, label] of samples) {
    assert.ok(Math.abs(astronomy.nextPhase(Date.parse(start), phase) - Date.parse(expected)) < 45 * 60_000);
    assert.equal(astronomy.moonPhaseAt(Date.parse(expected)), label);
  }
  const justAfter = Date.parse("2026-11-24T17:00Z");
  assert.equal(astronomy.isoDay(astronomy.nextPhase(justAfter, 180)), "2026-12-24");
});

test("annual meteor peaks roll into the next year and keep one entry per shower", () => {
  const now = Date.parse("2026-12-28T12:00:00Z");
  const showers = astronomy.upcomingShowers(now);
  assert.equal(showers[0].name, "Quadrantids");
  assert.equal(astronomy.isoDay(showers[0].peak), "2027-01-03");
  assert.equal(new Set(showers.map((shower) => shower.name)).size, showers.length);
  assert.ok(showers.every(({ ra, dec }) => ra >= 0 && ra < 360 && Math.abs(dec) <= 90));
  assert.equal(astronomy.upcomingShowers(Date.parse("2026-12-15"))[0].name, "Geminids");
});
