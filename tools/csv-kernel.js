// JS side of the Rust/WebAssembly CSV kernel (rust/crates/csv). Global AstroNotCsv, also CommonJS for node tests.
//
// WHAT IT DOES
//   The kernel tokenizes a whole CSV file once (record boundaries and field counts only: no string per cell) and parses
//   chosen columns straight into Float64Array plus one status byte per cell. Cells are turned into JS strings only when
//   something asks for them (an ID on screen, a diagnostic for a bad row).
//
// HOW MODELS USE IT (tools/xmatch.js, tools/spectrum-csv.js, tools/timeseries.js)
//   AstroNotCsv.use(kernel)       once at start-up with the object from AstroNotWasm.load("csv") (null keeps everything in JS)
//   AstroNotCsv.open(input, opts) -> CsvTable or null; input is a string or bytes; null means "use the JS reader"
//   AstroNotCsv.source(input) / sourceFromFile(file) -> CsvSource: bytes in wasm memory that can be opened with other options
//   table.numeric(specs, {from}) -> [{ values, status }] per spec { col, flags, missing } for rows from..end
//   table.cell(row, col)          -> string or null (the row has no such column)
//   table.row(row)                -> string[] (all fields; what the JS readers return for that record)
//   table.dispose()               frees the bytes and tables inside wasm memory (also done when the object is collected)
//
// The number syntax of each reader is selected with flags and a mask of missing-value words (see `profiles`), so the
// status codes can be mapped one to one onto the messages the JS code gives.
(function (root) {
  "use strict";

  const status = { ok: 0, empty: 1, missing: 2, nan: 3, inf: 4, invalid: 5, overflow: 6, absent: 7 };
  const flags = { comma: 1, inf: 2, dexp: 4, uminus: 8 };
  const missing = { nan: 1, null: 2, na: 4, naSlash: 8, none: 16, dash2: 32, dash: 64, nil: 128, masked: 256, question: 512 };
  const openFlags = { comments: 1, lines: 2 };
  // Number syntax of each JS reader this kernel replaces.
  const profiles = {
    // tools/xmatch.js isMissing() + parseDecimal(): U+2212 minus, no decimal comma, no D exponent.
    xmatch: { flags: flags.uminus, missing: missing.nan | missing.null | missing.na | missing.naSlash | missing.none | missing.dash2 | missing.dash | missing.nil | missing.masked },
    // tools/spectrum-csv.js parseNumber(text, decimalComma): missing words, infinity reported, optional decimal comma.
    spectrum: { flags: flags.inf, missing: missing.nan | missing.null | missing.none | missing.na | missing.naSlash | missing.dash2 | missing.dash },
    spectrumComma: { flags: flags.inf | flags.comma, missing: missing.nan | missing.null | missing.none | missing.na | missing.naSlash | missing.dash2 | missing.dash },
    // tools/timeseries.js parseNumber(): D exponent, "?" counts as missing.
    timeseries: { flags: flags.dexp, missing: missing.nan | missing.null | missing.none | missing.na | missing.naSlash | missing.dash2 | missing.dash | missing.question },
  };

  let kernel = null;
  const decoder = typeof TextDecoder === "function" ? new TextDecoder("utf-8", { ignoreBOM: true }) : null;
  const encoder = typeof TextEncoder === "function" ? new TextEncoder() : null;
  const registry = typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry((release) => { try { release(); } catch { /* wasm instance already gone */ } })
    : null;

  function use(next) {
    kernel = next && next.exports && next.exports.csv_open ? next : null;
    return kernel !== null;
  }

  function memory() {
    return kernel.exports.memory.buffer;
  }

  function decode(ptr, length) {
    if (length === 0) return "";
    const view = new Uint8Array(memory(), ptr, length);
    if (length <= 24) {
      let text = "";
      for (let i = 0; i < length; i++) {
        const byte = view[i];
        if (byte >= 0x80) return decoder.decode(view);
        text += String.fromCharCode(byte);
      }
      return text;
    }
    return decoder.decode(view);
  }

  // The bytes of an input inside wasm memory. One source can be opened more than once (for example after the head of the
  // file was read in JS to find where the table starts).
  class CsvSource {
    constructor(k, region, length) {
      this.k = k;
      this.region = region;
      this.byteLength = length;
      this.disposed = false;
      if (registry) registry.register(this, () => k.free(region), this);
    }

    // The input bytes (a view; valid until the next call that may grow wasm memory).
    get bytes() {
      return new Uint8Array(this.k.exports.memory.buffer, this.region.ptr, this.byteLength);
    }

    // options: { delimiter, comments, trackLines, begin, maxRecords, skipBom, ownsSource }
    open(options = {}) {
      return new CsvTable(this, options);
    }

    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      if (registry) registry.unregister(this);
      this.k.free(this.region);
    }
  }

  class CsvTable {
    constructor(source, options) {
      const k = source.k;
      const length = source.byteLength;
      const region = source.region;
      this.k = k;
      this.source = source;
      this.region = region;
      this.byteLength = length;
      this.delimiter = options.delimiter ?? ",";
      this.options = options;
      const e = k.exports;
      let begin = options.begin ?? 0;
      if (options.skipBom !== false && begin === 0 && length >= 3) {
        const head = new Uint8Array(k.exports.memory.buffer, region.ptr, 3);
        if (head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF) begin = 3;
      }
      this.begin = begin;
      const opts = (options.comments ? openFlags.comments : 0) | (options.trackLines ? openFlags.lines : 0);
      const maxRecords = options.maxRecords === undefined || options.maxRecords === Infinity ? 0xFFFFFFF0 : options.maxRecords;
      this.handle = e.csv_open(region.ptr, length, begin, this.delimiter.charCodeAt(0), opts, maxRecords);
      this.status = e.csv_status(this.handle); // 0 ok, 1 unclosed quote, 2 too many records
      this.errorLine = e.csv_error_line(this.handle);
      this.rowCount = e.csv_rows(this.handle);
      this.comments = e.csv_comments(this.handle);
      this.disposed = false;
      const handle = this.handle;
      this.release = () => { e.csv_free(handle); if (options.ownsSource) source.dispose(); };
      if (registry) registry.register(this, () => e.csv_free(handle), this);
    }

    // Number of fields of every record (Uint32Array view valid until the next call that may grow memory).
    get fieldCounts() {
      return new Uint32Array(memory(), this.k.exports.csv_fields_ptr(this.handle), this.rowCount);
    }

    // Line number each record starts on (needs the trackLines option).
    get lines() {
      return new Uint32Array(memory(), this.k.exports.csv_lines_ptr(this.handle), this.rowCount);
    }

    // The input bytes (view valid until the next call that may grow memory).
    get bytes() {
      return this.source.bytes;
    }

    cell(row, col) {
      const e = this.k.exports;
      const ptr = e.csv_cell(this.handle, row, col);
      if (ptr === 0) return null;
      return decode(ptr, e.csv_cell_len(this.handle));
    }

    row(row) {
      const e = this.k.exports;
      const count = e.csv_row(this.handle, row);
      const lens = new Uint32Array(memory(), e.csv_row_lens_ptr(this.handle), count);
      const base = e.csv_row_buf_ptr(this.handle);
      const cells = new Array(count);
      let at = base;
      for (let i = 0; i < count; i++) {
        cells[i] = decode(at, lens[i]);
        at += lens[i];
      }
      return cells;
    }

    // specs: [{ col, flags, missing }] (a `profile` name from `profiles` may stand for flags and missing).
    // Returns [{ values: Float64Array, status: Uint8Array }] with one entry per row.
    numeric(specs, { from: first = 0, chunkRows = 1 << 20 } = {}) {
      const e = this.k.exports;
      const k = this.k;
      const rows = this.rowCount - first;
      const out = specs.map(() => ({ values: new Float64Array(rows), status: new Uint8Array(rows) }));
      if (rows === 0 || specs.length === 0) return out;
      const chunk = Math.min(chunkRows, rows);
      const values = specs.map(() => k.alloc(Float64Array, chunk));
      const statuses = specs.map(() => k.alloc(Uint8Array, chunk));
      const desc = new Uint32Array(specs.length * 5);
      specs.forEach((spec, index) => {
        const profile = spec.profile ? profiles[spec.profile] : spec;
        desc.set([spec.col, profile.flags ?? spec.flags ?? 0, profile.missing ?? spec.missing ?? 0, values[index].ptr, statuses[index].ptr], index * 5);
      });
      const descRegion = k.put(desc);
      try {
        for (let from = 0; from < rows; from += chunk) {
          const to = Math.min(rows, from + chunk);
          e.csv_extract(this.handle, descRegion.ptr, specs.length, first + from, first + to);
          specs.forEach((_, index) => {
            out[index].values.set(new Float64Array(memory(), values[index].ptr, to - from), from);
            out[index].status.set(new Uint8Array(memory(), statuses[index].ptr, to - from), from);
          });
        }
      } finally {
        k.free(descRegion, ...values, ...statuses);
      }
      return out;
    }

    // Rows whose trimmed text in `col` also occurs in another row, and rows with an empty or missing value there.
    idStats(col, from = 0) {
      const e = this.k.exports;
      const duplicate = e.csv_id_stats(this.handle, col, from);
      return { duplicate, empty: e.csv_id_empty(this.handle) };
    }

    // True when some trimmed cell of `col` has the shape of `pattern`: '#' a digit, 'S' a sign (+ or -), other
    // characters literal (case-sensitive, ASCII). Example: "J######.##S######.#".
    anyShape(col, pattern, from = 0) {
      const bytes = encoder.encode(pattern);
      const region = this.k.put(bytes);
      try {
        return this.k.exports.csv_any_shape(this.handle, col, region.ptr, bytes.length) === 1;
      } finally {
        this.k.free(region);
      }
    }

    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      if (registry) registry.unregister(this);
      this.release();
    }
  }

  // string | ArrayBuffer | typed array -> CsvSource (null when no kernel is loaded or the input is not text or bytes).
  function source(input) {
    if (!kernel) return null;
    let region = null;
    try {
      let bytes;
      if (typeof input === "string") bytes = encoder.encode(input);
      else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
      else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      else return null;
      region = kernel.put(bytes);
      return new CsvSource(kernel, region, bytes.length);
    } catch {
      if (region) kernel.free(region);
      return null;
    }
  }

  // File or Blob: the bytes are copied into wasm memory in slices, so no second copy of a large file is held in JS.
  async function sourceFromFile(blob) {
    if (!kernel) return null;
    let region = null;
    try {
      region = kernel.alloc(Uint8Array, blob.size);
      const slice = 32 * 1024 * 1024;
      for (let at = 0; at < blob.size; at += slice) {
        const bytes = new Uint8Array(await blob.slice(at, Math.min(blob.size, at + slice)).arrayBuffer());
        new Uint8Array(kernel.exports.memory.buffer, region.ptr + at, bytes.length).set(bytes);
      }
      return new CsvSource(kernel, region, blob.size);
    } catch {
      if (region) kernel.free(region);
      return null;
    }
  }

  // input: string | ArrayBuffer | typed array. options: see CsvSource.open. Returns null when the kernel cannot be used.
  function open(input, options = {}) {
    const held = source(input);
    if (!held) return null;
    try {
      return held.open({ ...options, ownsSource: true });
    } catch {
      held.dispose();
      return null;
    }
  }

  // One string -> { status, value } with a number syntax profile (tests, small uses).
  function parseNumber(text, profile = "xmatch") {
    if (!kernel) return null;
    const bytes = encoder.encode(text);
    const region = kernel.put(bytes);
    const out = kernel.alloc(Float64Array, 1);
    try {
      const p = profiles[profile];
      const code = kernel.exports.csv_parse_number(region.ptr, bytes.length, p.flags, p.missing, out.ptr);
      return { status: code, value: new Float64Array(memory(), out.ptr, 1)[0] };
    } finally {
      kernel.free(region, out);
    }
  }

  // Offset of the first non-whitespace byte at or after `from` (JavaScript trim() whitespace), or bytes.length.
  function firstNonSpace(bytes, from = 0) {
    for (let i = from; i < bytes.length;) {
      const byte = bytes[i];
      if (byte > 0x20 && byte < 0x80) return i;
      if (byte === 0x20 || (byte >= 9 && byte <= 13)) { i++; continue; }
      if (byte === 0xC2 && bytes[i + 1] === 0xA0) { i += 2; continue; }
      if (byte === 0xE1 && bytes[i + 1] === 0x9A && bytes[i + 2] === 0x80) { i += 3; continue; }
      if (byte === 0xE2 && ((bytes[i + 1] === 0x80 && ((bytes[i + 2] >= 0x80 && bytes[i + 2] <= 0x8A) || bytes[i + 2] === 0xA8 || bytes[i + 2] === 0xA9 || bytes[i + 2] === 0xAF)) || (bytes[i + 1] === 0x81 && bytes[i + 2] === 0x9F))) { i += 3; continue; }
      if (byte === 0xE3 && bytes[i + 1] === 0x80 && bytes[i + 2] === 0x80) { i += 3; continue; }
      if (byte === 0xEF && bytes[i + 1] === 0xBB && bytes[i + 2] === 0xBF) { i += 3; continue; }
      return i;
    }
    return bytes.length;
  }

  // The line that starts at `from`: { text, next } where next is the offset after its terminator (CR LF, LF or CR).
  function lineAt(bytes, from) {
    let end = from;
    while (end < bytes.length && bytes[end] !== 10 && bytes[end] !== 13) end++;
    let next = end;
    if (next < bytes.length) next += bytes[end] === 13 && bytes[end + 1] === 10 ? 2 : 1;
    return { text: decoder.decode(bytes.subarray(from, end)), end, next, terminated: end < bytes.length };
  }

  const api = {
    use, open, source, sourceFromFile, parseNumber, firstNonSpace, lineAt, status, flags, missing, profiles, CsvTable, CsvSource,
    get active() { return kernel !== null; },
    get kernel() { return kernel; },
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.AstroNotCsv = api;
})(typeof globalThis === "object" ? globalThis : this);
