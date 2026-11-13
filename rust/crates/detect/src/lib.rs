//! Source Detection kernel (WebAssembly) for tools/detect.js, plus the residual-peak search of tools/motion-model.js.
//!
//! Every function here repeats a loop of the JavaScript implementation operation for operation, in the same order, with
//! the same intermediate rounding (f32 storage where the JS code stores into a Float32Array, f64 everywhere else, no fused
//! multiply-add, no reassociated sums). Results are therefore bit-identical to the JS fallback, which the tests assert.
//! SIMD comes only from loops whose iterations are independent output pixels (each pixel's own sum keeps its order).
//! The JS side owns all buffers (an_alloc); functions write every element of their outputs, so memory need not be zeroed.
use std::alloc::{alloc, dealloc, Layout};
use std::cmp::Ordering;

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

unsafe fn rd<'a, T>(p: *const T, n: usize) -> &'a [T] {
    std::slice::from_raw_parts(p, n)
}

unsafe fn wr<'a, T>(p: *mut T, n: usize) -> &'a mut [T] {
    std::slice::from_raw_parts_mut(p, n)
}

const MAD_TO_SIGMA: f64 = 1.482602218505602;
const CLIP_SIGMA: f64 = 3.0;
const CLIP_ITERATIONS: usize = 10;
const SAMPLE_LIMIT: usize = 262144;
const MIN_CELL_PIXELS: f64 = 25.0;
const MIN_CELL_FRACTION: f64 = 0.5;
const MIN_COVERAGE: f64 = 0.3;
const RELATIVE_VALLEY: f64 = 0.1;
const NEIGHBOURS: [(i64, i64); 8] = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)];

// ---- Robust statistics -----------------------------------------------------------------------------------------------
/// Median by selection: the middle element, or the mean of the two middle ones. Reorders `buf`.
fn median_of(buf: &mut [f64]) -> f64 {
    let n = buf.len();
    if n == 0 {
        return f64::NAN;
    }
    let mid = n >> 1;
    let (lower, upper, _) = buf.select_nth_unstable_by(mid, |a, b| a.total_cmp(b));
    let hi = *upper;
    if n & 1 == 1 {
        hi
    } else {
        let mut lo = f64::NEG_INFINITY;
        for &v in lower.iter() {
            if v > lo {
                lo = v;
            }
        }
        (lo + hi) / 2.0
    }
}

/// Sigma-clipped median and 1.4826 x MAD (3 sigma, up to 10 passes). Same pass structure as clippedStats() in detect.js.
fn clipped_stats(buf: &mut [f64], dev: &mut Vec<f64>) -> (f64, f64, usize) {
    let mut n = buf.len();
    let mut median = f64::NAN;
    let mut sigma = f64::NAN;
    for pass in 0..=CLIP_ITERATIONS {
        if n < 1 {
            break;
        }
        median = median_of(&mut buf[..n]);
        dev.clear();
        dev.extend(buf[..n].iter().map(|&x| (x - median).abs()));
        sigma = MAD_TO_SIGMA * median_of(dev);
        if !(sigma > 0.0) || pass == CLIP_ITERATIONS {
            break;
        }
        let low = median - CLIP_SIGMA * sigma;
        let high = median + CLIP_SIGMA * sigma;
        let mut w = 0;
        for i in 0..n {
            let v = buf[i];
            if v >= low && v <= high {
                buf[w] = v;
                w += 1;
            }
        }
        if w == n {
            break;
        }
        n = w;
    }
    (median, sigma, n)
}

/// out = [median, sigma, clipped count, sample size] of the valid pixels (a regular sample when there are many).
#[no_mangle]
pub unsafe extern "C" fn det_global_stats(values: *const f64, valid: *const u8, total: usize, valid_count: usize, out: *mut f64) {
    let values = rd(values, total);
    let valid = rd(valid, total);
    let stride = ((valid_count + SAMPLE_LIMIT - 1) / SAMPLE_LIMIT).max(1);
    let mut sample: Vec<f64> = Vec::with_capacity((valid_count + stride - 1) / stride);
    let mut seen = 0usize;
    for i in 0..total {
        if valid[i] == 0 {
            continue;
        }
        if seen % stride == 0 {
            sample.push(values[i]);
        }
        seen += 1;
    }
    let mut dev = Vec::with_capacity(sample.len());
    let (median, sigma, count) = clipped_stats(&mut sample, &mut dev);
    let out = wr(out, 4);
    out[0] = median;
    out[1] = sigma;
    out[2] = count as f64;
    out[3] = sample.len() as f64;
}

