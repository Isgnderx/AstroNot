//! Bilinear reprojection kernel: port of `reprojectBilinear` (tools/difference.js) and of the TAN / TAN-SIP maths of
//! tools/wcs.js it needs (pixel -> sky and the iterative sky -> pixel). The arithmetic follows the JavaScript statement by
//! statement (same operation order, same thresholds, same status codes) so results agree to rounding of the platform
//! sin/cos/atan2; the only deliberate difference is that powers in the SIP polynomials use repeated multiplication.
//!
//! WCS parameter block (f64 array, built by `AstroNotWcs` as `wcs.params`):
//!   0 alpha0, 1 delta0, 2 lonpole, 3..7 matrix (u,v -> intermediate), 7..11 inverse matrix, 11 crpix1, 12 crpix2,
//!   13 sip flag, 14 nA, 15 nB, 16 nAP, 17 nBP, then the terms A, B, AP, BP as (p, q, coefficient) triples.
use std::alloc::{alloc, dealloc, Layout};

const DEG: f64 = std::f64::consts::PI / 180.0;
const RAD: f64 = 180.0 / std::f64::consts::PI;
const SNAP: f64 = 1e-7;
const EDGE: f64 = 1e-6;
const HEADER: usize = 18;

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

type Term = (usize, usize, f64);

struct Wcs {
    alpha0: f64,
    lonpole: f64,
    sin_d0: f64,
    cos_d0: f64,
    sin_l: f64,
    cos_l: f64,
    m: [f64; 4],
    inv: [f64; 4],
    crpix: [f64; 2],
    sip: bool,
    a: Vec<Term>,
    b: Vec<Term>,
    ap: Vec<Term>,
    bp: Vec<Term>,
}

fn terms(block: &[f64], from: usize, count: usize) -> Vec<Term> {
    (0..count)
        .map(|i| {
            let at = from + 3 * i;
            (block[at] as usize, block[at + 1] as usize, block[at + 2])
        })
        .collect()
}

fn parse(block: &[f64]) -> Option<Wcs> {
    if block.len() < HEADER {
        return None;
    }
    let counts = [block[14] as usize, block[15] as usize, block[16] as usize, block[17] as usize];
    if block.len() < HEADER + 3 * counts.iter().sum::<usize>() {
        return None;
    }
    let mut at = HEADER;
    let mut next = |n: usize| {
        let t = terms(block, at, n);
        at += 3 * n;
        t
    };
    let (a, b, ap, bp) = (next(counts[0]), next(counts[1]), next(counts[2]), next(counts[3]));
    for list in [&a, &b, &ap, &bp] {
        if list.iter().any(|t| t.0 > 9 || t.1 > 9) {
            return None;
        }
    }
    Some(Wcs {
        alpha0: block[0],
        lonpole: block[2],
        sin_d0: (block[1] * DEG).sin(),
        cos_d0: (block[1] * DEG).cos(),
        sin_l: (block[2] * DEG).sin(),
        cos_l: (block[2] * DEG).cos(),
        m: [block[3], block[4], block[5], block[6]],
        inv: [block[7], block[8], block[9], block[10]],
        crpix: [block[11], block[12]],
        sip: block[13] != 0.0,
        a,
        b,
        ap,
        bp,
    })
}

#[inline]
fn is_number(x: f64) -> bool {
    x.is_finite()
}

