# AstroNot

We’re not astronauts. We are AstroNot.

Open `index.html` in a browser to browse the local files. To use the clean URLs, run the preview server from the project folder and open [AstroNot on localhost](http://127.0.0.1:4173).

```sh
node serve.mjs
```

## Site pages

- `/` — Landing page
- `/tools` — Scientific Tools directory
  - `/tools/sky-explorer` — Sky Explorer
  - `/tools/time-machine` — Time Machine
  - `/tools/image-differencing` — Image Differencing
  - `/tools/spectrum` — Spectrum Lab
  - `/tools/motion` — Motion Detector
- `/explore` — Public discovery
- `/learn` — Educational content
  - `/learn#fits-guide` — Step-by-step guide to opening the bundled SPHEREx FITS example and reading its OBSID, DATE-OBS, and BUNIT. Observation Search and FITS Viewer link back to it with **FITS guide**.
- `/about` — Mission and team

## Scientific Tools

Spectrum Lab and Motion Detector have read-only workspace previews and are marked Coming Soon. The directory enables launches for Sky Explorer, Time Machine, Image Differencing, Observation Search, and FITS Viewer. Previous landing anchors and workspace query links continue to open their matching content.

- **Observation Search** at `/tools/observation-search` converts ICRS coordinates, UTC dates, and wavelengths into an IRSA SIA query for SPHEREx Quick Release 2. The generated link opens the archive’s CSV results. [IRSA SIA reference](https://irsa.ipac.caltech.edu/ibe/sia.html)
  - Hand-off to FITS Viewer: save the CSV from the generated link, then choose it under **Import IRSA CSV**. Each observation row (one per detector) offers **Download FITS cutout** (IRSA cutout service, centered on the search position, 0.12° by default, ICRS degrees), **Open in FITS Viewer**, and the full file. The Viewer lists the selected observation, and after you choose the downloaded file with **Choose a local FITS file** it compares the header OBSID and detector with the selected row. Only HTTPS `irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/…fits` links are accepted. [IRSA cutout service](https://irsa.ipac.caltech.edu/data/SPHEREx/docs/cutout_tool.html)
  - Why a CSV import: on 12 Nov 2026 neither the SIA response, the full product, nor the cutout carried an `Access-Control-Allow-Origin` header, and Chrome blocked a `fetch` from a page on another origin. A page therefore cannot read them directly, and the project has no server route for it. Downloads work as ordinary navigations.
  - IRSA reports SIA errors as HTTP 200 with a VOTable even when CSV is requested, and the CSV has no overflow flag. The import shows the service message, and warns when a file holds as many rows as the 100-record limit of the generated query. The `cloud_access` column holds unquoted JSON with commas, which the importer rejoins.
  - Tests: `node --test`. `ASTRONOT_LIVE=1 node --test tests/observation.test.mjs` also queries the real archive.
- **Sky Explorer** at `/tools/sky-explorer` opens the SPHEREx example or a local uncompressed 2D FITS image, with zoom, pan (mouse, touch, arrow keys), and a readout of the view-center and pointer RA/Dec (ICRS, degrees) and the field of view in the image area shown. Coordinates come from the image header: the primary WCS with `RA---TAN`/`DEC--TAN`, with or without `-SIP`, using `PCi_j` with `CDELTi` or `CDi_j`, `CRPIX` anywhere (including negative), and `LONPOLE`. Other projections, frames, and legacy `CROTA` headers open as pixels with RA/Dec marked Unavailable. The WCS maths is in `tools/wcs.js` and has no DOM dependency, so other tools can reuse it.
- **Time Machine** at `/tools/time-machine` compares a **Reference observation** and a **Comparison observation**, each a local uncompressed 2D FITS image HDU (the same files you download from Observation Search), or the bundled example pair. Each side shows observation ID, HDU, size, `BUNIT`, `RADESYS`, observation time, exposure, detector and, for SPHEREx cutouts that keep the `WCS-WAVE` table, the per-pixel wavelength at the image center (verified against Astropy). Observation time comes from `DATE-OBS`/`MJD-OBS` with `TIMESYS` (UTC when absent); a disagreement of more than 1 s, an unsupported scale or no time shows **Observation time unavailable**, `DATE` is shown separately as the file-written time, and a time you type is labeled **Entered manually**. The pair is checked from the WCS: sky overlap, then whether the two arrays lie on one pixel grid (same size and the same sky position for sample pixels within 0.05 px). Only a verified common grid enables linked pan/zoom and **Blink**; otherwise each panel keeps its own view and the reason is shown. Real SPHEREx exposures on different dates are usually about half a pixel apart, so the optional **Align comparison to the reference grid (display only)** copies the nearest comparison pixel onto the reference grid (no interpolation, uncovered pixels undefined) to allow Blink; it is a viewing aid, not a calibrated reprojection. Other features: shared or separate contrast range (shared only for equal units), per-panel range readout, a timeline ordered by the valid times, a marked sky point that is read from each file, **Swap roles**, and detection of the same observation used twice (identical pixel data are rejected). Blink starts stopped, offers at most 2 frames per second (1 with reduced motion), can be started with Space or B in the Blink view, and 1 or 2 pick the frame. The model is in `tools/pair.js` (no DOM) and is meant to be reused by Image Differencing.
  - Example pair: two real IRSA QR2 cutouts of one field (RA 156.09328159, Dec −41.64466331, 0.12°, detector 2): `2025W21_2C_0280_1` (2025-05-24T04:24:53 UTC) and `2025W24_1A_0514_1` (2025-06-11T14:21:56 UTC), both processed as `l2b-v20`. They keep the primary, IMAGE and WCS-WAVE HDUs in `assets/tools/spherex-time-machine-example.js`. [IRSA cutout service](https://irsa.ipac.caltech.edu/data/SPHEREx/docs/cutout_tool.html)
- **Image Differencing** at `/tools/image-differencing` computes **Δ = target − reference** for a **Reference** and a **Target** local uncompressed 2D FITS image HDU (or the bundled Time Machine example pair) and shows the reference, the target on the reference grid, and Δ with a zero-centered blue–white–red scale, a legend with the unit, and hatched invalid pixels. The sign is always labeled, and **Swap** exchanges the roles. Computation lives in `tools/difference.js` (no DOM, reusable by Motion Detector), which returns one result structure: aligned images, difference, validity and overlap masks, per-pixel status, optional variance and SNR, WCS, unit and both observation IDs (`window.AstroNotLatestDifference` holds the latest one in the page).
  - Checks before subtracting: identical units, or Jy prefixes (kJy/sr, MJy/sr) which are converted, otherwise refused with the reason (a missing BUNIT is refused unless you tick the unverified opt-in); a usable TAN/TAN-SIP WCS in both (equal array sizes alone are never accepted); overlap on the sky; the same pixel data twice is refused.
  - Grids: if every sample pixel agrees within 0.01 pixel the arrays are subtracted as they are and labeled a **pixel difference**. Otherwise the target is reprojected onto the reference grid by **bilinear interpolation** through both WCS (the method of astropy-reproject `reproject_interp` with order bilinear; values are interpolated as surface brightness). Pixels the target does not cover, or whose four interpolation neighbours include a NaN/masked pixel, stay invalid. The usable footprint ends at the outermost target pixel centers (reproject extends it by half a pixel; AstroNot does not extrapolate). Target pixels much smaller than the reference pixels are refused (aliasing). **Require one identical pixel grid** turns reprojection off. Reprojection smooths the target and correlates its noise. Real SPHEREx exposures on different dates are about half a pixel apart, so the example pair is reprojected.
  - Variance: only when both files have a VARIANCE image of the same size and matching units, Var(Δ) = Var(target) + Var(reference) for independent errors (a reprojected target contributes the sum of squared bilinear weights times variance, neighbouring pixels stay correlated); otherwise SNR is empty. No PSF matching is applied; an optional global median offset can be removed from Δ and is reported with its value. FLAGS or other mask images are not interpreted: only NaN and BLANK pixels are invalid.
  - Pixel readout: click or tap a pixel, type its FITS pixel position, or focus a view and use the arrow keys (Shift: ten pixels); the readout and the announcement give the reference value, the target value, Δ, Var(Δ), SNR, the sky position and the reason a pixel is invalid. Display range and the color limit (percentile of |Δ| or a custom value) never change the numbers. **Download difference FITS** writes DIFFERENCE (float64, NaN where invalid, reference WCS, BUNIT, `DIFFDIR`, both observation IDs), MASK (0 valid, 1 invalid) and, when available, VARIANCE.
  - Real-pair result: `2025W24_1A_0514_1` minus `2025W21_2C_0280_1` (detector 2, MJy/sr) is reprojected (largest grid offset 0.488 pixel); 4,760 of 4,900 pixels are valid, 139 lie outside the target footprint and 1 is NaN in the reference. These cutouts carry no VARIANCE image, so the SNR is unavailable there. This is a plain pixel difference without PSF or background matching.
- **FITS Viewer** at `/tools/fits-viewer` reads local FITS files in the browser and exposes each HDU’s header cards. Image previews support uncompressed 2D arrays with up to 4,194,304 pixels, a 4,096-pixel axis limit, and BITPIX values of 8, 16, 32, −32, or −64. The display applies FITS scaling and a sampled grayscale stretch. [FITS standard](https://fits.gsfc.nasa.gov/fits_standard.html)

The FITS example preserves the primary and IMAGE HDUs of SPHEREx QR2 observation `2025W21_2C_0280_1`, detector 2, from a 0.12° IRSA cutout. The directory thumbnail is a grayscale rendering of that image. [Original IRSA cutout](https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/2025W21_2C/l2b-v20-2025-250/2/level2_2025W21_2C_0280_1D2_spx_l2b-v20-2025-250.fits?center=156.09328159,-41.64466331&size=0.12)

## Tests

```sh
node --test
```

`tests/wcs.test.mjs` checks `tools/wcs.js` against an independent JavaScript implementation and, when Python with Astropy is installed (set `ASTRONOT_PYTHON` to choose the interpreter), against Astropy WCS on the real SPHEREx example and synthetic headers. Without Astropy those comparisons are reported as skipped. `tests/difference.test.mjs` covers `tools/difference.js` (direction, units, variance, grid decisions, reprojection, invalid pixels, background, FITS export) with synthetic arrays and the real pair; with Python that has astropy and reproject (`ASTRONOT_PYTHON`) it also compares the reprojection with `reproject_interp` and reads the export back with astropy, otherwise those checks are skipped. `tests/pair.test.mjs` covers `tools/pair.js` (observation time, overlap, grid check, duplicates, link/blink decisions, view maths, alignment, wavelength lookup) with synthetic headers and with the real example pair.

## Image credits

The Explore and Learn captions show the original image credits. The Hubble images are covered by the [ESA/Hubble CC BY 4.0 terms](https://esahubble.org/copyright/).

- Whirlpool Galaxy. NASA, ESA, S. Beckwith (STScI), and the Hubble Heritage Team (STScI/AURA). [ESA/Hubble image](https://esahubble.org/images/heic0506a/)
- Orion Nebula. NASA, ESA, M. Robberto (STScI/ESA), and the Hubble Space Telescope Orion Treasury Project Team. [ESA/Hubble image](https://esahubble.org/images/heic0601a/)
- A Farewell to Saturn. NASA/JPL-Caltech/Space Science Institute. [NASA image](https://science.nasa.gov/resource/a-farewell-to-saturn-2/) · [NASA media guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/)
- M51 in visible light. NASA, ESA, S. Beckwith (STScI), and the Hubble Heritage Team (STScI/AURA). Resized for the web. [ESA/Hubble image](https://esahubble.org/images/opo1103c/)
- M51 dust map. NASA, ESA, M. Regan and B. Whitmore (STScI), and R. Chandar (University of Toledo, USA). Resized for the web. [ESA/Hubble image](https://esahubble.org/images/opo1103b/)
- SPHEREx’s Dust Cloud Reveal. NASA/JPL-Caltech. The directory displays a grayscale preview. [NASA Photojournal](https://science.nasa.gov/photojournal/spherexs-dust-cloud-reveal/)

Inter is distributed under the [SIL Open Font License](assets/Inter-OFL.txt).

### Hero artwork

The spiral galaxy in `assets/spiral-galaxy.jpg` was generated with ImageGen. Its prompt was

> Use case: photorealistic-natural. Create a square, full-resolution astrophotography texture for an animated website hero. One magnificent loosely wound spiral galaxy, seen perfectly face-on, alone against absolutely black space. Its tiny luminous warm ivory nucleus is exactly at the center of the square, with braided charcoal dust lanes, blue-white star clouds, and sparse pale rose nebulae along two long asymmetrical arms. The visual should feel like a finely resolved deep-space telescope exposure with detailed grain and deep blacks, a concentrated white-gold heart and muted cool blue arms. The galaxy fills roughly 85% of the square, and the faint outer arms naturally fade to pure black on all edges. The empty background is pure black, with almost no detached stars. No text, symbols, diffraction spikes, frame, planets, duplicate galaxies or clouds separate from the arms.
