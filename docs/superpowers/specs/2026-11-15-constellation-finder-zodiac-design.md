# Constellation Finder: all 88 constellations and "your zodiac sign" — design

Date: 2026-11-15. Status: approved by the owner (approach A, outcome (c) below) on 2026-11-15; builder check done, its five questions answered in "Builder-check answers" below.

## Intent

The public **Constellation Finder** (`/tools/constellation-finder`, added in commit a040f71) shows a local night sky — city, date 2000–2050, time of day — with 2,579 Yale Bright Star Catalogue stars and six hand-drawn teaching constellations (Orion, Ursa Major, Cassiopeia, Cygnus, Scorpius, Crux). The owner wants two things:

1. **Every constellation.** All 88 IAU constellations selectable and shown on the map, not six.
2. **"Your zodiac sign."** The visitor enters a birth date and the tool shows their sign on the sky map — in the honest form the owner chose: **both** the astrological sign (tropical zodiac, the familiar date ranges) **and** the constellation the Sun was actually in on that date by the IAU boundaries (13, Ophiuchus included), side by side, with the actual one highlighted on the map and the Sun's birthday position marked.

Audience: the public/beginner side of the site (the "non-researcher" tools). Tone: friendly, exact, no astrology claims — the astrological sign is presented as the convention people know, the constellation as where the Sun really was.

## Goals

1. The constellation select lists all 88, grouped: *Zodiac* (13, Ophiuchus last and marked), *Classic shapes* (the existing six), *All constellations A–Z*. Names shown in the interface language (en, az, tr, ru, zh, es — the data file carries them; az hand-written).
2. The selected constellation is drawn as its **official IAU boundary** (outline + faint fill), with its name at its label point, its Yale stars inside the boundary brightened; the existing six and the 13 zodiac constellations also get stick-figure lines (hand-authored from Yale stars; the six keep theirs). Unselected constellations: faint boundaries only when zoomed in (zoom ≥ 1.3), otherwise nothing, so the sky stays readable.
3. The facts panel works for all 88: "Brightest star" (from the Yale stars inside the boundary, with magnitude), "Height above horizon", "Look toward", above/below horizon — anchored at the brightest star (or the label point when no Yale star falls inside, which happens for small southern constellations).
4. A new panel **"Your zodiac sign"**: a date input (1900–2100, any day), optional time of day (default noon UTC, see Decisions). Output: (a) the astrological sign with its conventional date range; (b) the IAU constellation the Sun was in, with the actual date range of that constellation for that year; (c) a one-line note when the two differ ("Precession has shifted the signs by about one constellation since the zodiac was defined") and when the Sun was within half a degree of a boundary ("the time of birth decides"). A button "Show on the sky" selects that constellation and marks the Sun's birthday position (J2000 RA/Dec) with a small sun glyph; the status says plainly that the real Sun is not there now and whether the constellation is above the horizon at the chosen sky time.
5. Tests in `node --test`: Sun longitude against equinox/solstice instants (≤ 0.02°), sign boundaries, IAU lookup for known stars and dates (Antares → Sco, Vega → Lyr, Polaris → UMi, a southern pole point → Oct, a point across RA 0 → And; 2000-12-05 noon → Oph), every one of the 89 polygons closed and containing its own label point, and the az/other-language name tables complete (88 entries each).
6. Honest, accessible, phone-friendly, as the rest of the public tools (keyboard turning, `role="status"` readouts, reduced-motion respected).

## Non-goals

- Stick figures for all 88 (needs GPL or copyrighted line data; boundaries give all 88 from public data).
- Planets, the Moon or the real Sun drawn on the map (the finder shows stars only; the birthday Sun is a fixed J2000 marker).
- Horoscopes, personality text, or any claim about the sign's meaning.
- Re-translating the existing six tips into languages beyond what the catalog already has.

## Anti-goals

- Presenting the astrological sign as "where the Sun was" or vice versa; the page always shows both with labels.
- Guessing the constellation when the Sun sits within a boundary's tolerance without saying so.
- A constellation list that depends on the English name for translation through the i18n catalog (names come from the data file by language; the select is `translate="no"`).
- Shipping data without provenance and licence.

