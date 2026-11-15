const fitsBlockSize = 2880;
const fitsCardSize = 80;
const fitsBitDepths = [8, 16, 32, 64, -32, -64];
const fitsMaxPixels = 4194304;
const fitsDecoder = new TextDecoder("ascii");

function fitsValue(card) {
  const source = card.slice(10).trimStart();
  if (source.startsWith("'")) {
    return /^'((?:''|[^'])*)'/.exec(source)?.[1].replaceAll("''", "'").trimEnd() ?? source;
  }
  const value = source.split("/", 1)[0].trim();
  if (value === "T" || value === "F") return value === "T";
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[DE][+-]?\d+)?$/i.test(value)) {
    return Number(value.replace(/d/i, "e"));
  }
  return value;
}

async function readFitsHeader(file, offset) {
  const fields = Object.create(null);
  const cards = [];
  for (let block = 0; block < 256 && offset + fitsBlockSize <= file.size; block++) {
    const next = offset + fitsBlockSize;
    const text = fitsDecoder.decode(await file.slice(offset, next).arrayBuffer());
    for (let start = 0; start < fitsBlockSize; start += fitsCardSize) {
      const card = text.slice(start, start + fitsCardSize);
      const key = card.slice(0, 8).trim();
      cards.push(card.trimEnd());
      if (key === "END") return { fields, cards, dataStart: next };
      if (key && card[8] === "=") fields[key] = fitsValue(card);
    }
    offset = next;
  }
  throw new Error("A complete FITS header could not be read.");
}

async function readFitsHdus(file) {
  if (file.size < fitsBlockSize || file.size % fitsBlockSize !== 0) {
    throw new Error("Choose an uncompressed FITS file with complete 2880-byte blocks.");
  }
  const signature = fitsDecoder.decode(await file.slice(0, 9).arrayBuffer());
  if (signature !== "SIMPLE  =") throw new Error("The file does not start with a FITS primary header.");

  const hdus = [];
  let offset = 0;
  while (offset < file.size) {
    if (hdus.length >= 1024) throw new Error("This file has more than 1,024 HDUs.");
    const { fields, cards, dataStart } = await readFitsHeader(file, offset);
    const primary = hdus.length === 0;
    if (primary ? fields.SIMPLE !== true : !cards[0].startsWith("XTENSION=")) {
      throw new Error("The file contains an invalid FITS HDU header.");
    }

    const bitpix = fields.BITPIX;
    const axisCount = fields.NAXIS;
    if (!fitsBitDepths.includes(bitpix) || !Number.isInteger(axisCount) || axisCount < 0 || axisCount > 999) {
      throw new Error("A FITS header has invalid BITPIX or NAXIS metadata.");
    }
    const axes = Array.from({ length: axisCount }, (_, index) => fields["NAXIS" + (index + 1)]);
    const groups = primary && fields.GROUPS === true;
    const parameters = primary && !groups ? 0 : fields.PCOUNT;
    const groupCount = primary && !groups ? 1 : fields.GCOUNT;
    if (axes.some((axis) => !Number.isSafeInteger(axis) || axis < 0) ||
        !Number.isSafeInteger(parameters) || parameters < 0 ||
        !Number.isSafeInteger(groupCount) || groupCount < 1) {
      throw new Error("A FITS HDU has invalid array dimensions.");
    }

    const arrayAxes = groups ? axes.slice(1) : axes;
    const pixels = arrayAxes.length ? arrayAxes.reduce((product, axis) => product * axis, 1) : 0;
    const byteLength = Math.abs(bitpix) / 8 * groupCount * (parameters + pixels);
    const next = dataStart + Math.ceil(byteLength / fitsBlockSize) * fitsBlockSize;
    if (!Number.isSafeInteger(next) || next > file.size) {
      throw new Error("The file ends before an HDU is complete.");
    }

    const image = (primary || fields.XTENSION === "IMAGE") && !groups &&
      parameters === 0 && groupCount === 1 && axes.length === 2 && pixels > 0;
    const renderable = image && bitpix !== 64 && pixels <= fitsMaxPixels && axes.every((axis) => axis <= 4096);
    hdus.push({
      name: primary ? "Primary" : fields.EXTNAME || fields.XTENSION || "Extension",
      fields, cards, axes, bitpix, pixels, dataStart, byteLength, image, renderable,
    });
    offset = next;
  }
  return hdus;
}

