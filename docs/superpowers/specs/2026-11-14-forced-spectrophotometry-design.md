# Forced Spectrophotometry — design

Date: 2026-11-14. Status: approved by the owner on 2026-11-14 (approach B; the calls marked "my call" below were accepted).

## Intent

Add a new tool to AstroNot that reproduces, in the browser and without a server, the IRSA SPHEREx **Spectrophotometry Tool** as reverse-engineered and re-implemented by `spxphot` (`C:\Users\loq\Downloads\spxphot\spxphot`, Rust). For one or more sky positions it measures the source in every SPHEREx Level-2 spectral image that covers it, by **forced ePSF photometry** (flux × ePSF + background, weighted linear least squares), and writes one spectral point per image. spxphot is validated against the real IRSA tool on point sources (median flux ratio 0.9999, flags identical on 100 % of 1148 points) and does the whole job in about 20 s instead of 11 minutes, because it reads only the needed bytes of each frame from IRSA's public S3 bucket.

Why now: the site's existing **Spectrophotometry** tool does aperture photometry and says so ("This is not the IRSA forced photometry"). The IRSA method is the one researchers compare against, and the owner has the working reference implementation in hand.

Why it can be done client-side (checked 2026-11-14 with `curl`):

- `https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/` answers `Range` requests (206) **with `Access-Control-Allow-Origin: *`**, `Access-Control-Allow-Methods: HEAD, GET`, and a preflight that allows the `range` header. A page on any origin, including `file://`, can read frame rows, the ePSF table and the wavelength table exactly as spxphot does.
- IRSA TAP (`/TAP/sync`) sends no CORS header, so the browser cannot run spxphot's ADQL frame query. The site already has the substitute: **Observation Search** builds an IRSA SIA query and imports its CSV, and SIA accepts `MAXREC=2000` (BD+17 4708: DR1 239 + QR3 113 = 352 frames, the same 352 spxphot finds).
- The IRSA cutout service answered 503 and has no CORS header; it is not used.

## Goals

1. A new tool page, listed among the scientific tools, that takes 1–20 targets and a frame list and produces the same spectrum spxphot produces: the same columns, the same numbers (the JS port must agree with spxphot's own output to numerical precision, not merely with IRSA within tolerance).
2. Frames are read from S3 by byte range, on the fly, in the browser: about 25 rows of IMAGE, FLAGS (RICE_1, decoded in JS) and VARIANCE per frame, plus the ePSF and WCS-WAVE tables once per detector/calibration. A full run of ~350 frames should finish in about a minute on an ordinary connection, show progress per frame, be cancellable, and leave partial results usable.
3. Point sources at full parity with the IRSA tool; Sersic galaxies offered with the same caveat spxphot gives (fluxes ~4 % high, "indicative only").
4. Output: an on-page spectrum plot and table, a CSV with IRSA's column names (spxphot's format), and a Spectrum Lab CSV (`method = forced-epsf`) through the existing hand-off pattern.
5. Tests in `node --test` that (a) pass spxphot's own reference vectors (astropy/photutils), (b) reproduce spxphot's validation CSVs row by row, and (c) optionally (live, env-gated) measure real frames from S3.
6. Quality on par with the other tools: honest status text, every refusal gives a reason, keyboard and screen-reader behaviour like Time Machine / Spectrophotometry, Azerbaijani catalog entries written by hand.

## Non-goals

- The ADQL/TAP search of `spxphot search` (impossible from a browser: no CORS). Frame discovery stays in Observation Search.
- Building IRSA-format cutout files locally from S3 (`spxphot cutout`). Feasible and useful, but it belongs in Observation Search ("Download FITS cutout" currently depends on the 503-prone IRSA service). Follow-up.
- A Rust/WASM kernel. The arithmetic is tiny (a 13-px fit per frame); the time is network. The site's WASM convention requires a JS fallback anyway, so JS is the implementation.
- Validating the Sersic mode against IRSA. Shipped with spxphot's caveat.
- Translating the new strings into tr/ru/es/zh (they fall back to English until done; az is done by hand).

