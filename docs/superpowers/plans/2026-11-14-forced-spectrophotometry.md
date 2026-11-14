# Forced Spectrophotometry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new AstroNot tool, `/tools/forced-spectrophotometry`, that reproduces the IRSA SPHEREx Spectrophotometry Tool in the browser by porting spxphot: forced ePSF photometry on every SPHEREx frame covering a position, with frame bytes read from IRSA's S3 bucket by HTTP range.

**Architecture:** Three DOM-free modules ported line by line from spxphot's Rust (`tools/fits-range.js` ← `fits.rs` + the byte-source half of `archive.rs`; `tools/epsf.js` ← `psf.rs` + `sersic.rs`; `tools/forced-phot.js` ← `phot.rs`, `wcs.rs`, the calibration cache of `archive.rs` and `process_frame` of `main.rs`), each a classic script that is also CommonJS for `node --test`, exactly like `tools/pair.js`. One UI file and one page on top. The frame list comes from Observation Search's SIA CSV import (extended with the deep-field collections and a higher record limit). Tests prove parity with a fresh spxphot run on the same bytes.

**Tech Stack:** Plain browser JavaScript (no build step), Node 24 `node --test`, spxphot (Rust, built once with cargo 1.100 for fixtures and oracles), IRSA S3 (`https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/`).

**Spec:** `docs/superpowers/specs/2026-11-14-forced-spectrophotometry-design.md`

## Global Constraints