## Data and provenance

- **Boundaries:** d3-celestial `data/constellations.bounds.json` (Olaf Frohn, BSD-3-Clause; derived from the IAU boundaries by Roman 1987 via VizieR VI/49), J2000, 89 polygons (Serpens Caput and Cauda separately), 1,659 vertices; longitude in −180…180 (RA > 180 negative). Fetched 2026-11-15 (CDS itself was unreachable from here).
- **Names and label points:** d3-celestial `data/constellations.json`: `name`, `desig` (IAU abbreviation), `gen` (genitive), `en`, `la`, `tr`, `ru`, `es`, `zh`, and the label point (feature geometry). **az** names are hand-written (standard Azerbaijani astronomical names, e.g. Andromeda, Qartal (Aquila), Qurbangah (Ara), Qoç (Aries), Buğa (Taurus), Əkizlər (Gemini), Xərçəng (Cancer), Şir (Leo), Qız (Virgo), Tərəzi (Libra), Əqrəb (Scorpius), Oxatan (Sagittarius), Oğlaq (Capricornus), Dolça (Aquarius), Balıqlar (Pisces), İlanbürc (Ophiuchus), Böyük Ayı, Kiçik Ayı, Kassiopeya, Qu (Cygnus), Cənub Xaçı (Crux)); checked against the Azerbaijani list of constellations.
- **Stars:** the existing `assets/tools/bright-stars.js` (Yale BSC, J2000). Stick-figure lines for the 13 zodiac constellations: hand-authored star paths named like the existing `guideStars` (ICRS degrees from SIMBAD/BSC), kept small (5–12 stars each).
- **Sun position:** Meeus, *Astronomical Algorithms*, ch. 25 low-precision solar coordinates (accuracy 0.01°); apparent ecliptic longitude of date → tropical sign = ⌊λ/30°⌋; for the IAU lookup, reduce to J2000 by subtracting general precession in longitude (50.29″ per Julian year from J2000) and convert to equatorial with ε₀ = 23.4393°, then point-in-polygon on the J2000 boundaries (ray casting in RA/Dec with RA wrap handled; polygons containing a pole handled by the standard trick of counting crossings against a reference point known to be outside). Both the astrological sign and the IAU constellation are computed from the same λ, never from a fixed calendar table — the table in the UI is derived text.
- One new file `assets/tools/constellations.js` (`window.AstroNotConstellations = { source, licence, fetched, constellations: [{ desig, name, gen, names: { en, az, tr, ru, zh, es }, label: [ra, dec], polygons: [[[ra, dec], …]], zodiac: order|null, lines?: [[starName, …]] }], stars: { name: [ra, dec, mag] } }`), ≈ 60 kB; the publish rules already allow `.js` under `assets/`.

## Decisions

