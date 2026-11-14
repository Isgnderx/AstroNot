# Provenance of the spxphot reference material

Generated 2026-11-14 from the owner's spxphot (Rust reimplementation of the IRSA SPHEREx Spectrophotometry Tool), `C:\Users\loq\Downloads\spxphot\spxphot`.

- spxphot is not a git repository. Source hashes (sha256, `src/*.rs`):
  - archive.rs a44358f2ac680c385069180ab2f5758f7252b171dd44e64814da62c0b4bf1cbc
  - cutout.rs 1d084ce1518bd125ed769d8520afd04d92d415c0b70beeada55966211a60f2f5
  - fits.rs de79a773fd8a2fb821f6d04d3421dcc82f4a4842b20e1bb6de0467e7f37f1195
  - main.rs 762d207e864609aa99e0c85ddd832d15ac1514d8886fb311005772e817d44bc5
  - phot.rs ba970bd082b2151b070aadaeb07345e2a07a20cba27b6e039041768be492a1e8
  - psf.rs 0cc444c35178db6b5bee23b9ad6aa86d72903a2b7e3c2b53fc062e39c7ec2c20
  - search.rs d3a9297057555a9d5cbeb5fb498629bfbb0b0d8cbeb26d4e5f3470ad36ca6570
  - sersic.rs ccf5082f9cb27fa26336ffb20a6449181094bbb0c4899bc85e79f4103b5daa70
  - wcs.rs d41b9ac2e8b0a585bb330cc790b087b2d932270959f794923e370c17d0123269
  - Cargo.lock 84fccf740a3b5bd94ff8e1ad300b79d895f8a0f600fec4b0611886ff1dd71493
- Built with cargo 1.100.0 (`cargo build --release`, 2 compiler warnings).

## Copied unchanged from spxphot

`epsf_vectors.json`, `wcs_vectors.json`, `rice_vectors.json` (from `tests/data/`); `bd17_irsa.csv`, `wd_irsa.csv`, `gal_irsa.csv` (from `validation/`, the IRSA tool's own outputs).

## `bd17_spxphot.csv` (oracle, regenerated)

```
spxphot.exe phot --ra 332.882637 --dec 18.093128 --name BD+17_4708 -o bd17_spxphot.csv
```

Result: 352 frame(s) cover 1 target(s); 352 spectral points, 0 frame failure(s), 6 ePSF calibration download(s).

Compared with `validation/bd17_spxphot.csv` in the spxphot copy, joined on `lvf_id`+`det_id`: 352 rows each, 0 missing, 0 rows whose `flux` differs by more than 1e-9 relative (largest relative difference 9.3e-12). The archive has not been reprocessed. The files are not byte-identical (last digits of some floats).

## `bd17-cutout.fits` and `bd17-cutout.frame.json` (fixture)

The first `SPHEREx-D1` row of the SIA response for `COLLECTION=spherex_dr1`, `POS=CIRCLE 332.882637 18.093128 0.0001`, `MAXREC=2000` (239 rows):

```
spxphot.exe cutout --file dr1/level2/2025W21_2C/l2b-v27-2026-199/1/level2_2025W21_2C_0321_1D1_spx_l2b-v27-2026-199.fits --ra 332.882637 --dec 18.093128 --size 0.06 -o bd17-cutout.fits
```

- access_url: `https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/2025W21_2C/l2b-v27-2026-199/1/level2_2025W21_2C_0321_1D1_spx_l2b-v27-2026-199.fits`
- obs_id `2025W21_2C_0321_1`, DETECTOR 1, EXPIDN = lvf_id = 202521203032111 (present in `bd17_spxphot.csv` with det_id 1, lambda 0.99523 um, flux 22734.84).
- File: 3,965,760 bytes; HDUs PRIMARY, IMAGE (35x35 float32), FLAGS (35x35 int32), VARIANCE, ZODI, EPSF (8752 x 441 bytes), WCS-WAVE (720 x 1 bytes).

## `assets/tools/spherex-bd17-frames.js`

Written by `node scripts/make-bd17-frames.mjs` on 2026-11-14: spherex_dr1 239 rows, spherex_qr3 113 rows, columns trimmed to obs_id, access_url, access_format, energy_bandpassname, obs_collection, t_min, t_max, em_min, em_max, s_region.