#[no_mangle]
pub unsafe extern "C" fn det_valid(values: *const f64, valid: *mut u8, total: usize) -> usize {
    let values = rd(values, total);
    let valid = wr(valid, total);
    let mut count = 0usize;
    for i in 0..total {
        let ok = values[i].is_finite();
        valid[i] = ok as u8;
        count += ok as usize;
    }
    count
}

// ---- Mesh background ---------------------------------------------------------------------------------------------------
/// Clipped median and sigma of every box (NaN for a box with too few valid pixels). Returns the number of boxes used.
#[no_mangle]
pub unsafe extern "C" fn det_mesh_cells(values: *const f64, valid: *const u8, width: usize, height: usize, bx: usize, levels: *mut f64, sigmas: *mut f64) -> usize {
    let values = rd(values, width * height);
    let valid = rd(valid, width * height);
    let nx = (width + bx - 1) / bx;
    let ny = (height + bx - 1) / bx;
    let levels = wr(levels, nx * ny);
    let sigmas = wr(sigmas, nx * ny);
    let mut buffer: Vec<f64> = Vec::with_capacity(bx * bx);
    let mut dev: Vec<f64> = Vec::with_capacity(bx * bx);
    let mut used = 0usize;
    for cy in 0..ny {
        let y0 = cy * bx;
        let y1 = height.min(y0 + bx);
        for cx in 0..nx {
            let x0 = cx * bx;
            let x1 = width.min(x0 + bx);
            buffer.clear();
            for y in y0..y1 {
                let row = y * width;
                for x in x0..x1 {
                    if valid[row + x] != 0 {
                        buffer.push(values[row + x]);
                    }
                }
            }
            let area = ((x1 - x0) * (y1 - y0)) as f64;
            let at = cy * nx + cx;
            if (buffer.len() as f64) < MIN_CELL_PIXELS.max(MIN_CELL_FRACTION * area) {
                levels[at] = f64::NAN;
                sigmas[at] = f64::NAN;
                continue;
            }
            let (median, sigma, _) = clipped_stats(&mut buffer, &mut dev);
            levels[at] = median;
            sigmas[at] = sigma;
            used += 1;
        }
    }
    used
}

/// Bilinear interpolation of the (filtered) box grids to every pixel: background (f64) and noise (f32).
#[no_mangle]
pub unsafe extern "C" fn det_mesh_interp(
    grid_levels: *const f64, grid_sigmas: *const f64, nx: usize, ny: usize,
    x_i0: *const i32, x_i1: *const i32, x_t: *const f64, x_c: *const f64, width: usize,
    y_i0: *const i32, y_i1: *const i32, y_t: *const f64, y_c: *const f64, height: usize,
    background: *mut f64, sigma: *mut f32,
) {
    let gl = rd(grid_levels, nx * ny);
    let gs = rd(grid_sigmas, nx * ny);
    let (x_i0, x_i1, x_t, x_c) = (rd(x_i0, width), rd(x_i1, width), rd(x_t, width), rd(x_c, width));
    let (y_i0, y_i1, y_t, y_c) = (rd(y_i0, height), rd(y_i1, height), rd(y_t, height), rd(y_c, height));
    let background = wr(background, width * height);
    let sigma = wr(sigma, width * height);
    for y in 0..height {
        let row = y * width;
        let ty = y_t[y];
        let sy = y_c[y];
        let r0 = y_i0[y] as usize * nx;
        let r1 = y_i1[y] as usize * nx;
        let bg = &mut background[row..row + width];
        let sg = &mut sigma[row..row + width];
        for x in 0..width {
            let tx = x_t[x];
            let sx = x_c[x];
            let a = x_i0[x] as usize;
            let b = x_i1[x] as usize;
            let (l00, l01, l10, l11) = (gl[r0 + a], gl[r0 + b], gl[r1 + a], gl[r1 + b]);
            bg[x] = (l00 * (1.0 - tx) + l01 * tx) * (1.0 - ty) + (l10 * (1.0 - tx) + l11 * tx) * ty;
            let (s00, s01, s10, s11) = (gs[r0 + a], gs[r0 + b], gs[r1 + a], gs[r1 + b]);
            sg[x] = ((s00 * (1.0 - sx) + s01 * sx) * (1.0 - sy) + (s10 * (1.0 - sx) + s11 * sx) * sy) as f32;
        }
    }
}

