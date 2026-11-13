//! Catalog cross-match kernel: the matching core of tools/xmatch.js in Rust.
//!
//! Same rules as the JS code (which stays as the reference and the fallback):
//!   - Vincenty great-circle separation, RA differences reduced to (-180, 180] first;
//!   - declination-zone index (zones of equal height, rows inside a zone sorted by RA, binary search per RA window),
//!     RA windows that wrap at 0/360 and open to all RA when the search circle contains a pole;
//!   - inclusive radius with a 1e-9 arcsec tolerance;
//!   - candidates sorted by (round(separation / 1e-6 arcsec), catalog row). JS then orders exact ties by catalog ID,
//!     because identifiers are strings that never enter the kernel;
//!   - proper-motion propagation of catalog positions along a great circle.
//! Only row indices cross the boundary. Queries run in chunks so wasm memory stays bounded for 1M sources x 10M rows.
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

const RAD: f64 = std::f64::consts::PI / 180.0;
const MAS_TO_RAD: f64 = RAD / 3.6e6;
const BOUNDARY_TOLERANCE_ARCSEC: f64 = 1e-9;
const TIE_RESOLUTION_ARCSEC: f64 = 1e-6;

/// Great-circle separation in arcsec (Vincenty). Same operations as separationArcsec in tools/xmatch.js.
#[inline]
fn separation_arcsec(ra1: f64, dec1: f64, ra2: f64, dec2: f64) -> f64 {
    let mut d_ra = (ra2 - ra1) % 360.0;
    if d_ra > 180.0 {
        d_ra -= 360.0;
    } else if d_ra <= -180.0 {
        d_ra += 360.0;
    }
    let lambda = d_ra * RAD;
    let phi1 = dec1 * RAD;
    let phi2 = dec2 * RAD;
    let (sin_l, cos_l) = (lambda.sin(), lambda.cos());
    let cos2 = phi2.cos();
    let (sin1, cos1) = (phi1.sin(), phi1.cos());
    let sin2 = phi2.sin();
    let x = cos1 * sin2 - sin1 * cos2 * cos_l;
    let y = cos2 * sin_l;
    let z = sin1 * sin2 + cos1 * cos2 * cos_l;
    x.hypot(y).atan2(z) / RAD * 3600.0
}

#[no_mangle]
pub extern "C" fn xm_separation(ra1: f64, dec1: f64, ra2: f64, dec2: f64) -> f64 {
    separation_arcsec(ra1, dec1, ra2, dec2)
}

/// out[i] = separation from (cra, cdec) to (ra[i], dec[i]).
#[no_mangle]
pub unsafe extern "C" fn xm_separation_batch(n: usize, ra: *const f64, dec: *const f64, cra: f64, cdec: f64, out: *mut f64) {
    for i in 0..n {
        *out.add(i) = separation_arcsec(cra, cdec, *ra.add(i), *dec.add(i));
    }
}

/// Moves a position along its proper motion for `years`. Returns (ra, dec) in degrees.
fn propagate(ra: f64, dec: f64, pmra: f64, pmdec: f64, years: f64, includes_cos_dec: bool) -> (f64, f64) {
    let alpha = ra * RAD;
    let delta = dec * RAD;
    let east = (if includes_cos_dec { pmra } else { pmra * delta.cos() }) * MAS_TO_RAD * years;
    let north = pmdec * MAS_TO_RAD * years;
    let angle = east.hypot(north);
    if angle == 0.0 {
        return (ra, dec);
    }
    let (sa, ca, sd, cd) = (alpha.sin(), alpha.cos(), delta.sin(), delta.cos());
    let p = [cd * ca, cd * sa, sd];
    let e = [-sa, ca, 0.0];
    let n = [-sd * ca, -sd * sa, cd];
    let along = angle.sin() / angle;
    let cos_angle = angle.cos();
    let mut q = [0.0f64; 3];
    for k in 0..3 {
        q[k] = p[k] * cos_angle + (east * e[k] + north * n[k]) * along;
    }
    let mut new_ra = q[1].atan2(q[0]) / RAD;
    if new_ra < 0.0 {
        new_ra += 360.0;
    }
    if new_ra >= 360.0 {
        new_ra -= 360.0;
    }
    (new_ra, q[2].atan2(q[0].hypot(q[1])) / RAD)
}