// Math.hypot as V8 computes it for two arguments (scaled, compensated sum), so both sides round alike.
#[inline]
fn hypot(x: f64, y: f64) -> f64 {
    let (ax, ay) = (x.abs(), y.abs());
    if ax == f64::INFINITY || ay == f64::INFINITY {
        return f64::INFINITY;
    }
    if x.is_nan() || y.is_nan() {
        return f64::NAN;
    }
    let max = if ax > ay { ax } else { ay };
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0;
    let mut compensation = 0.0;
    for v in [ax, ay] {
        let n = v / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

fn normalize_ra(ra: f64) -> f64 {
    let mut value = ra % 360.0;
    if value < 0.0 {
        value += 360.0;
    }
    if value >= 360.0 || (value == 0.0 && value.is_sign_negative()) {
        0.0
    } else {
        value
    }
}

fn powers(x: f64) -> [f64; 10] {
    let mut p = [1.0; 10];
    for i in 1..10 {
        p[i] = p[i - 1] * x;
    }
    p
}

fn polynomial(list: &[Term], u: f64, v: f64) -> f64 {
    if list.is_empty() {
        return 0.0;
    }
    let (pu, pv) = (powers(u), powers(v));
    let mut sum = 0.0;
    for &(p, q, c) in list {
        sum += c * pu[p] * pv[q];
    }
    sum
}

fn derivatives(list: &[Term], u: f64, v: f64) -> (f64, f64) {
    if list.is_empty() {
        return (0.0, 0.0);
    }
    let (pu, pv) = (powers(u), powers(v));
    let (mut du, mut dv) = (0.0, 0.0);
    for &(p, q, c) in list {
        if p > 0 {
            du += c * p as f64 * pu[p - 1] * pv[q];
        }
        if q > 0 {
            dv += c * q as f64 * pu[p] * pv[q - 1];
        }
    }
    (du, dv)
}

impl Wcs {
    // Pixel -> intermediate world coordinates (degrees on the tangent plane), SIP included.
    fn pixel_to_plane(&self, x: f64, y: f64) -> Option<(f64, f64)> {
        if !is_number(x) || !is_number(y) {
            return None;
        }
        let mut u = x - self.crpix[0];
        let mut v = y - self.crpix[1];
        if self.sip {
            let du = polynomial(&self.a, u, v);
            let dv = polynomial(&self.b, u, v);
            u += du;
            v += dv;
        }
        Some((self.m[0] * u + self.m[1] * v, self.m[2] * u + self.m[3] * v))
    }

    fn pixel_to_sky(&self, x: f64, y: f64) -> Option<(f64, f64)> {
        let (px, py) = self.pixel_to_plane(x, y)?;
        // tanDeproject
        let r = hypot(px, py);
        let phi = px.atan2(-py);
        let theta = RAD.atan2(r);
        let dphi = phi - self.lonpole * DEG;
        let (sin_t, cos_t) = (theta.sin(), theta.cos());
        let cos_dphi = dphi.cos();
        let sin_dec = sin_t * self.sin_d0 + cos_t * self.cos_d0 * cos_dphi;
        let ra = self.alpha0 + (-cos_t * dphi.sin()).atan2(sin_t * self.cos_d0 - cos_t * self.sin_d0 * cos_dphi) * RAD;
        let ra = normalize_ra(ra);
        // Math.max(-1, Math.min(1, x)) propagates NaN, f64::max would not.
        let dec = if sin_dec.is_nan() { f64::NAN } else { sin_dec.max(-1.0).min(1.0).asin() * RAD };
        if is_number(ra) && is_number(dec) {
            Some((ra, dec))
        } else {
            None
        }
    }

    fn sky_to_pixel(&self, ra: f64, dec: f64) -> Option<(f64, f64)> {
        if !is_number(ra) || !is_number(dec) || dec.abs() > 90.0 {
            return None;
        }
        // tanProject
        let d_alpha = (ra - self.alpha0) * DEG;
        let sin_d = (dec * DEG).sin();
        let cos_d = (dec * DEG).cos();
        let cos_da = d_alpha.cos();
        let east = -cos_d * d_alpha.sin();
        let north = sin_d * self.cos_d0 - cos_d * self.sin_d0 * cos_da;
        let phi = self.lonpole * DEG + east.atan2(north);
        let sin_theta = sin_d * self.sin_d0 + cos_d * self.cos_d0 * cos_da;
        if !(sin_theta > 1e-9) {
            return None;
        }
        let r = RAD * hypot(east, north) / sin_theta;
        self.plane_to_pixel(r * phi.sin(), -r * phi.cos())
    }

    // Intermediate world coordinates -> pixel: inverse matrix, then the SIP inverse (Newton, as wcs.js).
    fn plane_to_pixel(&self, px: f64, py: f64) -> Option<(f64, f64)> {
        let f = self.inv[0] * px + self.inv[1] * py;
        let g = self.inv[2] * px + self.inv[3] * py;
        if !self.sip {
            return Some((f + self.crpix[0], g + self.crpix[1]));
        }
        let mut u = f + polynomial(&self.ap, f, g);
        let mut v = g + polynomial(&self.bp, f, g);
        if self.ap.is_empty() {
            u = f;
            v = g;
        }
        let mut converged = false;
        for _ in 0..30 {
            let residual_u = u + polynomial(&self.a, u, v) - f;
            let residual_v = v + polynomial(&self.b, u, v) - g;
            let (a_u, a_v) = derivatives(&self.a, u, v);
            let (b_u, b_v) = derivatives(&self.b, u, v);
            let j11 = 1.0 + a_u;
            let j12 = a_v;
            let j21 = b_u;
            let j22 = 1.0 + b_v;
            let det = j11 * j22 - j12 * j21;
            if !(det.abs() > 1e-12) {
                return None;
            }
            let step_u = (j22 * residual_u - j12 * residual_v) / det;
            let step_v = (-j21 * residual_u + j11 * residual_v) / det;
            u -= step_u;
            v -= step_v;
            if step_u.abs() < 1e-11 && step_v.abs() < 1e-11 {
                converged = true;
                break;
            }
        }
        if converged && is_number(u) && is_number(v) {
            Some((u + self.crpix[0], v + self.crpix[1]))
        } else {
            None
        }
    }
}

/// Output pixel -> source pixel without any trigonometry per pixel: the tangent-plane point of the output WCS is a direction
/// in space, a fixed 3x3 rotation (output frame -> source frame) turns it into a direction about the source tangent point,
/// and the source projection divides by its z. Mathematically the same map as pixel_to_sky followed by sky_to_pixel
/// (differences are rounding, about 1e-15 relative); the homogeneous scale cancels, so there is not even a square root.
struct Link {
    cos_a: f64,
    sin_a: f64,
}

impl Link {
    fn new(dst: &Wcs, src: &Wcs) -> Link {
        let d = (dst.alpha0 - src.alpha0) * DEG;
        Link { cos_a: d.cos(), sin_a: d.sin() }
    }

    fn map(&self, dst: &Wcs, src: &Wcs, x: f64, y: f64) -> Option<(f64, f64)> {
        let (px, py) = dst.pixel_to_plane(x, y)?;
        let (s, co) = (px * DEG, -(py * DEG)); // cos(theta) sin(phi), cos(theta) cos(phi), times N
        let (a, b) = (co * dst.cos_l + s * dst.sin_l, s * dst.cos_l - co * dst.sin_l);
        let (cx, cy, cz) = (dst.cos_d0 - a * dst.sin_d0, -b, dst.sin_d0 + a * dst.cos_d0);
        let (rx, ry) = (cx * self.cos_a - cy * self.sin_a, cx * self.sin_a + cy * self.cos_a);
        let east = -ry;
        let north = cz * src.cos_d0 - rx * src.sin_d0;
        let sin_theta = cz * src.sin_d0 + rx * src.cos_d0; // times N, N^2 = 1 + |plane|^2 (radians)
        let n2 = 1.0 + s * s + co * co;
        if !(sin_theta > 0.0 && sin_theta * sin_theta > 1e-18 * n2) {
            return None;
        }
        let k = RAD / sin_theta;
        src.plane_to_pixel(k * (east * src.cos_l + north * src.sin_l), -k * (north * src.cos_l - east * src.sin_l))
    }
}

/// Reprojects `rows` output rows of width `width`. The window pixel (column, row) is evaluated at the FITS position
/// (((column + 1) + gx0) + dx, ((row + 1) + gy0) + dy) of the output WCS (gx0, gy0 are whole numbers: window origin;
/// dx, dy: sub-pixel sampling offset). `variance` and `mask` may be null; `out_variance` must be non-null exactly when
/// `variance` is. `exact` != 0 runs the same trigonometric chain as wcs.js (pixelToSky then skyToPixel); 0 uses the
/// trigonometry-free rotation (Link), much faster and equal to rounding. Returns 0 on success, 1 for an unusable WCS block.
/// Status codes written: 0 valid, 1 outside the source, 3 a neighbour with non-zero weight is NaN or masked.
#[no_mangle]
pub unsafe extern "C" fn reproject_bilinear(
    src_wcs: *const f64, src_wcs_len: usize, out_wcs: *const f64, out_wcs_len: usize,
    nx: u32, ny: u32, values: *const f64, variance: *const f64, mask: *const u8,
    width: u32, rows: u32, gx0: f64, dx: f64, gy0: f64, dy: f64,
    out_values: *mut f64, out_variance: *mut f64, out_status: *mut u8, exact: u32,
) -> i32 {
    let (Some(src), Some(dst)) = (
        parse(std::slice::from_raw_parts(src_wcs, src_wcs_len)),
        parse(std::slice::from_raw_parts(out_wcs, out_wcs_len)),
    ) else {
        return 1;
    };
    let (nxs, nys) = (nx as usize, ny as usize);
    let values = std::slice::from_raw_parts(values, nxs * nys);
    let variance = if variance.is_null() { None } else { Some(std::slice::from_raw_parts(variance, nxs * nys)) };
    let mask = if mask.is_null() { None } else { Some(std::slice::from_raw_parts(mask, nxs * nys)) };
    let count = width as usize * rows as usize;
    let out_values = std::slice::from_raw_parts_mut(out_values, count);
    let mut out_variance = if out_variance.is_null() { None } else { Some(std::slice::from_raw_parts_mut(out_variance, count)) };
    let out_status = std::slice::from_raw_parts_mut(out_status, count);
    let link = Link::new(&dst, &src);
    let (fnx, fny) = (nx as f64, ny as f64);
    let usable = |index: usize| values[index].is_finite() && !mask.map_or(false, |m| m[index] != 0);

    for row in 0..rows as usize {
        for column in 0..width as usize {
            let out = row * width as usize + column;
            out_values[out] = f64::NAN;
            if let Some(v) = out_variance.as_mut() {
                v[out] = f64::NAN;
            }
            out_status[out] = 1;
            let x = ((column + 1) as f64 + gx0) + dx;
            let y = ((row + 1) as f64 + gy0) + dy;
            let mapped = if exact != 0 {
                dst.pixel_to_sky(x, y).and_then(|(ra, dec)| src.sky_to_pixel(ra, dec))
            } else {
                link.map(&dst, &src, x, y)
            };
            let Some((ax, ay)) = mapped else { continue };
            if !is_number(ax) || !is_number(ay) {
                continue;
            }
            if ax < 1.0 - EDGE || ax > fnx + EDGE || ay < 1.0 - EDGE || ay > fny + EDGE {
                continue;
            }
            let sx = fnx.min(1.0f64.max(ax));
            let sy = fny.min(1.0f64.max(ay));
            let mut fx = sx - sx.floor();
            let mut fy = sy - sy.floor();
            let mut i0 = sx.floor() as i64 - 1;
            let mut j0 = sy.floor() as i64 - 1;
            if fx < SNAP {
                fx = 0.0;
            } else if fx > 1.0 - SNAP {
                fx = 0.0;
                i0 += 1;
            }
            if fy < SNAP {
                fy = 0.0;
            } else if fy > 1.0 - SNAP {
                fy = 0.0;
                j0 += 1;
            }
            i0 = i0.min(nx as i64 - 1);
            j0 = j0.min(ny as i64 - 1);
            let i1 = (i0 + 1).min(nx as i64 - 1) as usize;
            let j1 = (j0 + 1).min(ny as i64 - 1) as usize;
            let (i0, j0) = (i0 as usize, j0 as usize);
            let taps = [
                (j0 * nxs + i0, (1.0 - fx) * (1.0 - fy)),
                (j0 * nxs + i1, fx * (1.0 - fy)),
                (j1 * nxs + i0, (1.0 - fx) * fy),
                (j1 * nxs + i1, fx * fy),
            ];
            let mut sum = 0.0;
            let mut spread = if variance.is_some() { 0.0 } else { f64::NAN };
            let mut good = true;
            for (index, weight) in taps {
                if weight <= 0.0 {
                    continue;
                }
                if !usable(index) {
                    good = false;
                    break;
                }
                sum += weight * values[index];
                if let Some(var) = variance {
                    let each = var[index];
                    spread = if each.is_finite() && each >= 0.0 && spread.is_finite() { spread + weight * weight * each } else { f64::NAN };
                }
            }
            if !good {
                out_status[out] = 3;
                continue;
            }
            out_status[out] = 0;
            out_values[out] = sum;
            if let Some(v) = out_variance.as_mut() {
                v[out] = spread;
            }
        }
    }
    0
}