// ---- Noise and usable pixels -------------------------------------------------------------------------------------------
/// sigma = sqrt(variance) where valid and positive and finite, else NaN. Returns the number of usable pixels.
#[no_mangle]
pub unsafe extern "C" fn det_variance_sigma(valid: *const u8, variance: *const f64, sigma: *mut f32, total: usize) -> usize {
    let valid = rd(valid, total);
    let variance = rd(variance, total);
    let sigma = wr(sigma, total);
    let mut usable = 0usize;
    for i in 0..total {
        let v = variance[i];
        if valid[i] != 0 && v.is_finite() && v > 0.0 {
            sigma[i] = v.sqrt() as f32;
            usable += 1;
        } else {
            sigma[i] = f32::NAN;
        }
    }
    usable
}

/// use = valid, and (for a threshold in sigma) a positive finite noise. out = [use count, pixels left out for zero noise].
#[no_mangle]
pub unsafe extern "C" fn det_use_mask(valid: *const u8, sigma: *const f32, use_: *mut u8, total: usize, sigma_mode: u32, out: *mut f64) {
    let valid = rd(valid, total);
    let sigma = rd(sigma, total);
    let use_ = wr(use_, total);
    let mut count = 0usize;
    let mut zero = 0usize;
    for i in 0..total {
        use_[i] = 0;
        if valid[i] == 0 {
            continue;
        }
        let s = sigma[i];
        if sigma_mode != 0 && !(s > 0.0 && s.is_finite()) {
            zero += 1;
            continue;
        }
        use_[i] = 1;
        count += 1;
    }
    let out = wr(out, 2);
    out[0] = count as f64;
    out[1] = zero as f64;
}

// ---- Detection image ---------------------------------------------------------------------------------------------------
/// out = kernel (x) kernel (x) src with zero weight outside the image. Horizontal sums are f64 in tap order, stored as f32;
/// the vertical pass accumulates f64 in tap order, stored as f32 (exactly the JS convolve()). Interior pixels are computed
/// B at a time with the accumulators in registers (every pixel keeps its own tap order, so the sums are unchanged).
fn convolve(src: &[f32], w: usize, h: usize, kernel: &[f64], tmp: &mut [f32], out: &mut [f32]) {
    const B: usize = 8;
    let half = (kernel.len() - 1) / 2;
    let edge = |row: &[f32], x: usize| -> f32 {
        let a = x.saturating_sub(half);
        let b = (w - 1).min(x + half);
        let mut sum = 0.0f64;
        for xx in a..=b {
            sum += kernel[xx + half - x] * row[xx] as f64;
        }
        sum as f32
    };
    for y in 0..h {
        let row = &src[y * w..(y + 1) * w];
        let trow = &mut tmp[y * w..(y + 1) * w];
        let mut x = 0;
        while x < w {
            if x >= half && x + B + half <= w {
                let mut acc = [0f64; B];
                for (k, &kv) in kernel.iter().enumerate() {
                    let s = &row[x + k - half..x + k - half + B];
                    for j in 0..B {
                        acc[j] += kv * s[j] as f64;
                    }
                }
                for j in 0..B {
                    trow[x + j] = acc[j] as f32;
                }
                x += B;
            } else {
                trow[x] = edge(row, x);
                x += 1;
            }
        }
    }
    for y in 0..h {
        let a = y.saturating_sub(half);
        let b = (h - 1).min(y + half);
        let orow = &mut out[y * w..(y + 1) * w];
        let mut x = 0;
        while x + B <= w {
            let mut acc = [0f64; B];
            for yy in a..=b {
                let weight = kernel[yy + half - y];
                let s = &tmp[yy * w + x..yy * w + x + B];
                for j in 0..B {
                    acc[j] += weight * s[j] as f64;
                }
            }
            for j in 0..B {
                orow[x + j] = acc[j] as f32;
            }
            x += B;
        }
        while x < w {
            let mut sum = 0.0f64;
            for yy in a..=b {
                sum += kernel[yy + half - y] * tmp[yy * w + x] as f64;
            }
            orow[x] = sum as f32;
            x += 1;
        }
    }
}