/// Moves every valid row to the target epoch (Julian year). out_ra/out_dec receive the published position for rows that
/// cannot be moved. stats (4 f64): moved, no-motion, no-epoch, largest shift in arcsec. A row is valid when its RA is
/// not NaN; epoch and both proper motions must be finite to move it.
#[no_mangle]
pub unsafe extern "C" fn xm_propagate(
    n: usize, ra: *const f64, dec: *const f64, pmra: *const f64, pmdec: *const f64, epoch: *const f64,
    target: f64, includes_cos_dec: u32, out_ra: *mut f64, out_dec: *mut f64, stats: *mut f64,
) {
    let (mut moved, mut no_motion, mut no_epoch, mut max_shift) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    for i in 0..n {
        let (r, d) = (*ra.add(i), *dec.add(i));
        *out_ra.add(i) = r;
        *out_dec.add(i) = d;
        if r.is_nan() {
            continue;
        }
        let e = *epoch.add(i);
        if !e.is_finite() {
            no_epoch += 1.0;
            continue;
        }
        let (a, b) = (*pmra.add(i), *pmdec.add(i));
        if !a.is_finite() || !b.is_finite() {
            no_motion += 1.0;
            continue;
        }
        let (nr, nd) = propagate(r, d, a, b, target - e, includes_cos_dec != 0);
        let shift = separation_arcsec(r, d, nr, nd);
        if shift > max_shift {
            max_shift = shift;
        }
        *out_ra.add(i) = nr;
        *out_dec.add(i) = nd;
        moved += 1.0;
    }
    *stats = moved;
    *stats.add(1) = no_motion;
    *stats.add(2) = no_epoch;
    *stats.add(3) = max_shift;
}

#[derive(Clone, Copy)]
struct Item {
    ra: f64,
    dec: f64,
    idx: u32,
}

#[derive(Clone, Copy)]
struct Hit {
    key: f64,
    row: u32,
    sep: f64,
}

pub struct Index {
    height: f64,
    zones: usize,
    items: Vec<Item>,
    zone_start: Vec<u32>,
    hits: Vec<Hit>,
    offsets: Vec<u32>,
    rows: Vec<u32>,
    seps: Vec<f64>,
    keys: Vec<f64>,
}

impl Index {
    #[inline]
    fn zone_of(&self, value: f64) -> usize {
        let z = ((value + 90.0) / self.height).floor();
        if z.is_nan() || z < 0.0 {
            0
        } else {
            (z as usize).min(self.zones - 1)
        }
    }

    // All indexed rows within radius (arcsec) of (qra, qdec), appended to `hits` unsorted.
    fn query(&self, qra: f64, qdec: f64, radius: f64, hits: &mut Vec<Hit>) {
        let radius_deg = radius / 3600.0;
        let low = qdec - radius_deg - 1e-9;
        let high = qdec + radius_deg + 1e-9;
        let contains_pole = high >= 90.0 || low <= -90.0;
        let mut windows = [(0.0f64, 360.0f64); 2];
        let mut count = 1;
        if !contains_pole {
            let half = (1.0f64.min((radius_deg * RAD).sin() / (qdec * RAD).cos())).asin() / RAD * (1.0 + 1e-9) + 1e-9;
            if half >= 180.0 {
                // whole circle of right ascension
            } else {
                let (start, end) = (qra - half, qra + half);
                if start < 0.0 {
                    windows = [(start + 360.0, 360.0), (0.0, end)];
                    count = 2;
                } else if end >= 360.0 {
                    windows = [(start, 360.0), (0.0, end - 360.0)];
                    count = 2;
                } else {
                    windows[0] = (start, end);
                }
            }
        }
        let z_from = self.zone_of(low.max(-90.0));
        let z_to = self.zone_of(high.min(90.0));
        let mut z = z_from;
        while z <= z_to {
            let from = self.zone_start[z] as usize;
            let to = self.zone_start[z + 1] as usize;
            if from != to {
                let zone = &self.items[from..to];
                for w in 0..count {
                    let (start, end) = windows[w];
                    let mut p = zone.partition_point(|it| it.ra < start);
                    while p < zone.len() && zone[p].ra <= end {
                        let it = &zone[p];
                        let sep = separation_arcsec(qra, qdec, it.ra, it.dec);
                        if sep <= radius + BOUNDARY_TOLERANCE_ARCSEC {
                            hits.push(Hit { key: (sep / TIE_RESOLUTION_ARCSEC).round(), row: it.idx, sep });
                        }
                        p += 1;
                    }
                }
            }
            z += 1;
        }
    }
}

