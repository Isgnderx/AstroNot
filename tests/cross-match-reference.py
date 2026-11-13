"""Independent reference values for tests/cross-match.test.mjs, computed with Astropy.

Prints one JSON object. Run with `python tests/cross-match-reference.py` (needs astropy). The numbers are pasted into the
test file as constants so the Node test needs no Python. Cases:
  separations  great-circle separations (SkyCoord.separation) in arcsec
  motion       positions moved with SkyCoord.apply_space_motion (no distance or radial velocity given, so there is no
               parallax or perspective term, the same model as tools/xmatch.js propagatePosition)
"""
import json
import warnings

import astropy
import astropy.units as u
from astropy.coordinates import SkyCoord
from astropy.time import Time

warnings.simplefilter("ignore")

sep_cases = {
    "wrap_equator": [(359.9999, 0.0, 0.0001, 0.0)],
    "near_pole_same_ra_gap": [(10.0, 89.9999, 190.0, 89.9999)],
    "near_pole_90deg_in_ra": [(10.0, 89.9999, 100.0, 89.9999)],
    "tiny": [(156.09328159, -41.64466331, 156.09328259, -41.64466331)],
    "antipodal": [(0.0, 0.0, 180.0, 0.0)],
}
separations = {
    name: [SkyCoord(a * u.deg, b * u.deg).separation(SkyCoord(c * u.deg, d * u.deg)).arcsec for a, b, c, d in cases]
    for name, cases in sep_cases.items()
}

motion_cases = {
    "gaia_like_back_5p26yr": (156.11948822347, -41.65045654674, -2.917, 2.214, 2016.0, 2010.744),
    "fast_mid_dec": (10.0, -30.0, -500.0, 300.0, 2016.0, 2000.0),
    "high_dec": (200.0, 85.0, 120.0, -80.0, 2016.0, 2026.0),
    "near_pole": (40.0, 89.99, 300.0, 200.0, 2016.0, 2056.0),
    "ra_wrap": (359.99999, 0.0, 5000.0, 0.0, 2016.0, 2046.0),
}
moved = {}
for name, (ra, dec, pmra, pmdec, t0, t1) in motion_cases.items():
    c = SkyCoord(ra=ra * u.deg, dec=dec * u.deg, pm_ra_cosdec=pmra * u.mas / u.yr, pm_dec=pmdec * u.mas / u.yr,
                 obstime=Time(t0, format="jyear"), frame="icrs")
    n = c.apply_space_motion(new_obstime=Time(t1, format="jyear"))
    moved[name] = {"input": [ra, dec, pmra, pmdec, t0, t1], "ra": n.ra.deg, "dec": n.dec.deg}

print(json.dumps({"astropy": astropy.__version__, "separations": separations, "motion": moved}, indent=1))