// ---- Optional WebAssembly accelerator (rust/crates/fitsdata, loaded by tools/wasm.js) -----------------------------------------
// Every function below stays synchronous and gives the same numbers with or without the kernel. The kernel is installed by
// AstroNotFits.useKernel() once tools/wasm/fitsdata.wasm(.js) has loaded; images read before that, images smaller than
// minPixels (the copy into wasm memory would cost more than it saves) and BITPIX 64 simply use the JavaScript loops.
const fitsEngine = { kernel: null, minPixels: 1 << 16, chunkPixels: 1 << 18, decode: true, shade: true, scratch: { input: null, output: null }, counters: { decode: 0, draw: 0 } };

function fitsSetEngineMarker() {
  // A data attribute (no visible change) so a page or a test can tell which engine is installed.
  if (typeof document === "object" && document.body && document.body.setAttribute) document.body.setAttribute("data-engine", fitsEngine.kernel ? "wasm" : "js");
}

function fitsUseKernel(kernel) {
  fitsEngine.scratch = { input: null, output: null };
  fitsEngine.kernel = null;
  if (kernel && kernel.exports && kernel.exports.fd_decode_f64 && kernel.exports.fd_shade_raw) {
    // Sanity check on a known value (-2.5 as a big-endian float32 with scale 2 and zero 1 gives -4) before trusting the module.
    fitsEngine.kernel = kernel;
    try {
      const bytes = new Uint8Array([0xC0, 0x20, 0, 0]);
      const out = new Float64Array(1);
      fitsKernelDecode(bytes.buffer, -32, 2, 1, undefined, 1, out);
      if (out[0] !== -4) fitsEngine.kernel = null;
    } catch {
      fitsEngine.kernel = null;
    }
  }
  fitsSetEngineMarker();
  return Boolean(fitsEngine.kernel);
}

// A scratch region in wasm memory that is reused by every call (and grows when needed): returns its address.
function fitsScratch(slot, bytes) {
  const current = fitsEngine.scratch[slot];
  if (current && current.bytes >= bytes) return current.ptr;
  if (current) fitsEngine.kernel.exports.an_free(current.ptr, current.bytes);
  const ptr = fitsEngine.kernel.exports.an_alloc(bytes);
  fitsEngine.scratch[slot] = { ptr, bytes };
  return ptr;
}

function fitsCalibration(hdu) {
  const scale = hdu.fields.BSCALE ?? 1;
  const zero = hdu.fields.BZERO ?? 0;
  const blank = hdu.bitpix > 0 ? hdu.fields.BLANK : undefined;
  if (!Number.isFinite(scale) || !Number.isFinite(zero)) throw new Error("The image has invalid FITS scaling metadata.");
  return { scale, zero, blank };
}

function fitsKernelUsable(bytes, hdu) {
  const bitpix = hdu.bitpix;
  return Boolean(fitsEngine.kernel) && fitsEngine.decode && hdu.pixels >= fitsEngine.minPixels &&
    (bitpix === 8 || bitpix === 16 || bitpix === 32 || bitpix === -32 || bitpix === -64) &&
    bytes.byteLength >= hdu.pixels * Math.abs(bitpix) / 8;
}

// Decodes `out.length` pixels (Float64Array or Float32Array) from `bytes` (the data of one HDU) through the kernel, in chunks
// so wasm memory stays small however large the image is.
function fitsKernelDecode(bytes, bitpix, scale, zero, blank, count, out) {
  const { exports } = fitsEngine.kernel;
  const width = Math.abs(bitpix) / 8;
  const chunk = Math.min(count, fitsEngine.chunkPixels);
  const input = fitsScratch("input", chunk * width);
  const output = fitsScratch("output", chunk * out.BYTES_PER_ELEMENT);
  const decode = out.BYTES_PER_ELEMENT === 4 ? exports.fd_decode_f32 : exports.fd_decode_f64;
  const source = new Uint8Array(bytes, 0, count * width);
  const hasBlank = typeof blank === "number" ? 1 : 0;
  for (let start = 0; start < count; start += chunk) {
    const length = Math.min(chunk, count - start);
    new Uint8Array(exports.memory.buffer, input, length * width).set(source.subarray(start * width, (start + length) * width));
    decode(input, length, bitpix, scale, zero, hasBlank, hasBlank ? blank : 0, output);
    out.set(new out.constructor(exports.memory.buffer, output, length), start);
  }
  fitsEngine.counters.decode += count;
}

