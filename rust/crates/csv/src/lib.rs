//! CSV tokenizer and numeric column extractor (see tools/csv-kernel.js for the JS side).
//!
//! The bytes stay in wasm memory (JS copies the file there once). `csv_open` makes one pass and records, per record,
//! where it starts and ends and how many fields it has; no string is built. Cells are read on demand:
//!   - `csv_extract` parses chosen columns straight to f64 plus one status byte per cell, in one pass over the rows;
//!   - `csv_cell` / `csv_row` hand back the bytes of single cells (JS decodes them only when it must show them).
//!
//! The record rules are those of the JS readers this replaces (tools/observation-csv.js parseCsv, tools/spectrum-csv.js
//! parseDelimited, tools/timeseries.js parseDelimited): a quote opens a quoted field only when the field is empty so
//! far, `""` inside quotes is a quote, CR LF / CR / LF end a record, records of one whitespace-only field are dropped,
//! optional `#` comment lines at a record start, and an unclosed quote is an error. "Whitespace" is JavaScript's
//! String.prototype.trim set (so a no-break space or a BOM inside a cell is trimmed exactly as the JS code does).
use std::alloc::{alloc, dealloc, Layout};

#[no_mangle]
pub extern "C" fn an_alloc(bytes: usize) -> *mut u8 {
    if bytes == 0 {
        return 8 as *mut u8;
    }
    unsafe { alloc(Layout::from_size_align_unchecked(bytes, 8)) }
}

#[no_mangle]
pub unsafe extern "C" fn an_free(ptr: *mut u8, bytes: usize) {
    if bytes != 0 {
        dealloc(ptr, Layout::from_size_align_unchecked(bytes, 8));
    }
}

// ---- Cell status codes (one byte per parsed cell) -------------------------------------------------------------------
const ST_OK: u8 = 0;
const ST_EMPTY: u8 = 1; // nothing but whitespace
const ST_MISSING: u8 = 2; // a missing-value word selected by the mask (not "nan")
const ST_NAN: u8 = 3; // the word "nan" and the mask allows it
const ST_INF: u8 = 4; // [+-]inf / infinity (only with FLAG_INF)
const ST_INVALID: u8 = 5; // not a number in the accepted syntax
const ST_OVERFLOW: u8 = 6; // syntax fine but the value is not finite as a double
const ST_ABSENT: u8 = 7; // the row has no such column

// Number syntax flags.
const FLAG_COMMA: u32 = 1; // "1,5" is 1.5 (decimal comma), only the form [+-]digits,digits[eE...]
const FLAG_INF: u32 = 2; // report [+-]inf|infinity as ST_INF
const FLAG_DEXP: u32 = 4; // accept d/D as an exponent letter (Fortran style)
const FLAG_UMINUS: u32 = 8; // U+2212 counts as '-'

// Missing-value words (ASCII, case-insensitive). The empty cell is always ST_EMPTY.
const M_NAN: u32 = 1;
const M_NULL: u32 = 2;
const M_NA: u32 = 4;
const M_NA_SLASH: u32 = 8;
const M_NONE: u32 = 16;
const M_DASH2: u32 = 32;
const M_DASH: u32 = 64;
const M_NIL: u32 = 128;
const M_MASKED: u32 = 256;
const M_QUESTION: u32 = 512;

// ---- JavaScript whitespace over UTF-8 -------------------------------------------------------------------------------
// WhiteSpace and LineTerminator of ECMAScript: TAB LF VT FF CR SP, U+00A0, U+1680, U+2000-200A, U+2028, U+2029, U+202F,
// U+205F, U+3000, U+FEFF.
fn ws_front(s: &[u8]) -> usize {
    let n = s.len();
    if n == 0 {
        return 0;
    }
    match s[0] {
        9..=13 | 32 => 1,
        0xC2 if n >= 2 && s[1] == 0xA0 => 2,
        0xE1 if n >= 3 && s[1] == 0x9A && s[2] == 0x80 => 3,
        0xE2 if n >= 3 => match (s[1], s[2]) {
            (0x80, 0x80..=0x8A) | (0x80, 0xA8) | (0x80, 0xA9) | (0x80, 0xAF) | (0x81, 0x9F) => 3,
            _ => 0,
        },
        0xE3 if n >= 3 && s[1] == 0x80 && s[2] == 0x80 => 3,
        0xEF if n >= 3 && s[1] == 0xBB && s[2] == 0xBF => 3,
        _ => 0,
    }
}

