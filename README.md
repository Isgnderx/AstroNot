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
  - `/tools/spectrum` — Spectrum Lab
  - `/tools/motion` — Motion Detector
- `/explore` — Public discovery
- `/learn` — Educational content
- `/about` — Mission and team

## Scientific Tools

The four featured tools have read-only workspace previews and are marked Coming Soon. The directory enables launches for Observation Search and FITS Viewer. Previous landing anchors and workspace query links continue to open their matching content.

- **Observation Search** at `/tools/observation-search` converts ICRS coordinates, UTC dates, and wavelengths into an IRSA SIA query for SPHEREx Quick Release 2. The generated link opens the archive’s CSV results. [IRSA SIA reference](https://irsa.ipac.caltech.edu/ibe/sia.html)
- **FITS Viewer** at `/tools/fits-viewer` reads local FITS files in the browser and exposes each HDU’s header cards. Image previews support uncompressed 2D arrays with up to 4,194,304 pixels, a 4,096-pixel axis limit, and BITPIX values of 8, 16, 32, −32, or −64. The display applies FITS scaling and a sampled grayscale stretch. [FITS standard](https://fits.gsfc.nasa.gov/fits_standard.html)

The FITS example preserves the primary and IMAGE HDUs of SPHEREx QR2 observation `2025W21_2C_0280_1`, detector 2, from a 0.12° IRSA cutout. The directory thumbnail is a grayscale rendering of that image. [Original IRSA cutout](https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/2025W21_2C/l2b-v20-2025-250/2/level2_2025W21_2C_0280_1D2_spx_l2b-v20-2025-250.fits?center=156.09328159,-41.64466331&size=0.12)

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