- Every numeric routine is a port of the named spxphot function, same names and comments, so the two can be diffed; spxphot source: `C:\Users\loq\Downloads\spxphot\spxphot\src\`.
- Parity with spxphot is exact: output columns equal a fresh `spxphot phot` run to 1e-9 relative (`fit_ql` 1e-6), flags identical. A tolerance is never widened to make a test pass.
- Modules load as classic scripts (globals `AstroNotFitsRange`, `AstroNotEpsf`, `AstroNotForcedPhot`) and as CommonJS; dependencies are reached as `tools/photometry.js:37` does: `typeof module === "object" && module.exports ? require("./x.js") : root.AstroNotX`.
- Pixel coordinates are 0-based inside the three ported modules (as in spxphot); `x_image`/`y_image` in output are parent-frame pixels as spxphot defines them (`tx + 1 - CRPIX1A`).
- Flags are 64-bit (bits 32 and 33 are set on output): accumulate as `BigInt` inside `fitFrame`, expose as `Number` on output rows.
- spxphot defaults are the defaults: fit 13 px circle, `bkgHalf` 10, `bkgExcludeR` 3, background median, sky fit on, `qlRadius` 2.5, `flagRadius` 2.5, `SYS_FRAC` 0.03, retry 7 attempts from 750 ms doubling, SIP applied to the wavelength lookup **off** (`strictWave` on).
- Nothing under `assets/` larger than ~150 kB; fixtures that carry an ePSF table live under `tests/data/spxphot/`.
- Visible strings of the new page and of changed Observation Search text get hand-written Azerbaijani entries in `assets/i18n/az.js` (glossary: məcburi fotometriya, kadr, istinad, epoxa, axın sıxlığı, ulduz ölçüsü).
- Data credit and non-affiliation text on the page: "Data: NASA/IPAC Infrared Science Archive (IRSA), SPHEREx DR1/QR3. This is an independent reimplementation of the IRSA Spectrophotometry Tool's method and is not affiliated with IPAC or the SPHEREx team."
- Commits: one per task, message in the repo's style, ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A target within the fit or background box of a frame edge (cutout edge or detector edge): the fit uses only pixels inside, `n_pix` shrinks, no exception. Pinned in Task 5.
2. A frame without an `EPSF` extension (pre-QR3 data, or the site's bundled QR2 cutouts): the frame is skipped with the reason "no EPSF extension", the run continues. Pinned in Task 6.
3. A network failure on one frame after all retries (HTTP 500, or no 206): that frame is listed under failed, every other frame is still measured, partial results are returned. Pinned in Task 6.
4. Cancelling a run: in-flight frames finish or abort, no new frame starts, rows measured so far are returned, the report says cancelled. Pinned in Task 6.
5. A degenerate fit (two targets at the same position, or no valid variance in the fit region): `FIT_ERROR` set, flux and error `NaN`, `fit_ql` `NaN`, no exception; the page shows the row with empty flux. Pinned in Task 5.

---

### Task 1: Reference material — build spxphot, fresh oracles, a real fixture cutout, the example frame list

**Files:**
- Create: `tests/data/spxphot/epsf_vectors.json`, `wcs_vectors.json`, `rice_vectors.json` (copied), `bd17_irsa.csv`, `wd_irsa.csv`, `gal_irsa.csv` (copied), `bd17_spxphot.csv` (regenerated), `bd17-cutout.fits`, `bd17-cutout.frame.json`, `PROVENANCE.md`
- Create: `assets/tools/spherex-bd17-frames.js`
- Create: `scripts/make-bd17-frames.mjs` (one-off, kept for reproducibility)

**Interfaces:**
- Produces: the fixture `tests/data/spxphot/bd17-cutout.fits` (IMAGE, FLAGS as int32, VARIANCE, ZODI, EPSF, WCS-WAVE of one DR1 detector-1 frame around BD+17 4708, 0.06°), its sidecar `bd17-cutout.frame.json` `{ "access_url", "obs_id", "obs_collection", "energy_bandpassname", "t_min", "lvf_id", "target": { "label": "BD+17_4708", "ra": 332.882637, "dec": 18.093128 } }`, the oracle `bd17_spxphot.csv` (spxphot's 19 columns), and the global `spherexBd17Frames = { fetched: "YYYY-MM-DD", target: {label, ra, dec}, files: [{ name: "spherex_dr1.csv", text }, { name: "spherex_qr3.csv", text }] }` whose `text`s are SIA CSVs trimmed to the columns `obs_id, access_url, access_format, energy_bandpassname, obs_collection, t_min, t_max, em_min, em_max, s_region`.

- [ ] **Step 1: Build spxphot**

Run: `cd C:\Users\loq\Downloads\spxphot\spxphot && cargo build --release 2>&1 | tail -3`
Expected: `Finished release` and `target\release\spxphot.exe` exists. Record `git -C . rev-parse HEAD` if it is a git repo, else `sha256sum src/*.rs`.

- [ ] **Step 2: Fresh oracle**

Run: `.\target\release\spxphot.exe phot --ra 332.882637 --dec 18.093128 --name BD+17_4708 -o C:\Users\loq\Desktop\AstroNot\tests\data\spxphot\bd17_spxphot.csv`
Expected: stderr `352 frame(s) cover 1 target(s)` and `352 spectral points, 0 frame failure(s)`. Then compare with the Downloads copy: `node -e` that joins both CSVs on `lvf_id`+`det_id` and prints the count of rows whose `flux` differs by more than 1e-9 relative. Write the count into `PROVENANCE.md`; if it is not 0 the archive was reprocessed and the fresh file is the oracle.

- [ ] **Step 3: Fixture cutout**

Fetch `https://irsa.ipac.caltech.edu/SIA?COLLECTION=spherex_dr1&POS=CIRCLE%20332.882637%2018.093128%200.0001&MAXREC=2000&RESPONSEFORMAT=CSV` into the scratchpad and pick its first row whose `energy_bandpassname` is `SPHEREx-D1`. Run:
`.\target\release\spxphot.exe cutout --file <its access_url path after /ibe/data/spherex/> --ra 332.882637 --dec 18.093128 --size 0.06 -o C:\Users\loq\Desktop\AstroNot\tests\data\spxphot\bd17-cutout.fits`
Expected: file of 4–5 MB; `grep -a -o "EXTNAME = '[A-Z-]*'"` lists IMAGE, FLAGS, VARIANCE, ZODI, EPSF, WCS-WAVE. Read `EXPIDN` from the IMAGE header (any FITS reader, or `python -I`), confirm a row with that `lvf_id` and `det_id` 1 exists in `bd17_spxphot.csv`, and write the sidecar JSON from the SIA row plus `lvf_id`.

- [ ] **Step 4: Example frame list**

Write `scripts/make-bd17-frames.mjs`: fetches the DR1 and QR3 SIA CSVs for the position (MAXREC 2000), keeps only the ten listed columns (re-quoting fields that contain commas), and writes `assets/tools/spherex-bd17-frames.js` as `window.spherexBd17Frames = {...};` (follow `assets/tools/xmatch-example.js` for the file header comment). Run it.
Expected: file under 150 kB; `node -e "...require after defining window..."` shows 239 + 113 rows.

- [ ] **Step 5: Copy vectors and validation CSVs, write PROVENANCE.md**

Copy `tests/data/{epsf,wcs,rice}_vectors.json` and `validation/*_irsa.csv` from spxphot. `PROVENANCE.md`: date, spxphot commit/hash, cargo version, exact commands of Steps 2–4, the oracle drift count, the fixture frame's `access_url` and `lvf_id`.

- [ ] **Step 6: Verify the package still builds**

Run: `node --test tests/publish.test.mjs`
Expected: 3 pass (the new asset is a `.js` under `assets/`, the fixtures are under `tests/` and never enter the package).

- [ ] **Step 7: Commit**

```bash
git add tests/data/spxphot assets/tools/spherex-bd17-frames.js scripts/make-bd17-frames.mjs
git commit -m "Add spxphot reference vectors, a fresh BD+17 4708 oracle, a fixture cutout and the example frame list"
```

---

### Task 2: `tools/fits-range.js` — headers, byte sources, rows, Rice, binary tables

**Files:**
- Create: `tools/fits-range.js`
- Test: `tests/fits-range.test.mjs`

**Interfaces:**
- Produces (global `AstroNotFitsRange`, CommonJS):
  - `BLOCK = 2880`
  - `parseHeader(bytes: Uint8Array) → { cards: Object<string,string>, history: string[], size: number, get(key) → string|undefined, num(key, fallback?) → number, int(key) → number, str(key) → string|undefined, dataSize() → number, calibId(name) → string|undefined } | null` (null when no END card within `bytes`; port of `Header::parse`, `parse_value`, `data_size`, `calib_id`; HIERARCH and `D` exponents handled as in Rust)
  - `decodeImage(bitpix: number, bytes: Uint8Array) → Float64Array` (−32, −64, 32, 16; throws otherwise)
  - `riceDecompressI32(bytes: Uint8Array, nx: number, blocksize: number) → Int32Array` (port of `rice_decompress_i32`, 64-bit accumulator as `BigInt` or two 32-bit words — the implementer chooses; must pass the vectors)
  - `createBinTable(header, bytes: Uint8Array) → { columns: [{ name, code, repeat, offset }], rowLength, rows, get(row, name) → Float64Array, scalar(row, name) → number }`
  - `createMemorySource(bytes: Uint8Array) → source`, `createHttpSource(url, { fetch = globalThis.fetch, retries = 7, firstDelayMs = 750 } = {}) → source`; a source is `{ kind: "memory"|"http", read(offset, length) → Promise<Uint8Array> }`; HTTP requires status 206 (else throws "server ignored Range request"), retries with exponential backoff, rejects after the last attempt with the last error.
  - `hduAt(source, offset) → Promise<{ name, header, dataOffset, dataSize, end }>` (reads 8 blocks, grows ×4 until END)
  - `readRows(source, hdu, y0, n) → Promise<{ y0, width, data: Float64Array, at(x, y) → number }>` — uncompressed (BZERO/BSCALE applied) and RICE_1 row-tiled (`ZTILE2 = 1`, `ZBITPIX 32`, P or Q descriptors, THEAP, BLOCKSIZE from ZNAMEi/ZVALi), the port of `Source::rows` and `compressed_rows`
  - `readTableBytes(source, hdu) → Promise<Uint8Array>` (`NAXIS1 × NAXIS2` bytes at `dataOffset`)
  - `walkHdus(source, { offset = 0, until = "WCS-WAVE", max = 8 } = {}) → Promise<hdu[]>`

- [ ] **Step 1: Failing tests**

`tests/fits-range.test.mjs` (loader as in `tests/spectrophotometry.test.mjs`: `createRequire` + `require("../tools/fits-range.js")`; fixture path `tests/data/spxphot/bd17-cutout.fits`):

```js
test("parseHeader: values, strings with '' escapes, HIERARCH, HISTORY calib ids, padded size", ...)
  // cards built like fits.rs::parses_header_and_history; assert get("BUNIT") === "MJy / sr", num("OMEGA_MEDIAN") === 37.94,
  // calibId("epsf") === "019f-aaaa", size === 2880, dataSize() === 2880
test("riceDecompressI32 matches astropy on the four real FLAGS rows", ...)
  // for each case of rice_vectors.json: deepEqual(Array.from(riceDecompressI32(Uint8Array.from(raw), values.length, 32)), values)
test("hdu chain of the fixture cutout", async ...)
  // names from walkHdus(createMemorySource(bytes)) include "IMAGE","FLAGS","VARIANCE","EPSF","WCS-WAVE" in this order; IMAGE header int("NAXIS1") equals the width expected for 0.06° (round(0.06*3600/6.15) = 35 ± 1)
test("readRows of IMAGE equals a direct big-endian decode", async ...)
  // rows 10..14 of IMAGE: compare data to DataView getFloat32 at dataOffset + (y*width+x)*4 for 50 random pixels
test("createBinTable reads EPSF zones and the WCS-WAVE table", async ...)
  // EPSF: rows === 441, scalar(0,"XCENTER") finite, get(0,"EPSF").length === 33*33 (or TDIM product); WCS-WAVE: get(0,"VALUES").length === 2 * get(0,"X").length * get(0,"Y").length
test("HttpSource: range reads, 206 required, retry then success", async ...)
  // node:http server serving the fixture with Range → 206; one path that answers 500 twice then 206: read succeeds with 3 fetch calls (firstDelayMs 1);
  // a path answering 200 without Content-Range rejects with /ignored Range/ after `retries` attempts
```

- [ ] **Step 2: Run, expect failure**

Run: `node --test tests/fits-range.test.mjs`  Expected: fails with "Cannot find module '../tools/fits-range.js'".

- [ ] **Step 3: Implement `tools/fits-range.js`** with the interfaces above (IIFE `(function (root) { ... })(globalThis)`, `root.AstroNotFitsRange = api; if (module) module.exports = api;`).

- [ ] **Step 4: Run, expect pass**  `node --test tests/fits-range.test.mjs` → all pass.

- [ ] **Step 5: Commit**  `git add tools/fits-range.js tests/fits-range.test.mjs && git commit -m "Add fits-range: FITS headers, range byte sources, row reads, RICE_1 and binary tables"`

---

### Task 3: `tools/epsf.js` — spline, ePSF rendering, Sersic

**Files:**
- Create: `tools/epsf.js`
- Test: `tests/epsf.test.mjs`

**Interfaces:**
- Consumes: `createBinTable` result (Task 2) in `parseEpsf`.
- Produces (global `AstroNotEpsf`, CommonJS):
  - `createSpline1D(n) → { n, weights(t, out: Float64Array) → boolean }` (port of `Spline1D::new` + `weights`; `solveDense` private)
  - `createEpsfSet(zones: [{ x, y, epsf }]) → { zones, nearest(x, y) → epsf, render(epsf, x0, y0, xa, ya, w, h) → Float64Array }` where `epsf = { nx, ny, oversample, data: Float64Array }`
  - `parseEpsf(header, table) → EpsfSet` (port of `archive.rs::parse_epsf`: `OVSMPX`, anisotropy refused, `TDIMn` of the `EPSF` column, zones from `XCENTER`/`YCENTER`)
  - `createSersic({ n, reArcsec, axisRatio, paDeg }) → { ..., render(epsf, affine, x0, y0, xa, ya, w, h) → Float64Array }`
  - `bN(n)`, `lnGamma(x)`

- [ ] **Step 1: Failing tests** (`tests/epsf.test.mjs`):

```js
test("not-a-knot spline reproduces cubics exactly and returns false outside the grid", ...)   // psf.rs::spline_reproduces_cubics_exactly, 1e-9
test("render matches photutils ImagePSF on the real ePSF cases", ...)                        // epsf_vectors.json, |g−w| < 1e-12 + 1e-9|w|
test("parseEpsf on the fixture: 441 zones, 33×33, oversample 5, nearest picks the closest centre", async ...)
test("lnGamma(5) = ln 24 and lnGamma(0.5) = ln √π to 1e-12", ...)
test("Sersic model conserves flux to 5e-3 on a Gaussian-like ePSF", ...)                   // sersic.rs::model_conserves_flux_and_shrinks_to_psf, same numbers
```

- [ ] **Step 2: Run, expect failure** (`Cannot find module`).
- [ ] **Step 3: Implement `tools/epsf.js`.**
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** `"Add epsf: not-a-knot spline, ePSF rendering and Sersic models (port of spxphot)"`

---

### Task 4: `tools/forced-phot.js` part 1 — TAN-SIP, solid angle, wavelength table

**Files:**
- Create: `tools/forced-phot.js`
- Test: `tests/forced-phot.test.mjs`

**Interfaces:**
- Consumes: `tools/wcs.js` `createWcs(fields).wcs.skyToPixel/pixelToSky` (1-based) for the cross-check only.
- Produces (global `AstroNotForcedPhot`, CommonJS; this task's part):
  - `sipTerms(fields, prefix) → [[p, q, c], ...]`
  - `createTanSip(fields: Object<string, string|number>) → { worldToPix(ra, dec) → [x, y], pixToWorld(x, y) → [ra, dec], pixelSolidAngle(x, y) → number (sr), localAffineArcsec(x, y) → [[a, b], [c, d]] }` 0-based, port of `wcs.rs::TanSip` including the Newton loop and `jacobian_plane`; throws on non-TAN or LONPOLE ≠ 180
  - `createWaveTable(xs, ys, values, { sip = null } = {}) → { eval(x0, y0, crpix: [c1, c2]) → [waveUm, bandUm], withoutSip() → WaveTable, withSipFrom(fields) → WaveTable }` (port of `WaveTable`)

- [ ] **Step 1: Failing tests** (append to `tests/forced-phot.test.mjs`; `V = wcs_vectors.json`, `fields = V.header`):

```js
test("TanSip matches astropy: sky to 1e-6 arcsec, roundtrip to 1e-8 px", ...)        // wcs.rs::celestial_matches_astropy
test("pixelSolidAngle matches the finite-difference reference to 2e-4", ...)         // omega_arcsec2, factor 206264.80624709636²
test("WaveTable with SIP matches astropy wavelength and bandwidth to 1e-6", ...)     // wcs.rs::wavelength_matches_astropy
test("worldToPix agrees with tools/wcs.js skyToPixel to 1e-8 px (after the 1-based shift)", ...)
```

- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement** the part-1 functions in `tools/forced-phot.js` (module skeleton with the dependency pattern from Global Constraints; `AstroNotEpsf` and `AstroNotFitsRange` required now, used from Task 5 on).
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** `"Add forced-phot: TAN-SIP, pixel solid angle and WCS-WAVE lookup (port of spxphot wcs.rs)"`

---

### Task 5: `tools/forced-phot.js` part 2 — the fit

**Files:**
- Modify: `tools/forced-phot.js`
- Test: `tests/forced-phot.test.mjs`

**Interfaces:**
- Produces:
  - `bits` = `{ TRANSIENT: 1n, SUR_ERROR: 4n, NONFUNC, MISSING_DATA, HOT, COLD, NONLINEAR, PERSIST, OUTLIER, SOURCE, BLOOM, SNOWBALL, HALO, SATELLITE_HALO, CONTAINS_BAD_PIXEL: 1n << 32n, FIT_ERROR: 1n << 33n, FIT_IGNORE, BAD }` (values from `phot.rs::bits`), `flagNames(flags: number|bigint) → string[]`
  - `defaultParams = { fitSize: 13, fitShape: "circle", bkgHalf: 10, bkgExcludeR: 3, bkgStat: "median", skyFit: true, qlRadius: 2.5, flagRadius: 2.5, astropyWave: false }` (`astropyWave` is spxphot's `--astropy-wave`; the run passes `strictWave = !params.astropyWave`), `withFitHalf(params) → params + { fitHalf: Math.ceil(params.fitSize / 2) + 1 }`
  - `fitFrame(px: { image, flags, variance, height }, params, srcs: [[x, y]], target: number, models: Float64Array[], bx, by) → { flux: number[], fluxErr: number[], bkgPre, bkgFit, fitQl, flags: bigint, nPix }` where `image/flags/variance` are `readRows` results; port of `fit_frame`, `clipped_stat`, `sigma_clipped_median`, `invert_spd`

- [ ] **Step 1: Failing tests**:

```js
test("recovers flux and background exactly without noise", ...)      // phot.rs test, same Gaussian helper, |flux − 500·inBox| < 1e-6, bkg 3 ± 1e-9, fitQl < 1e-9, flags 0n
test("a hot pixel is masked and flagged", ...)                         // flux 100 ± 1e-6, flags & HOT, flags & CONTAINS_BAD_PIXEL
test("edge: a source 2 px from the top row fits with fewer pixels and no exception", ...)   // Review Focus 1: nPix < full count, flux finite
test("degenerate: two sources at one position give FIT_ERROR and NaN", ...)                 // Review Focus 5: flags & FIT_ERROR, Number.isNaN(flux[0])
test("degenerate: zero variance everywhere gives nPix 0 and FIT_ERROR", ...)
test("background statistic mode = 2.5·median − 1.5·mean after clipping; none gives bkgPre 0", ...)
```

- [ ] **Step 2: Run, expect failure.** - [ ] **Step 3: Implement.** - [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** `"forced-phot: weighted linear fit, background, fit quality and flags (port of spxphot phot.rs)"`

---

### Task 6: `tools/forced-phot.js` part 3 — frames, calibration cache, per-frame measurement, the run

**Files:**
- Modify: `tools/forced-phot.js`
- Test: `tests/forced-phot.test.mjs`

**Interfaces:**
- Consumes: Task 2 sources/`hduAt`/`readRows`/`readTableBytes`/`createBinTable`; Task 3 `parseEpsf`, `createSersic`; Tasks 4–5.
- Produces:
  - `S3_BASE = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/"`, `IRSA_PREFIX = "https://irsa.ipac.caltech.edu/ibe/data/spherex/"`
  - `frameFromImportRow(row) → { uri, url, obsId, collection, dataCollection, deep, detector, mjd } | null` from an Observation Search row (`row.product.href`, `row.obsId`, `row.collection` (Task 8; fallback `irsaReleases[row.release].collection`), `row.detector`, `row.start`); `dataCollection` = collection without `spherex_` and `_deep`
  - `validateShape(n, re, q, pa) → { ok: true, shape: Sersic|null } | { ok: false, reason }` (port of `validate_shape`; Re < 1 → `shape: null`)
  - `parseTargetsCsv(text) → { ok, targets: [{ name, ra, dec, shape }], reason }` (port of `read_targets`; 1..20 rows)
  - `selectFrames(frames, { deep = false, detectors = [], mjdMin = null, mjdMax = null } = {}) → { frames, excluded: { deep, detector, mjd } }`
  - `createCalibCache() → { get(source, imageHdu, afterVariance) → Promise<{ epsf, wave }>, epsfDownloads: number }` (port of `CalibCache::get`; "no EPSF extension" error text `frame has no EPSF extension`)
  - `measureFrame({ source, frame, targets, params, cache, strictWave = true }) → Promise<row[]>` (port of `process_frame` with every target as a member — all targets share one frame list here, and the on-image test per target does the rest; the TAN-SIP is built with `createTanSip(imageHdu.header.cards)`; rows have exactly spxphot's 19 fields with spxphot's names: `label, ra, dec, lambda, lambda_width, flux, flux_err, flux_err_tractor, flags, fit_ql, flux_bkg, lvf_id, det_id, deep_flg, mjd, data_collection, x_image, y_image, n_pix`)
  - `runForcedPhotometry({ frames, targets, params = defaultParams, filters = {}, concurrency = 6, openSource = (frame) => createHttpSource(frame.url), onProgress = () => {}, signal = null }) → Promise<{ rows, report: { frames, measured, skipped: [{ uri, reason }], failed: [{ uri, error }], epsfDownloads, cancelled: boolean, seconds } }>`; `filters.wvlMin/wvlMax` drop rows after measuring; rows sorted by label then lambda; `onProgress({ done, total, measured, failed })` after every frame; frames whose targets all fall off the image are skipped with reason `target off image`
  - `irsaColumns` (the 19 names), `rowsToIrsaCsv(rows) → string`, `rowsToSpectrumLabCsv(rows) → string` (contract columns `source_id, obs_id, mjd, ra, dec, wavelength, lambda_width, flux, flux_err, flags, method` with `method = "forced-epsf"`, then `lvf_id, det_id, x_image, y_image, fit_ql, flux_bkg, data_collection`), `METHOD = "forced-epsf"`

- [ ] **Step 1: Failing tests** (fixture = `bd17-cutout.fits` as a memory source; `oracle` = the `bd17_spxphot.csv` row with the sidecar's `lvf_id` and `det_id` 1; `frame` built from the sidecar as an import-style row):

```js
test("parity: the fixture cutout reproduces spxphot's row to 1e-9", async ...)
  // for every column except fit_ql: relative 1e-9 (strings equal for label/data_collection/deep_flg); fit_ql relative 1e-6; flags ===
test("runForcedPhotometry over one memory frame: report counts and sorted rows", async ...)   // frames 1, measured 1, epsfDownloads 1
test("a frame without EPSF is skipped with its reason", async ...)                          // Review Focus 2: memory source = fixture bytes cut after VARIANCE; skipped[0].reason matches /no EPSF extension/
test("a frame whose source rejects is listed as failed and the others are measured", async ...)  // Review Focus 3: two frames, openSource throws for one
test("abort stops new frames and keeps rows measured so far", async ...)                     // Review Focus 4: 5 copies of the frame, concurrency 1, abort after the first onProgress; report.cancelled === true, rows.length >= 1, done < 5
test("selectFrames: deep, detector and MJD filters count what they exclude", ...)
test("parseTargetsCsv: 0 rows, 21 rows, missing dec, Sersic columns, Re < 1 is a point source", ...)
test("frameFromImportRow maps the IRSA URL to the S3 URL and reads deep from the collection", ...)
test("rowsToIrsaCsv round-trips the parity row; rowsToSpectrumLabCsv is read by AstroNotSpectrum without warnings", ...)
  // Spectrum: readTable → detectColumns → buildSpectrum; assert no entries in its warnings/problems list and one point with flux === row.flux
test("LIVE: first 6 BD+17 frames from S3 match the oracle rows and IRSA's rows", { skip: !process.env.ASTRONOT_LIVE }, async ...)
  // frames from spherexBd17Frames (load the asset in a vm with a fake window) through parseIrsaResults; parity vs bd17_spxphot.csv as above;
  // vs bd17_irsa.csv matched by lvf_id: flux ratio within 0.98–1.02, flags ===, |Δx_image|,|Δy_image| < 1e-3
test("LIVE FULL: all 352 frames, median flux ratio vs IRSA within 0.995–1.005", { skip: !process.env.ASTRONOT_LIVE_FULL }, ...)
```

- [ ] **Step 2: Run, expect failure.** - [ ] **Step 3: Implement** (request budget: after the first frame of a `dataCollection`, remember the IMAGE/FLAGS/VARIANCE header offsets and data sizes; for later frames read the IMAGE header at the remembered offset first and fall back to the full walk when `NAXIS1/NAXIS2/BITPIX` or the EXTNAME differ). - [ ] **Step 4: Run, expect pass** (`node --test tests/forced-phot.test.mjs`, then once with `ASTRONOT_LIVE=1`).
- [ ] **Step 5: Commit** `"forced-phot: calibration cache, per-frame measurement and the concurrent run (port of spxphot)"`

---

### Task 7: Observation Search — record limit, deep-field collections, hand-off

**Files:**
- Modify: `tools/observation-csv.js:15-23` (`irsaMaxRecords = 2000`; `irsaReleases` gains `dr1_deep: { collection: "spherex_dr1_deep", label: "SPHEREx DR1 deep fields" }` and `qr3_deep: { collection: "spherex_qr3_deep", label: "SPHEREx QR3 deep fields" }`), `:253-266` (rows gain `collection: get("obs_collection") || irsaReleases[release].collection` and `deep: collection.endsWith("_deep")`)
- Modify: `tools/observation-search/index.html:50-56` (two `<option>`s), `tools/observation.js:257-259` (note text uses the constant; add "Measure these frames in Forced Spectrophotometry" link to `sitePage("/tools/forced-spectrophotometry") + "?ra=…&dec=…"` under the results when a position was prepared)
- Modify: `tests/observation.test.mjs` (`"SIA query: each data release selects its own IRSA collection"` covers the five; `"IRSA results: rows from each release import"` asserts `collection` and `deep` for a deep row whose URL is under `dr1/level2/`), `README.md` Observation Search paragraph, `assets/i18n/az.js` (new labels/note/link)

- [ ] **Step 1: Failing tests** (the two tests above extended; a new `test("Deep-field rows keep their collection and deep flag; MAXREC is 2000")`).
- [ ] **Step 2: Run, expect failure.** - [ ] **Step 3: Implement.** - [ ] **Step 4: Run** `node --test tests/observation.test.mjs` → pass.
- [ ] **Step 5: Commit** `"Observation Search: deep-field collections, 2000-record searches and a hand-off to Forced Spectrophotometry"`

---

### Task 8: The page — frames, targets, parameters, run, table, downloads

**Files:**
- Create: `tools/forced-spectrophotometry/index.html`, `tools/forced-spectrophotometry.css`, `tools/forced-spectrophotometry.js`
- Modify: `tools/registry.js:77-85` (insert after Spectrophotometry: `{ id: "forced-spectrophotometry", route: "forced-spectrophotometry", name: "Forced Spectrophotometry", category: "analysis", description: "Measure SPHEREx spectra by forced ePSF photometry on every spectral image covering a position, read directly from the IRSA archive — the IRSA Spectrophotometry Tool's method, in your browser.", diagram: "flux", available: true }`)

**Interfaces:**
- Consumes: `AstroNotForcedPhot` (Task 6), `parseIrsaResults` (global from `tools/observation-csv.js`), `AstroNotXmatch.parseAngle(text, axis, unit)`, `window.spherexBd17Frames` (Task 1, loaded on demand like `spectrophotometry.js:195` `loadScript`), `AstroNotFitsRange.createMemorySource` for local files.
- Produces: the page at `/tools/forced-spectrophotometry/` with `data-fs-*` hooks; panels in this order and with these headings: **Frames** (import SIA CSV files, choose local FITS files, "Use the BD+17 4708 example", loaded-frames table: file/collection/detector/MJD/source, counts by collection), **Targets** (rows ≤ 20 with Label/RA/Dec/Sersic fields, "Add target", targets CSV upload), **Filters and parameters** (deep, detectors, MJD, wavelength; `<details>` Advanced with the rest; concurrency), **Run** (Measure / Cancel, progress `n / N frames`, status line in spxphot's wording: "352 spectral points, 0 frame failures, 6 ePSF calibration downloads, 41.3 s"), **Results** (table with the 19 columns + decoded flag names; `?ra=&dec=` from the URL prefill the first target), **Downloads** (IRSA-format CSV named `forced-spectrophotometry_<label>.csv`; Spectrum Lab CSV via the same pattern as `spectrophotometry.js:599-614`).

- [ ] **Step 1: Page skeleton** copied from `tools/spectrophotometry/index.html` (scripts: routes, i18n, wcs, fits-range, epsf, forced-phot, observation-csv, xmatch, workspace, forced-spectrophotometry), `data-workspace-id="forced-spectrophotometry"`, registry entry.
- [ ] **Step 2: Verify the route serves**  Run `node serve.mjs` (background) and `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4173/tools/forced-spectrophotometry/` → 200; `node --test tests/publish.test.mjs` → pass.
- [ ] **Step 3: UI module** — state `{ frames: [], targets: [], params, filters, run: null, result: null }`; frames from SIA CSVs via `parseIrsaResults` → `frameFromImportRow`, de-duplicated by `uri` across files (the count of duplicates is reported in the status line), from local files via `createMemorySource(await file.arrayBuffer())` with `openSource` returning that source (and `data_collection`/`deep_flg` filled only when a loaded frame row has the same `obsId` and detector); run through `runForcedPhotometry` with an `AbortController`; every refusal writes its reason to the status element (`role="status"`); buttons disabled states follow `spectrophotometry.js`.
- [ ] **Step 4: Browser check** (the `run` skill's headless pattern used earlier in this project): open `http://127.0.0.1:4173/tools/forced-spectrophotometry/`, click the example, run; expected after ≲ 90 s: status line with `352 spectral points` (or 352 minus the frames IRSA has since removed, with the failures listed), table rows 352, both downloads produce files; export the IRSA CSV and compare to `tests/data/spxphot/bd17_spxphot.csv` with a one-off node script: every matched row within 1e-9 relative. Screenshot kept in the scratchpad.
- [ ] **Step 5: Commit** `"Add the Forced Spectrophotometry page: frames, targets, run, results and downloads"`

---

### Task 9: Plot, method note, documentation, Azerbaijani strings, cross-links

**Files:**
- Modify: `tools/forced-spectrophotometry/index.html`, `tools/forced-spectrophotometry.js`, `tools/forced-spectrophotometry.css`
- Modify: `README.md` (new tool paragraph after Spectrophotometry: method in six steps, validation table from spxphot's README, known differences, data credit, how to run the live tests, `node scripts/make-bd17-frames.mjs`), `TODO.md` (follow-ups: local cutouts in Observation Search, tr/ru/es/zh strings, Sersic validation), `tools/spectrophotometry/index.html` (one sentence + link to the new tool; and the reverse link on the new page), `assets/i18n/az.js`

- [ ] **Step 1: Plot** — inline SVG: x wavelength µm, y flux µJy (linear/log toggle; non-positive fluxes listed, not plotted, as Spectrum Lab does), error bars from `flux_err`, one colour per detector with a legend, flagged points hollow, click/keyboard selection shared with the table (`aria-selected`), one series per target label. `prefers-reduced-motion` respected (no animation anyway).
- [ ] **Step 2: Method note** — the six steps, the agreement table (BD+17 4708 0.9999 / WD 1657+343 1.013 / NGC 7619 Sersic 1.040 not validated), the known differences (wavelength +0.0003 µm, `fit_ql` +6 %, ~2 % outliers), the Sersic caveat shown next to the Sersic fields too, the credit and non-affiliation text from Global Constraints.
- [ ] **Step 3: Azerbaijani** — collect every visible string of the page and of Task 7's additions (`node` one-liner over the HTML text nodes/attributes and the UI file's string literals), add hand-written entries to `assets/i18n/az.js` in alphabetical position (same format as the file; templates with `{0}` where the UI builds counts), then render the page headless with `?lang=az` and confirm no English text node remains except technical tokens.
- [ ] **Step 4: Full test run** `node --test` → 0 failures; `node --test tests/publish.test.mjs` → pass.
- [ ] **Step 5: Commit** `"Forced Spectrophotometry: spectrum plot, method note, README, Azerbaijani strings and cross-links"`
