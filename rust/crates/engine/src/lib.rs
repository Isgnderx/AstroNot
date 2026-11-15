//! engine: the resident-image kernel behind `tools/engine/` (FITS Viewer, Sky Explorer and, step by step, the other
//! image tools). Unlike `fitsdata`, which computes on arrays that JavaScript owns and copies in band by band, this crate
//! OWNS the image: JavaScript decodes a FITS HDU straight into a float32 image that lives in wasm memory (`img_create`,
//! `img_decode_rows`), then asks for a 2x pyramid, statistics, quantiles and display tiles without the pixels ever
//! crossing back into the JavaScript heap. That is what makes gigabyte images workable in a browser tab.
//!
//! Conventions
//!   * Pixel rows keep the FITS order: row 0 is the BOTTOM row of the displayed image. Tiles are rendered in canvas
//!     order (row 0 at the top), the flip happens in `img_render_tile`.
//!   * Values are calibrated (BSCALE/BZERO applied, BLANK -> NaN) and stored as f32. All reductions accumulate in f64.
//!   * Every function is `extern "C"` over raw pointers; `an_alloc`/`an_free` manage scratch regions for JavaScript.
//!   * A handle is a small positive integer; 0 means failure (usually: no memory for an image of that size).
#![allow(clippy::missing_safety_doc)]
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

unsafe fn slice<'a, T>(ptr: *const T, len: usize) -> &'a [T] {
    if len == 0 { &[] } else { std::slice::from_raw_parts(ptr, len) }
}

unsafe fn slice_mut<'a, T>(ptr: *mut T, len: usize) -> &'a mut [T] {
    if len == 0 { &mut [] } else { std::slice::from_raw_parts_mut(ptr, len) }
}

// ---------------------------------------------------------------------------------------------------------------------
// Image store
// ---------------------------------------------------------------------------------------------------------------------

struct Level {
    w: usize,
    h: usize,
    data: Vec<f32>,
}

#[derive(Clone, Copy)]
struct Scan {
    finite: f64,
    nan: f64,
    min: f64,
    max: f64,
    mean: f64,
    std: f64,
}

struct Image {
    levels: Vec<Level>,
    scan: Option<Scan>,
}

static mut IMAGES: Vec<Option<Image>> = Vec::new();

fn images() -> &'static mut Vec<Option<Image>> {
    // wasm32-unknown-unknown is single threaded: one caller at a time.
    unsafe { &mut *std::ptr::addr_of_mut!(IMAGES) }
}

fn image(handle: u32) -> Option<&'static mut Image> {
    if handle == 0 {
        return None;
    }
    images().get_mut(handle as usize - 1)?.as_mut()
}

/// Allocates a width x height float32 image filled with NaN. Returns a handle, or 0 when the memory is not available.
#[no_mangle]
pub extern "C" fn img_create(width: u32, height: u32) -> u32 {
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 {
        return 0;
    }
    let Some(n) = w.checked_mul(h) else { return 0 };
    let mut data: Vec<f32> = Vec::new();
    if data.try_reserve_exact(n).is_err() {
        return 0;
    }
    data.resize(n, f32::NAN);
    let img = Image { levels: vec![Level { w, h, data }], scan: None };
    let list = images();
    for (i, slot) in list.iter_mut().enumerate() {
        if slot.is_none() {
            *slot = Some(img);
            return (i + 1) as u32;
        }
    }
    list.push(Some(img));
    list.len() as u32
}

#[no_mangle]
pub extern "C" fn img_free(handle: u32) {
    if handle != 0 {
        if let Some(slot) = images().get_mut(handle as usize - 1) {
            *slot = None;
        }
    }
}

#[no_mangle]
pub extern "C" fn img_levels(handle: u32) -> u32 {
    image(handle).map_or(0, |img| img.levels.len() as u32)
}

#[no_mangle]
pub extern "C" fn img_level_width(handle: u32, level: u32) -> u32 {
    image(handle).and_then(|img| img.levels.get(level as usize)).map_or(0, |l| l.w as u32)
}