/// Detection image df, its noise sigf and the kernel coverage. klen = 0 means no smoothing.
#[no_mangle]
pub unsafe extern "C" fn det_detection_image(
    values: *const f64, background: *const f64, sigma: *const f32, use_: *const u8, total: usize, width: usize, height: usize,
    kernel: *const f64, kernel2: *const f64, klen: usize, df: *mut f32, sigf: *mut f32, coverage: *mut f32,
) {
    let values = rd(values, total);
    let background = rd(background, total);
    let sigma = rd(sigma, total);
    let use_ = rd(use_, total);
    let df = wr(df, total);
    let sigf = wr(sigf, total);
    let coverage = wr(coverage, total);
    if klen == 0 {
        for i in 0..total {
            if use_[i] != 0 {
                df[i] = (values[i] - background[i]) as f32;
                let s = sigma[i];
                sigf[i] = if s.is_finite() { s } else { 0.0 };
                coverage[i] = 1.0;
            } else {
                df[i] = 0.0;
                sigf[i] = 0.0;
                coverage[i] = 0.0;
            }
        }
        return;
    }
    let kernel = rd(kernel, klen);
    let kernel2 = rd(kernel2, klen);
    let mut tmp = vec![0f32; total];
    let mut source = vec![0f32; total];
    for i in 0..total {
        source[i] = if use_[i] != 0 { 1.0 } else { 0.0 };
    }
    convolve(&source, width, height, kernel, &mut tmp, coverage);
    for i in 0..total {
        source[i] = if use_[i] != 0 { (values[i] - background[i]) as f32 } else { 0.0 };
    }
    convolve(&source, width, height, kernel, &mut tmp, df);
    for i in 0..total {
        let s = sigma[i] as f64;
        source[i] = if use_[i] != 0 && s.is_finite() { (s * s) as f32 } else { 0.0 };
    }
    convolve(&source, width, height, kernel2, &mut tmp, sigf);
    for i in 0..total {
        let w = coverage[i] as f64;
        if w > 0.0 {
            df[i] = (df[i] as f64 / w) as f32;
            sigf[i] = ((sigf[i] as f64).sqrt() / w) as f32;
        }
    }
}

/// testable = use and coverage >= 0.3. Returns the number of testable pixels.
#[no_mangle]
pub unsafe extern "C" fn det_testable(use_: *const u8, coverage: *const f32, testable: *mut u8, total: usize) -> usize {
    let use_ = rd(use_, total);
    let coverage = rd(coverage, total);
    let testable = wr(testable, total);
    let mut count = 0usize;
    for i in 0..total {
        let t = use_[i] != 0 && (coverage[i] as f64) >= MIN_COVERAGE;
        testable[i] = t as u8;
        count += t as usize;
    }
    count
}

/// mask = testable and above the threshold. Returns the number of masked pixels.
#[no_mangle]
pub unsafe extern "C" fn det_threshold(df: *const f32, sigf: *const f32, testable: *const u8, mask: *mut u8, total: usize, sigma_mode: u32, threshold: f64) -> usize {
    let df = rd(df, total);
    let sigf = rd(sigf, total);
    let testable = rd(testable, total);
    let mask = wr(mask, total);
    let mut count = 0usize;
    for i in 0..total {
        let mut above = false;
        if testable[i] != 0 {
            above = if sigma_mode != 0 { df[i] as f64 > threshold * sigf[i] as f64 } else { df[i] as f64 > threshold };
        }
        mask[i] = above as u8;
        count += above as usize;
    }
    count
}

// ---- Segmentation ------------------------------------------------------------------------------------------------------
/// 8-connected components of `mask` (consumed). order = flat indices in discovery order, starts[i]..starts[i+1] is segment i.
/// `order` holds `count` entries, `starts` count + 1. Returns the number of segments.
#[no_mangle]
pub unsafe extern "C" fn det_components(mask: *mut u8, width: usize, height: usize, count: usize, order: *mut i32, starts: *mut i32) -> usize {
    let mask = wr(mask, width * height);
    let order = wr(order, count);
    let starts = wr(starts, count + 1);
    let mut length = 0usize;
    let mut segments = 0usize;
    let w = width as i64;
    let h = height as i64;
    for y in 0..height {
        for x in 0..width {
            let seed = y * width + x;
            if mask[seed] == 0 {
                continue;
            }
            let start = length;
            starts[segments] = start as i32;
            segments += 1;
            order[length] = seed as i32;
            length += 1;
            mask[seed] = 0;
            let mut head = start;
            while head < length {
                let p = order[head] as usize;
                head += 1;
                let px = (p % width) as i64;
                let py = (p / width) as i64;
                for &(dx, dy) in NEIGHBOURS.iter() {
                    let xx = px + dx;
                    let yy = py + dy;
                    if xx < 0 || yy < 0 || xx >= w || yy >= h {
                        continue;
                    }
                    let q = (yy * w + xx) as usize;
                    if mask[q] != 0 {
                        mask[q] = 0;
                        order[length] = q as i32;
                        length += 1;
                    }
                }
            }
        }
    }
    starts[segments] = length as i32;
    segments
}

fn find(parent: &mut [i32], mut id: i32) -> i32 {
    while parent[id as usize] != id {
        let up = parent[parent[id as usize] as usize];
        parent[id as usize] = up;
        id = up;
    }
    id
}