fn ws_back(s: &[u8]) -> usize {
    let n = s.len();
    if n == 0 {
        return 0;
    }
    let last = s[n - 1];
    if matches!(last, 9..=13 | 32) {
        return 1;
    }
    if last < 0x80 {
        return 0;
    }
    if n >= 2 && s[n - 2] == 0xC2 && last == 0xA0 {
        return 2;
    }
    if n >= 3 {
        let tail = &s[n - 3..];
        if ws_front(tail) == 3 {
            return 3;
        }
    }
    0
}

fn js_trim(mut s: &[u8]) -> &[u8] {
    loop {
        let k = ws_front(s);
        if k == 0 {
            break;
        }
        s = &s[k..];
    }
    loop {
        let k = ws_back(s);
        if k == 0 {
            break;
        }
        s = &s[..s.len() - k];
    }
    s
}

// ---- The table --------------------------------------------------------------------------------------------------------
pub struct Table {
    data: *const u8,
    len: usize,
    delim: u8,
    comment_any: bool,
    track_lines: bool,
    starts: Vec<u32>,
    ends: Vec<u32>,
    fields: Vec<u32>,
    lines: Vec<u32>,
    status: u32,
    error_line: u32,
    error_pos: u32,
    comments: u32,
    scratch: Vec<u8>,
    cell_len: usize,
    row_buf: Vec<u8>,
    row_lens: Vec<u32>,
    id_empty: u32,
}

impl Table {
    fn data(&self) -> &'static [u8] {
        unsafe { std::slice::from_raw_parts(self.data, self.len) }
    }
}

// Calls f(column, content) for each field of the record [start, end); f returns false to stop. Content is the field
// with quoting removed. Unquoted fields are returned as slices of the input; quoted ones are built in `scratch`.
fn walk<F: FnMut(usize, &[u8]) -> bool>(data: &[u8], delim: u8, start: usize, end: usize, scratch: &mut Vec<u8>, mut f: F) {
    let mut i = start;
    let mut col = 0usize;
    loop {
        if i < end && data[i] == b'"' {
            scratch.clear();
            let mut quoted = true;
            i += 1;
            while i < end {
                let c = data[i];
                if quoted {
                    if c == b'"' {
                        if i + 1 < end && data[i + 1] == b'"' {
                            scratch.push(b'"');
                            i += 2;
                        } else {
                            quoted = false;
                            i += 1;
                        }
                    } else {
                        scratch.push(c);
                        i += 1;
                    }
                } else if c == delim {
                    break;
                } else if c == b'"' && scratch.is_empty() {
                    quoted = true;
                    i += 1;
                } else {
                    scratch.push(c);
                    i += 1;
                }
            }
            if !f(col, &scratch[..]) {
                return;
            }
        } else {
            let s = i;
            while i < end && data[i] != delim {
                i += 1;
            }
            if !f(col, &data[s..i]) {
                return;
            }
        }
        if i >= end {
            return;
        }
        i += 1;
        col += 1;
    }
}

fn single_field_is_blank(data: &[u8], delim: u8, start: usize, end: usize, scratch: &mut Vec<u8>) -> bool {
    if start == end {
        return true;
    }
    let mut blank = true;
    walk(data, delim, start, end, scratch, |_, content| {
        blank = js_trim(content).is_empty();
        false
    });
    blank
}