#[no_mangle]
pub extern "C" fn img_level_height(handle: u32, level: u32) -> u32 {
    image(handle).and_then(|img| img.levels.get(level as usize)).map_or(0, |l| l.h as u32)
}

/// Address of the first pixel of a level (row 0 = bottom row), for direct reads from JavaScript; 0 when absent.
#[no_mangle]
pub extern "C" fn img_level_ptr(handle: u32, level: u32) -> *const f32 {
    image(handle).and_then(|img| img.levels.get(level as usize)).map_or(std::ptr::null(), |l| l.data.as_ptr())
}

// ---------------------------------------------------------------------------------------------------------------------
// Decoding (big-endian FITS data -> calibrated f32)
// ---------------------------------------------------------------------------------------------------------------------

#[inline(always)]
unsafe fn be16(src: *const u8, i: usize) -> u16 {
    u16::from_be((src.add(i * 2) as *const u16).read_unaligned())
}
#[inline(always)]
unsafe fn be32(src: *const u8, i: usize) -> u32 {
    u32::from_be((src.add(i * 4) as *const u32).read_unaligned())
}
#[inline(always)]
unsafe fn be64(src: *const u8, i: usize) -> u64 {
    u64::from_be((src.add(i * 8) as *const u64).read_unaligned())
}

#[inline(always)]
unsafe fn raw_at(src: *const u8, bitpix: i32, i: usize) -> f64 {
    match bitpix {
        8 => *src.add(i) as f64,
        16 => be16(src, i) as i16 as f64,
        32 => be32(src, i) as i32 as f64,
        64 => be64(src, i) as i64 as f64,
        -32 => f32::from_bits(be32(src, i)) as f64,
        _ => f64::from_bits(be64(src, i)),
    }
}

#[inline(always)]
fn calibrate(raw: f64, scale: f64, zero: f64, has_blank: bool, blank: f64) -> f64 {
    if has_blank && raw == blank { f64::NAN } else { raw * scale + zero }
}

#[inline(always)]
unsafe fn decode_into<const BITPIX: i32>(src: *const u8, out: &mut [f32], scale: f64, zero: f64, has_blank: bool, blank: f64) {
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = calibrate(raw_at(src, BITPIX, i), scale, zero, has_blank, blank) as f32;
    }
}

/// Decodes `rows` rows of big-endian pixels (bitpix 8, 16, 32, 64, -32 or -64, BSCALE/BZERO/BLANK applied) into level 0
/// starting at `row0`. Returns 0, or -1 (bad handle), -2 (rows out of range), -3 (bad bitpix). Decoding is idempotent per
/// row, so a cancelled load can simply be dropped with img_free.
#[no_mangle]
pub unsafe extern "C" fn img_decode_rows(handle: u32, src: *const u8, row0: u32, rows: u32, bitpix: i32, scale: f64, zero: f64, has_blank: i32, blank: f64) -> i32 {
    let Some(img) = image(handle) else { return -1 };
    img.scan = None;
    let level = &mut img.levels[0];
    let (row0, rows) = (row0 as usize, rows as usize);
    if row0 + rows > level.h {
        return -2;
    }
    let w = level.w;
    let out = &mut level.data[row0 * w..(row0 + rows) * w];
    let hb = has_blank != 0;
    if bitpix == -32 && scale == 1.0 && zero == 0.0 && !hb {
        // The common case (calibrated float images): a byte swap, which the compiler vectorizes.
        for (i, slot) in out.iter_mut().enumerate() {
            *slot = f32::from_bits(be32(src, i));
        }
        return 0;
    }
    match bitpix {
        8 => decode_into::<8>(src, out, scale, zero, hb, blank),
        16 => decode_into::<16>(src, out, scale, zero, hb, blank),
        32 => decode_into::<32>(src, out, scale, zero, hb, blank),
        64 => decode_into::<64>(src, out, scale, zero, hb, blank),
        -32 => decode_into::<-32>(src, out, scale, zero, hb, blank),
        -64 => decode_into::<-64>(src, out, scale, zero, hb, blank),
        _ => return -3,
    }
    0
}

