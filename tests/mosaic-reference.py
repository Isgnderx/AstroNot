"""Independent reader for tests/mosaic.test.mjs, built on astropy.

Reads one JSON request on stdin and writes one JSON reply on stdout. Run with `python -I`.
Request keys:
  read  path of a FITS file written by AstroNot Mosaic Builder; the reply summarises every HDU (name, shape, BITPIX, BUNIT,
        provenance keywords, NaN count, the pixel values and the WCS sky position of chosen pixels).
  pixels  optional list of [x, y] FITS pixel positions (1-based) whose sky position astropy computes from the primary HDU WCS.
"""
import json
import sys
import warnings

import astropy
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

warnings.simplefilter("ignore")
request = json.load(sys.stdin)
reply = {"astropy": astropy.__version__, "numpy": np.__version__}


def listing(array):
    flat = np.asarray(array, dtype=float).ravel()
    return [None if not np.isfinite(value) else float(value) for value in flat]


if "read" in request:
    summary = []
    with fits.open(request["read"]) as hdul:
        for hdu in hdul:
            entry = {"name": hdu.name, "shape": list(hdu.data.shape) if hdu.data is not None else None}
            for key in ("BUNIT", "BITPIX", "COMBINE", "NINPUTS", "RESAMPLE", "PIXSCALE", "SRCFIL01", "SRCOBS01", "SRCFIL02", "SRCOBS02", "CTYPE1", "CRPIX1"):
                if key in hdu.header:
                    entry[key] = hdu.header[key]
            entry["history"] = [str(card) for card in hdu.header.get("HISTORY", [])]
            if hdu.data is not None:
                data = np.asarray(hdu.data, dtype=float)
                entry["nan"] = int(np.isnan(data).sum())
                entry["sum"] = float(np.nansum(data))
                entry["values"] = listing(data)
            summary.append(entry)
        reply["hdus"] = summary
        primary = hdul[0]
        wcs = WCS(primary.header)
        sky = []
        for x, y in request.get("pixels", []):
            ra, dec = wcs.pixel_to_world_values(x - 1, y - 1)
            sky.append([float(ra), float(dec)])
        reply["sky"] = sky

json.dump(reply, sys.stdout)
