// Minimal FITS reader for SPHEREx Level-2 spectral images, with partial reads (global `AstroNotFitsRange`, also a CommonJS module).
//
// UI-independent: no DOM access. A port of spxphot's fits.rs (Header, decode_image, BinTable, rice_decompress_i32) and of the byte-source
// half of archive.rs (Source::read, header_at, hdu_at, rows, compressed_rows, retry). Names and comments follow the Rust so the two can
// be diffed.
//
// WHAT IT COMPUTES
//   - Header cards, HISTORY lines and the data size of an HDU (parseHeader).
//   - Pixels of an image, plain or RICE_1 tile-compressed (one tile per row), without reading the whole file: a file is described by its
//     HDU layout (where each header and data block starts), and data is read through a byte source.
//   - Numeric columns of a binary table (createBinTable).
//
// BYTE SOURCES
//   A source is { kind: "memory" | "http", read(offset, length) -> Promise<Uint8Array> }. The memory source wraps a buffer (a cutout
//   file). The HTTP source sends Range requests, requires status 206 and retries transient failures with exponential backoff.
//
// All pixel and table values come back as Float64Array. FITS stores big-endian numbers.
(function (root) {
  "use strict";

  const BLOCK = 2880;

  // ---- Header ----------------------------------------------------------------------------------------------------------------
  const latin1 = new TextDecoder("latin1");

  // Rust's str::parse::<f64>() accepts decimal and exponent forms (and inf/nan), and nothing else; Number() would also take "", "0x10".
  function parseF64(s) {
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) || /^[+-]?(inf|infinity|nan)$/i.test(s)) return Number(s.replace(/inf(inity)?$/i, "Infinity"));
    return NaN;
  }

  function parseValue(raw) {
    raw = raw.trimStart();
    if (raw.startsWith("'")) {
      // String value; '' is an escaped quote.
      let out = "";
      for (let i = 1; i < raw.length; i++) {
        const c = raw[i];
        if (c === "'") {
          if (raw[i + 1] === "'") {
            out += "'";
            i++;
          } else {
            break;
          }
        } else {
          out += c;
        }
      }
      return out.trimEnd();
    }
    return raw.split("/")[0].trim().replace(/[Dd]/g, "E");
  }

  class Header {
    constructor() {
      this.cards = {};
      // HISTORY lines, in order (SPHEREx stores calibration IDs here).
      this.history = [];
      this.size = 0;
    }

    get(k) {
      return Object.hasOwn(this.cards, k) ? this.cards[k] : undefined;
    }
    // Without a fallback a missing or non-numeric card throws (Header::f64); with one it is returned instead (Header::f64_or).
    num(k, fallback) {
      const v = this.get(k);
      if (fallback !== undefined) {
        const n = v === undefined ? NaN : parseF64(v);
        return Number.isNaN(n) ? fallback : n;
      }
      if (v === undefined) throw new Error("missing header key " + k);
      const n = parseF64(v);
      if (Number.isNaN(n)) throw new Error("header key " + k + " is not a number");
      return n;
    }
    int(k) {
      return Math.trunc(this.num(k));
    }
    str(k) {
      return this.get(k);
    }

    // Size of the data unit in bytes, padded to whole blocks.
    dataSize() {
      const naxis = this.int("NAXIS");
      if (naxis === 0) return 0;
      const bitpix = Math.abs(this.int("BITPIX"));
      let n = 1;
      for (let i = 1; i <= naxis; i++) n *= this.int("NAXIS" + i);
      const pcount = Math.max(0, Math.trunc(this.num("PCOUNT", 0)));
      const gcount = Math.max(0, Math.trunc(this.num("GCOUNT", 1)));
      const bytes = Math.floor(bitpix / 8) * gcount * (n + pcount);
      return Math.ceil(bytes / BLOCK) * BLOCK;
    }

    // Last HISTORY line of the form "[CALIB] <name> <uuid>".
    calibId(name) {
      for (let i = this.history.length - 1; i >= 0; i--) {
        const it = this.history[i].split(/\s+/).filter((t) => t !== "");
        if (it[0] === "[CALIB]" && it[1] === name && it[2] !== undefined) return it[2];
      }
      return undefined;
    }
  }

  // Parse 80-char cards until END. Returns the header (its `size` is the padded size in bytes), or null if END was not found within
  // `bytes` (caller must read more).
  function parseHeader(bytes) {
    const text = latin1.decode(bytes);
    const h = new Header();
    const ncards = Math.floor(text.length / 80);
    for (let i = 0; i < ncards; i++) {
      const s = text.slice(i * 80, i * 80 + 80);
      let key = s.slice(0, 8).trimEnd();
      if (key === "END") {
        const used = (i + 1) * 80;
        h.size = Math.ceil(used / BLOCK) * BLOCK;
        return h;
      }
      if (key === "HISTORY") {
        h.history.push(s.slice(8).trim());
        continue;
      }
      // HIERARCH cards: "HIERARCH NAME = value"
      let rest;
      if (key === "HIERARCH") {
        const eq = s.indexOf("=", 8);
        if (eq < 0) continue;
        key = s.slice(8, eq).trim();
        rest = s.slice(eq + 1);
      } else if (s.length > 10 && s.slice(8, 10) === "= ") {
        rest = s.slice(10);
      } else {
        continue;
      }
      h.cards[key] = parseValue(rest);
    }
    return null;
  }

  // ---- Big-endian decoding -----------------------------------------------------------------------------------------------------
  function view(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  // Decode an image row block according to BITPIX into f64.
  function decodeImage(bitpix, b) {
    const dv = view(b);
    let out;
    switch (bitpix) {
      case -32:
        out = new Float64Array(Math.floor(b.length / 4));
        for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(i * 4);
        return out;
      case -64:
        out = new Float64Array(Math.floor(b.length / 8));
        for (let i = 0; i < out.length; i++) out[i] = dv.getFloat64(i * 8);
        return out;
      case 32:
        out = new Float64Array(Math.floor(b.length / 4));
        for (let i = 0; i < out.length; i++) out[i] = dv.getInt32(i * 4);
        return out;
      case 16:
        out = new Float64Array(Math.floor(b.length / 2));
        for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(i * 2);
        return out;
      default:
        throw new Error("unsupported BITPIX " + bitpix);
    }
  }

  // ---- Binary tables -----------------------------------------------------------------------------------------------------------
  const columnWidth = { L: 1, B: 1, A: 1, I: 2, J: 4, E: 4, K: 8, D: 8 };

  function createBinTable(h, data) {
    const nfields = h.int("TFIELDS");
    const rowLength = h.int("NAXIS1");
    const rows = h.int("NAXIS2");
    const columns = [];
    let off = 0;
    for (let i = 1; i <= nfields; i++) {
      const name = h.str("TTYPE" + i) ?? "";
      const form = h.str("TFORM" + i);
      if (form === undefined) throw new Error("TFORM" + i);
      const digits = /^\d*/.exec(form)[0];
      const repeat = digits === "" ? 1 : Number(digits);
      const code = form[digits.length];
      if (code === undefined) throw new Error("bad TFORM");
      const width = columnWidth[code];
      if (width === undefined) throw new Error("unsupported TFORM code " + code);
      columns.push({ name, code, repeat, offset: off });
      off += width * repeat;
    }
    if (data.length < rowLength * rows) throw new Error("binary table truncated");
    const dv = view(data);

    // Read a column for one row as f64 values.
    function get(row, name) {
      const wanted = name.toLowerCase();
      const c = columns.find((col) => col.name.toLowerCase() === wanted);
      if (!c) throw new Error("no column " + name);
      const start = row * rowLength + c.offset;
      const out = new Float64Array(c.repeat);
      switch (c.code) {
        case "J":
          for (let i = 0; i < c.repeat; i++) out[i] = dv.getInt32(start + i * 4);
          break;
        case "E":
          for (let i = 0; i < c.repeat; i++) out[i] = dv.getFloat32(start + i * 4);
          break;
        case "D":
          for (let i = 0; i < c.repeat; i++) out[i] = dv.getFloat64(start + i * 8);
          break;
        case "K":
          for (let i = 0; i < c.repeat; i++) out[i] = Number(dv.getBigInt64(start + i * 8));
          break;
        case "I":
          for (let i = 0; i < c.repeat; i++) out[i] = dv.getInt16(start + i * 2);
          break;
        default:
          throw new Error("column type " + c.code + " not readable as numbers");
      }
      return out;
    }
    function scalar(row, name) {
      return get(row, name)[0];
    }
    return { columns, rowLength, rows, get, scalar };
  }

  // ---- Tile-compressed images (RICE_1, as used for SPHEREx FLAGS) --------------------------------------------------------------
  // Decompress one Rice-coded tile of 32-bit integers (CFITSIO `fits_rdecomp`).
  //
  // The Rust keeps the bit buffer `b` in a u64. Here it is a plain Number with 32-bit operators: b is masked to `nbits` bits after every
  // symbol, and `nbits` never exceeds 15 between symbols, so b holds at most nbits + fs <= 7 + 24 = 31 bits at its widest. Only the 32-bit
  // difference words (`diff`, `d`, `lastpix`) can use the top bit; they are kept unsigned with `>>> 0`, as the Rust does with u32.
  function riceDecompressI32(c, nx, nblock) {
    const FSBITS = 5;
    const FSMAX = 25;
    const BBITS = 32;
    if (c.length < 4) throw new Error("rice tile too short");
    let pos = 4;
    const next = () => {
      if (pos >= c.length) throw new Error("rice tile truncated");
      return c[pos++];
    };
    let lastpix = ((c[0] << 24) | (c[1] << 16) | (c[2] << 8) | c[3]) >>> 0;
    const out = new Int32Array(nx);
    let b = next();
    let nbits = 8;
    let i = 0;
    while (i < nx) {
      const imax = Math.min(i + nblock, nx);
      nbits -= FSBITS;
      while (nbits < 0) {
        b = (b << 8) | next();
        nbits += 8;
      }
      const fs = (b >> nbits) - 1;
      b &= (1 << nbits) - 1;
      if (fs < 0) {
        while (i < imax) {
          out[i] = lastpix;
          i++;
        }
      } else if (fs === FSMAX) {
        while (i < imax) {
          let k = BBITS - nbits;
          let diff = nbits === 0 ? 0 : (b << k) >>> 0; // b is 0 when nbits is 0 (JS would shift by 32 % 32)
          k -= 8;
          while (k >= 0) {
            b = next();
            diff = (diff | (b << k)) >>> 0;
            k -= 8;
          }
          if (nbits > 0) {
            b = next();
            diff = (diff | (b >> -k)) >>> 0;
            b &= (1 << nbits) - 1;
          } else {
            b = 0;
          }
          let d = diff >>> 0;
          d = (d & 1) === 0 ? d >>> 1 : ~(d >>> 1) >>> 0;
          lastpix = (d + lastpix) >>> 0;
          out[i] = lastpix;
          i++;
        }
      } else {
        while (i < imax) {
          while (b === 0) {
            nbits += 8;
            b = next();
          }
          const nzero = nbits - (32 - Math.clz32(b));
          nbits -= nzero + 1;
          b ^= 1 << nbits;
          nbits -= fs;
          while (nbits < 0) {
            b = (b << 8) | next();
            nbits += 8;
          }
          const diff = ((nzero << fs) | (b >> nbits)) >>> 0;
          b &= (1 << nbits) - 1;
          let d = diff;
          d = (d & 1) === 0 ? d >>> 1 : ~(d >>> 1) >>> 0;
          lastpix = (d + lastpix) >>> 0;
          out[i] = lastpix;
          i++;
        }
      }
    }
    return out;
  }

  // ---- Byte sources ------------------------------------------------------------------------------------------------------------
  // End of file is a condition of its own (error.code === "EOF"): it is never retried, and walkHdus may end a walk on it.
  function endOfFile(message) {
    const e = new Error(message);
    e.code = "EOF";
    return e;
  }

  function createMemorySource(bytes) {
    return {
      kind: "memory",
      async read(off, len) {
        const end = Math.min(off + len, bytes.length);
        if (off >= end) throw endOfFile("read past end of buffer");
        return bytes.slice(off, end);
      }
    };
  }

  // Retry transient network failures with exponential backoff: `retries` attempts in all, delays firstDelayMs, 2x, 4x ... between them.
  async function retry(f, retries, firstDelayMs) {
    const attempts = Math.max(1, retries);
    let delay = firstDelayMs;
    for (let attempt = 0; ; attempt++) {
      try {
        return await f();
      } catch (e) {
        if (e.code === "EOF" || attempt >= attempts - 1) throw e;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      }
    }
  }

  function createHttpSource(url, { fetch = globalThis.fetch, retries = 7, firstDelayMs = 750 } = {}) {
    return {
      kind: "http",
      read(off, len) {
        return retry(
          async () => {
            const r = await fetch(url, { headers: { Range: "bytes=" + off + "-" + (off + len - 1) } });
            if (r.status === 416) {
              // Range Not Satisfiable: the offset is at or past the end of the file.
              r.body?.cancel();
              throw endOfFile("read past end of file (416)");
            }
            if (!r.ok) {
              r.body?.cancel();
              throw new Error("HTTP status " + r.status + " for " + url);
            }
            if (r.status !== 206) {
              r.body?.cancel();
              throw new Error("server ignored Range request (" + r.status + ")");
            }
            return new Uint8Array(await r.arrayBuffer());
          },
          retries,
          firstDelayMs
        );
      }
    };
  }

  // ---- HDUs and rows -----------------------------------------------------------------------------------------------------------
  // Read and parse the header starting at `off`, growing the read as needed. Returns the header and the offset of its data.
  async function headerAt(source, off) {
    let len = BLOCK * 8;
    for (;;) {
      const buf = await source.read(off, len);
      const h = parseHeader(buf);
      if (h) return { header: h, dataOffset: off + h.size };
      if (buf.length < len) throw new Error("FITS header has no END card");
      len *= 4;
    }
  }

  // Where one HDU lives inside a file.
  async function hduAt(source, off) {
    const { header, dataOffset } = await headerAt(source, off);
    const name = header.str("EXTNAME") ?? "PRIMARY";
    const dataSize = header.dataSize();
    return { name, header, dataOffset, dataSize, end: dataOffset + dataSize };
  }

  // A rectangular block of an image: full-width rows starting at row `y0`.
  function rowBlock(y0, width, data) {
    return { y0, width, data, at: (x, y) => data[(y - y0) * width + x] };
  }

  // Read full-width rows [y0, y0+n) of a 2D image HDU (plain or RICE tile-compressed).
  async function readRows(source, hdu, y0, n) {
    const h = hdu.header;
    if (h.get("ZIMAGE") === "T") return compressedRows(source, hdu, y0, n);
    const width = h.int("NAXIS1");
    const bitpix = h.int("BITPIX");
    const bpp = Math.abs(bitpix) / 8;
    const off = hdu.dataOffset + y0 * width * bpp;
    const bytes = await source.read(off, n * width * bpp);
    const data = decodeImage(bitpix, bytes);
    const bz = h.num("BZERO", 0);
    const bs = h.num("BSCALE", 1);
    if (bz !== 0 || bs !== 1) {
      for (let i = 0; i < data.length; i++) data[i] = data[i] * bs + bz;
    }
    return rowBlock(y0, width, data);
  }

  // Tile-compressed image with one tile per row (ZTILE2 = 1): read only the descriptors and heap bytes of the requested rows, then
  // Rice-decode them.
  async function compressedRows(source, hdu, y0, n) {
    const h = hdu.header;
    const width = h.int("ZNAXIS1");
    if (Math.trunc(h.num("ZTILE1", width)) !== width || h.num("ZTILE2", 1) !== 1) throw new Error("only row-tiled compressed images are supported");
    const cmp = h.get("ZCMPTYPE") ?? "";
    if (cmp !== "RICE_1" || h.int("ZBITPIX") !== 32) throw new Error("unsupported compression " + cmp + " / ZBITPIX " + h.get("ZBITPIX"));
    const form = h.get("TFORM1") ?? "";
    const desc = form.includes("Q") ? 16 : 8;
    const rowLen = h.int("NAXIS1");
    const heap = hdu.dataOffset + Math.trunc(h.num("THEAP", rowLen * h.int("NAXIS2")));
    let blocksize = 32;
    for (let i = 1; i <= 8; i++) {
      if (h.get("ZNAME" + i) === "BLOCKSIZE") blocksize = Math.trunc(h.num("ZVAL" + i, 32));
    }
    const d = await source.read(hdu.dataOffset + y0 * rowLen, n * rowLen);
    const dv = view(d);
    const spans = [];
    for (let r = 0; r < n; r++) {
      const b = r * rowLen;
      if (desc === 8) spans.push({ off: dv.getInt32(b + 4), len: dv.getInt32(b) });
      else spans.push({ off: Number(dv.getBigInt64(b + 8)), len: Number(dv.getBigInt64(b)) });
    }
    const lo = Math.min(...spans.map((s) => s.off));
    const hi = Math.max(...spans.map((s) => s.off + s.len));
    const heapBytes = await source.read(heap + lo, hi - lo);
    const data = new Float64Array(n * width);
    spans.forEach((s, r) => {
      const tile = heapBytes.subarray(s.off - lo, s.off - lo + s.len);
      data.set(riceDecompressI32(tile, width, blocksize), r * width);
    });
    return rowBlock(y0, width, data);
  }

  // The NAXIS1 x NAXIS2 data bytes of a binary table HDU (the heap, if any, is not included).
  function readTableBytes(source, hdu) {
    return source.read(hdu.dataOffset, hdu.header.int("NAXIS1") * hdu.header.int("NAXIS2"));
  }

  // Walk the HDUs from `offset` until the one named `until` (inclusive), `max` HDUs, or the end of the file. Only a genuine end of file
  // (a read past the end of a memory buffer, or an HTTP 416) ends the walk quietly after the first HDU; every other error propagates.
  async function walkHdus(source, { offset = 0, until = "WCS-WAVE", max = 8 } = {}) {
    const hdus = [];
    let off = offset;
    for (let i = 0; i < max; i++) {
      let hdu;
      try {
        hdu = await hduAt(source, off);
      } catch (e) {
        if (i === 0 || e.code !== "EOF") throw e;
        break;
      }
      hdus.push(hdu);
      off = hdu.end;
      if (hdu.name === until) break;
    }
    return hdus;
  }

  const api = { BLOCK, parseHeader, decodeImage, riceDecompressI32, createBinTable, createMemorySource, createHttpSource, hduAt, readRows, readTableBytes, walkHdus };

  root.AstroNotFitsRange = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);