/// Copies already calibrated f32 rows (for example from a Float32Array a test built) into level 0.
#[no_mangle]
pub unsafe extern "C" fn img_put_rows(handle: u32, src: *const f32, row0: u32, rows: u32) -> i32 {
    let Some(img) = image(handle) else { return -1 };
    img.scan = None;
    let level = &mut img.levels[0];
    let (row0, rows) = (row0 as usize, rows as usize);
    if row0 + rows > level.h {
        return -2;
    }
    let w = level.w;
    level.data[row0 * w..(row0 + rows) * w].copy_from_slice(slice(src, rows * w));
    0
}

// ---------------------------------------------------------------------------------------------------------------------
// Pyramid: each level halves the previous one; a destination pixel is the mean of its finite source pixels, NaN if none.
// ---------------------------------------------------------------------------------------------------------------------

fn halve(src: &Level) -> Option<Level> {
    let (w, h) = ((src.w + 1) / 2, (src.h + 1) / 2);
    let mut data: Vec<f32> = Vec::new();
    data.try_reserve_exact(w * h).ok()?;
    for y in 0..h {
        let r0 = &src.data[(2 * y) * src.w..(2 * y + 1) * src.w];
        let r1 = if 2 * y + 1 < src.h { &src.data[(2 * y + 1) * src.w..(2 * y + 2) * src.w] } else { &[][..] };
        for x in 0..w {
            let x0 = 2 * x;
            let mut sum = 0.0f64;
            let mut count = 0u32;
            let mut take = |v: f32| {
                if v.is_finite() {
                    sum += v as f64;
                    count += 1;
                }
            };
            take(r0[x0]);
            if x0 + 1 < src.w {
                take(r0[x0 + 1]);
            }
            if !r1.is_empty() {
                take(r1[x0]);
                if x0 + 1 < src.w {
                    take(r1[x0 + 1]);
                }
            }
            data.push(if count == 0 { f32::NAN } else { (sum / count as f64) as f32 });
        }
    }
    Some(Level { w, h, data })
}

/// Builds (or rebuilds) the pyramid until both sides are at most `min_size`. Returns the number of levels (>= 1); the
/// level-0 image is kept even when a coarser level could not be allocated.
#[no_mangle]
pub extern "C" fn img_build_pyramid(handle: u32, min_size: u32) -> u32 {
    let Some(img) = image(handle) else { return 0 };
    img.levels.truncate(1);
    let min_size = min_size.max(1) as usize;
    while {
        let last = img.levels.last().unwrap();
        last.w > min_size || last.h > min_size
    } {
        match halve(img.levels.last().unwrap()) {
            Some(level) => img.levels.push(level),
            None => break,
        }
    }
    img.levels.len() as u32
}

// ---------------------------------------------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------------------------------------------

fn scan_level(level: &Level) -> Scan {
    let mut finite = 0u64;
    let mut nan = 0u64;
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    // Shifted sums (about the first finite value) keep the variance accurate for images with a large offset.
    let shift = level.data.iter().copied().find(|v| v.is_finite()).unwrap_or(0.0) as f64;
    let mut sum = 0.0f64;
    let mut sum2 = 0.0f64;
    for &v in &level.data {
        if v.is_finite() {
            let x = v as f64;
            finite += 1;
            if x < min { min = x; }
            if x > max { max = x; }
            let d = x - shift;
            sum += d;
            sum2 += d * d;
        } else if v.is_nan() {
            nan += 1;
        }
    }
    if finite == 0 {
        return Scan { finite: 0.0, nan: nan as f64, min: f64::NAN, max: f64::NAN, mean: f64::NAN, std: f64::NAN };
    }
    let n = finite as f64;
    let mean_d = sum / n;
    let var = (sum2 / n - mean_d * mean_d).max(0.0);
    Scan { finite: n, nan: nan as f64, min, max, mean: mean_d + shift, std: var.sqrt() }
}

fn scan_of(img: &mut Image) -> Scan {
    if let Some(s) = img.scan {
        return s;
    }
    let s = scan_level(&img.levels[0]);
    img.scan = Some(s);
    s
}

