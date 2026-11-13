//! fitsdata: the per-pixel loops that every AstroNot image tool shares (FITS pixel decoding, display statistics,
//! grayscale / diverging RGBA fills, subtraction with validity masks, mosaic accumulation and combination).
//!
//! Every function is a plain `extern "C"` function over raw pointers into linear memory; `tools/fits.js` and
//! `tools/pixels.js` own the JavaScript side, keep a JS twin of each function and compare against it in
//! `tests/fitsdata-wasm.test.mjs`. Where a result must match the JavaScript twin bit for bit, the arithmetic is written in
//! the same order as the JavaScript (no reassociation of sums, no fused multiply-add, rounding as Uint8ClampedArray does).
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
    if len == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len)
    }
}

unsafe fn slice_mut<'a, T>(ptr: *mut T, len: usize) -> &'a mut [T] {
    if len == 0 {
        &mut []
    } else {
        std::slice::from_raw_parts_mut(ptr, len)
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// FITS pixel decoding
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

/// Raw value of pixel `i` as a JS number would read it (getUint8 / getInt16 / getInt32 / getFloat32 / getFloat64, big endian).
/// `bitpix` must be one of 8, 16, 32, -32, -64 (checked by the callers).
#[inline(always)]
unsafe fn raw_at(src: *const u8, bitpix: i32, i: usize) -> f64 {
    match bitpix {
        8 => *src.add(i) as f64,
        16 => be16(src, i) as i16 as f64,
        32 => be32(src, i) as i32 as f64,
        -32 => f32::from_bits(be32(src, i)) as f64,
        _ => f64::from_bits(be64(src, i)),
    }
}

/// `raw === blank ? NaN : raw * scale + zero`, exactly as tools/fits.js fitsPixelReader.
#[inline(always)]
fn calibrate(raw: f64, scale: f64, zero: f64, has_blank: bool, blank: f64) -> f64 {
    if has_blank && raw == blank {
        f64::NAN
    } else {
        raw * scale + zero
    }
}

#[inline(always)]
unsafe fn decode_loop<const BITPIX: i32>(src: *const u8, n: usize, scale: f64, zero: f64, has_blank: bool, blank: f64, mut put: impl FnMut(usize, f64)) {
    for i in 0..n {
        put(i, calibrate(raw_at(src, BITPIX, i), scale, zero, has_blank, blank));
    }
}

/// Decodes `n` big-endian pixels of `bitpix` (8, 16, 32, -32, -64) into f64, applying BSCALE/BZERO and BLANK.
#[no_mangle]
pub unsafe extern "C" fn fd_decode_f64(src: *const u8, n: usize, bitpix: i32, scale: f64, zero: f64, has_blank: i32, blank: f64, out: *mut f64) {
    let out = slice_mut(out, n);
    let hb = has_blank != 0;
    match bitpix {
        8 => decode_loop::<8>(src, n, scale, zero, hb, blank, |i, v| out[i] = v),
        16 => decode_loop::<16>(src, n, scale, zero, hb, blank, |i, v| out[i] = v),
        32 => decode_loop::<32>(src, n, scale, zero, hb, blank, |i, v| out[i] = v),
        -32 => decode_loop::<-32>(src, n, scale, zero, hb, blank, |i, v| out[i] = v),
        _ => decode_loop::<-64>(src, n, scale, zero, hb, blank, |i, v| out[i] = v),
    }
}

/// Same as fd_decode_f64 but stores f32 (round to nearest, as a Float32Array store does).
#[no_mangle]
pub unsafe extern "C" fn fd_decode_f32(src: *const u8, n: usize, bitpix: i32, scale: f64, zero: f64, has_blank: i32, blank: f64, out: *mut f32) {
    let out = slice_mut(out, n);
    let hb = has_blank != 0;
    match bitpix {
        8 => decode_loop::<8>(src, n, scale, zero, hb, blank, |i, v| out[i] = v as f32),
        16 => decode_loop::<16>(src, n, scale, zero, hb, blank, |i, v| out[i] = v as f32),
        32 => decode_loop::<32>(src, n, scale, zero, hb, blank, |i, v| out[i] = v as f32),
        -32 => decode_loop::<-32>(src, n, scale, zero, hb, blank, |i, v| out[i] = v as f32),
        _ => decode_loop::<-64>(src, n, scale, zero, hb, blank, |i, v| out[i] = v as f32),
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// RGBA fills (ImageData). Output is little-endian RGBA words, so 0xAABBGGRR; R = G = B = shade for grayscale.
// ---------------------------------------------------------------------------------------------------------------------

/// Uint8ClampedArray store: NaN -> 0, clamp to 0..255, round half to even.
#[inline(always)]
fn to_u8_clamped(x: f64) -> u32 {
    if x.is_nan() || x <= 0.0 {
        0
    } else if x >= 255.0 {
        255
    } else {
        x.round_ties_even() as u32
    }
}

#[inline(always)]
fn gray_word(shade: u32) -> u32 {
    0xFF00_0000 | (shade << 16) | (shade << 8) | shade
}

/// Shading constants: shade = clamp(255 * (value / divisor - low_over_divisor) / span), see drawFitsImage.
/// With divisor 1 the division is skipped (value / 1 is value).
#[derive(Clone, Copy)]
struct Shade {
    divisor: f64,
    low: f64,
    span: f64,
    unit: bool,
}

impl Shade {
    /// Shade of one value; `finite_check` makes a non-finite value 0 (otherwise NaN -> 0 and +-inf clamp, as Uint8ClampedArray).
    #[inline(always)]
    fn one(&self, value: f64, finite_check: bool) -> u32 {
        if finite_check && !value.is_finite() {
            return 0;
        }
        let scaled = if self.unit { value - self.low } else { value / self.divisor - self.low };
        to_u8_clamped(255.0 * scaled / self.span)
    }
}

#[cfg(target_feature = "simd128")]
mod simd {
    use super::Shade;
    use core::arch::wasm32::*;

    /// Two shaded pixels as RGBA words in lanes 0 and 1 (lanes 2, 3 are junk), the same arithmetic as Shade::one on each lane.
    #[inline(always)]
    pub fn shade_pair(v: v128, s: &Shade, finite_check: bool) -> v128 {
        let scaled = if s.unit { f64x2_sub(v, f64x2_splat(s.low)) } else { f64x2_sub(f64x2_div(v, f64x2_splat(s.divisor)), f64x2_splat(s.low)) };
        let x = f64x2_div(f64x2_mul(f64x2_splat(255.0), scaled), f64x2_splat(s.span));
        let x = v128_and(x, f64x2_gt(x, f64x2_splat(0.0))); // NaN and values <= 0 become +0
        let x = f64x2_nearest(f64x2_min(x, f64x2_splat(255.0))); // round half to even
        let x = if finite_check { v128_and(x, f64x2_eq(f64x2_sub(v, v), f64x2_splat(0.0))) } else { x };
        let shade = i32x4_trunc_sat_f64x2_zero(x);
        v128_or(i32x4_mul(shade, i32x4_splat(0x0001_0101)), i32x4_splat(0xFF00_0000u32 as i32))
    }

    #[inline(always)]
    pub fn words(pair: v128) -> (u32, u32) {
        (i32x4_extract_lane::<0>(pair) as u32, i32x4_extract_lane::<1>(pair) as u32)
    }

    /// Slots (0..=512) of the diverging table for two differences: round(clamp(d / limit, -1, 1) * 256) + 256 (NaN -> 256).
    #[inline(always)]
    pub fn diverging_slots(d: v128, limit: f64) -> (usize, usize) {
        let t = f64x2_max(f64x2_min(f64x2_div(d, f64x2_splat(limit)), f64x2_splat(1.0)), f64x2_splat(-1.0));
        let x = f64x2_mul(t, f64x2_splat(256.0));
        let f = f64x2_floor(x);
        let up = v128_and(f64x2_ge(f64x2_sub(x, f), f64x2_splat(0.5)), f64x2_splat(1.0)); // Math.round: ties go up
        let slot = f64x2_add(f64x2_add(f, up), f64x2_splat(256.0));
        let slot = v128_bitselect(slot, f64x2_splat(256.0), f64x2_eq(slot, slot));
        let i = i32x4_trunc_sat_f64x2_zero(slot);
        (i32x4_extract_lane::<0>(i) as usize, i32x4_extract_lane::<1>(i) as usize)
    }
}

/// drawFitsImage: decodes `rows` source rows (row 0 of the band is the first source row) and writes the shaded RGBA band
/// flipped vertically, so the band can be copied straight to the canvas rows (height - lastRow - 1 ..).
/// Pixel shade: non-finite -> 0; span === 0 -> 128; else 255 * (value / divisor - low_over_divisor) / span.
#[no_mangle]
pub unsafe extern "C" fn fd_shade_raw(
    src: *const u8, width: usize, rows: usize, bitpix: i32, scale: f64, zero: f64, has_blank: i32, blank: f64,
    divisor: f64, low_over_divisor: f64, span: f64, out: *mut u32,
) {
    let out = slice_mut(out, width * rows);
    let hb = has_blank != 0;
    let shade = Shade { divisor, low: low_over_divisor, span, unit: divisor == 1.0 };
    macro_rules! run {
        ($bp:literal) => {
            for row in 0..rows {
                let dst = &mut out[(rows - 1 - row) * width..(rows - row) * width];
                let base = row * width;
                let value = |x: usize| calibrate(raw_at(src, $bp, base + x), scale, zero, hb, blank);
                let mut x = 0;
                if span != 0.0 {
                    #[cfg(target_feature = "simd128")]
                    while x + 2 <= width {
                        let v = core::arch::wasm32::f64x2(value(x), value(x + 1));
                        let (a, b) = simd::words(simd::shade_pair(v, &shade, true));
                        dst[x] = a;
                        dst[x + 1] = b;
                        x += 2;
                    }
                }
                while x < width {
                    let v = value(x);
                    dst[x] = gray_word(if !v.is_finite() { 0 } else if span == 0.0 { 128 } else { shade.one(v, true) });
                    x += 1;
                }
            }
        };
    }
    match bitpix {
        8 => run!(8),
        16 => run!(16),
        32 => run!(32),
        -32 => run!(-32),
        _ => run!(-64),
    }
}

/// Grayscale fill of already calibrated values (the paint loops of Time Machine, Image Differencing, Mosaic Builder, Motion).
/// mode 0: a pixel with valid == 0 (or no range at all) stays transparent (0); mode 1: a non-finite value is opaque black.
/// shade = span > 0 ? clamp(255 * (value - low) / span) : 128. `valid` may be null. Rows are written flipped like fd_shade_raw.
#[no_mangle]
pub unsafe extern "C" fn fd_paint_gray(values: *const f64, valid: *const u8, width: usize, rows: usize, has_range: i32, low: f64, span: f64, mode: i32, out: *mut u32) {
    let values = slice(values, width * rows);
    let out = slice_mut(out, width * rows);
    let valid = if valid.is_null() { None } else { Some(slice(valid, width * rows)) };
    let shade = Shade { divisor: 1.0, low, span, unit: true };
    let finite_mode = mode != 0;
    for row in 0..rows {
        let src = &values[row * width..(row + 1) * width];
        let flags = valid.map(|v| &v[row * width..(row + 1) * width]);
        let dst = &mut out[(rows - 1 - row) * width..(rows - row) * width];
        if !finite_mode && has_range == 0 {
            dst.fill(0);
            continue;
        }
        let mut x = 0;
        if span > 0.0 {
            #[cfg(target_feature = "simd128")]
            while x + 2 <= width {
                let v = core::arch::wasm32::v128_load(src.as_ptr().add(x) as *const core::arch::wasm32::v128);
                let (mut a, mut b) = simd::words(simd::shade_pair(v, &shade, finite_mode));
                if !finite_mode {
                    if let Some(f) = flags {
                        if f[x] == 0 {
                            a = 0;
                        }
                        if f[x + 1] == 0 {
                            b = 0;
                        }
                    }
                }
                dst[x] = a;
                dst[x + 1] = b;
                x += 2;
            }
        }
        while x < width {
            let value = src[x];
            dst[x] = if finite_mode {
                if !value.is_finite() {
                    0xFF00_0000
                } else if span > 0.0 {
                    gray_word(shade.one(value, false))
                } else {
                    gray_word(128)
                }
            } else if flags.map_or(false, |f| f[x] == 0) {
                0
            } else if span > 0.0 {
                gray_word(shade.one(value, false))
            } else {
                gray_word(128)
            };
            x += 1;
        }
    }
}

/// Math.round for values in a small range: floor(x + 0.5) without the rounding error of the addition.
#[inline(always)]
fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

/// Diverging colour fill (Image Differencing / Motion): t = clamp(diff / limit, -1, 1); colour = table[round(t * 256) + 256]
/// where `table` holds 513 RGB triples built by the page from Diff.divergingColor. Invalid pixels stay transparent.
#[no_mangle]
pub unsafe extern "C" fn fd_paint_diverging(diff: *const f64, valid: *const u8, width: usize, rows: usize, limit: f64, table: *const u8, out: *mut u32) {
    let diff = slice(diff, width * rows);
    let valid = slice(valid, width * rows);
    let table = slice(table, 513 * 3);
    let out = slice_mut(out, width * rows);
    let mut words = [0u32; 513];
    for (slot, word) in words.iter_mut().enumerate() {
        let c = &table[slot * 3..slot * 3 + 3];
        *word = 0xFF00_0000 | ((c[2] as u32) << 16) | ((c[1] as u32) << 8) | c[0] as u32;
    }
    for row in 0..rows {
        let src = &diff[row * width..(row + 1) * width];
        let flags = &valid[row * width..(row + 1) * width];
        let dst = &mut out[(rows - 1 - row) * width..(rows - row) * width];
        let mut x = 0;
        #[cfg(target_feature = "simd128")]
        while x + 2 <= width {
            let v = core::arch::wasm32::v128_load(src.as_ptr().add(x) as *const core::arch::wasm32::v128);
            let (a, b) = simd::diverging_slots(v, limit);
            // A slot can only be out of range for an infinite or NaN limit; the table lookup stays inside it.
            dst[x] = if flags[x] == 0 { 0 } else { words[a.min(512)] };
            dst[x + 1] = if flags[x + 1] == 0 { 0 } else { words[b.min(512)] };
            x += 2;
        }
        while x < width {
            dst[x] = if flags[x] == 0 {
                0
            } else {
                let mut t = src[x] / limit;
                if t > 1.0 {
                    t = 1.0;
                } else if t < -1.0 {
                    t = -1.0;
                }
                let slot = if t.is_nan() { 256 } else { (js_round(t * 256.0) + 256.0) as usize };
                words[slot.min(512)]
            };
            x += 1;
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Statistics: exact order statistics (radix selection, no sort, no copy), moments, sigma clipping.
// A value takes part when it is finite, `valid` (when not null) is non-zero, and lo <= x <= hi, where x = |value| if `abs`.
// ---------------------------------------------------------------------------------------------------------------------

#[inline(always)]
unsafe fn for_each_included(values: *const f64, valid: *const u8, n: usize, abs: bool, lo: f64, hi: f64, mut f: impl FnMut(f64)) {
    let values = slice(values, n);
    if valid.is_null() {
        for &v in values {
            let x = if abs { v.abs() } else { v };
            if x.is_finite() && x >= lo && x <= hi {
                f(x);
            }
        }
    } else {
        let valid = slice(valid, n);
        for (i, &v) in values.iter().enumerate() {
            let x = if abs { v.abs() } else { v };
            if valid[i] != 0 && x.is_finite() && x >= lo && x <= hi {
                f(x);
            }
        }
    }
}

#[inline(always)]
fn key(x: f64) -> u64 {
    let bits = x.to_bits();
    if bits >> 63 == 1 {
        !bits
    } else {
        bits | (1 << 63)
    }
}

#[inline(always)]
fn unkey(k: u64) -> f64 {
    if k >> 63 == 1 {
        f64::from_bits(k & !(1u64 << 63))
    } else {
        f64::from_bits(!k)
    }
}

unsafe fn count_included(values: *const f64, valid: *const u8, n: usize, abs: bool, lo: f64, hi: f64) -> usize {
    let mut count = 0usize;
    for_each_included(values, valid, n, abs, lo, hi, |_| count += 1);
    count
}

/// The `rank`-th smallest (0-based) included value, by four 16-bit radix passes over the order-preserving key of the f64.
unsafe fn nth_included(values: *const f64, valid: *const u8, n: usize, abs: bool, lo: f64, hi: f64, rank: usize) -> f64 {
    let mut hist = vec![0u32; 65536];
    let mut rank = rank as u64;
    let mut prefix = 0u64;
    for pass in 0..4u32 {
        let shift = 48 - 16 * pass;
        hist.fill(0);
        if pass == 0 {
            for_each_included(values, valid, n, abs, lo, hi, |x| hist[(key(x) >> 48) as usize] += 1);
        } else {
            let upper = shift + 16;
            for_each_included(values, valid, n, abs, lo, hi, |x| {
                let k = key(x);
                if k >> upper == prefix {
                    hist[((k >> shift) & 0xFFFF) as usize] += 1;
                }
            });
        }
        let mut below = 0u64;
        let mut digit = 0usize;
        while digit < 65535 {
            let c = hist[digit] as u64;
            if below + c > rank {
                break;
            }
            below += c;
            digit += 1;
        }
        rank -= below;
        prefix = (prefix << 16) | digit as u64;
    }
    unkey(prefix)
}

/// Number of included values.
#[no_mangle]
pub unsafe extern "C" fn fd_count(values: *const f64, valid: *const u8, n: usize, abs: i32, lo: f64, hi: f64) -> u32 {
    count_included(values, valid, n, abs != 0, lo, hi) as u32
}

/// The rank-th smallest included value (0-based); NaN when rank >= count.
#[no_mangle]
pub unsafe extern "C" fn fd_nth(values: *const f64, valid: *const u8, n: usize, abs: i32, lo: f64, hi: f64, rank: u32) -> f64 {
    nth_included(values, valid, n, abs != 0, lo, hi, rank as usize)
}

/// Several order statistics in one go (at most 16 ranks): the radix passes run for all ranks together, so k percentiles cost
/// about k scans per pass instead of k full selections. out[i] = the ranks[i]-th smallest included value, NaN when out of range.
#[no_mangle]
pub unsafe extern "C" fn fd_nth_multi(values: *const f64, valid: *const u8, n: usize, abs: i32, lo: f64, hi: f64, ranks: *const u32, k: usize, out: *mut f64) {
    let abs = abs != 0;
    let k = k.min(16);
    let ranks = slice(ranks, k);
    let out = slice_mut(out, k);
    let count = count_included(values, valid, n, abs, lo, hi) as u64;
    let mut remaining: Vec<u64> = ranks.iter().map(|&r| r as u64).collect();
    let mut prefix = vec![0u64; k];
    let mut hists: Vec<Vec<u32>> = (0..k).map(|_| vec![0u32; 65536]).collect();
    for pass in 0..4u32 {
        let shift = 48 - 16 * pass;
        for h in hists.iter_mut() {
            h.fill(0);
        }
        if pass == 0 {
            let h = &mut hists[0];
            for_each_included(values, valid, n, abs, lo, hi, |x| h[(key(x) >> 48) as usize] += 1);
            let (first, rest) = hists.split_at_mut(1);
            for other in rest.iter_mut() {
                other.copy_from_slice(&first[0]);
            }
        } else {
            let upper = shift + 16;
            for_each_included(values, valid, n, abs, lo, hi, |x| {
                let kx = key(x);
                let digit = ((kx >> shift) & 0xFFFF) as usize;
                for r in 0..k {
                    if kx >> upper == prefix[r] {
                        hists[r][digit] += 1;
                    }
                }
            });
        }
        for r in 0..k {
            let mut below = 0u64;
            let mut digit = 0usize;
            while digit < 65535 {
                let c = hists[r][digit] as u64;
                if below + c > remaining[r] {
                    break;
                }
                below += c;
                digit += 1;
            }
            remaining[r] = remaining[r].saturating_sub(below);
            prefix[r] = (prefix[r] << 16) | digit as u64;
        }
    }
    for r in 0..k {
        out[r] = if (ranks[r] as u64) < count { unkey(prefix[r]) } else { f64::NAN };
    }
}

#[inline(always)]
unsafe fn moments(values: *const f64, valid: *const u8, n: usize, abs: bool, lo: f64, hi: f64) -> [f64; 6] {
    let mut count = 0usize;
    let mut sum = 0.0f64;
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for_each_included(values, valid, n, abs, lo, hi, |x| {
        count += 1;
        sum += x;
        if x < min {
            min = x;
        }
        if x > max {
            max = x;
        }
    });
    if count == 0 {
        return [0.0, 0.0, f64::NAN, f64::NAN, f64::NAN, f64::NAN];
    }
    let mean = sum / count as f64;
    let mut m2 = 0.0f64;
    for_each_included(values, valid, n, abs, lo, hi, |x| {
        let d = x - mean;
        m2 += d * d;
    });
    [count as f64, sum, mean, m2, min, max]
}

/// out[0..6] = count, sum, mean, sum of squared deviations from the mean (two pass), min, max over the included values.
#[no_mangle]
pub unsafe extern "C" fn fd_moments(values: *const f64, valid: *const u8, n: usize, abs: i32, lo: f64, hi: f64, out: *mut f64) {
    slice_mut(out, 6).copy_from_slice(&moments(values, valid, n, abs != 0, lo, hi));
}

unsafe fn median_of(values: *const f64, valid: *const u8, n: usize, abs: bool, lo: f64, hi: f64, count: usize) -> f64 {
    if count % 2 == 1 {
        nth_included(values, valid, n, abs, lo, hi, count / 2)
    } else {
        let a = nth_included(values, valid, n, abs, lo, hi, count / 2 - 1);
        let b = nth_included(values, valid, n, abs, lo, hi, count / 2);
        (a + b) / 2.0
    }
}

/// Iterative sigma clipping about the median (population standard deviation, like astropy sigma_clipped_stats with
/// default cenfunc/stdfunc except ddof = 0): stats of all finite values, then up to `max_iterations` times keep
/// median +- sigma * std until the count stops changing.
/// out[0..7] = count, mean, median, std, low bound, high bound, iterations done (of the final retained set).
#[no_mangle]
pub unsafe extern "C" fn fd_sigma_clip(values: *const f64, valid: *const u8, n: usize, sigma: f64, max_iterations: u32, out: *mut f64) {
    let out = slice_mut(out, 7);
    let (mut lo, mut hi) = (f64::NEG_INFINITY, f64::INFINITY);
    let mut count = count_included(values, valid, n, false, lo, hi);
    if count == 0 {
        out.copy_from_slice(&[0.0, f64::NAN, f64::NAN, f64::NAN, lo, hi, 0.0]);
        return;
    }
    let stats = |lo: f64, hi: f64, count: usize| {
        let m = moments(values, valid, n, false, lo, hi);
        let median = median_of(values, valid, n, false, lo, hi, count);
        (m[2], median, (m[3] / count as f64).sqrt())
    };
    let (mut mean, mut median, mut std) = stats(lo, hi, count);
    let mut iterations = 0u32;
    while iterations < max_iterations {
        let next_lo = median - sigma * std;
        let next_hi = median + sigma * std;
        let next_count = count_included(values, valid, n, false, next_lo, next_hi);
        if next_count == count || next_count == 0 {
            break;
        }
        iterations += 1;
        lo = next_lo;
        hi = next_hi;
        count = next_count;
        let s = stats(lo, hi, count);
        mean = s.0;
        median = s.1;
        std = s.2;
    }
    out.copy_from_slice(&[count as f64, mean, median, std, lo, hi, iterations as f64]);
}

// ---------------------------------------------------------------------------------------------------------------------
// Subtraction with validity masks (the "direct" path of tools/difference.js computeDifference) and the variance sum.
// Status codes as Diff.status: valid 0, outside 1, referenceInvalid 2, targetInvalid 3.
// ---------------------------------------------------------------------------------------------------------------------

/// target * factor, the pixel states, the difference and the validity maps. `ref_mask` / `target_mask` may be null.
/// counts[0..5] = covered, valid, outside, referenceInvalid, targetInvalid.
#[no_mangle]
pub unsafe extern "C" fn fd_subtract(
    reference: *const f64, target: *const f64, ref_mask: *const u8, target_mask: *const u8, factor: f64, n: usize,
    target_out: *mut f64, state_out: *mut u8, diff_out: *mut f64, valid_out: *mut u8, ref_valid_out: *mut u8, target_valid_out: *mut u8,
    counts: *mut u32,
) {
    let reference = slice(reference, n);
    let target = slice(target, n);
    let ref_mask = if ref_mask.is_null() { None } else { Some(slice(ref_mask, n)) };
    let target_mask = if target_mask.is_null() { None } else { Some(slice(target_mask, n)) };
    let target_out = slice_mut(target_out, n);
    let state_out = slice_mut(state_out, n);
    let diff_out = slice_mut(diff_out, n);
    let valid_out = slice_mut(valid_out, n);
    let ref_valid_out = slice_mut(ref_valid_out, n);
    let target_valid_out = slice_mut(target_valid_out, n);
    let (mut valid_count, mut ref_bad_count, mut target_bad_count) = (0u32, 0u32, 0u32);
    for i in 0..n {
        let scaled = target[i] * factor;
        target_out[i] = scaled;
        let target_input_bad = !target[i].is_finite() || target_mask.map_or(false, |m| m[i] != 0);
        let reference_bad = !reference[i].is_finite() || ref_mask.map_or(false, |m| m[i] != 0);
        let target_bad = target_input_bad || !scaled.is_finite();
        ref_valid_out[i] = !reference_bad as u8;
        target_valid_out[i] = !target_bad as u8;
        if reference_bad {
            state_out[i] = 2;
            ref_bad_count += 1;
            diff_out[i] = f64::NAN;
            valid_out[i] = 0;
        } else if target_bad {
            state_out[i] = 3;
            target_bad_count += 1;
            diff_out[i] = f64::NAN;
            valid_out[i] = 0;
        } else {
            state_out[i] = 0;
            diff_out[i] = scaled - reference[i];
            valid_out[i] = 1;
            valid_count += 1;
        }
    }
    let counts = slice_mut(counts, 5);
    counts[0] = n as u32;
    counts[1] = valid_count;
    counts[2] = 0;
    counts[3] = ref_bad_count;
    counts[4] = target_bad_count;
}

/// Var(diff) = Var(reference) + Var(target * factor) and the SNR, on valid pixels; others become NaN. Returns the number of
/// pixels with a usable variance (sum finite and >= 0, reference variance >= 0). `variance_out` / `snr_out` are filled with NaN first.
#[no_mangle]
pub unsafe extern "C" fn fd_variance_sum(
    ref_variance: *const f64, target_variance: *const f64, factor: f64, diff: *const f64, valid: *const u8, n: usize,
    variance_out: *mut f64, snr_out: *mut f64,
) -> u32 {
    let ref_variance = slice(ref_variance, n);
    let target_variance = slice(target_variance, n);
    let diff = slice(diff, n);
    let valid = slice(valid, n);
    let variance_out = slice_mut(variance_out, n);
    let snr_out = slice_mut(snr_out, n);
    let mut with_variance = 0u32;
    for i in 0..n {
        variance_out[i] = f64::NAN;
        snr_out[i] = f64::NAN;
        if valid[i] == 0 {
            continue;
        }
        let sum = ref_variance[i] + target_variance[i] * factor * factor;
        if sum.is_finite() && sum >= 0.0 && ref_variance[i] >= 0.0 {
            variance_out[i] = sum;
            with_variance += 1;
            if sum > 0.0 {
                snr_out[i] = diff[i] / sum.sqrt();
            }
        }
    }
    with_variance
}

// ---------------------------------------------------------------------------------------------------------------------
// Mosaic accumulation and combination (the per-pixel loops of tools/mosaic-model.js mosaicSteps).
// ---------------------------------------------------------------------------------------------------------------------

/// Adds one reprojected input window (cols x rows, placed at column c0 / row r0 of the output grid, width `grid_width`) into the
/// accumulators. state: 0 valid, 1 outside, 3 invalid. mode 0 = equal weights, 1 = inverse variance. `part_variance` may be null
/// (then no variance is used); `var_sum`/`var_bad` may be null. counters[0..4] += footprint, valid, invalid, noVariance.
#[no_mangle]
pub unsafe extern "C" fn fd_mosaic_accumulate(
    part_values: *const f64, part_variance: *const f64, part_state: *const u8, cols: usize, rows: usize,
    grid_width: usize, c0: usize, r0: usize, factor: f64, mode: i32,
    sums: *mut f64, weights: *mut f64, var_sum: *mut f64, var_bad: *mut u8, coverage: *mut u16, counters: *mut u32,
) {
    let count = cols * rows;
    let values = slice(part_values, count);
    let state = slice(part_state, count);
    let variance = if part_variance.is_null() { None } else { Some(slice(part_variance, count)) };
    let counters = slice_mut(counters, 4);
    let total = (r0 + rows) * grid_width;
    let sums = slice_mut(sums, total);
    let coverage = slice_mut(coverage, total);
    let mut weights = if weights.is_null() { None } else { Some(slice_mut(weights, total)) };
    let mut var_sum = if var_sum.is_null() { None } else { Some(slice_mut(var_sum, total)) };
    let mut var_bad = if var_bad.is_null() { None } else { Some(slice_mut(var_bad, total)) };
    let (mut footprint, mut valid, mut invalid, mut no_variance) = (0u32, 0u32, 0u32, 0u32);
    for row in 0..rows {
        for column in 0..cols {
            let at = row * cols + column;
            let out = (r0 + row) * grid_width + c0 + column;
            let s = state[at];
            if s == 1 {
                continue;
            }
            footprint += 1;
            let value = values[at] * factor;
            if s != 0 || !value.is_finite() {
                invalid += 1;
                continue;
            }
            if mode == 1 {
                let var = variance.map_or(f64::NAN, |v| v[at]) * factor * factor;
                if !(var.is_finite() && var > 0.0) {
                    no_variance += 1;
                    continue;
                }
                let weight = 1.0 / var;
                sums[out] += weight * value;
                if let Some(w) = weights.as_mut() {
                    w[out] += weight;
                }
            } else {
                sums[out] += value;
                if let Some(vs) = var_sum.as_mut() {
                    let var = variance.map_or(f64::NAN, |v| v[at]) * factor * factor;
                    if var.is_finite() && var >= 0.0 {
                        vs[out] += var;
                    } else if let Some(vb) = var_bad.as_mut() {
                        vb[out] = 1;
                    }
                }
            }
            coverage[out] = coverage[out].wrapping_add(1);
            valid += 1;
        }
    }
    counters[0] += footprint;
    counters[1] += valid;
    counters[2] += invalid;
    counters[3] += no_variance;
}

/// The final pass: values = sums / weights (mode 1) or sums / count (mode 0), variance = 1 / weights or var_sum / count^2
/// (mode 0, only where var_bad == 0), valid = coverage > 0, histogram[coverage]++ (entries above hist_len are skipped).
/// `values_out` and `variance_out` (may be null) are written for every pixel (NaN where not covered). Returns the valid count.
#[no_mangle]
pub unsafe extern "C" fn fd_mosaic_combine(
    sums: *const f64, weights: *const f64, var_sum: *const f64, var_bad: *const u8, coverage: *const u16, n: usize, mode: i32,
    values_out: *mut f64, valid_out: *mut u8, variance_out: *mut f64, histogram: *mut u32, hist_len: usize,
) -> u32 {
    let sums = slice(sums, n);
    let coverage = slice(coverage, n);
    let values_out = slice_mut(values_out, n);
    let valid_out = slice_mut(valid_out, n);
    let histogram = slice_mut(histogram, hist_len);
    let weights = if weights.is_null() { None } else { Some(slice(weights, n)) };
    let var_sum = if var_sum.is_null() { None } else { Some(slice(var_sum, n)) };
    let var_bad = if var_bad.is_null() { None } else { Some(slice(var_bad, n)) };
    let mut variance_out = if variance_out.is_null() { None } else { Some(slice_mut(variance_out, n)) };
    let mut valid_count = 0u32;
    for i in 0..n {
        let count = coverage[i] as usize;
        if count < hist_len {
            histogram[count] += 1;
        }
        if let Some(v) = variance_out.as_mut() {
            v[i] = f64::NAN;
        }
        if count == 0 {
            values_out[i] = f64::NAN;
            valid_out[i] = 0;
            continue;
        }
        valid_out[i] = 1;
        valid_count += 1;
        if mode == 1 {
            let w = weights.map_or(f64::NAN, |w| w[i]);
            values_out[i] = sums[i] / w;
            if let Some(v) = variance_out.as_mut() {
                v[i] = 1.0 / w;
            }
        } else {
            values_out[i] = sums[i] / count as f64;
            if let (Some(v), Some(vs)) = (variance_out.as_mut(), var_sum) {
                if var_bad.map_or(true, |b| b[i] == 0) {
                    v[i] = vs[i] / (count as f64 * count as f64);
                }
            }
        }
    }
    valid_count
}