- Boundary edges are interpolated every 1° in RA/Dec before projection so curved borders look right; wrap at RA 0/360 and polygons enclosing a pole are handled in the data loader (split at the wrap, not at draw time).
- Birth **time**: default 12:00 UTC; an optional time + time zone (the city list's zones) refines it. The Sun moves ~1°/day, so the tolerance note triggers within 0.5° of a boundary (≈ 12 hours).
- The IAU date ranges shown per sign for the birth year are computed by scanning the year day by day with the same function (cheap: 366 evaluations), so Ophiuchus shows its real ~18 days.
- Existing behaviour preserved: the six classic tips, "Center constellation", the tonight logic, the animate-time loop; the default selection stays the best-visible classic shape.
- The "Your zodiac sign" panel lives on the Constellation Finder page under the "Find a constellation" section; no new tool, no registry change (the card description gets one phrase: "… and see your zodiac sign on the map").
- i18n: new interface strings get entries in all six catalogs — az by hand; tr/ru/es/zh written by the implementer in the same register as the existing public-tool entries (those catalogs are machine-quality already; do not make them worse); constellation names come from the data file, not the catalogs.
- README's Constellation Finder line is extended (data sources, licences, the two meanings of "sign", the precision statement); TODO's public-tools section gets a done line.

## Approaches considered

A (chosen): extend the existing Constellation Finder page and its data; one new data file; boundaries for 88 + lines for 19. B: a separate "Zodiac" tool — rejected (duplicates the sky map). C: all-88 stick figures from Stellarium's sky culture — rejected (GPL data; boundaries already give 88 honestly).

## Builder-check answers (controller decisions, 2026-11-15)

1. **Which name is shown.** The interface name is the **Latin IAU name** (`name` in the data: "Aries", "Ursa Major", "Serpens") for English, as the existing six already do; the data's folk `en` names ("Ram", "Big Dipper") are not used as names — the zodiac panel may add the English folk name in parentheses for the 13 signs only ("Aries (the Ram)"). Other languages use the data's `tr`, `ru`, `es`, `zh` fields, except: (a) where the i18n catalog already has a name for one of the six, the catalog's wording wins and the data table is edited to match (Cassiopeia tr "Kraliçe", Scorpius es "Escorpio", Cygnus az "Qu quşu"); (b) the `zh` column is converted to Simplified Chinese (the site is zh-Hans) with an explicit mapping of the Traditional characters that occur (寶→宝, 雙→双, 鵝→鹅, 魚→鱼, 飛→飞, 龍→龙, 鳥→鸟, 馬→马, 獅→狮, 貓→猫, 鶴→鹤, 鷹→鹰, 蠍→蝎, 鯨→鲸, 劍→剑, 時→时, 顯→显, 鏡→镜, 繪→绘, 盤→盘, 網→网, 羅→罗, 蘿→萝, 雲→云, 爐→炉, 鑿→凿, 圓→圆, 規→规, 鳳→凤, 鴿→鸽, 鷺→鹭, 烏→乌, 天鵝→天鹅, 龜→龟 — complete the list from the actual data) and checked against the catalog's existing 大熊座/天鹅座; (c) the language code is taken from `document.documentElement.lang` with "zh-Hans" → `zh`, falling back to `en`. The six appear once under *Classic shapes* and once under *All constellations*, with the same label. Serpens Caput and Cauda are one constellation (one select entry "Serpens") with two polygons; bounds and names are paired by index, not by id.
2. **Brightest star.** No new star-name table. The 18 constellations with stick figures (the six classics + the 13 zodiac, Scorpius counted once) keep a named anchor ("Guide star") from the hand-authored star list; the other 70 show "Brightest star in our catalogue: magnitude m" from the Yale stars inside the boundary (no name), anchored there; if no Yale star falls inside, the label point is the anchor and the fact reads "no star brighter than 5.4 inside". The six keep their current anchors (Dubhe stays Ursa Major's guide; the fact label says "Guide star", not "Brightest").
3. **Azerbaijani names.** The complete table of 88 is in Appendix A below and is authoritative for the data file; the test asserts 88 non-empty az names.
4. **Birth time and zone.** The zodiac panel does not reuse the sky city. It has an optional "Time of birth" (`<input type="time">`) and a "UTC offset" select (−12:00 … +14:00 in 30-minute steps, default "+04:00 (Baku)") that is used only when a time is entered; with no time, 12:00 UTC is used and the result says "time of birth not given — noon UTC assumed". No `Intl` zone lookups for historical dates.
5. **Boundary source and precision.** The shipped boundaries are the d3-celestial corner polygons (BSD-3). The dense J2000 file `bound_in_20.txt` (pbarbier.com, 13,238 points, interpolated from VizieR VI/49) is stored under `tests/data/constellations/` with its URL and fetch date and used only as a test cross-check: every dense point must lie within 0.05° of its constellation's simplified polygon for the 13 zodiac constellations and within 0.5° elsewhere (the measured maxima are 0.04° and 0.44°, the latter at Cepheus/Ursa Minor near the pole). README states: "boundaries follow the IAU lines to within 0.05° in the zodiac and 0.5° near the celestial poles". The dense file is not shipped.
Small items: "lines for 19" above means 18 (Scorpius is both classic and zodiac); faint neighbour boundaries appear from zoom ≥ 1.3 so the 1.38 centring zoom shows them; Serpens pairing by index.

## Appendix A — Azerbaijani constellation names (authoritative)

Andromeda — Andromeda; Antlia — Nasos; Apus — Cənnət Quşu; Aquarius — Dolça; Aquila — Qartal; Ara — Qurbangah; Aries — Qoç; Auriga — Arabaçı; Boötes — Çoban; Caelum — Kəski; Camelopardalis — Zürafə; Cancer — Xərçəng; Canes Venatici — Tazılar; Canis Major — Böyük Köpək; Canis Minor — Kiçik Köpək; Capricornus — Oğlaq; Carina — Gəmi Omurğası; Cassiopeia — Kassiopeya; Centaurus — Kentavr; Cepheus — Sefey; Cetus — Balina; Chamaeleon — Buqələmun; Circinus — Pərgar; Columba — Göyərçin; Coma Berenices — Veronika Saçları; Corona Australis — Cənub Tacı; Corona Borealis — Şimal Tacı; Corvus — Qarğa; Crater — Kasa; Crux — Cənub Xaçı; Cygnus — Qu quşu; Delphinus — Delfin; Dorado — Qızıl Balıq; Draco — Əjdaha; Equuleus — Kiçik At; Eridanus — Eridan; Fornax — Soba; Gemini — Əkizlər; Grus — Durna; Hercules — Herkules; Horologium — Saat; Hydra — Hidra; Hydrus — Cənub Hidrası; Indus — Hindli; Lacerta — Kərtənkələ; Leo — Şir; Leo Minor — Kiçik Şir; Lepus — Dovşan; Libra — Tərəzi; Lupus — Canavar; Lynx — Vaşaq; Lyra — Lira; Mensa — Masa Dağı; Microscopium — Mikroskop; Monoceros — Təkbuynuz; Musca — Milçək; Norma — Künyə; Octans — Oktant; Ophiuchus — İlanbürc; Orion — Orion; Pavo — Tovuz Quşu; Pegasus — Peqas; Perseus — Persey; Phoenix — Feniks; Pictor — Rəssam; Pisces — Balıqlar; Piscis Austrinus — Cənub Balığı; Puppis — Gəmi Arxası; Pyxis — Kompas; Reticulum — Tor; Sagitta — Ox; Sagittarius — Oxatan; Scorpius — Əqrəb; Sculptor — Heykəltəraş; Scutum — Qalxan; Serpens — İlan; Sextans — Sekstant; Taurus — Buğa; Telescopium — Teleskop; Triangulum — Üçbucaq; Triangulum Australe — Cənub Üçbucağı; Tucana — Tukan; Ursa Major — Böyük Ayı; Ursa Minor — Kiçik Ayı; Vela — Yelkən; Virgo — Qız; Volans — Uçan Balıq; Vulpecula — Tülkü.

Zodiac signs in the zodiac panel use the same names; the astrological sign list in order: Qoç, Buğa, Əkizlər, Xərçəng, Şir, Qız, Tərəzi, Əqrəb, Oxatan, Oğlaq, Dolça, Balıqlar.

## What's left to the builder

- Exact drawing style of boundaries/fill/labels within the existing palette; label collision handling (only the selected name is mandatory).
- Where in `public-tools.js` / `public-scenes.js` / `public-astronomy.js` the new code goes (follow the existing split: astronomy = pure functions, scenes = canvas, tools = DOM), and whether the solar/zodiac functions get their own small module (`tools/public-zodiac.js`) — preferred if `public-astronomy.js` would grow past ~400 lines.
- The zodiac stick-figure star choices.
- Test fixtures for the Sun (use published equinox/solstice instants, e.g. 2000-03-20 07:35 UTC, 2023-06-21 14:58 UTC, 2026-09-22 … from USNO/IMCCE, with the source cited in the test).