/// One pass over level 0: out[0] finite count, [1] NaN count, [2] min, [3] max, [4] mean, [5] population std.
/// (+-Infinity pixels count as neither finite nor NaN.) Returns 0, or -1 for a bad handle.
#[no_mangle]
pub unsafe extern "C" fn img_scan(handle: u32, out: *mut f64) -> i32 {
    let Some(img) = image(handle) else { return -1 };
    let s = scan_of(img);
    let out = slice_mut(out, 6);
    out.copy_from_slice(&[s.finite, s.nan, s.min, s.max, s.mean, s.std]);
    0
}

const BINS: usize = 1 << 16;
const MAX_COLLECT: usize = 1 << 24; // more values than this in one bin: interpolate inside the bin instead of selecting

/// Exact order statistics of the finite values of level 0 without a sort or a copy of the image: `ranks` are 0-based
/// ranks in ascending order (as f64, so they can exceed 2^32), `out` receives the value at each rank. Two passes: a 65,536
/// bin histogram over [min, max] locates the bin of every rank, a second pass collects only those bins and selects exactly.
/// A bin with more than 16,777,216 values (an almost constant image) is interpolated linearly inside the bin, which is
/// still within one bin width (range / 65,536) of the exact value. Returns the number of interpolated ranks, or -1.
#[no_mangle]
pub unsafe extern "C" fn img_quantile_ranks(handle: u32, ranks: *const f64, count: u32, out: *mut f64) -> i32 {
    let Some(img) = image(handle) else { return -1 };
    let scan = scan_of(img);
    let ranks = slice(ranks, count as usize);
    let out = slice_mut(out, count as usize);
    let level = &img.levels[0];
    if scan.finite == 0.0 {
        out.fill(f64::NAN);
        return 0;
    }
    let (min, max) = (scan.min, scan.max);
    if max == min {
        out.fill(min);
        return 0;
    }
    let width = (max - min) / BINS as f64;
    let bin_of = |x: f64| (((x - min) / width) as usize).min(BINS - 1);
    let mut counts = vec![0u64; BINS];
    for &v in &level.data {
        if v.is_finite() {
            counts[bin_of(v as f64)] += 1;
        }
    }
    let total = scan.finite as u64;
    // Bin and offset for each rank.
    let mut cumulative = vec![0u64; BINS + 1];
    for b in 0..BINS {
        cumulative[b + 1] = cumulative[b] + counts[b];
    }
    let mut wanted: Vec<(usize, u64, usize)> = Vec::with_capacity(ranks.len()); // (bin, offset in bin, index in out)
    for (i, &r) in ranks.iter().enumerate() {
        let rank = if r.is_finite() { (r.max(0.0) as u64).min(total - 1) } else { 0 };
        let bin = match cumulative.binary_search(&(rank + 1)) {
            Ok(mut b) => {
                // cumulative[b] == rank + 1: the rank is the last value of bin b-1; skip empty bins above.
                b -= 1;
                while counts[b] == 0 { b -= 1; }
                b
            }
            Err(b) => b - 1,
        };
        wanted.push((bin, rank - cumulative[bin], i));
    }
    let mut interpolated = 0;
    let mut collect: Vec<Vec<f32>> = Vec::new();
    let mut bins_needed: Vec<usize> = wanted.iter().map(|w| w.0).collect();
    bins_needed.sort_unstable();
    bins_needed.dedup();
    let mut bin_slot = vec![usize::MAX; BINS];
    for &b in &bins_needed {
        if counts[b] as usize <= MAX_COLLECT {
            bin_slot[b] = collect.len();
            let mut v = Vec::new();
            if v.try_reserve_exact(counts[b] as usize).is_err() {
                bin_slot[b] = usize::MAX;
                continue;
            }
            collect.push(v);
        }
    }
    if !collect.is_empty() {
        for &v in &level.data {
            if v.is_finite() {
                let s = bin_slot[bin_of(v as f64)];
                if s != usize::MAX {
                    collect[s].push(v);
                }
            }
        }
    }
    for &(bin, offset, i) in &wanted {
        let s = bin_slot[bin];
        if s == usize::MAX {
            interpolated += 1;
            out[i] = min + width * (bin as f64 + (offset as f64 + 0.5) / counts[bin] as f64);
            continue;
        }
        let values = &mut collect[s];
        let k = offset as usize;
        let (_, v, _) = values.select_nth_unstable_by(k, |a, b| a.partial_cmp(b).unwrap());
        out[i] = *v as f64;
    }
    interpolated
}