/// Builds the zone index over rows whose RA and Dec are not NaN. zone_height in degrees (clamped to 0.002..30).
#[no_mangle]
pub unsafe extern "C" fn xm_build(n: usize, ra: *const f64, dec: *const f64, zone_height: f64) -> *mut Index {
    let height = zone_height.max(0.002).min(30.0);
    let zones = (180.0 / height).ceil() as usize;
    let mut index = Box::new(Index {
        height,
        zones,
        items: Vec::new(),
        zone_start: vec![0u32; zones + 1],
        hits: Vec::new(),
        offsets: Vec::new(),
        rows: Vec::new(),
        seps: Vec::new(),
        keys: Vec::new(),
    });
    let ra = std::slice::from_raw_parts(ra, n);
    let dec = std::slice::from_raw_parts(dec, n);
    let mut zone_of_row = vec![0u32; n];
    let mut valid = 0usize;
    for i in 0..n {
        if ra[i].is_nan() || dec[i].is_nan() {
            zone_of_row[i] = u32::MAX;
            continue;
        }
        let z = index.zone_of(dec[i]);
        zone_of_row[i] = z as u32;
        index.zone_start[z + 1] += 1;
        valid += 1;
    }
    for z in 0..zones {
        index.zone_start[z + 1] += index.zone_start[z];
    }
    let mut fill: Vec<u32> = index.zone_start[..zones].to_vec();
    let mut items = vec![Item { ra: 0.0, dec: 0.0, idx: 0 }; valid];
    for i in 0..n {
        let z = zone_of_row[i];
        if z == u32::MAX {
            continue;
        }
        let at = fill[z as usize] as usize;
        fill[z as usize] += 1;
        items[at] = Item { ra: ra[i], dec: dec[i], idx: i as u32 };
    }
    drop(fill);
    drop(zone_of_row);
    for z in 0..zones {
        let (a, b) = (index.zone_start[z] as usize, index.zone_start[z + 1] as usize);
        if b - a > 1 {
            items[a..b].sort_unstable_by(|x, y| x.ra.partial_cmp(&y.ra).unwrap().then(x.idx.cmp(&y.idx)));
        }
    }
    index.items = items;
    Box::into_raw(index)
}

#[no_mangle]
pub unsafe extern "C" fn xm_free(index: *mut Index) {
    if !index.is_null() {
        drop(Box::from_raw(index));
    }
}

#[no_mangle]
pub unsafe extern "C" fn xm_index_size(index: *const Index) -> u32 {
    (*index).items.len() as u32
}
#[no_mangle]
pub unsafe extern "C" fn xm_zone_count(index: *const Index) -> u32 {
    (*index).zones as u32
}
#[no_mangle]
pub unsafe extern "C" fn xm_zone_height(index: *const Index) -> f64 {
    (*index).height
}

/// Queries `count` sources. Results (valid until the next xm_query): offsets (count + 1 u32), then for all hits in
/// source order, sorted per source by (key, row): rows (u32), seps (f64), keys (f64). Sources with a NaN position get
/// no hits. Returns the number of hits.
#[no_mangle]
pub unsafe extern "C" fn xm_query(index: *mut Index, ra: *const f64, dec: *const f64, count: usize, radius: f64) -> u32 {
    let index = &mut *index;
    let mut hits = std::mem::take(&mut index.hits);
    let mut offsets = std::mem::take(&mut index.offsets);
    let mut rows = std::mem::take(&mut index.rows);
    let mut seps = std::mem::take(&mut index.seps);
    let mut keys = std::mem::take(&mut index.keys);
    offsets.clear();
    rows.clear();
    seps.clear();
    keys.clear();
    offsets.push(0);
    for i in 0..count {
        let (qra, qdec) = (*ra.add(i), *dec.add(i));
        if !qra.is_nan() {
            hits.clear();
            index.query(qra, qdec, radius, &mut hits);
            if hits.len() > 1 {
                hits.sort_unstable_by(|a, b| a.key.partial_cmp(&b.key).unwrap().then(a.row.cmp(&b.row)));
            }
            for h in hits.iter() {
                rows.push(h.row);
                seps.push(h.sep);
                keys.push(h.key);
            }
        }
        offsets.push(rows.len() as u32);
    }
    let total = rows.len() as u32;
    index.hits = hits;
    index.offsets = offsets;
    index.rows = rows;
    index.seps = seps;
    index.keys = keys;
    total
}

#[no_mangle]
pub unsafe extern "C" fn xm_res_offsets(index: *const Index) -> *const u32 {
    (*index).offsets.as_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn xm_res_rows(index: *const Index) -> *const u32 {
    (*index).rows.as_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn xm_res_seps(index: *const Index) -> *const f64 {
    (*index).seps.as_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn xm_res_keys(index: *const Index) -> *const f64 {
    (*index).keys.as_ptr()
}