// The one-pixel reader: BSCALE and BZERO are applied here, BLANK becomes NaN. This is the reference implementation.
function fitsScalarReader(bytes, hdu) {
  const view = new DataView(bytes);
  const bitpix = hdu.bitpix;
  const byteCount = Math.abs(bitpix) / 8;
  const getters = { 8: "getUint8", 16: "getInt16", 32: "getInt32", "-32": "getFloat32", "-64": "getFloat64" };
  const getter = getters[bitpix];
  const { scale, zero, blank } = fitsCalibration(hdu);
  return (index) => {
    const raw = view[getter](index * byteCount, false);
    return raw === blank ? NaN : raw * scale + zero;
  };
}

function fitsPixelReader(bytes, hdu) {
  const read = fitsScalarReader(bytes, hdu);
  if (!fitsKernelUsable(bytes, hdu)) return read;
  // A large image: the first read decodes the whole array through the kernel, later reads are plain array lookups.
  const { scale, zero, blank } = fitsCalibration(hdu);
  let decoded = null;
  return (index) => {
    if (!decoded) {
      decoded = new Float64Array(hdu.pixels);
      fitsKernelDecode(bytes, hdu.bitpix, scale, zero, blank, hdu.pixels, decoded);
    }
    return index >= 0 && index < decoded.length ? decoded[index] : read(index);
  };
}

// All pixels of an image HDU as a Float64Array (or Float32Array), calibrated like fitsPixelReader: the loop
// `for (i...) values[i] = read(i)` that every tool runs, done by the kernel when it is installed and the image is large.
function fitsReadValues(bytes, hdu, Type = Float64Array) {
  const values = new Type(hdu.pixels);
  if (fitsKernelUsable(bytes, hdu) && (Type === Float64Array || Type === Float32Array)) {
    const { scale, zero, blank } = fitsCalibration(hdu);
    fitsKernelDecode(bytes, hdu.bitpix, scale, zero, blank, hdu.pixels, values);
    return values;
  }
  const read = fitsScalarReader(bytes, hdu);
  for (let index = 0; index < values.length; index++) values[index] = read(index);
  return values;
}

// Shades the whole image into `data` (the RGBA bytes of an ImageData) with the kernel, in bands of rows.
function fitsKernelShade(bytes, hdu, data, divisor, lowOverDivisor, span) {
  const { exports } = fitsEngine.kernel;
  const [width, height] = hdu.axes;
  const bytesPer = Math.abs(hdu.bitpix) / 8;
  const { scale, zero, blank } = fitsCalibration(hdu);
  const hasBlank = typeof blank === "number" ? 1 : 0;
  const bandRows = Math.max(1, Math.min(height, Math.floor(fitsEngine.chunkPixels / width)));
  const input = fitsScratch("input", bandRows * width * bytesPer);
  const output = fitsScratch("output", bandRows * width * 4);
  const source = new Uint8Array(bytes, 0, width * height * bytesPer);
  for (let first = 0; first < height; first += bandRows) {
    const rows = Math.min(bandRows, height - first);
    new Uint8Array(exports.memory.buffer, input, rows * width * bytesPer).set(source.subarray(first * width * bytesPer, (first + rows) * width * bytesPer));
    exports.fd_shade_raw(input, width, rows, hdu.bitpix, scale, zero, hasBlank, hasBlank ? blank : 0, divisor, lowOverDivisor, span, output);
    // Band rows first..first+rows-1 of the FITS array land on canvas rows height-first-rows .. height-first-1.
    data.set(new Uint8ClampedArray(exports.memory.buffer, output, rows * width * 4), (height - first - rows) * width * 4);
  }
  fitsEngine.counters.draw += width * height;
}

function drawFitsImage(canvas, bytes, hdu) {
  const [width, height] = hdu.axes;
  const read = fitsScalarReader(bytes, hdu); // Only ~16,000 samples are read here, so no whole-image decode.
  const samples = [];
  const stride = Math.max(1, Math.ceil(hdu.pixels / 16384));
  for (let index = 0; index < hdu.pixels; index += stride) {
    const value = read(index);
    if (Number.isFinite(value)) samples.push(value);
  }
  if (samples.length === 0 && stride > 1) {
    for (let index = 0; index < hdu.pixels && samples.length < 16384; index++) {
      const value = read(index);
      if (Number.isFinite(value)) samples.push(value);
    }
  }
  if (samples.length === 0) throw new Error("This image has no finite pixels to display.");
  samples.sort((a, b) => a - b);
  const last = samples.length - 1;
  let low = samples[Math.floor(last * 0.01)];
  let high = samples[Math.floor(last * 0.99)];
  if (low === high) {
    low = samples[0];
    high = samples[last];
  }

  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser could not allocate the image preview.");
  const image = context.createImageData(width, height);
  const divisor = Number.isFinite(high - low) ? 1 : 2;
  const span = high / divisor - low / divisor;
  if (fitsKernelUsable(bytes, hdu) && fitsEngine.shade) {
    fitsKernelShade(bytes, hdu, image.data, divisor, low / divisor, span);
  } else {
    for (let y = 0; y < height; y++) {
      // FITS axis 2 begins at the bottom of the displayed image.
      const sourceRow = (height - y - 1) * width;
      for (let x = 0; x < width; x++) {
        const value = read(sourceRow + x);
        const shade = Number.isFinite(value) ? (span === 0 ? 128 : 255 * (value / divisor - low / divisor) / span) : 0;
        const output = (y * width + x) * 4;
        image.data[output] = image.data[output + 1] = image.data[output + 2] = shade;
        image.data[output + 3] = 255;
      }
    }
  }
  context.putImageData(image, 0, 0);
}