/// Histogram of a level: `out` has `bins + 2` counters: [0] below `low`, [1..=bins] the bins over [low, high], [bins+1]
/// above `high`. NaN is not counted. Returns the number of finite values counted, or -1.
#[no_mangle]
pub unsafe extern "C" fn img_histogram(handle: u32, level: u32, low: f64, high: f64, bins: u32, out: *mut u32) -> f64 {
    let Some(img) = image(handle) else { return -1.0 };
    let Some(level) = img.levels.get(level as usize) else { return -1.0 };
    let bins_n = bins.max(1) as usize;
    let out = slice_mut(out, bins_n + 2);
    out.fill(0);
    let span = high - low;
    let mut counted = 0u64;
    for &v in &level.data {
        if !v.is_finite() {
            continue;
        }
        counted += 1;
        let x = v as f64;
        if x < low {
            out[0] += 1;
        } else if x > high {
            out[bins_n + 1] += 1;
        } else {
            let b = if span > 0.0 { (((x - low) / span) * bins_n as f64) as usize } else { 0 };
            out[1 + b.min(bins_n - 1)] += 1;
        }
    }
    counted as f64
}

/// Sampled sigma clipping about the median: at most `max_samples` evenly strided finite values of level 0 (the median
/// of a 1M sample of a 268M image is within ~0.1% quantile). out: [count, mean, median, std, low, high, iterations].
#[no_mangle]
pub unsafe extern "C" fn img_sigma_clip(handle: u32, max_samples: u32, sigma: f64, max_iterations: u32, out: *mut f64) -> i32 {
    let Some(img) = image(handle) else { return -1 };
    let out = slice_mut(out, 7);
    let level = &img.levels[0];
    let n = level.data.len();
    let stride = (n / (max_samples.max(1) as usize)).max(1);
    let mut sample: Vec<f64> = level.data.iter().step_by(stride).copied().filter(|v| v.is_finite()).map(|v| v as f64).collect();
    if sample.is_empty() {
        out.copy_from_slice(&[0.0, f64::NAN, f64::NAN, f64::NAN, f64::NEG_INFINITY, f64::INFINITY, 0.0]);
        return 0;
    }
    sample.sort_unstable_by(|a, b| a.partial_cmp(b).unwrap());
    let (mut lo, mut hi) = (f64::NEG_INFINITY, f64::INFINITY);
    let (mut from, mut to) = (0usize, sample.len());
    let stats = |s: &[f64]| {
        let n = s.len() as f64;
        let mean = s.iter().sum::<f64>() / n;
        let m2 = s.iter().map(|x| (x - mean) * (x - mean)).sum::<f64>();
        let median = if s.len() % 2 == 1 { s[(s.len() - 1) / 2] } else { (s[s.len() / 2 - 1] + s[s.len() / 2]) / 2.0 };
        (mean, median, (m2 / n).sqrt())
    };
    let (mut mean, mut median, mut std) = stats(&sample[from..to]);
    let mut iterations = 0;
    while iterations < max_iterations {
        let (next_lo, next_hi) = (median - sigma * std, median + sigma * std);
        let next_from = sample.partition_point(|&x| x < next_lo);
        let next_to = sample.partition_point(|&x| x <= next_hi);
        if next_to <= next_from || (next_from == from && next_to == to) {
            break;
        }
        iterations += 1;
        lo = next_lo;
        hi = next_hi;
        from = next_from;
        to = next_to;
        let s = stats(&sample[from..to]);
        mean = s.0;
        median = s.1;
        std = s.2;
    }
    out.copy_from_slice(&[(to - from) as f64, mean, median, std, lo, hi, iterations as f64]);
    0
}

