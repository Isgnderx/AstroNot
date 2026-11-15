# Constellation Finder — all 88 constellations and "your zodiac sign" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The public Constellation Finder lists and draws all 88 IAU constellations (official boundaries, names in six languages) and gains a "Your zodiac sign" panel that shows, for a birth date, both the astrological sign and the constellation the Sun was actually in, highlighted on the sky map.

**Architecture:** One generated data file (`assets/tools/constellations.js`, built by a script from the d3-celestial J2000 boundary and name files plus a hand-written extras file), one new DOM-free module (`tools/public-zodiac.js`: solar position, tropical sign, point-in-constellation, date scans, star membership), extensions to the canvas scene (`public-scenes.js` `sky()` draws boundaries, star highlights and a Sun marker) and to the finder view (`public-tools.js` `constellations()`: grouped select of 88, facts for all, the zodiac panel). Existing six classic shapes, tips and behaviour are kept.

**Tech Stack:** Plain browser JS (classic scripts; the new module is also CommonJS for `node --test`), canvas 2D, Node 24 tests, the six runtime i18n catalogs.

**Spec:** `docs/superpowers/specs/2026-11-15-constellation-finder-zodiac-design.md` (read its Decisions, Builder-check answers and Appendix A — they are binding).

## Global Constraints

- Names: English shows the Latin IAU name (`name`); other languages use the data's `tr/ru/es/zh` with the overrides Cassiopeia tr "Kraliçe", Scorpius es "Escorpio", Cygnus az "Qu quşu"; `zh` converted to Simplified; **az names exactly as Appendix A** (88). The select and labels are `translate="no"`; language from `document.documentElement.lang` ("zh-Hans" → `zh`, fallback `en`).
- Serpens is one entry with two polygons; bounds/names paired by index. 18 constellations have stick figures (six classics + 13 zodiac; Scorpius counted once).
- Facts: the 18 with lines show "Guide star" (named anchor; the six keep their current anchors); the other 70 show "Brightest star in our catalogue: magnitude m" (Yale star inside the boundary), or "no star brighter than 5.4 inside" with the label point as anchor.
- Boundaries: d3-celestial polygons (BSD-3), edges densified every 1°, RA wrap unwrapped per polygon, pole-containing polygons (Octans, Ursa Minor) closed along the pole for the inside test only; faint neighbours drawn from zoom ≥ 1.3; selected one outlined, faintly filled, labelled at its label point.
- Sun: Meeus ch. 25 low-precision apparent longitude of date; J2000 longitude = λ − 1.39697°·T (T Julian centuries from J2000); ε₀ = 23.4392911°; tropical sign = ⌊λ_date/30°⌋ (Aries = 0); IAU constellation from the J2000 RA/Dec against the boundaries; "near boundary" when within 0.5°. Birth time default 12:00 UTC; optional time + UTC offset select (−12:00…+14:00, 30-min steps, default +04:00). Date range 1900-01-01…2100-12-31.
- Both results always shown with labels; no horoscope text. Credit lines on the page and README: boundaries "IAU constellation boundaries (Roman 1987) via d3-celestial, BSD-3-Clause", Sun "Meeus, Astronomical Algorithms, ch. 25 (±0.01°)", precision "boundaries follow the IAU lines to within 0.05° in the zodiac and 0.5° near the celestial poles".
- New interface strings get entries in all six catalogs (`assets/i18n/{az,tr,ru,zh,es}.js`; az by hand, glossary: bürc = constellation/sign, doğum tarixi = birth date, astroloji bürc, Günəşin olduğu bürc, üfüq = horizon, presessiya = precession); constellation names never go through the catalogs.
- Nothing under `assets/` larger than ~150 kB; raw inputs live under `tests/data/constellations/` with `PROVENANCE.md`.
- Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A birth date on 29 February, an empty date, or a date outside 1900–2100: a clear message, no exception, no stale result left on screen. Pinned in Task 4.
2. A birth at noon on an equinox/solstice day (e.g. 2000-03-20): the Sun is within 0.5° of a sign boundary, so the "time of birth decides" note must appear and the optional time must change the sign. Pinned in Tasks 2 and 4.
3. Constellations that cross RA 0/360 (Andromeda, Pisces, Pegasus, Cetus) or contain a pole (Octans, Ursa Minor): membership and drawing are right — no polygon smeared across the whole sky. Pinned in Tasks 2 and 3.
4. Switching the interface language while a constellation is selected: names in the select, the label and the facts re-render in the new language and the selection stays. Pinned in Task 3.
5. Selecting a far-southern constellation from Baku (never above the horizon): the facts say so, "Center constellation" still points the view, nothing hangs. Pinned in Task 3.