struct Analysis {
    sorted: Vec<i32>,
    parent: Vec<i32>,
    peak: Vec<f64>,
    size: Vec<i32>,
    slot: Vec<i32>,
    roots: Vec<i32>,
    ranking: Vec<usize>,
    offset: Vec<usize>,
    group_len: Vec<usize>,
    /// Pixels grouped by group, groups ordered by peak height; group_len holds the sizes in that order.
    out: Vec<i32>,
}

/// Splits one segment at significant separate peaks (analyseSegment in detect.js). Returns the number of groups.
fn analyse_segment(pixels: &[i32], width: usize, height: usize, df: &[f32], sigf: &[f32], valley_sigma: f64, min_pixels: i32, branch: &mut [i32], a: &mut Analysis) -> usize {
    let w = width as i64;
    let h = height as i64;
    a.sorted.clear();
    a.sorted.extend_from_slice(pixels);
    a.sorted.sort_unstable_by(|&p, &q| df[q as usize].partial_cmp(&df[p as usize]).unwrap_or(Ordering::Equal).then(p.cmp(&q)));
    a.parent.clear();
    a.peak.clear();
    a.size.clear();
    a.parent.push(0);
    a.peak.push(0.0);
    a.size.push(0);
    for si in 0..a.sorted.len() {
        let p = a.sorted[si] as usize;
        let value = df[p] as f64;
        let px = (p % width) as i64;
        let py = (p / width) as i64;
        let mut best_value = f64::NEG_INFINITY;
        let mut best = 0i32;
        let mut seen = [0i32; 8];
        let mut seen_len = 0usize;
        for &(dx, dy) in NEIGHBOURS.iter() {
            let xx = px + dx;
            let yy = py + dy;
            if xx < 0 || yy < 0 || xx >= w || yy >= h {
                continue;
            }
            let q = (yy * w + xx) as usize;
            let id = branch[q];
            if id == 0 {
                continue;
            }
            let root = find(&mut a.parent, id);
            if !seen[..seen_len].contains(&root) {
                seen[seen_len] = root;
                seen_len += 1;
            }
            if df[q] as f64 > best_value {
                best_value = df[q] as f64;
                best = root;
            }
        }
        if seen_len == 0 {
            let id = a.parent.len() as i32;
            a.parent.push(id);
            a.peak.push(value);
            a.size.push(1);
            branch[p] = id;
            continue;
        }
        let mut dominant = seen[0];
        for &id in &seen[..seen_len] {
            let (pi, pd) = (a.peak[id as usize], a.peak[dominant as usize]);
            if pi > pd || (pi == pd && id < dominant) {
                dominant = id;
            }
        }
        let noise = sigf[p] as f64;
        for &id in &seen[..seen_len] {
            if id == dominant {
                continue;
            }
            let prominence = a.peak[id as usize] - value;
            let needed = (valley_sigma * (if noise > 0.0 { noise } else { 0.0 })).max(RELATIVE_VALLEY * a.peak[id as usize]);
            let separate = a.size[id as usize] >= min_pixels && a.size[dominant as usize] >= min_pixels && prominence >= needed;
            if !separate {
                a.parent[id as usize] = dominant;
                a.size[dominant as usize] += a.size[id as usize];
            }
        }
        let target = find(&mut a.parent, best);
        branch[p] = target;
        a.size[target as usize] += 1;
    }
    // Groups in order of first appearance along the sorted pixels, then stably by descending peak.
    a.slot.clear();
    a.slot.resize(a.parent.len(), -1);
    a.roots.clear();
    a.group_len.clear();
    for si in 0..a.sorted.len() {
        let p = a.sorted[si] as usize;
        let id = find(&mut a.parent, branch[p]);
        if a.slot[id as usize] < 0 {
            a.slot[id as usize] = a.roots.len() as i32;
            a.roots.push(id);
            a.group_len.push(0);
        }
        a.group_len[a.slot[id as usize] as usize] += 1;
    }
    let groups = a.roots.len();
    a.ranking.clear();
    a.ranking.extend(0..groups);
    {
        let (roots, peak) = (&a.roots, &a.peak);
        a.ranking.sort_by(|&x, &y| peak[roots[y] as usize].partial_cmp(&peak[roots[x] as usize]).unwrap_or(Ordering::Equal));
    }
    a.offset.clear();
    a.offset.resize(groups, 0);
    let mut cursor = 0usize;
    for &g in &a.ranking {
        a.offset[g] = cursor;
        cursor += a.group_len[g];
    }
    a.out.clear();
    a.out.resize(a.sorted.len(), 0);
    for si in 0..a.sorted.len() {
        let p = a.sorted[si];
        let id = find(&mut a.parent, branch[p as usize]);
        let g = a.slot[id as usize] as usize;
        a.out[a.offset[g]] = p;
        a.offset[g] += 1;
    }
    // Report sizes in output order.
    let ordered: Vec<usize> = a.ranking.iter().map(|&g| a.group_len[g]).collect();
    a.group_len.clear();
    a.group_len.extend(ordered);
    groups
}

