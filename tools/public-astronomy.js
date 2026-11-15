// Data and approximate sky calculations for the beginner tools.
(function (root) {
  "use strict";

  const degrees = Math.PI / 180;
  const day = 86_400_000;
  const angle = (value) => ((value % 360) + 360) % 360;
  const sine = (value) => Math.sin(value * degrees);
  const cosine = (value) => Math.cos(value * degrees);
  const isoDay = (date) => new Date(date).toISOString().slice(0, 10);

  // City-center coordinates, with IANA zones so the displayed time is local to the city.
  const cities = [
    ["Baku", 40.4093, 49.8671, "Asia/Baku"],
    ["Istanbul", 41.0082, 28.9784, "Europe/Istanbul"],
    ["London", 51.5072, -0.1276, "Europe/London"],
    ["Mexico City", 19.4326, -99.1332, "America/Mexico_City"],
    ["New York", 40.7128, -74.0060, "America/New_York"],
    ["São Paulo", -23.5505, -46.6333, "America/Sao_Paulo"],
    ["Sydney", -33.8688, 151.2093, "Australia/Sydney"],
    ["Tokyo", 35.6762, 139.6503, "Asia/Tokyo"],
  ];

  const zoneFormats = new Map();
  function offsetAt(instant, zone) {
    if (!zoneFormats.has(zone)) {
      zoneFormats.set(zone, new Intl.DateTimeFormat("en-GB", { timeZone: zone, timeZoneName: "longOffset" }));
    }
    const offset = zoneFormats.get(zone).formatToParts(instant).find(({ type }) => type === "timeZoneName").value;
    const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(offset);
    return match ? (Number(match[2]) * 60 + Number(match[3])) * (match[1] === "-" ? -60_000 : 60_000) : 0;
  }

  // At an ambiguous clock time, use its first occurrence. In a skipped hour,
  // move the requested time forward by the size of the clock change.
  function cityTime(date, hour, zone) {
    const local = Date.parse(date + "T00:00:00Z") + hour * 3_600_000;
    const before = local - offsetAt(local - day, zone);
    const after = local - offsetAt(local + day, zone);
    if (before + offsetAt(before, zone) === local) return before;
    if (after + offsetAt(after, zone) === local) return after;
    return Math.max(before, after);
  }

  function cityClock(timestamp, zone) {
    return new Date(timestamp + offsetAt(timestamp, zone)).toISOString().slice(11, 16);
  }

  function todayIn(zone, now = Date.now()) {
    const format = new Intl.DateTimeFormat("sv-SE", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
    return format.format(now);
  }

  // Positions of bright guides are rounded ICRS degrees from SIMBAD / the Yale Bright Star Catalogue.
  // Each guide has a tip, an anchor and a list of star paths. The lines are teaching asterisms.
  const constellations = [
    {
      name: "Orion", anchor: "Alnilam",
      tip: "Find the three bright stars in a short, straight row. They mark Orion’s Belt.",
      paths: [["Betelgeuse", "Alnitak", "Alnilam", "Mintaka", "Bellatrix", "Betelgeuse"],
        ["Alnitak", "Saiph", "Rigel", "Mintaka"]],
    },
    {
      name: "Ursa Major", anchor: "Dubhe",
      tip: "Look for a bowl of four stars and a handle of three. This pattern is the Big Dipper.",
      paths: [["Alkaid", "Mizar", "Alioth", "Megrez", "Dubhe", "Merak", "Phecda", "Megrez"]],
    },
    {
      name: "Cassiopeia", anchor: "Gamma Cassiopeiae",
      tip: "Look for five stars in a zigzag. It looks like a W or an M as the sky turns.",
      paths: [["Caph", "Schedar", "Gamma Cassiopeiae", "Ruchbah", "Segin"]],
    },
    {
      name: "Cygnus", anchor: "Deneb",
      tip: "Start at bright Deneb and trace a long cross. Deneb also marks one corner of the Summer Triangle.",
      paths: [["Deneb", "Sadr", "Gienah", "Zeta Cygni"], ["Delta Cygni", "Sadr", "Albireo"]],
    },
    {
      name: "Scorpius", anchor: "Antares",
      tip: "Start at reddish Antares and follow the curved tail to the two stars at its tip.",
      paths: [["Dschubba", "Antares", "Tau Scorpii", "Epsilon Scorpii", "Mu Scorpii", "Zeta Scorpii",
        "Eta Scorpii", "Sargas", "Kappa Scorpii", "Shaula", "Lesath"]],
    },
    {
      name: "Crux", anchor: "Acrux",
      tip: "Look for a small cross in the southern sky. Its long axis points roughly toward the south celestial pole.",
      paths: [["Gacrux", "Acrux"], ["Mimosa", "Delta Crucis"]],
    },
  ];

  const guideStars = {
    Betelgeuse: [88.793, 7.407, 0.45], Bellatrix: [81.283, 6.350, 1.64], Alnitak: [85.190, -1.943, 1.77],
    Alnilam: [84.053, -1.202, 1.69], Mintaka: [83.002, -0.299, 2.23], Saiph: [86.939, -9.670, 2.07],
    Rigel: [78.634, -8.202, 0.13], Alkaid: [206.885, 49.313, 1.86], Mizar: [200.981, 54.925, 2.23],
    Alioth: [193.507, 55.960, 1.77], Megrez: [183.856, 57.033, 3.31], Dubhe: [165.932, 61.751, 1.79],
    Merak: [165.460, 56.382, 2.37], Phecda: [178.458, 53.695, 2.44], Caph: [2.295, 59.150, 2.27],
    Schedar: [10.127, 56.537, 2.24], "Gamma Cassiopeiae": [14.177, 60.717, 2.47],
    Ruchbah: [21.454, 60.235, 2.68], Segin: [28.599, 63.670, 3.35], Deneb: [310.358, 45.280, 1.25],
    Sadr: [305.557, 40.257, 2.23], Gienah: [311.552, 33.970, 2.48], "Zeta Cygni": [318.234, 30.227, 3.21],
    "Delta Cygni": [296.243, 45.131, 2.87], Albireo: [292.680, 27.960, 3.08], Dschubba: [240.083, -22.622, 2.32],
    Antares: [247.352, -26.432, 1.06], "Tau Scorpii": [248.971, -28.216, 2.82],
    "Epsilon Scorpii": [252.541, -34.293, 2.29], "Mu Scorpii": [252.968, -38.047, 3.00],
    "Zeta Scorpii": [253.646, -42.362, 3.62], "Eta Scorpii": [258.038, -43.239, 3.33],
    Sargas: [264.330, -42.998, 1.87], "Kappa Scorpii": [265.622, -39.030, 2.41],
    Shaula: [263.402, -37.104, 1.62], Lesath: [262.691, -37.295, 2.70], Gacrux: [187.791, -57.113, 1.59],
    Acrux: [186.650, -63.099, 0.76], Mimosa: [191.930, -59.689, 1.25], "Delta Crucis": [183.786, -58.749, 2.79],
  };

  function skyTransform(timestamp, latitude, longitude) {
    const d = timestamp / day - 10957.5;
    const sidereal = angle(280.46061837 + 360.98564736629 * d + longitude);
    const north = sine(latitude);
    const vertical = cosine(latitude);
    return (ra, dec) => {
      const hourAngle = sidereal - ra;
      const x = cosine(dec) * cosine(hourAngle);
      const z = sine(dec);
      return [-cosine(dec) * sine(hourAngle), z * vertical - x * north, z * north + x * vertical];
    };
  }

  function skyAngles([east, north, up]) {
    return { azimuth: angle(Math.atan2(east, north) / degrees), altitude: Math.asin(Math.max(-1, Math.min(1, up))) / degrees };
  }

  // Approximate geocentric elongation following Paul Schlyter's lunar longitude terms.
  // Dates of the four principal phases are roots of multiples of 90°.
  function trueAnomaly(mean, eccentricity) {
    const m = angle(mean) * degrees;
    let eccentric = m;
    for (let i = 0; i < 3; i++) eccentric -= (eccentric - eccentricity * Math.sin(eccentric) - m) /
      (1 - eccentricity * Math.cos(eccentric));
    return Math.atan2(Math.sqrt(1 - eccentricity ** 2) * Math.sin(eccentric), Math.cos(eccentric) - eccentricity) / degrees;
  }

  function moonAngle(timestamp) {
    const d = timestamp / day - 10956;
    const sunMean = 356.0470 + 0.9856002585 * d;
    const sunPerihelion = 282.9404 + 0.0000470935 * d;
    const sunLongitude = sunPerihelion + trueAnomaly(sunMean, 0.016709 - 1.151e-9 * d);
    const moonMean = 115.3654 + 13.0649929509 * d;
    const moonPerihelion = 318.0634 + 0.1643573223 * d;
    const node = 125.1228 - 0.0529538083 * d;
    const moonMeanLongitude = moonMean + moonPerihelion + node;
    const distance = moonMeanLongitude - (sunMean + sunPerihelion);
    const latitudeArgument = moonMeanLongitude - node;
    const argument = moonPerihelion + trueAnomaly(moonMean, 0.0549);
    const moonLongitude = node + Math.atan2(sine(argument) * cosine(5.1454), cosine(argument)) / degrees;
    const correction = -1.274 * sine(moonMean - 2 * distance) + 0.658 * sine(2 * distance) - 0.186 * sine(sunMean)
      - 0.059 * sine(2 * moonMean - 2 * distance) - 0.057 * sine(moonMean - 2 * distance + sunMean)
      + 0.053 * sine(moonMean + 2 * distance) + 0.046 * sine(2 * distance - sunMean) + 0.041 * sine(moonMean - sunMean)
      - 0.035 * sine(distance) - 0.031 * sine(moonMean + sunMean) - 0.015 * sine(2 * latitudeArgument - 2 * distance)
      + 0.011 * sine(moonMean - 4 * distance);
    return angle(moonLongitude + correction - sunLongitude);
  }

  function nextPhase(start, target) {
    let low = start;
    let high = start + 33 * day;
    const startAngle = moonAngle(start);
    const distance = angle(target - startAngle);
    // Pick the turn nearest the average synodic rate. The real Moon varies in
    // speed, but its accumulated difference stays far below half a turn.
    while (high - low > 60_000) {
      const middle = (low + high) / 2;
      const wrapped = angle(moonAngle(middle) - startAngle);
      const mean = (middle - start) / (29.53059 * day) * 360;
      const swept = wrapped + 360 * Math.round((mean - wrapped) / 360);
      if (swept < distance) low = middle;
      else high = middle;
    }
    return high;
  }

  const moonPhases = ["New Moon", "Waxing crescent", "First quarter", "Waxing gibbous",
    "Full Moon", "Waning gibbous", "Last quarter", "Waning crescent"];

  function moonPhaseAt(timestamp) {
    const start = Math.floor(timestamp / day) * day;
    const elongation = moonAngle(timestamp);
    const nextQuarter = (Math.floor(moonAngle(start) / 90) + 1) % 4;
    if (nextPhase(start, nextQuarter * 90) < start + day) return moonPhases[nextQuarter * 2];
    return moonPhases[Math.floor(elongation / 90) * 2 + 1];
  }

  // Mean diameters (km), twice NASA JPL's volume-equivalent radii rounded to the nearest km.
  const planets = [
    ["Mercury", 4879, "#ad9e8f"], ["Venus", 12104, "#dcb989"], ["Earth", 12742, "#79adea"],
    ["Mars", 6779, "#d58b66"], ["Jupiter", 139822, "#d9a889"], ["Saturn", 116464, "#ded0a5"],
    ["Uranus", 50724, "#a2ced1"], ["Neptune", 49244, "#7f9ee6"],
  ];

  // Typical peak nights, not year-specific predictions. Month and day mark the center of the window.
  const showers = [
    ["Quadrantids", 1, 3, "Boötes", 230, 49],
    ["Lyrids", 4, 22, "Lyra", 271, 34],
    ["Eta Aquariids", 5, 6, "Aquarius", 338, -1],
    ["Perseids", 8, 12, "Perseus", 48, 58],
    ["Orionids", 10, 21, "Orion", 95, 16],
    ["Leonids", 11, 17, "Leo", 152, 22],
    ["Geminids", 12, 14, "Gemini", 112, 33],
    ["Ursids", 12, 22, "Ursa Minor", 217, 76],
  ];

  function upcomingShowers(now = Date.now()) {
    const year = new Date(now).getUTCFullYear();
    const today = Math.floor(now / day) * day;
    return showers.map(([name, month, date, radiant, ra, dec]) => {
      let peak = Date.UTC(year, month - 1, date);
      if (peak + day < today) peak = Date.UTC(year + 1, month - 1, date);
      return { name, peak, radiant, ra, dec };
    }).sort((a, b) => a.peak - b.peak);
  }

  const galaxies = [
    ["spiral", "Spiral", "Look for arms curling out of a compact center.", "Spiral arms curve outward from a bright central bulge.", "Curved arms surround a bright, compact center."],
    ["barred", "Barred spiral", "Turn the model until you can see the middle of the disk.", "A straight bar crosses the center. The two arms start at its ends.", "There is a straight band of bright stars across the center, with curved arms at its ends."],
    ["elliptical", "Elliptical", "Check whether the stars form any arms or a thin disk.", "The stars form a smooth oval. They thin out gradually away from the center.", "The stars form a smooth oval and gradually thin out toward its edge."],
    ["irregular", "Irregular", "Look at the whole outline and see if the bright patches form a pattern.", "Bright patches are scattered across a lopsided shape.", "The outline is uneven, with scattered bright patches."],
  ];

  const api = {
    angle, cities, cityClock, cityTime, constellations, day, degrees, galaxies, guideStars, isoDay, moonAngle,
    moonPhaseAt, nextPhase, planets, skyAngles, skyTransform, todayIn, upcomingShowers,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AstroNotPublicAstronomy = api;
})(globalThis);
