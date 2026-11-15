"""Reference values for tests/time-sequence.test.mjs (optional; needs astropy and reproject).

Reads a JSON request on stdin: {"fits": path, "ra", "dec", "n", "scale_deg"}. Builds the Time Machine's grid as a FITS WCS
(gnomonic, centred on ra/dec, x to the west and y to the south, so array row 0 is north and column 0 is east) and resamples the
IMAGE HDU of the file onto it twice:
- "values": reproject_interp(order="bilinear").
- "exact": astropy all_world2pix at a tolerance of 1e-10 pixel, then scipy map_coordinates(order=1): a second, independent bilinear
  resampling with an exact SIP inversion.
Writes JSON with grid pixel -> sky for a few pixels and both sets of values (null for no data).
"""
import json
import sys

import astropy
import numpy as np
import reproject
from astropy.io import fits
from astropy.wcs import WCS
from reproject import reproject_interp
from scipy.ndimage import map_coordinates

req = json.load(sys.stdin)
n = req["n"]
s = req["scale_deg"]
c = (n - 1) / 2

grid = WCS(naxis=2)
grid.wcs.ctype = ["RA---TAN", "DEC--TAN"]
grid.wcs.crval = [req["ra"], req["dec"]]
grid.wcs.crpix = [c + 1, c + 1]  # FITS pixels are 1-based
grid.wcs.cd = [[-s, 0.0], [0.0, -s]]  # x grows to the west, y grows to the south

with fits.open(req["fits"]) as hdul:
    image = hdul["IMAGE"]
    data = image.data.astype(np.float64)
    wcs = WCS(image.header, hdul, relax=True).celestial
    values, footprint = reproject_interp((data, wcs), grid, shape_out=(n, n), order="bilinear")

ys, xs = np.mgrid[0:n, 0:n]
world = grid.wcs_pix2world(np.column_stack([xs.ravel(), ys.ravel()]), 0)
with fits.open(req["fits"]) as hdul:
    image_wcs = WCS(hdul["IMAGE"].header, hdul, relax=True).celestial
    fx, fy = image_wcs.all_world2pix(world[:, 0], world[:, 1], 0, tolerance=1e-10, maxiter=50)
h, w = data.shape
inside = (fx >= 0) & (fy >= 0) & (fx <= w - 1) & (fy <= h - 1)
exact = map_coordinates(data, [fy, fx], order=1, mode="nearest", prefilter=False)
exact = [float(v) if ok and np.isfinite(v) else None for v, ok in zip(exact, inside)]

probe = [[0, 0], [n - 1, 0], [0, n - 1], [n - 1, n - 1], [c, c], [3, 7]]
sky = [list(map(float, grid.wcs_pix2world([[x, y]], 0)[0])) for x, y in probe]
flat = [None if (f == 0 or not np.isfinite(v)) else float(v) for v, f in zip(values.ravel(), footprint.ravel())]
json.dump({"astropy": astropy.__version__, "reproject": reproject.__version__, "probe": probe, "sky": sky, "values": flat, "exact": exact}, sys.stdout)