fn scan(t: &mut Table, begin: usize, max_records: usize) {
    let data = t.data();
    let n = data.len();
    let mut class = [0u8; 256];
    class[b'"' as usize] = 2;
    class[b'\n' as usize] = 3;
    class[b'\r' as usize] = 3;
    class[t.delim as usize] = 1;
    let mut i = begin;
    let mut line: u32 = 1;
    while i < n {
        let rec_start = i;
        let start_line = line;
        if t.comment_any && data[i] == b'#' {
            while i < n && data[i] != b'\n' && data[i] != b'\r' {
                i += 1;
            }
            t.comments += 1;
            if i < n {
                if data[i] == b'\r' && i + 1 < n && data[i + 1] == b'\n' {
                    i += 1;
                }
                i += 1;
                line += 1;
            }
            continue;
        }
        let mut nfields: u32 = 1;
        let mut field_empty = true;
        let mut quoted = false;
        let end;
        loop {
            if i >= n {
                if quoted {
                    t.status = 1;
                    t.error_line = start_line;
                    t.error_pos = rec_start as u32;
                    return;
                }
                end = n;
                break;
            }
            if quoted {
                let before = i;
                while i < n && data[i] != b'"' {
                    if data[i] == b'\n' {
                        line += 1;
                    }
                    i += 1;
                }
                if i > before {
                    field_empty = false;
                }
                if i < n {
                    if i + 1 < n && data[i + 1] == b'"' {
                        field_empty = false;
                        i += 2;
                    } else {
                        quoted = false;
                        i += 1;
                    }
                }
                continue;
            }
            let c = data[i];
            match class[c as usize] {
                0 => {
                    field_empty = false;
                    i += 1;
                    while i < n && class[data[i] as usize] == 0 {
                        i += 1;
                    }
                }
                1 => {
                    nfields += 1;
                    field_empty = true;
                    i += 1;
                }
                2 => {
                    if field_empty {
                        quoted = true;
                    }
                    i += 1;
                }
                _ => {
                    end = i;
                    if c == b'\r' && i + 1 < n && data[i + 1] == b'\n' {
                        i += 2;
                    } else {
                        i += 1;
                    }
                    line += 1;
                    break;
                }
            }
        }
        if nfields == 1 && single_field_is_blank(data, t.delim, rec_start, end, &mut t.scratch) {
            continue;
        }
        t.starts.push(rec_start as u32);
        t.ends.push(end as u32);
        t.fields.push(nfields);
        if t.track_lines {
            t.lines.push(start_line);
        }
        if t.starts.len() > max_records {
            t.status = 2;
            return;
        }
    }
}

/// Tokenizes `len` bytes at `data` from offset `begin` (after any BOM or leading lines JS skipped).
/// opts: bit 0 = lines starting with '#' at a record start are comments, bit 1 = record start line numbers.
/// Never returns null. Check csv_status: 0 ok, 1 unclosed quote (csv_error_line / csv_error_pos), 2 more than
/// `max_records` records (scanning stops there).
#[no_mangle]
pub unsafe extern "C" fn csv_open(data: *const u8, len: usize, begin: usize, delim: u32, opts: u32, max_records: usize) -> *mut Table {
    let reserve = (len / 80 + 16).min(1 << 24);
    let mut t = Box::new(Table {
        data,
        len,
        delim: delim as u8,
        comment_any: opts & 1 != 0,
        track_lines: opts & 2 != 0,
        starts: Vec::with_capacity(reserve),
        ends: Vec::with_capacity(reserve),
        fields: Vec::with_capacity(reserve),
        lines: Vec::new(),
        status: 0,
        error_line: 0,
        error_pos: 0,
        comments: 0,
        scratch: Vec::new(),
        cell_len: 0,
        row_buf: Vec::new(),
        row_lens: Vec::new(),
        id_empty: 0,
    });
    if t.track_lines {
        t.lines.reserve(reserve);
    }
    scan(&mut t, begin.min(len), max_records);
    Box::into_raw(t)
}

#[no_mangle]
pub unsafe extern "C" fn csv_free(t: *mut Table) {
    if !t.is_null() {
        drop(Box::from_raw(t));
    }
}