function setupFitsViewer() {
  const fileInput = document.querySelector("[data-fits-file]");
  const exampleButton = document.querySelector("[data-fits-example]");
  const status = document.querySelector("[data-fits-status]");
  const metadata = document.querySelector("[data-fits-metadata]");
  const filename = document.querySelector("[data-fits-filename]");
  const select = document.querySelector("[data-fits-hdu]");
  const facts = document.querySelector("[data-fits-facts]");
  const header = document.querySelector("[data-fits-header]");
  const provenance = document.querySelector("[data-fits-provenance]");
  const viewport = document.querySelector("[data-fits-viewport]");
  const empty = document.querySelector("[data-fits-empty]");
  const canvas = document.querySelector("[data-fits-canvas]");
  const caption = document.querySelector("[data-fits-caption]");
  const zoomLabel = document.querySelector("[data-fits-zoom-label]");
  const zoom = document.querySelector("[data-fits-zoom]");
  let currentFile;
  let hdus;
  let fileVersion = 0;
  let previewVersion = 0;
  let example;

  function setStatus(message, error = false) {
    status.toggleAttribute("data-error", error);
    status.textContent = message;
  }

  function showEmpty(message) {
    canvas.hidden = true;
    caption.hidden = true;
    zoomLabel.hidden = true;
    empty.querySelector("p").textContent = message;
    empty.hidden = false;
  }

  function setZoom() {
    const fit = zoom.value === "fit";
    viewport.toggleAttribute("data-zoomed", !fit);
    canvas.style.width = fit ? "" : canvas.width * Number(zoom.value) + "px";
    canvas.style.height = fit ? "" : canvas.height * Number(zoom.value) + "px";
    viewport.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }

  function renderFacts(hdu) {
    const rows = [
      ["Axis sizes", hdu.axes.length ? hdu.axes.join(" × ") : "—"],
      ["BITPIX", hdu.bitpix],
      ["Units", hdu.fields.BUNIT || "—"],
    ];
    if (hdu.fields.OBSID) rows.push(["Observation", hdu.fields.OBSID]);
    facts.replaceChildren(...rows.map(([label, value]) => {
      const row = document.createElement("div");
      const term = document.createElement("dt");
      const detail = document.createElement("dd");
      term.textContent = label;
      detail.setAttribute("translate", "no");
      detail.textContent = value;
      row.append(term, detail);
      return row;
    }));
    header.setAttribute("translate", "no");
    header.textContent = hdu.cards.join("\n");
  }

  function hduProblem(hdu) {
    if (!hdu.image) return "This HDU is not an uncompressed 2D image, so no pixels are shown. The header is available in File metadata.";
    if (hdu.bitpix === 64) return "This image uses 64-bit integers (BITPIX 64), which the preview does not read. The header is available in File metadata.";
    return "This image exceeds the preview limits (" + fitsMaxPixels.toLocaleString("en-US") + " pixels, 4,096 per axis). The header is available in File metadata.";
  }

  // announce: the person changed the HDU, so say what is shown. The first HDU of a new file keeps the "loaded" status.
  async function showHdu(announce = false) {
    const version = ++previewVersion;
    const hdu = hdus[Number(select.value)];
    renderFacts(hdu);
    if (!hdu.renderable) {
      const problem = hduProblem(hdu);
      showEmpty(problem);
      setStatus("HDU " + select.value + " (" + hdu.name + ") cannot be displayed. " + problem, true);
      return;
    }

    showEmpty("Reading image pixels…");
    try {
      const bytes = await currentFile.slice(hdu.dataStart, hdu.dataStart + hdu.byteLength).arrayBuffer();
      if (version !== previewVersion) return;
      drawFitsImage(canvas, bytes, hdu);
      const dimensions = hdu.axes.join(" × ");
      canvas.setAttribute("aria-label", "Grayscale preview of " + hdu.name + ", " + dimensions + " pixels");
      caption.textContent = "Grayscale display stretch · Undefined pixels shown in black";
      empty.hidden = true;
      canvas.hidden = false;
      zoomLabel.hidden = false;
      caption.hidden = false;
      zoom.value = "fit";
      setZoom();
      if (announce === true) setStatus("Showing HDU " + select.value + " (" + hdu.name + "), " + dimensions + " pixels.");
    } catch (error) {
      if (version === previewVersion) {
        showEmpty(error.message);
        setStatus("HDU " + select.value + " (" + hdu.name + ") cannot be displayed. " + error.message, true);
      }
    }
  }

  async function openFits(source, isExample = false) {
    const version = ++fileVersion;
    previewVersion++;
    const name = source instanceof File ? source.name : "The SPHEREx example";
    metadata.hidden = true;
    document.dispatchEvent(new CustomEvent("fits-opening"));
    showEmpty("Reading FITS headers…");
    setStatus("Reading FITS headers…");
    try {
      const file = await source;
      if (version !== fileVersion) return;
      const parsed = await readFitsHdus(file);
      if (version !== fileVersion) return;

      currentFile = file;
      hdus = parsed;
      filename.setAttribute("translate", "no");
      filename.textContent = file.name;
      select.replaceChildren(...hdus.map((hdu, index) => new Option(index + " · " + hdu.name, index)));
      const image = hdus.findIndex((hdu) => hdu.renderable && hdu.fields.EXTNAME === "IMAGE");
      select.selectedIndex = image >= 0 ? image : Math.max(0, hdus.findIndex((hdu) => hdu.renderable));
      provenance.hidden = !isExample;
      metadata.hidden = false;
      setStatus(isExample ? "SPHEREx QR2 example loaded." : "FITS headers loaded.");
      document.dispatchEvent(new CustomEvent("fits-opened", { detail: { hdus, example: isExample } }));
      await showHdu();
    } catch (error) {
      if (version !== fileVersion) return;
      fileInput.value = "";
      setStatus(name + " could not be opened. " + error.message, true);
      showEmpty("No image is shown. Choose another FITS file or load the SPHEREx example.");
    }
  }

  function loadExample() {
    if (!example) {
      example = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = siteAsset("assets/tools/spherex-example.js");
        script.addEventListener("load", () => {
          try {
            const bytes = Uint8Array.from(atob(spherexExampleData), (character) => character.charCodeAt(0));
            resolve(new File([bytes], "SPHEREx-QR2-D2.fits"));
          } catch {
            reject(new Error("The example file could not be read."));
          }
        }, { once: true });
        script.addEventListener("error", () => reject(new Error("The example file could not be loaded.")), { once: true });
        document.head.append(script);
      }).catch((error) => {
        example = undefined;
        throw error;
      });
    }
    return example;
  }

  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) openFits(fileInput.files[0]);
  });
  exampleButton.addEventListener("click", () => {
    fileInput.value = "";
    openFits(loadExample(), true);
  });
  select.addEventListener("change", () => showHdu(true));
  zoom.addEventListener("change", setZoom);
  fileInput.disabled = false;
  exampleButton.disabled = false;
}

// Other pages (Sky Explorer, tests) and the engine worker (no document at all) load this file for the shared readers.
if (typeof document === "object" && document.querySelector("[data-fits-file]")) setupFitsViewer();

// Public hook for the Rust/WebAssembly kernel and for tests: AstroNotFits.useKernel(kernel | null), .kernel(), .engine(), .ready.
// The kernel is requested here, once, so every page that includes this file also loads it (tools/wasm.js and
// tools/wasm/fitsdata.wasm.js before this file; without them the pages simply keep using the JavaScript loops).
const fitsApi = {
  useKernel: fitsUseKernel,
  kernel: () => fitsEngine.kernel,
  engine: () => (fitsEngine.kernel ? "wasm" : "js"),
  settings: fitsEngine,
  readValues: fitsReadValues,
  ready: Promise.resolve(false),
};
if (typeof AstroNotWasm === "object" && AstroNotWasm) {
  fitsApi.ready = AstroNotWasm.load("fitsdata").then((kernel) => fitsUseKernel(kernel), () => false);
}
globalThis.AstroNotFits = fitsApi;
fitsSetEngineMarker();
