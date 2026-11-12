"""Independent WCS reference for tests/wcs.test.mjs, computed with Astropy (wcslib).

Reads one JSON request on stdin and writes one JSON reply on stdout. Run with `python -I`.
Request keys:
  fits_path  path of a FITS file (the HDU named by `extname`, default IMAGE, is used) or
  header     a mapping of FITS keywords to values;
  pixels     list of [x, y] in FITS (1-based) pixel coordinates, converted with origin=1;
  sky        list of [ra, dec] in degrees, converted back with all_world2pix (origin=1);
  segments   list of [x1, y1, x2, y2]; the reply holds the SkyCoord separation in degrees.
"""
import json
import sys
import warnings

import astropy
import numpy as np
from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.wcs import WCS

warnings.simplefilter("ignore")
request = json.load(sys.stdin)

if "fits_path" in request:
    with fits.open(request["fits_path"]) as hdul:
        header = hdul[request.get("extname", "IMAGE")].header.copy()
        wcs = WCS(header, hdul)
else:
    header = fits.Header()
    for key, value in request["header"].items():
        header[key] = value
    wcs = WCS(header)

reply = {"astropy": astropy.__version__, "numpy": np.__version__, "sip": wcs.sip is not None}


def world(points):
    if not points:
        return np.empty(0), np.empty(0)
    arr = np.asarray(points, dtype=float)
    ra, dec = wcs.all_pix2world(arr[:, 0], arr[:, 1], 1)
    return np.mod(ra, 360.0), dec


ra, dec = world(request.get("pixels", []))
reply["pixels"] = [[float(a), float(b)] for a, b in zip(ra, dec)]

sky = request.get("sky", [])
if sky:
    arr = np.asarray(sky, dtype=float)
    x, y = wcs.all_world2pix(arr[:, 0], arr[:, 1], 1, tolerance=1e-12, maxiter=100, quiet=True)
    reply["sky"] = [[float(a), float(b)] for a, b in zip(x, y)]

segments = request.get("segments", [])
if segments:
    arr = np.asarray(segments, dtype=float)
    ra1, dec1 = wcs.all_pix2world(arr[:, 0], arr[:, 1], 1)
    ra2, dec2 = wcs.all_pix2world(arr[:, 2], arr[:, 3], 1)
    a = SkyCoord(ra1 * u.deg, dec1 * u.deg, frame="icrs")
    b = SkyCoord(ra2 * u.deg, dec2 * u.deg, frame="icrs")
    reply["segments"] = [float(value) for value in a.separation(b).deg]

json.dump(reply, sys.stdout)