/// Deblends every kept segment. Output groups are concatenated in `out_pix` (out_start[g]..out_start[g+1]), `out_blend[g]` = 1
/// when the segment holds a second significant peak. info = [group count (counted even beyond `cap`), segments with several peaks].
/// Group metadata is stored for the first `cap` groups only; `out_pix` has room for every pixel of the kept segments.
#[no_mangle]
pub unsafe extern "C" fn det_deblend(
    order: *const i32, order_len: usize, kstart: *const i32, kend: *const i32, nk: usize, width: usize, height: usize,
    df: *const f32, sigf: *const f32, valley_sigma: f64, min_pixels: usize, deblend: u32,
    out_pix: *mut i32, out_start: *mut i32, out_blend: *mut u8, cap: usize, info: *mut f64,
) {
    let total = width * height;
    let order = rd(order, order_len);
    let kstart = rd(kstart, nk);
    let kend = rd(kend, nk);
    let df = rd(df, total);
    let sigf = rd(sigf, total);
    let mut kept_pixels = 0usize;
    for i in 0..nk {
        kept_pixels += (kend[i] - kstart[i]) as usize;
    }
    let out_pix = wr(out_pix, kept_pixels);
    let out_start = wr(out_start, cap + 1);
    let out_blend = wr(out_blend, cap);
    let mut branch: Vec<i32> = Vec::new();
    let mut analysis = Analysis { sorted: Vec::new(), parent: Vec::new(), peak: Vec::new(), size: Vec::new(), slot: Vec::new(), roots: Vec::new(), ranking: Vec::new(), offset: Vec::new(), group_len: Vec::new(), out: Vec::new() };
    let mut groups = 0usize;
    let mut with_peaks = 0usize;
    let mut written = 0usize;
    for k in 0..nk {
        let pixels = &order[kstart[k] as usize..kend[k] as usize];
        let mut multi = false;
        let mut split = false;
        if pixels.len() >= 2 * min_pixels {
            if branch.is_empty() {
                branch = vec![0i32; total];
            }
            let ng = analyse_segment(pixels, width, height, df, sigf, valley_sigma, min_pixels as i32, &mut branch, &mut analysis);
            multi = ng > 1;
            split = multi && deblend != 0;
        }
        if multi {
            with_peaks += 1;
        }
        if split {
            let mut at = 0usize;
            for g in 0..analysis.group_len.len() {
                let len = analysis.group_len[g];
                if groups < cap {
                    out_start[groups] = written as i32;
                    out_blend[groups] = 1;
                }
                out_pix[written..written + len].copy_from_slice(&analysis.out[at..at + len]);
                written += len;
                at += len;
                groups += 1;
            }
        } else {
            if groups < cap {
                out_start[groups] = written as i32;
                out_blend[groups] = multi as u8;
            }
            out_pix[written..written + pixels.len()].copy_from_slice(pixels);
            written += pixels.len();
            groups += 1;
        }
    }
    out_start[groups.min(cap)] = written as i32;
    let info = wr(info, 2);
    info[0] = groups as f64;
    info[1] = with_peaks as f64;
}

