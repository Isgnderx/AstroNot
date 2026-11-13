// FITS Viewer side of the Observation Search hand-off. Observation Search links here with
// ?obs=<OBSID>&product=<IRSA FITS URL (DR1, QR3 or QR2 level 2)>&det=<1-6>&ra=&dec=&size=. The browser cannot fetch the
// archive file itself (IRSA sends no CORS headers), so this panel ties the download to the
// Viewer's "Choose a local FITS file" step and checks the OBSID in the opened file's header.
function setupObservationHandoff() {
  const panel = document.querySelector("[data-fits-handoff]");
  if (!panel) return;
  const params = new URLSearchParams(location.search);
  if (!params.has("obs")) return;

  const obsId = params.get("obs");
  const product = validateIrsaProductUrl(params.get("product") ?? "");
  const detector = Number(params.get("det"));
  const expectedDetector = detector >= 1 && detector <= 6 && Number.isInteger(detector) ? detector : null;
  const note = panel.querySelector("[data-handoff-note]");
  const facts = panel.querySelector("[data-handoff-facts]");
  const actions = panel.querySelector("[data-handoff-actions]");
  const result = panel.querySelector("[data-handoff-result]");
  panel.hidden = false;

  if (!irsaObservationId.test(obsId) || !product) {
    note.textContent = "The observation link is not valid, so it was ignored. Choose a local FITS file instead.";
    facts.hidden = actions.hidden = true;
    return;
  }

  const center = {
    ra: params.has("ra") ? Number(params.get("ra")) : NaN,
    dec: params.has("dec") ? Number(params.get("dec")) : NaN,
    size: params.has("size") ? Number(params.get("size")) : NaN,
  };
  const cutout = irsaCutoutUrl(product.href, center.ra, center.dec, center.size);

  const row = (label, value) => {
    const wrapper = document.createElement("div");
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    term.textContent = label;
    detail.textContent = value;
    wrapper.append(term, detail);
    return wrapper;
  };
  facts.replaceChildren(
    row("Observation ID", obsId),
    row("Data release", irsaReleases[irsaReleaseOfUrl(product)].label),
    row("Detector", expectedDetector ? String(expectedDetector) : "Unavailable"),
    row("Cutout center (ICRS)", cutout ? center.ra + "°, " + center.dec + "°" : "Unavailable"),
    row("Cutout size", cutout ? center.size + "°" : "Unavailable"),
  );

  const link = (label, href, primary) => {
    const anchor = document.createElement("a");
    anchor.className = "workspace-button" + (primary ? " workspace-button--primary" : "");
    anchor.textContent = label;
    anchor.href = href;
    anchor.target = "_blank";
    anchor.rel = "noopener";
    return anchor;
  };
  actions.replaceChildren(...(cutout ? [link("Download FITS cutout", cutout.href, true)] : []), link("Download full FITS file", product.href, !cutout));
  note.textContent = "Selected in Observation Search. Download the file, then choose it with Choose a local FITS file. The Viewer checks its header against this observation.";

  function show(state, message) {
    result.dataset.state = state;
    result.textContent = message;
  }

  document.addEventListener("fits-opening", () => {
    delete result.dataset.state;
    result.textContent = "";
  });
  document.addEventListener("fits-opened", (event) => {
    const { hdus, example } = event.detail;
    if (example) {
      show("neutral", "The bundled SPHEREx example is a fixed sample. It is not the file selected from the archive.");
      return;
    }
    const headers = hdus.map((hdu) => hdu.fields).filter((fields) => fields.OBSID !== undefined);
    if (headers.length === 0) {
      show("unknown", "This file's header has no OBSID, so it cannot be matched to " + obsId + ".");
    } else if (!headers.some((fields) => fields.OBSID === obsId)) {
      show("mismatch", "Header OBSID " + headers[0].OBSID + " does not match the selected observation " + obsId + ". Choose the file you downloaded for this row.");
    } else if (expectedDetector && headers.some((fields) => fields.OBSID === obsId && fields.DETECTOR !== undefined && fields.DETECTOR !== expectedDetector)) {
      show("mismatch", "Header OBSID matches " + obsId + ", but the file is detector " + headers.find((fields) => fields.OBSID === obsId).DETECTOR + " and detector " + expectedDetector + " was selected.");
    } else {
      show("match", "Header OBSID " + obsId + " matches the selected observation" + (expectedDetector ? " and detector " + expectedDetector : "") + ".");
    }
  });
}

setupObservationHandoff();
