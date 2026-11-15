# Constellation data provenance

Fetched 2026-11-15.

- `constellations.bounds.json`, `constellations.json`: d3-celestial by Olaf Frohn, BSD-3-Clause (`LICENSE-d3-celestial.txt`),
  https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/ — J2000 corner polygons of the IAU constellation
  boundaries (Roman 1987, VizieR VI/49) and names with the label points. 89 features (Serpens as two polygons), 1,659 vertices.
- `bound_in_20.txt`: dense J2000 boundary points (13,238, RA in hours) from https://pbarbier.com/constellations/bound_in_20.txt,
  interpolated from VizieR VI/49; used only by `tests/constellations.test.mjs` as a cross-check of the simplified polygons
  (measured maxima: 0.04° in the zodiac, 0.44° near the celestial poles). Not shipped.
- CDS/VizieR itself did not answer from this machine on the fetch date.

Generator: `node scripts/make-constellations.mjs` → `assets/tools/constellations.js` (hand data in
`scripts/constellations-extra.json`: Azerbaijani names, Simplified Chinese mapping, zodiac stick figures with SIMBAD/Yale positions).