/// Measurements of every group (step 6 of run() in detect.js). out holds 12 numbers per group:
/// sumW, sumX, sumY, flux, peak, peakIndex, bestSignificance (-Infinity when none), flags (1 edge, 2 masked neighbour, 4 saturated),
/// minX, maxX, minY, maxY (0-based).
#[no_mangle]
pub unsafe extern "C" fn det_measure(
    pix: *const i32, gstart: *const i32, ng: usize, width: usize, height: usize,
    values: *const f64, background: *const f64, df: *const f32, sigf: *const f32, use_: *const u8,
    has_saturation: u32, saturation: f64, out: *mut f64,
) {
    let total = width * height;
    let gstart = rd(gstart, ng + 1);
    let pix = rd(pix, gstart[ng] as usize);
    let values = rd(values, total);
    let background = rd(background, total);
    let df = rd(df, total);
    let sigf = rd(sigf, total);
    let use_ = rd(use_, total);
    let out = wr(out, ng * 12);
    let w = width as i64;
    let h = height as i64;
    for g in 0..ng {
        let pixels = &pix[gstart[g] as usize..gstart[g + 1] as usize];
        let (mut sum_w, mut sum_x, mut sum_y, mut flux) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
        let mut peak = f64::NEG_INFINITY;
        let mut peak_index = pixels[0] as usize;
        let mut best = f64::NEG_INFINITY;
        let (mut edge, mut masked, mut saturated) = (false, false, false);
        let (mut min_x, mut max_x, mut min_y, mut max_y) = (usize::MAX, 0usize, usize::MAX, 0usize);
        for &pi in pixels {
            let p = pi as usize;
            let px = p % width;
            let py = p / width;
            let d = values[p] - background[p];
            flux += d;
            let weight = if d > 0.0 { d } else { 0.0 };
            sum_w += weight;
            sum_x += weight * px as f64;
            sum_y += weight * py as f64;
            if d > peak {
                peak = d;
                peak_index = p;
            }
            let s = sigf[p] as f64;
            if s > 0.0 {
                let significance = df[p] as f64 / s;
                if significance > best {
                    best = significance;
                }
            }
            if px == 0 || py == 0 || px == width - 1 || py == height - 1 {
                edge = true;
            }
            if has_saturation != 0 && values[p] >= saturation {
                saturated = true;
            }
            if !masked {
                for &(dx, dy) in NEIGHBOURS.iter() {
                    let xx = px as i64 + dx;
                    let yy = py as i64 + dy;
                    if xx < 0 || yy < 0 || xx >= w || yy >= h {
                        continue;
                    }
                    if use_[(yy * w + xx) as usize] == 0 {
                        masked = true;
                        break;
                    }
                }
            }
            if px < min_x {
                min_x = px;
            }
            if px > max_x {
                max_x = px;
            }
            if py < min_y {
                min_y = py;
            }
            if py > max_y {
                max_y = py;
            }
        }
        let o = &mut out[g * 12..g * 12 + 12];
        o[0] = sum_w;
        o[1] = sum_x;
        o[2] = sum_y;
        o[3] = flux;
        o[4] = peak;
        o[5] = peak_index as f64;
        o[6] = best;
        o[7] = (edge as u32 | (masked as u32) << 1 | (saturated as u32) << 2) as f64;
        o[8] = min_x as f64;
        o[9] = max_x as f64;
        o[10] = min_y as f64;
        o[11] = max_y as f64;
    }
}

// ---- Motion Detector: residual peaks of a difference image (detectResiduals in tools/motion-model.js) ------------------
/// 1.4826 x MAD of `values` (NaN when fewer than two), the robustSigma() of motion-model.js.
fn robust_sigma(values: &mut [f64], dev: &mut Vec<f64>) -> f64 {
    if values.len() < 2 {
        return f64::NAN;
    }
    let center = median_of(values);
    dev.clear();
    dev.extend(values.iter().map(|&v| (v - center).abs()));
    1.4826 * median_of(dev)
}

/// usable = valid and finite score and difference. out = [usable count, finite count, global robust sigma or NaN].
/// The finite count and sigma are over the usable difference values, only when `snr_mode` is 0.
#[no_mangle]
pub unsafe extern "C" fn det_motion_prepare(valid: *const u8, difference: *const f64, score: *const f64, count: usize, snr_mode: u32, want_sigma: u32, usable: *mut u8, out: *mut f64) {
    let valid = rd(valid, count);
    let difference = rd(difference, count);
    let score = rd(score, count);
    let usable = wr(usable, count);
    let mut finite: Vec<f64> = Vec::new();
    let mut n = 0usize;
    for i in 0..count {
        let ok = valid[i] != 0 && score[i].is_finite() && difference[i].is_finite();
        usable[i] = ok as u8;
        if ok {
            n += 1;
            if snr_mode == 0 {
                finite.push(difference[i]);
            }
        }
    }
    let out = wr(out, 3);
    out[0] = n as f64;
    out[1] = finite.len() as f64;
    out[2] = if want_sigma != 0 {
        let mut dev = Vec::with_capacity(finite.len());
        robust_sigma(&mut finite, &mut dev)
    } else {
        f64::NAN
    };
}