---

### Task 1: Data — inputs with provenance, the extras file, the generator, the integrity tests

**Files:**
- Create: `tests/data/constellations/constellations.bounds.json`, `constellations.json` (copied from the scratchpad downloads `C:\Users\loq\AppData\Local\Temp\claude\08f310a342ef1301\9bcf1805-ae4f-4fcc-a22a-4e4acfb6d967\scratchpad\constellations\`, or re-fetched from `https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/`), `bound_in_20.txt` (from `https://pbarbier.com/constellations/bound_in_20.txt`, with `-A Mozilla/5.0`), `LICENSE-d3-celestial.txt`, `PROVENANCE.md`
- Create: `scripts/constellations-extra.json`, `scripts/make-constellations.mjs`
- Create: `assets/tools/constellations.js` (generated)
- Test: `tests/constellations.test.mjs`

**Interfaces:**
- Produces `window.AstroNotConstellations = { source: { boundaries, names, licence, fetched }, constellations: Constellation[], stars: { [name]: [raDeg, decDeg, mag] } }` where `Constellation = { desig: "And", name: "Andromeda", gen: "Andromedae", names: { en, az, tr, ru, zh, es }, label: [raDeg, decDeg], polygons: [[[raDeg, decDeg], …], …] (RA 0…360, each ring closed: first point repeated last), zodiac: 1…13 | null (Aries 1 … Pisces 12, Ophiuchus 13), classic: boolean, lines: [[starName, …], …] | null, anchor: starName | null }`, sorted by `name`; `stars` holds every star referenced by `lines` (the existing 40 `guideStars` of `public-astronomy.js` plus the zodiac stars).
- `scripts/constellations-extra.json` holds the hand data: `{ az: { "And": "Andromeda", … 88 }, zhSimplified: { "寶": "宝", … }, overrides: { "Cas": { tr: "Kraliçe" }, "Sco": { es: "Escorpio" }, "Cyg": { az: "Qu quşu" } }, zodiac: { "Ari": 1, …, "Oph": 13 }, classic: ["Ori", "UMa", "Cas", "Cyg", "Sco", "Cru"], lines: { "Ari": { anchor: "Hamal", paths: [["Hamal", "Sheratan", "Mesarthim"]] }, … 13 zodiac entries }, stars: { "Hamal": [31.793, 23.462, 2.01], … } }`. The six classics' `anchor`/`paths` stay in `public-astronomy.js` and are merged by the generator from `scripts/make-constellations.mjs` reading `tools/public-astronomy.js` via `require`.
- Loading in node: `globalThis.window = {}; require("../assets/tools/constellations.js"); const data = window.AstroNotConstellations;`.

- [ ] **Step 1: Failing tests** (`tests/constellations.test.mjs`):

```js
test("88 constellations, 89 polygons, Serpens in two parts, sorted by Latin name", ...)   // length 88; Ser polygons 2; total rings 89; names strictly ascending
test("every name table is complete: en/az/tr/ru/zh/es non-empty for all 88; az equals Appendix A", ...)  // az table copied into the test as the oracle (88 pairs)
test("zh names are Simplified: none of the characters 寶雙鵝魚飛龍鳥馬獅鶴鷹鯨劍時鏡網羅雲爐圓規鳳鴿烏龜 occur", ...)
test("rings are closed, RA in [0, 360), Dec in [-90, 90]", ...)
test("each label point lies inside its own constellation (point-in-polygon with wrap and pole handling)", ...)   // a local reference implementation in the test (independent of Task 2)
test("zodiac order 1..13 ends with Oph; classic flags are the six; 18 constellations have lines; every line star exists in stars", ...)
test("dense IAU boundary cross-check: every bound_in_20 point is within 0.05° (zodiac) / 0.5° (others) of its constellation's polygon", ...)   // distance point→segment in RA·cos(Dec), Dec; report the max per group
test("file size under 150 kB and the source block names the licence and fetch date", ...)
```

- [ ] **Step 2: Run** `node --test tests/constellations.test.mjs` → fails (module missing).
- [ ] **Step 3: Write `scripts/constellations-extra.json`** — az from Appendix A (88), the zh map built from the characters actually present (scan the names file), the three overrides, zodiac numbering, the classics list, 13 zodiac line sets (5–12 named stars each, J2000 ICRS degrees rounded to 3 decimals from SIMBAD/BSC: Aries, Taurus, Gemini, Cancer, Leo, Virgo, Libra, Scorpius (reuse the existing stars), Sagittarius (the Teapot), Capricornus, Aquarius, Pisces, Ophiuchus) with anchors (Hamal, Aldebaran, Pollux, Al Tarf, Regulus, Spica, Zubeneschamali, Antares, Kaus Australis, Deneb Algedi, Sadalsuud, Alpherg/Eta Piscium, Rasalhague).
- [ ] **Step 4: Write `scripts/make-constellations.mjs`** (no arguments; reads the three inputs + `public-astronomy.js` + the extras; writes the asset with a header comment naming sources, licence and fetch date; prints the entry count and byte size). RA conversion: `lon < 0 ? lon + 360 : lon`; Serpens merged by `desig`; `classic` entries take `anchor`/`paths`/`tip` from `public-astronomy.js` (tips stay there).
- [ ] **Step 5: Run the generator and the tests** → all pass; `node --test tests/publish.test.mjs` → pass.
- [ ] **Step 6: `PROVENANCE.md`** (URLs, dates, licences, the generator command, the measured cross-check maxima) and **commit**: `"Add the 88-constellation data file, its generator, inputs with provenance and integrity tests"`.

---

### Task 2: `tools/public-zodiac.js` — Sun position, signs, point-in-constellation, date scans, star membership

**Files:**
- Create: `tools/public-zodiac.js` (IIFE; `module.exports = api` in node, else `root.AstroNotPublicZodiac = api`, same as `public-astronomy.js`)
- Test: `tests/public-zodiac.test.mjs`

**Interfaces (produces):**
- `julianCenturies(timestamp) → T`
- `sunLongitude(timestamp) → { lambdaDate, lambdaJ2000 }` degrees in [0, 360)
- `sunEquatorialJ2000(timestamp) → { ra, dec }` degrees
- `tropicalSign(lambdaDate) → 0…11` (0 = Aries); `signNames` = `["Aries", …, "Pisces"]` (Latin); `signRanges` = the conventional date strings (`"21 Mar – 19 Apr"` …) as data for the UI
- `unwrapRing(ring) → ring` (RA made continuous; pole-containing rings closed along the pole; returns `{ points, polar: "north" | "south" | null }`)
- `pointInConstellation(ra, dec, constellations) → desig | null`
- `nearBoundary(ra, dec, constellations, toleranceDeg) → boolean` (distance to the nearest edge of the containing constellation in degrees on the sky, RA scaled by cos Dec)
- `sunConstellation(timestamp, constellations) → { desig, ra, dec, lambdaDate, lambdaJ2000, near: boolean }`
- `constellationDates(year, desig, constellations) → [{ start: "YYYY-MM-DD", end: "YYYY-MM-DD" }]` (noon-UTC day scan of the year)
- `densify(ring, stepDeg = 1) → [[ra, dec], …]` (linear in RA/Dec along each edge, original edges only)
- `assignStars(stars: [[ra, dec, mag, bv], …], constellations) → { membership: Int16Array (index into constellations, −1 if none), brightest: Int32Array (star index per constellation, −1 if none) }`

- [ ] **Step 1: Failing tests** (`tests/public-zodiac.test.mjs`; data loaded with the window stub):

```js
test("sun longitude at published equinox/solstice instants (USNO/IMCCE): 2000-03-20T07:35Z → 0°, 2023-06-21T14:58Z → 90°, 2024-12-21T09:20Z → 270°, each within 0.02°", ...)
test("tropical signs: λ 0 → Aries, 29.99 → Aries, 30 → Taurus, 359.9 → Pisces; 2000-04-10T12Z → Aries; 2000-12-05T12Z → Sagittarius", ...)
test("point in constellation: Antares (247.352, −26.432) → Sco; Vega (279.235, 38.784) → Lyr; Polaris (37.955, 89.264) → UMi; (0, −89.9) → Oct; Alpheratz (2.097, 29.090) → And; Algenib (3.309, 15.184) → Peg; (359.9, 20) → Peg; (180, 0) → Vir", ...)
test("the Sun by IAU boundaries: 2000-12-05 → Oph; 2000-11-25 → Sco; 2000-08-15 → Leo; 2000-04-10 → Psc; 2000-01-10 → Sgr", ...)
test("constellation dates for 2000: Oph from 2000-11-30 to 2000-12-17 (±1 day); Sco 7 ± 1 days; Vir ≥ 43 days", ...)
test("near boundary: noon on 2000-03-20 is within 0.5° of the Pisces/Aries border for the tropical sign and nearBoundary reports it; 2000-07-15 does not", ...)
test("densify: a 10°-long Dec edge gives 11 points; unwrapRing keeps every RA step below 180°; Oct and UMi are reported polar", ...)
test("assignStars on the Yale catalogue: membership covers ≥ 95 % of stars; Antares/Vega/Polaris rows map to Sco/Lyr/UMi; brightest of Ori is Rigel's row (the Yale star at RA 78.63, Dec −8.20, mag < 0.2)", ...)
```

- [ ] **Step 2: Run** → fails. - [ ] **Step 3: Implement** — Meeus ch. 25: `L0 = 280.46646 + 36000.76983T + 0.0003032T²`, `M = 357.52911 + 35999.05029T − 0.0001537T²`, `C = (1.914602 − 0.004817T − 0.000014T²) sin M + (0.019993 − 0.000101T) sin 2M + 0.000289 sin 3M`, `Ω = 125.04 − 1934.136T`, `λ = L0 + C − 0.00569 − 0.00478 sin Ω`; `lambdaJ2000 = λ − 1.39697·T`; RA/Dec from λ with ε₀; point-in-polygon by ray casting on the unwrapped ring (closing along the pole for polar rings; the test point's RA shifted into the ring's RA range). - [ ] **Step 4: Run** → pass; full `node --test` → 0 failures.
- [ ] **Step 5: Commit** `"Add public-zodiac: Sun position, tropical signs, IAU constellation lookup and star membership"`.

---

### Task 3: The finder shows all 88 — select, facts, boundaries, highlights, language

**Files:**
- Modify: `tools/public-tools.js` (`constellations()` view, ~lines 115–238), `tools/public-scenes.js` (`sky()` ~lines 188–286), `tools/constellation-finder/index.html` (scripts: add `../../assets/tools/constellations.js` and `../public-zodiac.js` after `bright-stars.js`; footer sources; description sentence), `tools/registry.js` (description: "Find any of the 88 constellations in the night sky and see your zodiac sign on the map."), `tools/public-tools.css`, `assets/i18n/{az,tr,ru,zh,es}.js`

**Interfaces:**
- Consumes: `AstroNotConstellations`, `AstroNotPublicZodiac.assignStars/densify/unwrapRing`.
- Produces: `scenes.sky(ctx, w, h, view, stars, guides, selected, extras)` where `extras = { boundaries: [{ rings: [[x,y,z], …][], selected: boolean, label: { point: [x,y,z], text } }], highlight: Set<number> (star indices to brighten), marker: { point: [x,y,z], text } | null, zoom }`; `extras` optional so other callers are unaffected. In the view: `state = { items (88, from the data, each with its name in the current language, tip or null, lines or null, anchorPoint), selected (index into items), membership, brightest }`, `nameOf(item)`, `rebuildSelect()` (three `<optgroup>`s), `selectConstellation(index)`; the facts `dt` for the first fact switches between "Guide star" and "Brightest star in our catalogue" via two `data-key` labels.

- [ ] **Step 1: Wire the data** — items from `AstroNotConstellations` merged with `astronomy.constellations` tips; `assignStars` once at load (log nothing); `fillOptions` replaced by `rebuildSelect()` with `<optgroup label>`s "Zodiac" (13, Ophiuchus labelled "Ophiuchus (13th)"), "Classic shapes", "All constellations" and `translate="no"` on the select; default selection = the best-visible classic as today.
- [ ] **Step 2: Facts for all** — anchor = named guide star (18) else brightest Yale star (membership) else label point; "Height above horizon", "Look toward", above/below text unchanged; tip = the six tips, else the sentence "The outline is the official IAU boundary. Brightest star in our catalogue: magnitude m." / "… no star brighter than 5.4 inside."
- [ ] **Step 3: Drawing** — in `update()`, transform the selected constellation's densified rings and (when `skyView.zoom ≥ 1.3`) all others; pass `extras` to `scenes.sky`: faint neighbours (`#2b3a4f`, 1 px), selected outline (`#96caff`, 1.4 px) with fill `rgba(150,202,255,0.07)`, label text at the label point in the existing 12 px font, member stars drawn with alpha 1 and radius +0.6; existing line drawing unchanged (the 18 with lines).
- [ ] **Step 4: Language** — `refreshOnLanguage` rebuilds the select (keeping `selected`), the label and the facts in the new language (Review Focus 4).
- [ ] **Step 5: i18n** — new strings ("Zodiac", "Classic shapes", "All constellations", "Brightest star in our catalogue", "no star brighter than 5.4 inside", "The outline is the official IAU boundary.", "Ophiuchus (13th)") in the six catalogs; footer source lines and the page description.
- [ ] **Step 6: Browser check** (`node serve.mjs` on a free port; headless Chrome/CDP as in `.superpowers` reports of the previous feature, or `--dump-dom`/`--screenshot`): the select holds 88 entries in three groups; choosing Octans from Baku shows "below the horizon" and Center works (Review Focus 5); choosing Andromeda draws one closed outline (no sky-wide smear, Review Focus 3); zoom ≥ 1.3 shows faint neighbours; `?lang=az` shows "Böyük Ayı", "İlanbürc (13-cü)"; switching language keeps the selection (Review Focus 4). Screenshots to the scratchpad.
- [ ] **Step 7: Tests and commit** — `node --test` 0 failures, `tests/publish.test.mjs` green; commit `"Constellation Finder: all 88 constellations with IAU boundaries, facts and names in six languages"`.

---

### Task 4: "Your zodiac sign" panel, README, TODO

**Files:**
- Modify: `tools/public-tools.js` (new section below "Find a constellation"), `tools/public-tools.css`, `tools/public-scenes.js` (the Sun marker drawn from `extras.marker`: a 5 px filled disc `#ffd36b` with a 9 px ring and the text), `assets/i18n/*.js`, `README.md` (the Constellation Finder line, ~53), `TODO.md`

**Interfaces:** consumes Task 2's `sunConstellation`, `tropicalSign`, `signNames`, `signRanges`, `constellationDates`, `nearBoundary`; Task 3's `selectConstellation(index)` and `extras.marker`.

- [ ] **Step 1: Markup** — `<section aria-labelledby="sky-zodiac"><h2>Your zodiac sign</h2>` with: `<input type="date" data-birth min="1900-01-01" max="2100-12-31">`, `<input type="time" data-birth-time>` (optional), `<select data-birth-offset>` (UTC offsets −12:00…+14:00 in 30-minute steps, default `+04:00`), a `role="status"` result block with two labelled lines ("Astrological sign: Aries (the Ram) — 21 Mar – 19 Apr" / "Where the Sun actually was: Pisces, 12 Mar – 18 Apr 2000 by the IAU boundaries"), the precession note when they differ, the "time of birth decides" note when `near`, the "noon UTC assumed" note when no time is given, and a button "Show on the sky" (selects the IAU constellation, sets `extras.marker` to the Sun's J2000 point with the text "Sun on <date>", centres the view, and writes "The real Sun is not there now; <constellation> is above/below the horizon at the chosen time").
- [ ] **Step 2: Behaviour tests in `tests/public-zodiac.test.mjs`** for the pure parts the panel relies on (added here because the UI has no test seam): `birthInstant("2000-03-20", "", "+04:00") === Date.parse("2000-03-20T12:00:00Z")`; `birthInstant("2000-03-20", "09:35", "+04:00") === Date.parse("2000-03-20T05:35:00Z")`; `birthInstant("2001-02-29", …)` → `null`; `birthInstant("1899-12-31", …)` → `null` (Review Focus 1); noon on 2000-03-20 → `tropicalSign` Aries with `near` true, and with time "05:00" UTC → Pisces (Review Focus 2). Add `birthInstant(date, time, offset) → timestamp | null` to `public-zodiac.js`.
- [ ] **Step 3: Implement the panel**; every invalid input writes its reason to the status block and clears the previous result; results re-render on language change (sign names from `AstroNotConstellations` names; the folk name in parentheses only in English).
- [ ] **Step 4: i18n (six catalogs), README line, TODO** — README: data sources, licences, the two meanings of "sign", the precision statement; TODO: tick/add the public-tools line "Bürc axtarışı: 88 bürc və doğum tarixinə görə bürc".
- [ ] **Step 5: Browser check** — enter 2000-12-05: "Sagittarius / Ophiuchus (30 Nov – 17 Dec 2000)", precession note shown; "Show on the sky" highlights Ophiuchus with the Sun marker; enter 2000-03-20 without time: the boundary note; with 09:35 +04:00: Pisces/Pisces; 29 Feb 2001: message; `?lang=az` render of the panel; 390 px screenshot. Full `node --test` 0 failures; publish test green.
- [ ] **Step 6: Commit** `"Constellation Finder: your zodiac sign — astrological sign and the Sun's actual constellation on the map"`.