#[no_mangle]
pub unsafe extern "C" fn csv_status(t: *const Table) -> u32 {
    (*t).status
}
#[no_mangle]
pub unsafe extern "C" fn csv_error_line(t: *const Table) -> u32 {
    (*t).error_line
}
#[no_mangle]
pub unsafe extern "C" fn csv_error_pos(t: *const Table) -> u32 {
    (*t).error_pos
}
#[no_mangle]
pub unsafe extern "C" fn csv_rows(t: *const Table) -> u32 {
    (*t).starts.len() as u32
}
#[no_mangle]
pub unsafe extern "C" fn csv_comments(t: *const Table) -> u32 {
    (*t).comments
}
#[no_mangle]
pub unsafe extern "C" fn csv_starts_ptr(t: *const Table) -> *const u32 {
    (*t).starts.as_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn csv_ends_ptr(t: *const Table) -> *const u32 {
    (*t).ends.as_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn csv_fields_ptr(t: *const Table) -> *const u32 {
    (*t).fields.as_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn csv_lines_ptr(t: *const Table) -> *const u32 {
    (*t).lines.as_ptr()
}

/// Offset of the first byte at or after `from` that is not JavaScript whitespace (`len` when there is none).
#[no_mangle]
pub unsafe extern "C" fn csv_first_nonspace(data: *const u8, len: usize, from: usize) -> usize {
    let s = std::slice::from_raw_parts(data, len);
    let mut i = from.min(len);
    loop {
        let k = ws_front(&s[i..]);
        if k == 0 {
            return i;
        }
        i += k;
    }
}

// ---- Single cells ---------------------------------------------------------------------------------------------------
/// Content of one cell (quotes removed, not trimmed). Returns a pointer valid until the next call on this table and
/// sets csv_cell_len; returns null with length 0 when the row has fewer fields.
#[no_mangle]
pub unsafe extern "C" fn csv_cell(t: *mut Table, row: u32, col: u32) -> *const u8 {
    let t = &mut *t;
    let data = t.data();
    let (start, end) = (t.starts[row as usize] as usize, t.ends[row as usize] as usize);
    let mut found: Option<(*const u8, usize)> = None;
    let target = col as usize;
    walk(data, t.delim, start, end, &mut t.scratch, |c, content| {
        if c == target {
            found = Some((content.as_ptr(), content.len()));
            false
        } else {
            true
        }
    });
    match found {
        Some((p, l)) => {
            t.cell_len = l;
            p
        }
        None => {
            t.cell_len = 0;
            std::ptr::null()
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn csv_cell_len(t: *const Table) -> usize {
    (*t).cell_len
}

/// All cells of a row: contents concatenated in csv_row_buf, lengths in csv_row_lens. Returns the field count.
#[no_mangle]
pub unsafe extern "C" fn csv_row(t: *mut Table, row: u32) -> u32 {
    let t = &mut *t;
    let data = t.data();
    let (start, end) = (t.starts[row as usize] as usize, t.ends[row as usize] as usize);
    t.row_buf.clear();
    t.row_lens.clear();
    let mut buf = std::mem::take(&mut t.row_buf);
    let mut lens = std::mem::take(&mut t.row_lens);
    walk(data, t.delim, start, end, &mut t.scratch, |_, content| {
        buf.extend_from_slice(content);
        lens.push(content.len() as u32);
        true
    });
    t.row_buf = buf;
    t.row_lens = lens;
    t.row_lens.len() as u32
}
#[no_mangle]
pub unsafe extern "C" fn csv_row_buf_ptr(t: *const Table) -> *const u8 {
    (*t).row_buf.as_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn csv_row_buf_len(t: *const Table) -> usize {
    (*t).row_buf.len()
}
#[no_mangle]
pub unsafe extern "C" fn csv_row_lens_ptr(t: *const Table) -> *const u32 {
    (*t).row_lens.as_ptr()
}

// ---- Numbers -------------------------------------------------------------------------------------------------------
const POW10: [f64; 23] = [
    1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22,
];

fn missing_word(s: &[u8], mask: u32) -> u8 {
    let l = s.len();
    if l == 0 || l > 6 || mask == 0 {
        return 0;
    }
    let mut buf = [0u8; 6];
    for k in 0..l {
        buf[k] = s[k].to_ascii_lowercase();
    }
    let (word, bit) = match &buf[..l] {
        b"nan" => (ST_NAN, M_NAN),
        b"null" => (ST_MISSING, M_NULL),
        b"na" => (ST_MISSING, M_NA),
        b"n/a" => (ST_MISSING, M_NA_SLASH),
        b"none" => (ST_MISSING, M_NONE),
        b"--" => (ST_MISSING, M_DASH2),
        b"-" => (ST_MISSING, M_DASH),
        b"nil" => (ST_MISSING, M_NIL),
        b"masked" => (ST_MISSING, M_MASKED),
        b"?" => (ST_MISSING, M_QUESTION),
        _ => return 0,
    };
    if mask & bit != 0 {
        word
    } else {
        0
    }
}

fn is_inf_word(s: &[u8]) -> bool {
    let body = if !s.is_empty() && (s[0] == b'+' || s[0] == b'-') { &s[1..] } else { s };
    body.eq_ignore_ascii_case(b"inf") || body.eq_ignore_ascii_case(b"infinity")
}

// Checks s (trimmed, non-empty) against ^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$ (plus the optional comma form and d
// exponent) and converts it. Returns (status, value).
fn parse_decimal(s: &[u8], flags: u32) -> (u8, f64) {
    let n = s.len();
    let mut i = 0;
    let mut neg = false;
    if s[0] == b'+' || s[0] == b'-' {
        neg = s[0] == b'-';
        i = 1;
    }
    let mut mant: u64 = 0;
    let mut too_many = false;
    let digit = |d: u8, mant: &mut u64, too_many: &mut bool| {
        if *mant < 1_000_000_000_000_000_000 {
            *mant = *mant * 10 + (d - b'0') as u64;
        } else {
            *too_many = true;
        }
    };
    let int_start = i;
    while i < n && s[i].is_ascii_digit() {
        digit(s[i], &mut mant, &mut too_many);
        i += 1;
    }
    let int_digits = i - int_start;
    let mut frac_digits = 0usize;
    if i < n && (s[i] == b'.' || (flags & FLAG_COMMA != 0 && s[i] == b',')) {
        let comma = s[i] == b',';
        i += 1;
        let frac_start = i;
        while i < n && s[i].is_ascii_digit() {
            digit(s[i], &mut mant, &mut too_many);
            i += 1;
        }
        frac_digits = i - frac_start;
        if comma && (int_digits == 0 || frac_digits == 0) {
            return (ST_INVALID, f64::NAN);
        }
    }
    if int_digits == 0 && frac_digits == 0 {
        return (ST_INVALID, f64::NAN);
    }
    let mut exp: i64 = 0;
    let mut has_exp = false;
    if i < n && (s[i] == b'e' || s[i] == b'E' || (flags & FLAG_DEXP != 0 && (s[i] == b'd' || s[i] == b'D'))) {
        has_exp = true;
        i += 1;
        let mut eneg = false;
        if i < n && (s[i] == b'+' || s[i] == b'-') {
            eneg = s[i] == b'-';
            i += 1;
        }
        let es = i;
        while i < n && s[i].is_ascii_digit() {
            if exp < 100_000_000 {
                exp = exp * 10 + (s[i] - b'0') as i64;
            }
            i += 1;
        }
        if i == es {
            return (ST_INVALID, f64::NAN);
        }
        if eneg {
            exp = -exp;
        }
    }
    if i != n {
        return (ST_INVALID, f64::NAN);
    }
    let _ = has_exp;
    let e10 = exp - frac_digits as i64;
    let value = if mant == 0 {
        0.0
    } else if !too_many && mant <= (1u64 << 53) && (-22..=22).contains(&e10) {
        let m = mant as f64;
        if e10 >= 0 {
            m * POW10[e10 as usize]
        } else {
            m / POW10[(-e10) as usize]
        }
    } else {
        // Correctly rounded conversion by the standard library on a normalized copy of the text.
        let mut text = [0u8; 96];
        let mut heap: Vec<u8> = Vec::new();
        let buf: &mut [u8] = if n <= text.len() {
            &mut text[..n]
        } else {
            heap.resize(n, 0);
            &mut heap[..]
        };
        for k in 0..n {
            buf[k] = match s[k] {
                b',' => b'.',
                b'd' | b'D' => b'e',
                c => c,
            };
        }
        let parsed = unsafe { std::str::from_utf8_unchecked(&buf[..]) }.parse::<f64>();
        match parsed {
            Ok(v) => {
                return if v.is_finite() { (ST_OK, v) } else { (ST_OVERFLOW, f64::NAN) };
            }
            Err(_) => return (ST_INVALID, f64::NAN),
        }
    };
    (ST_OK, if neg { -value } else { value })
}

fn normalize_minus(s: &[u8]) -> Option<Vec<u8>> {
    let mut found = false;
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if s[i] == 0xE2 && i + 2 < s.len() && s[i + 1] == 0x88 && s[i + 2] == 0x92 {
            out.push(b'-');
            i += 3;
            found = true;
        } else {
            out.push(s[i]);
            i += 1;
        }
    }
    if found {
        Some(out)
    } else {
        None
    }
}

/// Classifies and converts one cell (content bytes, not trimmed). Order, as in the JS readers: trim, empty, decimal
/// comma form, missing words, infinity, syntax check, value.
fn parse_number(raw: &[u8], flags: u32, mask: u32) -> (u8, f64) {
    let s = js_trim(raw);
    if s.is_empty() {
        return (ST_EMPTY, f64::NAN);
    }
    // Hot path: the first byte is a digit.
    if !s[0].is_ascii_digit() {
        let word = missing_word(s, mask);
        if word != 0 {
            return (word, f64::NAN);
        }
        if flags & FLAG_INF != 0 && is_inf_word(s) {
            return (ST_INF, f64::NAN);
        }
    }
    if flags & FLAG_UMINUS != 0 && s.iter().any(|&b| b == 0xE2) {
        if let Some(fixed) = normalize_minus(s) {
            return parse_decimal(&fixed, flags);
        }
    }
    parse_decimal(s, flags)
}

/// Parses one string (tests and tiny uses). Writes the value to `out` and returns the status.
#[no_mangle]
pub unsafe extern "C" fn csv_parse_number(data: *const u8, len: usize, flags: u32, mask: u32, out: *mut f64) -> u32 {
    let (status, value) = parse_number(std::slice::from_raw_parts(data, len), flags, mask);
    *out = value;
    status as u32
}

// One request of csv_extract: 5 u32 values in wasm memory.
//   [0] column, [1] flags, [2] missing-word mask, [3] pointer to f64 values (row - row_from), [4] pointer to u8 statuses
const DESC_WORDS: usize = 5;

/// Parses the requested columns for rows row_from..row_to in one pass.
#[no_mangle]
pub unsafe extern "C" fn csv_extract(t: *mut Table, desc: *const u32, count: u32, row_from: u32, row_to: u32) {
    let t = &mut *t;
    let data = t.data();
    let desc = std::slice::from_raw_parts(desc, count as usize * DESC_WORDS);
    let mut order: Vec<usize> = (0..count as usize).collect();
    order.sort_by_key(|&k| desc[k * DESC_WORDS]);
    let last_col = order.last().map(|&k| desc[k * DESC_WORDS] as usize).unwrap_or(0);
    let out_values = |k: usize| desc[k * DESC_WORDS + 3] as *mut f64;
    let out_status = |k: usize| desc[k * DESC_WORDS + 4] as *mut u8;
    for row in row_from..row_to {
        let at = (row - row_from) as usize;
        for k in 0..count as usize {
            *out_values(k).add(at) = f64::NAN;
            *out_status(k).add(at) = ST_ABSENT;
        }
        let (start, end) = (t.starts[row as usize] as usize, t.ends[row as usize] as usize);
        let mut j = 0usize;
        walk(data, t.delim, start, end, &mut t.scratch, |col, content| {
            while j < order.len() && (desc[order[j] * DESC_WORDS] as usize) < col {
                j += 1;
            }
            while j < order.len() && desc[order[j] * DESC_WORDS] as usize == col {
                let k = order[j];
                let (status, value) = parse_number(content, desc[k * DESC_WORDS + 1], desc[k * DESC_WORDS + 2]);
                *out_values(k).add(at) = value;
                *out_status(k).add(at) = status;
                j += 1;
            }
            col < last_col
        });
    }
}

// ---- Identifier statistics -------------------------------------------------------------------------------------------
/// For the trimmed text of column `col` in rows row_from..: the number of rows whose (non-empty) value also occurs in another row.
/// csv_id_empty() then gives the number of rows with an empty or missing value. Equal values are found through a
/// 64-bit hash (collision odds for 10 million rows are about 3 in a million).
#[no_mangle]
pub unsafe extern "C" fn csv_id_stats(t: *mut Table, col: u32, row_from: u32) -> u32 {
    let t = &mut *t;
    let data = t.data();
    let rows = t.starts.len();
    let mut hashes: Vec<u64> = Vec::with_capacity(rows);
    let mut empty = 0u32;
    let target = col as usize;
    for row in (row_from as usize)..rows {
        let (start, end) = (t.starts[row] as usize, t.ends[row] as usize);
        let mut seen = false;
        walk(data, t.delim, start, end, &mut t.scratch, |c, content| {
            if c < target {
                return true;
            }
            seen = true;
            let s = js_trim(content);
            if s.is_empty() {
                empty += 1;
            } else {
                let mut h: u64 = 0xcbf29ce484222325;
                for &b in s {
                    h = (h ^ b as u64).wrapping_mul(0x100000001b3);
                }
                h ^= h >> 29;
                h = h.wrapping_mul(0xbf58476d1ce4e5b9);
                h ^= h >> 32;
                hashes.push(h);
            }
            false
        });
        if !seen {
            empty += 1;
        }
    }
    t.id_empty = empty;
    hashes.sort_unstable();
    let mut dup = 0u32;
    let mut k = 0;
    while k < hashes.len() {
        let mut m = k + 1;
        while m < hashes.len() && hashes[m] == hashes[k] {
            m += 1;
        }
        if m - k > 1 {
            dup += (m - k) as u32;
        }
        k = m;
    }
    dup
}

#[no_mangle]
pub unsafe extern "C" fn csv_id_empty(t: *const Table) -> u32 {
    (*t).id_empty
}

// ---- Shapes ---------------------------------------------------------------------------------------------------------
/// 1 when the trimmed text of column `col` in some row has the shape `pattern`: '#' is an ASCII digit, 'S' is '+' or
/// '-', every other byte must match exactly. Stops at the first match. Used to recognise identifier formats.
#[no_mangle]
pub unsafe extern "C" fn csv_any_shape(t: *mut Table, col: u32, pattern: *const u8, pattern_len: usize, row_from: u32) -> u32 {
    let t = &mut *t;
    let data = t.data();
    let pattern = std::slice::from_raw_parts(pattern, pattern_len);
    let target = col as usize;
    for row in (row_from as usize)..t.starts.len() {
        let (start, end) = (t.starts[row] as usize, t.ends[row] as usize);
        let mut hit = false;
        walk(data, t.delim, start, end, &mut t.scratch, |c, content| {
            if c < target {
                return true;
            }
            let s = js_trim(content);
            hit = s.len() == pattern.len()
                && s.iter().zip(pattern.iter()).all(|(&b, &p)| match p {
                    b'#' => b.is_ascii_digit(),
                    b'S' => b == b'+' || b == b'-',
                    _ => b == p,
                });
            false
        });
        if hit {
            return 1;
        }
    }
    0
}