/// Local maxima and minima of `score` above the prefilter. Mode: 0 local-mad, 1 global-mad, 2 snr, 3 absolute.
/// Returns a buffer of `n` records of 10 numbers (column, row, x, y, sign, value, score, sigma, significance, method), free it
/// with an_free(ptr, n * 80). counts = [n, nearInvalid]. method: 0 local scatter, 1 too few pixels nearby, 2 local scatter is zero, 3 not local.
#[no_mangle]
pub unsafe extern "C" fn det_motion_scan(
    usable: *const u8, difference: *const f64, score: *const f64, width: usize, height: usize, mode: u32, threshold: f64, margin: usize, radius: usize,
    sigma_global: f64, pre: f64, counts: *mut f64,
) -> *mut f64 {
    let n = width * height;
    let usable = rd(usable, n);
    let difference = rd(difference, n);
    let score = rd(score, n);
    let w = width as i64;
    let h = height as i64;
    let mut found: Vec<f64> = Vec::new();
    let mut near_invalid = 0usize;
    let mut samples: Vec<f64> = Vec::new();
    let mut dev: Vec<f64> = Vec::new();
    let centroid_floor = mode != 2 && mode != 3;
    for row in 0..height {
        for column in 0..width {
            let index = row * width + column;
            if usable[index] == 0 {
                continue;
            }
            let value = score[index];
            if value.abs() < pre || value == 0.0 {
                continue;
            }
            let sign = if value > 0.0 { 1.0 } else { -1.0 };
            // isExtremum
            let mut extremum = true;
            let own = value * sign;
            for &(dx, dy) in NEIGHBOURS.iter() {
                let c = column as i64 + dx;
                let r = row as i64 + dy;
                if c < 0 || r < 0 || c >= w || r >= h {
                    continue;
                }
                let other = (r * w + c) as usize;
                if usable[other] == 0 {
                    continue;
                }
                let compare = score[other] * sign;
                let ok = if other < index { own > compare } else { own >= compare };
                if !ok {
                    extremum = false;
                    break;
                }
            }
            if !extremum {
                continue;
            }
            // clear(column, row)
            let mut clear = !(column < margin || row < margin || column + margin >= width || row + margin >= height);
            if clear {
                'scan: for dy in 0..=2 * margin {
                    for dx in 0..=2 * margin {
                        if usable[(row + dy - margin) * width + column + dx - margin] == 0 {
                            clear = false;
                            break 'scan;
                        }
                    }
                }
            }
            if !clear {
                near_invalid += 1;
                continue;
            }
            let mut sigma = 1.0f64;
            let mut method = 3.0f64;
            if mode == 0 {
                samples.clear();
                let r0 = row.saturating_sub(radius);
                let r1 = (height - 1).min(row + radius);
                let c0 = column.saturating_sub(radius);
                let c1 = (width - 1).min(column + radius);
                for r in r0..=r1 {
                    for c in c0..=c1 {
                        if (c as i64 - column as i64).abs() <= 2 && (r as i64 - row as i64).abs() <= 2 {
                            continue;
                        }
                        let at = r * width + c;
                        if usable[at] != 0 {
                            samples.push(difference[at]);
                        }
                    }
                }
                if samples.len() < 50 {
                    sigma = sigma_global;
                    method = 1.0;
                } else {
                    let s = robust_sigma(&mut samples, &mut dev);
                    if s > 0.0 {
                        sigma = s;
                        method = 0.0;
                    } else {
                        sigma = sigma_global;
                        method = 2.0;
                    }
                }
            } else if mode == 1 {
                sigma = sigma_global;
            }
            let significance = value.abs() / sigma;
            if !(significance >= threshold) {
                continue;
            }
            let (mut sw, mut sx, mut sy) = (0.0f64, 0.0f64, 0.0f64);
            for dy in -3i64..=3 {
                for dx in -3i64..=3 {
                    let c = column as i64 + dx;
                    let r = row as i64 + dy;
                    if c < 0 || r < 0 || c >= w || r >= h {
                        continue;
                    }
                    let at = (r * w + c) as usize;
                    if usable[at] == 0 {
                        continue;
                    }
                    let weight = (sign * difference[at] - if centroid_floor { sigma } else { 0.0 }).max(0.0);
                    sw += weight;
                    sx += weight * (c + 1) as f64;
                    sy += weight * (r + 1) as f64;
                }
            }
            found.extend_from_slice(&[
                column as f64, row as f64,
                if sw > 0.0 { sx / sw } else { (column + 1) as f64 },
                if sw > 0.0 { sy / sw } else { (row + 1) as f64 },
                sign, difference[index], value, sigma, significance, method,
            ]);
        }
    }
    let counts = wr(counts, 2);
    counts[0] = (found.len() / 10) as f64;
    counts[1] = near_invalid as f64;
    if found.is_empty() {
        return 8 as *mut f64;
    }
    let boxed = found.into_boxed_slice();
    Box::into_raw(boxed) as *mut f64
}
