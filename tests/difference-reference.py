"""Independent reference for tests/difference.test.mjs, computed with astropy and reproject.

Reads one JSON request on stdin and writes one JSON reply on stdout. Run with `python -I`.
Request keys:
  reproject  { reference, target }  paths of two FITS files (image HDU named IMAGE, or the first image HDU). The target is
             reprojected onto the reference grid with reproject_interp(order='bilinear'); the reply holds `values` and
             `footprint` (row-major, row 0 at the bottom, null for NaN) and the shape.
  read       path of a FITS file written by AstroNot; the reply summarises each HDU (name, shape, BUNIT, first header
             cards of interest, NaN count, WCS pixel-to-sky of the centre pixel).
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


def image_hdu(hdul):
    for hdu in hdul:
        if hdu.name == "IMAGE":
            return hdu
    for hdu in hdul:
        if hdu.data is not None and hdu.data.ndim == 2:
            return hdu
    raise ValueError("no image HDU")


def listing(array):
    flat = np.asarray(array, dtype=float).ravel()
    return [None if not np.isfinite(value) else float(value) for value in flat]


if "reproject" in request:
    import reproject

    reply["reproject"] = reproject.__version__
    spec = request["reproject"]
    with fits.open(spec["reference"]) as ref_hdul, fits.open(spec["target"]) as tgt_hdul:
        ref = image_hdu(ref_hdul)
        tgt = image_hdu(tgt_hdul)
        ref_wcs = WCS(ref.header, ref_hdul)
        tgt_wcs = WCS(tgt.header, tgt_hdul)
        values, footprint = reproject.reproject_interp(
            (np.asarray(tgt.data, dtype=float), tgt_wcs.celestial), ref_wcs.celestial, shape_out=ref.data.shape, order="bilinear"
        )
    reply["shape"] = list(values.shape)
    reply["values"] = listing(values)
    reply["footprint"] = [float(value) for value in np.asarray(footprint).ravel()]

if "read" in request:
    summary = []
    with fits.open(request["read"]) as hdul:
        for hdu in hdul:
            entry = {"name": hdu.name, "shape": list(hdu.data.shape) if hdu.data is not None else None}
            for key in ("BUNIT", "DIFFDIR", "DIFFMODE", "REFOBS", "TGTOBS", "BGMETHOD", "CTYPE1", "CRVAL1", "CRPIX1", "BITPIX"):
                if key in hdu.header:
                    entry[key] = hdu.header[key]
            if hdu.data is not None:
                data = np.asarray(hdu.data, dtype=float)
                entry["nan"] = int(np.isnan(data).sum())
                entry["sum"] = float(np.nansum(data))
                entry["values"] = listing(data)
                if "CTYPE1" in hdu.header:
                    sky = WCS(hdu.header).pixel_to_world_values(data.shape[1] / 2, data.shape[0] / 2)
                    entry["centre_sky"] = [float(sky[0]), float(sky[1])]
            summary.append(entry)
    reply["hdus"] = summary

json.dump(reply, sys.stdout)
