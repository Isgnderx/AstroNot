// GET /api/sia?collection=spherex_dr1&ra=83.8221&dec=-5.3911[&detector=2] — a narrow proxy for IRSA's SIA service, for the Time Machine.
//
// Why it exists: IRSA's SIA service sends no Access-Control-Allow-Origin header (checked 12–15 Nov 2026), so a browser page cannot
// read its answer. Everything else the Time Machine needs (the image pixels) comes straight from IRSA's public S3 bucket, which
// does send CORS headers. This is the only server code in AstroNot.
//
// Scope, on purpose: it accepts only a SPHEREx collection name and a position, builds the IRSA request itself (fixed tiny search
// radius, optional single-detector band, CSV, at most 10000 records) and returns IRSA's CSV unchanged. It forwards no other parameter, no header and no URL, so it
// cannot be used to reach anything else.
//
// Runs as a Cloudflare Pages Function (this file's path is its route). serve.mjs imports the same handler for local previews, so
// the two behave identically. On a static host without functions the request 404s and the page falls back to the IRSA link + CSV
// import, as Observation Search does.

export const SIA_URL = "https://irsa.ipac.caltech.edu/SIA";
export const COLLECTIONS = new Set(["spherex_dr1", "spherex_qr3", "spherex_dr1_deep", "spherex_qr3_deep"]);
export const SEARCH_RADIUS_DEG = 0.0003;
export const MAX_RECORDS = 10000;
// A narrow window at the centre of each detector's band: SIA's BAND keeps frames whose wavelength range contains it, so only that
// detector's frames come back (about a sixth of the rows; a deep field has ~2000 per detector over a year).
export const DETECTOR_BAND_CENTRES_UM = { 1: 0.92, 2: 1.36, 3: 2.02, 4: 3.12, 5: 4.12, 6: 4.71 };
const TIMEOUT_MS = 60000;

const number = (text) => (typeof text === "string" && /^[+-]?(\d+\.?\d*|\.\d+)$/.test(text.trim()) ? Number(text) : NaN);

// The SIA BAND value (metres) that selects one detector.
export function detectorBand(detector) {
  const c = DETECTOR_BAND_CENTRES_UM[detector];
  return (c - 0.005) * 1e-6 + " " + (c + 0.005) * 1e-6;
}

// The IRSA URL for validated parameters, or { error } with a message for the caller.
export function buildIrsaSiaUrl(params) {
  const collection = params.get("collection");
  const ra = number(params.get("ra"));
  const dec = number(params.get("dec"));
  const detector = params.has("detector") ? number(params.get("detector")) : null;
  if (!COLLECTIONS.has(collection)) return { error: "collection must be one of " + [...COLLECTIONS].join(", ") };
  if (!(ra >= 0 && ra < 360)) return { error: "ra must be a number of degrees from 0 to 360" };
  if (!(dec >= -90 && dec <= 90)) return { error: "dec must be a number of degrees from -90 to 90" };
  if (detector !== null && !Object.hasOwn(DETECTOR_BAND_CENTRES_UM, detector)) return { error: "detector must be 1 to 6" };
  const url = new URL(SIA_URL);
  url.searchParams.set("COLLECTION", collection);
  url.searchParams.set("POS", "CIRCLE " + ra + " " + dec + " " + SEARCH_RADIUS_DEG);
  if (detector !== null) url.searchParams.set("BAND", detectorBand(detector));
  url.searchParams.set("RESPONSEFORMAT", "CSV");
  url.searchParams.set("MAXREC", String(MAX_RECORDS));
  return { url: url.href };
}

function reply(status, body, extra = {}) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra },
  });
}

// `fetchImpl` is injectable for tests; Cloudflare and serve.mjs use the global fetch.
export async function handleSia(request, fetchImpl = globalThis.fetch) {
  if (request.method !== "GET" && request.method !== "HEAD") return reply(405, "GET only", { Allow: "GET, HEAD" });
  const built = buildIrsaSiaUrl(new URL(request.url).searchParams);
  if (built.error) return reply(400, built.error);
  let upstream;
  try {
    upstream = await fetchImpl(built.url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "text/csv" } });
  } catch (error) {
    return reply(504, "IRSA did not answer (" + (error && error.name === "TimeoutError" ? "timed out" : "network error") + "). Try again.");
  }
  if (!upstream.ok) {
    await upstream.body?.cancel();
    return reply(502, "IRSA answered HTTP " + upstream.status + ". Try again in a minute.");
  }
  const text = await upstream.text();
  // SIA reports query errors as a VOTable with HTTP 200; pass it on as it is and let the page's parser read the message.
  return new Response(request.method === "HEAD" ? null : text, {
    status: 200,
    headers: {
      "Content-Type": text.trimStart().startsWith("<") ? "application/xml; charset=utf-8" : "text/csv; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "X-AstroNot-Upstream": "IRSA SIA",
    },
  });
}

export function onRequest(context) {
  return handleSia(context.request);
}