## Anti-goals (failure even if it "works")

- Presenting the result as official IRSA photometry. The page must say it is an independent reimplementation of the method, with the measured agreement and the known differences (wavelength +0.0003 µm median, `fit_ql` ~6 % higher, ~2 % >3σ outliers on flagged frames).
- Silently differing from spxphot. A port that needs a looser tolerance than spxphot's tests to pass is a bug, not a tolerance to raise.
- Hiding partial coverage: frames skipped (off image, fetch failure, no EPSF extension) are counted and listed, never dropped quietly.
- A page that hangs the UI during a run, or that cannot be used offline with local files.

## Constraints

- Static site: plain HTML/JS/CSS, no bundler, no server. Scripts load as classic scripts (globals + CommonJS for node tests), like `tools/photometry.js`.
- Existing building blocks to reuse, not duplicate: `tools/wcs.js` (TAN-SIP, world↔pixel), `tools/pair.js` (BINTABLE column reader, WCS-WAVE lookup, observation time), `tools/fits.js` (header parsing for local files), `tools/observation-csv.js` (SIA CSV import), `tools/spectrum-csv.js` (Spectrum Lab CSV contract), the workspace page skeleton and CSS of Spectrophotometry / Time Machine.
- Browser per-host connection limit (~6) bounds concurrency; S3 is HTTP/1.1.
- The S3 CORS policy is IRSA's to change. Every network failure must produce a clear message, and local files must keep working.
- Data credit: NASA/IPAC IRSA, SPHEREx DR1/QR3/QR2; "independent reimplementation, not affiliated with IPAC or the SPHEREx team" (as spxphot's README states).

## Approaches considered

**A. Second method inside the existing Spectrophotometry tool.** Smallest surface, reuses the target form and hand-off. Rejected by the owner: the page would carry two unrelated methods, and the IRSA tool deserves its own place in the tool list.

**B. A separate tool page (chosen).** 1:1 with the IRSA tool and spxphot: target list with joint fits, release/detector/MJD/wavelength filters, progress over hundreds of frames, spectrum plot, both CSVs. More UI, but a clean story and room for Sersic and later for local cutouts.

**C. Port spxphot's Rust to a WASM crate** under A or B. Dropped: double implementation (site rule: JS fallback), negligible compute gain.

## Decisions (as decided, or as my call where marked)

### Name and place

- Name **"Forced Spectrophotometry"**, route `/tools/forced-spectrophotometry`, category *analysis*, registry id `forced-spectrophotometry`, listed next to Spectrophotometry (my call; the owner may rename). Description: "Measure SPHEREx spectra by forced ePSF photometry on every spectral image covering a position, read directly from the IRSA archive — the IRSA Spectrophotometry Tool's method, in your browser."
- Spectrophotometry (aperture) stays as is; its page gets one sentence pointing to the new tool for the IRSA method, and vice versa.

### Inputs

**Targets** (1–20, as IRSA): a form row per target with *Label*, *RA*, *Dec* (ICRS; decimal degrees or sexagesimal, parsed with `AstroNotXmatch.parseAngle` from `tools/xmatch.js`, the parser Catalog Cross-Match uses), and an optional galaxy model (*Sersic n* 0.5–6, *Re* arcsec < 20, *b/a* in (0, 1], *PA* degrees east of north; Re < 1″ is treated as a point source, as IRSA does). Also a CSV upload with spxphot's columns `ra,dec[,name][,sersic_n,re_arcsec,axis_ratio,pa_deg]`. Targets near each other on a frame are fit jointly (same rule as spxphot: within fit half-size + 4 px).

**Frame list**: one or more IRSA SIA CSV files saved from Observation Search. IRSA exposes five collections (`spherex_dr1`, `spherex_qr3`, `spherex_qr2`, and the deep fields `spherex_dr1_deep`, `spherex_qr3_deep`), one SIA query each, so up to five files for one position; rows are merged and de-duplicated by `access_url`. Observation Search currently offers only the first three, which would leave the "include deep-field frames" toggle with nothing to act on; **my call:** Observation Search's release selector gains the two deep collections (`irsaReleases`, the selector, its tests, README, az strings), and the new tool's toggle filters on `obs_collection` ending in `_deep`. The tool uses `access_url` (converted to the S3 key by stripping `https://irsa.ipac.caltech.edu/ibe/data/spherex/`), `obs_id`, `energy_bandpassname` (detector), `obs_collection` (deep flag: ends with `_deep`), `t_min`. Observation Search changes: `irsaMaxRecords` 100 → 2000 and the matching note text; the importer additionally keeps `obs_collection`, `t_min`, `em_min`, `em_max`; the results panel gets a link "Measure these frames in Forced Spectrophotometry" that carries the position (the frame CSV itself is still chosen by the user, as with the FITS Viewer hand-off, because the page cannot fetch SIA).

**Local files** (secondary path, same code): full Level-2 frames or IRSA cutouts that still carry EPSF and WCS-WAVE (cutouts made by the IRSA service keep them). The site's bundled QR2 example cutouts have only IMAGE and WCS-WAVE and are refused with the reason "no EPSF extension". Local files make the tool usable offline and let tests run without network. A FITS header names neither the release nor the deep status (only OBSID, EXPIDN, DETECTOR, MJD-AVG), so for a local file `data_collection` and `deep_flg` are filled only when the file matches a row of an imported frame list (same OBSID and detector); otherwise both are left empty, which the table and both CSVs show as empty, never guessed (my call).

**Example**: "Use the BD+17 4708 example" fills one target (332.882637, 18.093128, as in spxphot's README, with its note that the position may be a few arcsec off) and loads a bundled frame list (`assets/tools/spherex-bd17-frames.js`, a JS global holding the 352 DR1+QR3 rows in the importer's row format, fetched 2026-11-14, ~50 kB — a `.js` global like `assets/tools/xmatch-example.js`, because `publish-rules.mjs` has no `.csv` type and `.js` also works from `file://`). Running it needs network access to S3; the page says so.

**Filters and parameters** (defaults = spxphot defaults; all in a collapsed "Advanced" group except deep/detectors/MJD/wavelength): include deep-field frames (off), detectors 1–6, MJD min/max, keep points with wavelength in [min, max] µm, fit region 13 px circle (or box), background box half-size 10 px, background exclusion radius 3 px, background statistic median/mean/mode/none, fit a residual constant sky (on), apply SIP to the wavelength lookup like astropy (off), concurrency (default 6, max 12).

### The computation (port of spxphot, module by module)

All numerics are a line-by-line port of the Rust, keeping names and comments, so the two can be diffed. Pixel coordinates 0-based internally, as in spxphot; conversions at the FITS boundary.

- `tools/fits-range.js` — *byte sources and FITS structure* (port of `fits.rs` + the `Source`/`hdu_at`/`rows`/`compressed_rows` parts of `archive.rs`): `HttpSource(url)` with `Range` reads, retry with exponential backoff (7 attempts from 750 ms, as spxphot), 206 check; `MemorySource(bytes)`; `headerAt(offset)` growing reads from 8 blocks; HDU chain walk; row reads of uncompressed images with BZERO/BSCALE; RICE_1 row-tiled decompression (`rice_decompress_i32`, ZBITPIX 32, BLOCKSIZE from ZNAMEi/ZVALi, P/Q descriptors, THEAP); BINTABLE with `TDIMn`. Reuse `pair.js`'s column reader where it fits; extend rather than fork.
- `tools/epsf.js` — *PSF models* (port of `psf.rs` + `sersic.rs`): `Spline1D` (not-a-knot cubic, dense solve), `EpsfSet.nearest/render` (photutils `ImagePSF.evaluate` equivalent), `Sersic.render` with `b_n` and Lanczos `lnGamma`.
- `tools/forced-phot.js` — *the measurement* (port of `phot.rs`, `wcs.rs` `WaveTable` and `pixel_solid_angle`, `main.rs` `process_frame`, `archive.rs` `CalibCache`, `parse_epsf`): flag bits and `FIT_IGNORE`/`BAD` masks, pre-fit sigma-clipped background with the crowded-field fallback, weighted normal equations solved by Cholesky, `fit_ql`, flag propagation within 2.5 px with bits 32/33, units `flux[µJy] = F × Ω × 1e12`, `flux_err = √(σ² + (0.03 F)²)`, wavelength/bandwidth from the -TAB lookup with CRPIXiW, MJD from `MJD-AVG` (fallback `t_min`), `lvf_id` from `EXPIDN`, `x_image/y_image` in parent-frame pixels via CRPIXiA; a calibration cache keyed by detector + the EPSF / spectral-WCS UUIDs from header HISTORY; `runForcedPhotometry(frames, targets, params, {concurrency, onProgress, signal})` returning rows sorted by label then wavelength plus a per-frame report (measured / skipped with reason / failed with error). TAN-SIP world→pixel uses `tools/wcs.js`; the builder must confirm against `wcs_vectors.json` (≤1e-6″ sky, ≤1e-8 px roundtrip) and either reuse the site's solid angle or port spxphot's Jacobian one, whichever passes the 2e-4 check — but the port must then match spxphot's `x_image`, `y_image` and `flux` on the validation rows to 1e-9 relative, which fixes the choice in practice.
- `tools/forced-spectrophotometry.js` + `tools/forced-spectrophotometry/index.html` + `.css` — the page. No numerics in the UI file.

Request budget: spxphot issues about seven range reads per frame. Frames of one data release share an HDU layout, so after the first frame the page should predict the IMAGE/FLAGS/VARIANCE offsets and verify them with the header read it needs anyway, bringing a frame to about four requests. With 6 in flight that is the ~1-minute target. The UI must stay responsive during a run (a Web Worker is allowed but not required; fetches are asynchronous and the fit per frame is well under a millisecond).

### Output

- **Table** with IRSA's columns, in spxphot's order: `label, ra, dec, lambda, lambda_width, flux, flux_err, flux_err_tractor, flags, fit_ql, flux_bkg, lvf_id, det_id, deep_flg, mjd, data_collection, x_image, y_image, n_pix`; flags also decoded to names (SOURCE, CONTAINS_BAD_PIXEL, FIT_ERROR, …). Sortable, selection linked to the plot.
- **Plot**: flux density (µJy) against wavelength (µm) per target, error bars from `flux_err`, points coloured by detector, flagged points marked, log/linear flux axis; selection linked to the table. A plain SVG/canvas plot in the page's own style is enough; Spectrum Lab remains the place for deeper analysis.
- **Downloads**: (1) `forced-spectrophotometry_<label>.csv` in spxphot's format; (2) the Spectrum Lab CSV (`wavelength, flux, flux_err, lambda_width, flags, source_id, obs_id, mjd, ra, dec, method` with `method = forced-epsf`), through the same hand-off section Spectrophotometry uses.
- **Run report**: frames found / measured / skipped (target off image, no EPSF extension, filtered) / failed (network), ePSF downloads, wall time — the same summary line spxphot prints.
- **Method note** on the page: the pipeline in six steps (as spxphot's README), the measured agreement table, the known differences, the Sersic caveat, data credit and the non-affiliation statement.

### Observation Search changes

Listed above: `irsaMaxRecords` → 2000 (and the "at most N" note), importer keeps four more columns (`obs_collection`, `t_min`, `em_min`, `em_max`), the two deep-field collections in the release selector, a hand-off link to the new tool. Nothing else changes there.

### Tests (`tests/forced-phot.test.mjs`, plus fixtures under `tests/data/spxphot/`)

Copy from spxphot: `epsf_vectors.json`, `wcs_vectors.json`, `rice_vectors.json`, and `validation/{bd17,wd,gal}_{irsa,spxphot}.csv`. Then:

1. Ports of spxphot's unit tests: spline exact for cubics and `None` outside the grid; ePSF render equals photutils to 1e-9 relative; flux and background recovered exactly without noise; hot pixel masked and flagged; Sersic model conserves flux to 5e-3; `lnGamma(5) = ln 24`; Rice rows decode to the astropy vectors; celestial WCS to 1e-6″ and solid angle to 2e-4; wavelength/bandwidth to 1e-6.
2. **Local-file end-to-end** (no network): a fixture frame is needed. (a) One real cutout of a BD+17 4708 frame that keeps IMAGE/FLAGS/VARIANCE/EPSF/WCS-WAVE, made with `spxphot cutout` from S3 (the IRSA cutout service is unreliable); the EPSF table makes it ~4 MB, acceptable under `tests/data/spxphot/`, never under `assets/`. It ships with its frame-list row (a sidecar JSON) so `data_collection`/`deep_flg` compare too. (b) Fallback if spxphot may not be built and run: a synthetic frame from `tests/fits-builder.mjs` with a synthetic ePSF; then check 3 runs only live. **Decided (owner, 2026-11-14): (a).** Building and running the Downloads copy of spxphot (`cargo build --release`, then `spxphot cutout` and `spxphot phot` against S3) is allowed for fixtures and oracles.
3. **Parity with spxphot**: for the frames the fixture covers, every output column equals the corresponding row of `bd17_spxphot.csv` (matched by `lvf_id`) to 1e-9 relative (1e-6 for `fit_ql`); flags identical. `bd17_spxphot.csv` in the Downloads copy has no recorded provenance and the archive may have been reprocessed since; if (a) is allowed, the oracle is regenerated with a fresh `spxphot phot` run on the same day as the fixture, and the commit records the spxphot source hash and options. A disagreement between the port and a fresh spxphot run is a bug in the port; tolerances are never widened.
4. **Live** (`ASTRONOT_LIVE=1`, like `observation.test.mjs`): read the first N frames of the bundled BD+17 list from S3 and repeat check 3 against `bd17_spxphot.csv`; and against `bd17_irsa.csv` reproduce spxphot's README numbers on those rows (flux ratio median within 0.995–1.005, flags identical, `x_image`/`y_image` within 1e-3). A second env var allows the full 352-frame run.
5. CSV contracts: the IRSA-format CSV round-trips; the Spectrum Lab CSV is accepted by `spectrum-csv.js` without warnings.
6. Observation Search tests updated for the new limit and columns; `publish.test.mjs` for the new files.

### Site integration checklist

Registry entry, route, tools index card (diagram `flux` or a new one), README section (method, validation table, differences, data credit, test instructions), `publish-rules.mjs` allowlist for the new page/assets, `TODO.md` item for the follow-ups (cutouts, other languages, Sersic validation), Azerbaijani strings in `assets/i18n/az.js` (hand-written, glossary terms: *məcburi fotometriya*, *ePSF*, *kadr*, *istinad*), and the two cross-links between the photometry pages.

## What's left to the builder

- Exact page layout and copy, following Spectrophotometry's panel order (inputs → targets → run → results → hand-off → method note).
- Whether to run the pipeline in a Web Worker.
- The offset-prediction optimisation and the retry/backoff tuning within the stated budget.
- Plot implementation details.
- Fixture choice in test 2 (a) vs (b), subject to the preference stated.
- File names within the stated module split, as long as numerics stay out of the UI file.