// ---------------------------------------------------------------------------------------------------------------------
// Display tiles
// ---------------------------------------------------------------------------------------------------------------------

#[inline(always)]
fn stretch(t: f64, mode: u32) -> f64 {
    match mode {
        1 => t.sqrt(),
        2 => {
            // asinh stretch with softening a = 0.1 (as astropy.visualization.AsinhStretch)
            const A: f64 = 0.1;
            (t / A).asinh() / (1.0 / A).asinh()
        }
        3 => {
            const A: f64 = 1000.0;
            (A * t + 1.0).ln() / (A + 1.0).ln()
        }
        _ => t,
    }
}

/// Renders a `tw` x `th` RGBA tile of `level` whose top-left corner is at canvas coordinates (x0, y0) of that level
/// (canvas row 0 = top of the picture). Pixels outside the level and non-finite pixels are transparent (0).
/// t = clamp((v - low) / (high - low)); shade = round(255 * stretch(t)); `lut` is null (grayscale) or 768 bytes of RGB.
/// Returns 0, or -1 for a bad handle / level.
#[no_mangle]
pub unsafe extern "C" fn img_render_tile(handle: u32, level: u32, x0: i32, y0: i32, tw: u32, th: u32, low: f64, high: f64, mode: u32, lut: *const u8, out: *mut u32) -> i32 {
    let Some(img) = image(handle) else { return -1 };
    let Some(level) = img.levels.get(level as usize) else { return -1 };
    let (tw, th) = (tw as usize, th as usize);
    let out = slice_mut(out, tw * th);
    let lut = if lut.is_null() { None } else { Some(slice(lut, 768)) };
    let (lw, lh) = (level.w as i64, level.h as i64);
    let span = high - low;
    // 256-entry colour table for this tile (stretch applied once per shade level, not per pixel).
    let mut table = [0u32; 256];
    for (i, word) in table.iter_mut().enumerate() {
        let shade = (255.0 * stretch(i as f64 / 255.0, mode)).round().clamp(0.0, 255.0) as u32;
        *word = match lut {
            None => 0xFF00_0000 | (shade << 16) | (shade << 8) | shade,
            Some(l) => 0xFF00_0000 | ((l[3 * shade as usize + 2] as u32) << 16) | ((l[3 * shade as usize + 1] as u32) << 8) | l[3 * shade as usize] as u32,
        };
    }
    for cy in 0..th {
        let ly = y0 as i64 + cy as i64;
        let dst = &mut out[cy * tw..(cy + 1) * tw];
        if ly < 0 || ly >= lh {
            dst.fill(0);
            continue;
        }
        let row = (lh - 1 - ly) as usize * level.w;
        for (cx, slot) in dst.iter_mut().enumerate() {
            let lx = x0 as i64 + cx as i64;
            if lx < 0 || lx >= lw {
                *slot = 0;
                continue;
            }
            let v = level.data[row + lx as usize];
            if !v.is_finite() {
                *slot = 0;
                continue;
            }
            let t = if span > 0.0 { ((v as f64 - low) / span).clamp(0.0, 1.0) } else { 0.5 };
            *slot = table[(t * 255.0 + 0.5) as usize];
        }
    }
    0
}

/// Writes the finite values of a rectangle of level 0 (FITS 0-based column/row ranges, row order) into `out`, NaN kept;
/// returns the count written or -1. Used for pixel readouts, small cutouts and tests.
#[no_mangle]
pub unsafe extern "C" fn img_read_rect(handle: u32, x0: u32, y0: u32, w: u32, h: u32, out: *mut f32) -> i32 {
    let Some(img) = image(handle) else { return -1 };
    let level = &img.levels[0];
    let (x0, y0, w, h) = (x0 as usize, y0 as usize, w as usize, h as usize);
    if x0 + w > level.w || y0 + h > level.h {
        return -1;
    }
    let out = slice_mut(out, w * h);
    for r in 0..h {
        out[r * w..(r + 1) * w].copy_from_slice(&level.data[(y0 + r) * level.w + x0..(y0 + r) * level.w + x0 + w]);
    }
    (w * h) as i32
}
