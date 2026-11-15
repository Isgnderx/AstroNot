// Time Machine sequences: one sky position seen on many dates. DOM-free model behind the Time Machine's archive mode.
//
// UI-independent: no DOM access. Loads as a classic browser script (global `AstroNotTimeSequence`) and as a CommonJS module in
// node tests. Network access goes only through the byte sources of tools/fits-range.js (HTTP Range reads from IRSA's public S3
// bucket, which sends CORS headers) and, for the search, through a fetch the caller passes in.
//
// WHAT IT DOES
//   1. Search: builds the IRSA SIA request for a position (SPHEREx DR1/QR3, wide or deep fields). IRSA's SIA service sends no CORS
//      headers, so the page asks the site's own /api/sia proxy (functions/api/sia.js, also served by serve.mjs) and falls back to
//      the IRSA link + CSV import of Observation Search when that proxy is absent (static hosts, file://).
//   2. Sequence: keeps one detector, orders its frames by time and groups them by UTC day, by visit (gaps of more than 20 days) or
//      not at all, then picks one frame per group. "Hold one wavelength" picks, in each group, the frame whose wavelength at the
//      target is closest to a reference wavelength (within a tolerance) and skips groups with none; SPHEREx's linear variable
//      filter means the same star is seen at a different wavelength in every exposure, so without this, brightness changes in an
//      animation are mostly wavelength changes. Groups are scanned lazily: only as many as the current page needs.
//   3. Frames: for each picked frame, reads the IMAGE header and only the image rows that cover the field (about 1 MB instead of
//      the 70 MB file), then resamples them onto one north-up, east-left gnomonic grid centred on the target. Every frame of a
//      sequence lands on that same grid, so they can be shown as an animation. Resampling is bilinear and leaves NaN where the
//      frame has no data; values stay in the file's unit (MJy/sr). This is a display product, not a calibrated reprojection.
//
// Pixel conventions: frame pixels are 0-based (as in forced-phot.js createTanSip). Grid pixels are 0-based with x to the right
// (west) and y downward (south), i.e. canvas order with north up and east left.
(function (root) {
  "use strict";

  const cjs = typeof module === "object" && module.exports;
  const rangeLib = cjs ? require("./fits-range.js") : root.AstroNotFitsRange;
  const forced = cjs ? require("./forced-phot.js") : root.AstroNotForcedPhot;

  const D2R = Math.PI / 180;
  const PAGE_SIZE = 6;
  const VISIT_GAP_DAYS = 20;
  const SEARCH_RADIUS_DEG = 0.0003; // ~1 arcsec: frames that contain the position itself
  const FIELD_MIN_DEG = 0.02;
  const FIELD_MAX_DEG = 0.6;
  const GRID_SCALE_ARCSEC = 6.15; // SPHEREx native pixel scale
  const GRID_MAX_PIXELS = 400;
  const MAX_SIA_RECORDS = 10000;
  // Centre of each detector's band (µm): a SIA BAND window of ±0.005 µm there returns that detector's frames only.
  const detectorBandCentres = { 1: 0.92, 2: 1.36, 3: 2.02, 4: 3.12, 5: 4.12, 6: 4.71 };
  const SIA_URL = "https://irsa.ipac.caltech.edu/SIA";

  // SIA collections that can be searched (QR2 answers with no rows since 2026-11-14; see tools/observation-csv.js).
  const collections = {
    dr1: { collection: "spherex_dr1", label: "SPHEREx DR1" },
    qr3: { collection: "spherex_qr3", label: "SPHEREx QR3" },
    dr1_deep: { collection: "spherex_dr1_deep", label: "SPHEREx DR1 deep fields" },
    qr3_deep: { collection: "spherex_qr3_deep", label: "SPHEREx QR3 deep fields" },
  };
  const collectionNames = new Set(Object.values(collections).map((c) => c.collection));

  // Nominal detector bands (SPHEREx explanatory supplement; the per-pixel value comes from each file's WCS-WAVE table).
  const detectorBands = { 1: [0.75, 1.09], 2: [1.1, 1.62], 3: [1.63, 2.41], 4: [2.42, 3.82], 5: [3.83, 4.41], 6: [4.42, 5.0] };

  const samplings = new Set(["day", "visit", "all"]);

  // ---- Input ---------------------------------------------------------------------------------------------------------------------
  // Decimal degrees, or sexagesimal "hh:mm:ss.s" / "hh mm ss" for RA (hours) and "±dd:mm:ss" for Dec. Returns NaN when unreadable.
  function parseAngle(text, kind) {
    const s = String(text ?? "").trim();
    if (s === "") return NaN;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return Number(s);
    const m = /^([+-])?\s*(\d{1,3})[\s:hd°]+(\d{1,2})[\s:m′']+(\d{1,2}(?:\.\d*)?)\s*[s″"]?$/i.exec(s);
    if (!m) return NaN;
    const [a, b, c] = [Number(m[2]), Number(m[3]), Number(m[4])];
    if (b >= 60 || c >= 60) return NaN;
    const value = a + b / 60 + c / 3600;
    if (kind === "ra") return m[1] === "-" ? NaN : value * 15;
    return m[1] === "-" ? -value : value;
  }

  // Validate a search. `release` is a key of `collections`. Returns { ok: true, query } or { ok: false, message }.
  function parseQuery({ ra, dec, release, field, detector }) {
    const r = parseAngle(ra, "ra");
    const d = parseAngle(dec, "dec");
    if (!Number.isFinite(r) || r < 0 || r >= 360) return { ok: false, message: "Enter an RA from 0 to 360 degrees (or hh:mm:ss)." };
    if (!Number.isFinite(d) || d < -90 || d > 90) return { ok: false, message: "Enter a Dec from −90 to +90 degrees (or ±dd:mm:ss)." };
    if (!Object.hasOwn(collections, release)) return { ok: false, message: "Choose a data release." };
    const f = Number(field);
    if (!Number.isFinite(f) || f < FIELD_MIN_DEG || f > FIELD_MAX_DEG) {
      return { ok: false, message: "The field size must be " + FIELD_MIN_DEG + "° to " + FIELD_MAX_DEG + "°." };
    }
    const det = detector === undefined || detector === null || detector === "" ? null : Number(detector);
    if (det !== null && !Object.hasOwn(detectorBandCentres, det)) return { ok: false, message: "Choose a detector from 1 to 6." };
    return { ok: true, query: { ra: r, dec: d, release, collection: collections[release].collection, fieldDeg: f, detector: det } };
  }

  function detectorBand(detector) {
    const c = detectorBandCentres[detector];
    return (c - 0.005) * 1e-6 + " " + (c + 0.005) * 1e-6;
  }

  // The IRSA SIA request for one position (CSV), optionally for one detector. Same request functions/api/sia.js builds on the
  // server side (tests/time-sequence.test.mjs checks that the two agree).
  function irsaSiaUrl({ collection, ra, dec, detector = null, radius = SEARCH_RADIUS_DEG }) {
    const url = new URL(SIA_URL);
    url.searchParams.set("COLLECTION", collection);
    url.searchParams.set("POS", "CIRCLE " + ra + " " + dec + " " + radius);
    if (detector !== null) url.searchParams.set("BAND", detectorBand(detector));
    url.searchParams.set("RESPONSEFORMAT", "CSV");
    url.searchParams.set("MAXREC", String(MAX_SIA_RECORDS));
    return url.href;
  }

  // The site's proxy URL for the same request. `base` is the absolute URL of /api/sia.
  function proxySiaUrl(base, { collection, ra, dec, detector = null }) {
    const url = new URL(base);
    url.searchParams.set("collection", collection);
    url.searchParams.set("ra", String(ra));
    url.searchParams.set("dec", String(dec));
    if (detector !== null) url.searchParams.set("detector", String(detector));
    return url.href;
  }

  // ---- Frames and sequences -----------------------------------------------------------------------------------------------------
  // Frames from parsed IRSA rows (tools/observation-csv.js parseIrsaResults). Rows that are not SPHEREx level-2 FITS on IRSA are
  // dropped. Each frame carries its S3 URL (forced-phot.js frameFromImportRow) plus what the sequence needs.
  function framesFromRows(rows) {
    const frames = [];
    const seen = new Set();
    for (const row of rows) {
      const f = forced.frameFromImportRow(row);
      if (!f || seen.has(f.uri)) continue;
      seen.add(f.uri);
      frames.push({ ...f, obsId: row.obsId, mjdEnd: typeof row.end === "number" ? row.end : NaN });
    }
    return frames;
  }

  function countByDetector(frames) {
    const counts = {};
    for (const f of frames) if (Number.isInteger(f.detector)) counts[f.detector] = (counts[f.detector] ?? 0) + 1;
    return counts;
  }

  // One detector's frames in time order, grouped: "day" = one UTC day, "visit" = runs without a gap of more than 20 days,
  // "all" = every frame on its own. Frames without a start time cannot be ordered and are left out (counted in `undated`).
  function groupFrames(frames, { detector, sampling = "day" } = {}) {
    if (!samplings.has(sampling)) throw new Error("unknown sampling " + sampling);
    const own = frames.filter((f) => f.detector === detector);
    const dated = own.filter((f) => Number.isFinite(f.mjd)).sort((a, b) => a.mjd - b.mjd || (a.obsId < b.obsId ? -1 : 1));
    const groups = [];
    for (const f of dated) {
      const last = groups[groups.length - 1];
      const prev = last && last.frames[last.frames.length - 1];
      const same =
        last &&
        (sampling === "day" ? Math.floor(f.mjd) === Math.floor(last.frames[0].mjd) : sampling === "visit" ? f.mjd - prev.mjd <= VISIT_GAP_DAYS : false);
      if (same) last.frames.push(f);
      else groups.push({ frames: [f] });
    }
    return { groups, undated: own.length - dated.length };
  }

  // A lazily filled sequence: one pick per group, in time order. `choose(group, signal)` resolves to an item or null (the group has
  // no usable frame). `ensure(n)` scans groups until n items exist or the groups run out, `parallel` groups at a time (results are
  // kept in group order).
  function createSequence(groups, choose, { parallel = 3 } = {}) {
    const items = [];
    let next = 0;
    let skipped = 0;
    let running = null;

    async function scan(count, signal, onProgress) {
      while (items.length < count && next < groups.length) {
        if (signal && signal.aborted) throw signal.reason ?? new Error("aborted");
        const batch = groups.slice(next, next + parallel);
        next += batch.length;
        const picked = await Promise.all(batch.map((g) => choose(g, signal)));
        for (const item of picked) {
          if (item) items.push(item);
          else skipped++;
        }
        if (onProgress) onProgress(seq);
      }
    }

    const seq = {
      items,
      get scanned() { return next; },
      get skipped() { return skipped; },
      get total() { return groups.length; },
      get done() { return next >= groups.length; },
      // Serialised: a second call waits for the first, so items stay in time order.
      ensure(count, { signal, onProgress } = {}) {
        const run = (running ?? Promise.resolve()).catch(() => {}).then(() => scan(count, signal, onProgress));
        running = run;
        return run;
      },
    };
    return seq;
  }

  function pageCount(seq, size = PAGE_SIZE) {
    return Math.max(1, Math.ceil(seq.items.length / size));
  }

  // ---- Remote frame access ----------------------------------------------------------------------------------------------------
  // Shared state for one search: the IMAGE-header layout memo (forced-phot.js imageHdu) and one wavelength table per detector and
  // spectral-WCS calibration (the WCS-WAVE table is the same for every frame that records the same calibration UUID).
  function createContext({ sourceFor = (frame) => rangeLib.createHttpSource(frame.url) } = {}) {
    return { sourceFor, layouts: new Map(), waveTables: new Map(), headers: new Map() };
  }

  // The frame's IMAGE HDU, its WCS and the target pixel. The header and WCS are read once per frame and cached; the target pixel
  // is computed per call, so one context can serve any position.
  async function frameHeader(ctx, frame, target) {
    if (!ctx.headers.has(frame.uri)) {
      const p = (async () => {
        const source = ctx.sourceFor(frame);
        const image = await forced.imageHdu(source, frame, { layouts: ctx.layouts });
        if (image.name !== "IMAGE") throw new Error("second HDU is " + image.name + ", not IMAGE");
        const h = image.header;
        return { source, image, wcs: forced.createTanSip(h.cards), width: h.int("NAXIS1"), height: h.int("NAXIS2") };
      })();
      ctx.headers.set(frame.uri, p);
      p.catch(() => ctx.headers.delete(frame.uri));
    }
    const head = await ctx.headers.get(frame.uri);
    const [x, y] = head.wcs.worldToPix(target.ra, target.dec);
    return { ...head, x, y };
  }

  // Wavelength and bandwidth (µm) at the target pixel, from the frame's WCS-WAVE table, evaluated as forced-phot.js measureFrame
  // does by default (parent-frame pixel, no SIP; IRSA's convention). The table is read once per detector and calibration.
  async function waveAt(ctx, head) {
    const h = head.image.header;
    const key = (h.get("DETECTOR") ?? "?") + ":" + (h.calibId ? h.calibId("spectral_wcs") ?? "" : "");
    if (!ctx.waveTables.has(key)) {
      const p = (async () => {
        const tail = await rangeLib.walkHdus(head.source, { offset: head.image.end, until: "WCS-WAVE", max: 6 });
        const hdu = tail.find((t) => t.name === "WCS-WAVE");
        if (!hdu) throw new Error("frame has no WCS-WAVE extension");
        const t = rangeLib.createBinTable(hdu.header, await rangeLib.readTableBytes(head.source, hdu));
        return forced.createWaveTable(t.get(0, "X"), t.get(0, "Y"), t.get(0, "VALUES"));
      })();
      ctx.waveTables.set(key, p);
      p.catch(() => ctx.waveTables.delete(key));
    }
    const table = await ctx.waveTables.get(key);
    const px = head.x + 1 - h.num("CRPIX1A", 1);
    const py = head.y + 1 - h.num("CRPIX2A", 1);
    const [wavelength, bandwidth] = table.withoutSip().eval(px, py, [1, 1]);
    return { wavelength, bandwidth };
  }

  // Distance (pixels) from the target to the nearest frame edge; negative when the target is off the frame.
  function edgeMargin(head) {
    return Math.min(head.x + 0.5, head.y + 0.5, head.width - 0.5 - head.x, head.height - 0.5 - head.y);
  }

  // A chooser for createSequence. mode "any": the first frame of each group, without any read. mode "wavelength": the frame closest
  // to a reference wavelength, accepted only within `tolerance` bandwidths of it, and a group with none is skipped. The reference
  // is `reference` µm when given; otherwise it is chosen on the first `calibrate` groups as the candidate wavelength, inside the
  // detector's nominal band, that the most of those groups can match (ties: the earliest), so the sequence keeps as many dates as
  // possible. Frames whose target lies within
  // `margin` pixels of the edge are used only when no roomier frame of the group matches. `groups` are the sequence's groups (needed
  // for the calibration); `onCalibrate` reports progress.
  function createChooser(ctx, target, { mode = "any", reference = null, tolerance = 1, margin = 0, groups = [], calibrate = 12 } = {}) {
    const state = { reference, tolerance, mode, calibratedOn: 0 };
    if (mode === "any") return Object.assign(async (group) => ({ frame: group.frames[0], group }), { state });
    if (mode !== "wavelength") throw new Error("unknown mode " + mode);

    const cache = new Map(); // group -> Promise<candidates>
    const candidates = (group) => {
      if (!cache.has(group)) {
        cache.set(
          group,
          Promise.all(
            group.frames.map(async (frame) => {
              try {
                const head = await frameHeader(ctx, frame, target);
                if (edgeMargin(head) < 0) return null;
                const w = await waveAt(ctx, head);
                return { frame, ...w, margin: edgeMargin(head) };
              } catch {
                return null; // an unreadable frame is not a candidate
              }
            })
          ).then((list) => list.filter(Boolean))
        );
      }
      return cache.get(group);
    };
    const matches = (c, ref) => Math.abs(c.wavelength - ref) <= state.tolerance * c.bandwidth;

    let calibration = null;
    function calibrateReference() {
      if (!calibration) {
        calibration = (async () => {
          const window = groups.slice(0, Math.max(1, calibrate));
          const lists = await Promise.all(window.map(candidates));
          // Only wavelengths inside the detector's nominal band are reference candidates: past the band edges the filter's response
          // falls off and the calibrated image shows a dark arc (an iso-wavelength contour). Edge values are used only when no other
          // candidate exists.
          const all = lists.flat();
          const inside = all.filter((c) => {
            const band = detectorBands[c.frame.detector];
            return band ? c.wavelength >= band[0] && c.wavelength <= band[1] : true;
          });
          let best = null;
          for (const c of inside.length ? inside : all) {
            const n = lists.filter((other) => other.some((o) => matches(o, c.wavelength))).length;
            if (!best || n > best.n) best = { wavelength: c.wavelength, n };
          }
          state.calibratedOn = window.length;
          if (best) state.reference = best.wavelength;
        })();
      }
      return calibration;
    }

    const chooser = async (group) => {
      if (state.reference === null) await calibrateReference();
      const list = await candidates(group);
      if (state.reference === null) {
        // no group in the calibration window had a readable frame: take this group's first one
        if (list.length === 0) return null;
        state.reference = list[0].wavelength;
      }
      const near = list.filter((c) => matches(c, state.reference)).map((c) => ({ ...c, delta: Math.abs(c.wavelength - state.reference) }));
      if (near.length === 0) return null;
      const roomy = near.filter((c) => c.margin >= margin);
      const best = (roomy.length ? roomy : near).sort((a, b) => a.delta - b.delta)[0];
      return { frame: best.frame, group, wavelength: best.wavelength, bandwidth: best.bandwidth };
    };
    return Object.assign(chooser, { state });
  }

  // ---- The common grid ------------------------------------------------------------------------------------------------------
  // North-up, east-left gnomonic grid of `fieldDeg` on a side, centred on (ra, dec), at about the native pixel scale.
  function createGrid({ ra, dec, fieldDeg, scaleArcsec = GRID_SCALE_ARCSEC, maxPixels = GRID_MAX_PIXELS }) {
    const n = Math.max(16, Math.min(maxPixels, Math.round((fieldDeg * 3600) / scaleArcsec)));
    const s = fieldDeg / n; // degrees per grid pixel
    const c = (n - 1) / 2;
    const ra0 = ra * D2R;
    const dec0 = dec * D2R;
    const s0 = Math.sin(dec0);
    const c0 = Math.cos(dec0);

    // grid pixel -> (RA, Dec) degrees
    function pixToWorld(x, y) {
      const xi = -(x - c) * s * D2R; // x grows to the west
      const eta = -(y - c) * s * D2R; // y grows to the south
      const den = c0 - eta * s0;
      let r = (ra0 + Math.atan2(xi, den)) / D2R;
      r = ((r % 360) + 360) % 360;
      const d = Math.atan2(s0 + eta * c0, Math.sqrt(xi * xi + den * den)) / D2R;
      return [r, d];
    }

    // (RA, Dec) degrees -> grid pixel; null on the far hemisphere
    function worldToPix(r, d) {
      const a = r * D2R - ra0;
      const sd = Math.sin(d * D2R);
      const cd = Math.cos(d * D2R);
      const cosc = s0 * sd + c0 * cd * Math.cos(a);
      if (cosc <= 0) return null;
      const xi = (cd * Math.sin(a)) / cosc / D2R;
      const eta = (c0 * sd - s0 * cd * Math.cos(a)) / cosc / D2R;
      return [c - xi / s, c - eta / s];
    }

    return { ra, dec, fieldDeg, width: n, height: n, scaleDeg: s, scaleArcsec: s * 3600, center: c, pixToWorld, worldToPix };
  }

  // Frame-pixel coordinates of grid pixels. Exact (Newton, forced-phot.js createTanSip) on a mesh every `step` grid pixels and on
  // the last row/column, bilinear in between. Measured on a real TAN-SIP header: step 4 is within 4e-5 px of the exact inversion
  // (step 8: 1.4e-4 px, enough to shift a bright star's core pixels by ~1e-3 of their value) at a quarter of the cost of step 2.
  const MESH_STEP = 4;
  function frameCoordinates(frameWcs, grid, step = MESH_STEP) {
    const { width: w, height: h } = grid;
    const nodes = (len) => {
      const v = [];
      for (let i = 0; i < len - 1; i += step) v.push(i);
      v.push(len - 1);
      return v;
    };
    const xs = nodes(w);
    const ys = nodes(h);
    const mx = new Float64Array(xs.length * ys.length);
    const my = new Float64Array(xs.length * ys.length);
    ys.forEach((gy, j) =>
      xs.forEach((gx, i) => {
        const [r, d] = grid.pixToWorld(gx, gy);
        const [fx, fy] = frameWcs.worldToPix(r, d);
        mx[j * xs.length + i] = fx;
        my[j * xs.length + i] = fy;
      })
    );
    const fx = new Float64Array(w * h);
    const fy = new Float64Array(w * h);
    let j = 0;
    for (let y = 0; y < h; y++) {
      while (j < ys.length - 2 && y > ys[j + 1]) j++;
      const ty = ys.length > 1 ? (y - ys[j]) / (ys[j + 1] - ys[j]) : 0;
      let i = 0;
      for (let x = 0; x < w; x++) {
        while (i < xs.length - 2 && x > xs[i + 1]) i++;
        const tx = xs.length > 1 ? (x - xs[i]) / (xs[i + 1] - xs[i]) : 0;
        const k00 = j * xs.length + i;
        const k10 = k00 + 1;
        const k01 = k00 + xs.length;
        const k11 = k01 + 1;
        const bil = (m) => m[k00] * (1 - tx) * (1 - ty) + m[k10] * tx * (1 - ty) + m[k01] * (1 - tx) * ty + m[k11] * tx * ty;
        fx[y * w + x] = bil(mx);
        fy[y * w + x] = bil(my);
      }
    }
    return { fx, fy };
  }

  // Rows [y0, y0 + n) of a frame that hold the grid's footprint (one extra row each side for bilinear sampling), or null when the
  // grid misses the frame.
  function rowWindow(coords, frameWidth, frameHeight) {
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (let k = 0; k < coords.fx.length; k++) {
      const x = coords.fx[k];
      const y = coords.fy[k];
      if (x < xmin) xmin = x;
      if (x > xmax) xmax = x;
      if (y < ymin) ymin = y;
      if (y > ymax) ymax = y;
    }
    if (xmax < 0 || ymax < 0 || xmin > frameWidth - 1 || ymin > frameHeight - 1) return null;
    const y0 = Math.max(0, Math.floor(ymin) - 1);
    const y1 = Math.min(frameHeight - 1, Math.ceil(ymax) + 1);
    return { y0, n: y1 - y0 + 1 };
  }

  // Bilinear resampling of a row block (fits-range.js rowBlock) onto the grid. A grid pixel is NaN when its frame position lies
  // outside the rows read or the frame, or when any of the four frame pixels it needs is not finite.
  function resample(block, nrows, coords, frameWidth) {
    const out = new Float32Array(coords.fx.length);
    const { y0, width, data } = block;
    const xmax = Math.min(frameWidth, width) - 1;
    const ymax = nrows - 1;
    for (let k = 0; k < out.length; k++) {
      const x = coords.fx[k];
      const y = coords.fy[k] - y0;
      if (!(x >= 0 && y >= 0 && x <= xmax && y <= ymax)) {
        out[k] = NaN;
        continue;
      }
      // the last column/row is reached with weight 1 on it (tx or ty = 1 from the cell before)
      const ix = Math.min(Math.floor(x), xmax - 1);
      const iy = Math.min(Math.floor(y), ymax - 1);
      const tx = x - ix;
      const ty = y - iy;
      const a = data[iy * width + ix];
      const b = data[iy * width + ix + 1];
      const c = data[(iy + 1) * width + ix];
      const d = data[(iy + 1) * width + ix + 1];
      const v = a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
      out[k] = Number.isFinite(v) ? v : NaN;
    }
    return out;
  }

  function finiteFraction(values) {
    let n = 0;
    for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) n++;
    return values.length ? n / values.length : 0;
  }

  // Read one picked frame onto the grid. Returns { values, coverage, wavelength, bandwidth, meta, bytes } where meta holds the
  // header facts shown in the UI.
  async function loadFrame(ctx, item, grid, { signal, meshStep = MESH_STEP } = {}) {
    const target = { ra: grid.ra, dec: grid.dec };
    const head = await frameHeader(ctx, item.frame, target);
    if (signal && signal.aborted) throw signal.reason ?? new Error("aborted");
    const coords = frameCoordinates(head.wcs, grid, meshStep);
    const win = rowWindow(coords, head.width, head.height);
    const h = head.image.header;
    const text = (key) => (h.get(key) === undefined ? "" : String(h.get(key)).trim());
    const meta = {
      obsId: text("OBSID") || item.frame.obsId,
      detector: h.num("DETECTOR", item.frame.detector),
      dateObs: text("DATE-OBS"),
      mjd: h.num("MJD-AVG", h.num("MJD-OBS", item.frame.mjd)),
      exposure: h.num("TELAPSE", h.num("EXPTIME", NaN)),
      unit: text("BUNIT"),
      survey: text("SPS_FLAGS"),
      targetPixel: [head.x, head.y],
      edgeMargin: edgeMargin(head),
    };
    let wave = item.wavelength !== undefined ? { wavelength: item.wavelength, bandwidth: item.bandwidth } : null;
    if (!wave) {
      try {
        wave = edgeMargin(head) >= 0 ? await waveAt(ctx, head) : { wavelength: NaN, bandwidth: NaN };
      } catch {
        wave = { wavelength: NaN, bandwidth: NaN };
      }
    }
    if (!win) {
      return { values: new Float32Array(grid.width * grid.height).fill(NaN), coverage: 0, ...wave, meta, bytes: 0 };
    }
    const block = await rangeLib.readRows(head.source, head.image, win.y0, win.n);
    const values = resample(block, win.n, coords, head.width);
    return { values, coverage: finiteFraction(values), ...wave, meta, bytes: win.n * head.width * 4 };
  }

  // ---- Display --------------------------------------------------------------------------------------------------------------
  // Median of the finite values (sampled to at most `maxSamples`), or NaN when there are none. Used as the display offset that
  // removes each frame's own sky level (zodiacal light changes with date and detector position).
  function median(values, maxSamples = 50000) {
    const stride = Math.max(1, Math.floor(values.length / maxSamples));
    const s = [];
    for (let i = 0; i < values.length; i += stride) if (Number.isFinite(values[i])) s.push(values[i]);
    if (s.length === 0) return NaN;
    s.sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // [low, high] percentiles of the finite values of several images together (so one range serves a whole page of frames). Each
  // image may have an offset subtracted first (`offsets[i]`, 0 when absent).
  function sharedRange(images, lowPct = 0.5, highPct = 99.5, maxSamples = 200000, offsets = []) {
    let total = 0;
    for (const v of images) total += v.length;
    const stride = Math.max(1, Math.floor(total / maxSamples));
    const s = [];
    images.forEach((v, k) => {
      const o = offsets[k] || 0;
      for (let i = 0; i < v.length; i += stride) if (Number.isFinite(v[i])) s.push(v[i] - o);
    });
    if (s.length === 0) return null;
    s.sort((a, b) => a - b);
    const at = (p) => s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
    let lo = at(lowPct);
    let hi = at(highPct);
    if (!(hi > lo)) {
      lo = s[0];
      hi = s[s.length - 1];
    }
    return hi > lo ? [lo, hi] : [lo, lo + 1];
  }

  // 0..1 display level. "linear", "sqrt" or "asinh" (asinh(10t)/asinh(10): faint structure and bright cores both visible).
  function stretch(v, lo, hi, mode = "asinh") {
    let t = (v - lo) / (hi - lo);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    if (mode === "sqrt") return Math.sqrt(t);
    if (mode === "asinh") return Math.asinh(10 * t) / Math.asinh(10);
    return t;
  }

  // RGBA bytes for a canvas ImageData of `values - offset`: grey levels, NaN as a dark blue-grey so missing data is never mistaken
  // for black sky.
  function toRgba(values, range, mode, out, offset = 0) {
    const rgba = out ?? new Uint8ClampedArray(values.length * 4);
    const [lo, hi] = range ?? [0, 1];
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      const o = i * 4;
      if (!Number.isFinite(v)) {
        rgba[o] = 34;
        rgba[o + 1] = 38;
        rgba[o + 2] = 52;
      } else {
        const g = Math.round(255 * stretch(v - offset, lo, hi, mode));
        rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
      }
      rgba[o + 3] = 255;
    }
    return rgba;
  }

  // ---- Small formatting helpers shared by the UI and tests -----------------------------------------------------------------
  function mjdToIso(mjd) {
    if (!Number.isFinite(mjd)) return "";
    return new Date((mjd - 40587) * 86400000).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  // "183 d 7 h", "5 h 12 min", "3 min" — elapsed time between two MJDs.
  function formatElapsed(days) {
    if (!Number.isFinite(days)) return "";
    const sign = days < 0 ? "−" : "";
    let m = Math.round(Math.abs(days) * 1440);
    const d = Math.floor(m / 1440);
    m -= d * 1440;
    const h = Math.floor(m / 60);
    m -= h * 60;
    // Whole words, not "d" or "h" alone: the language catalogs match these as templates, and a
    // template needs a fixed part of at least four letters (assets/i18n/site-language.js).
    if (d > 0) return sign + d + (d === 1 ? " day " : " days ") + h + " h";
    if (h > 0) return sign + h + (h === 1 ? " hour " : " hours ") + m + " min";
    return sign + m + (m === 1 ? " minute" : " minutes");
  }

  const api = {
    PAGE_SIZE,
    VISIT_GAP_DAYS,
    SEARCH_RADIUS_DEG,
    FIELD_MIN_DEG,
    FIELD_MAX_DEG,
    GRID_SCALE_ARCSEC,
    MAX_SIA_RECORDS,
    collections,
    collectionNames,
    detectorBands,
    detectorBandCentres,
    detectorBand,
    parseAngle,
    parseQuery,
    irsaSiaUrl,
    proxySiaUrl,
    framesFromRows,
    countByDetector,
    groupFrames,
    createSequence,
    pageCount,
    createContext,
    frameHeader,
    waveAt,
    createChooser,
    createGrid,
    frameCoordinates,
    rowWindow,
    resample,
    finiteFraction,
    loadFrame,
    median,
    sharedRange,
    stretch,
    toRgba,
    mjdToIso,
    formatElapsed,
  };

  root.AstroNotTimeSequence = api;
  if (cjs) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);
