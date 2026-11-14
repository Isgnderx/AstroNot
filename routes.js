const astroNotRoot = new URL(".", document.currentScript.src);
const astroNotLanguageKey = "astronot-language";
const astroNotLanguageCodes = new Set(["az", "en", "tr", "ru", "zh", "es"]);

function getAstroNotLanguage() {
  const requested = new URL(location.href).searchParams.get("lang");
  if (astroNotLanguageCodes.has(requested)) return requested;
  try {
    const saved = localStorage.getItem(astroNotLanguageKey);
    if (astroNotLanguageCodes.has(saved)) return saved;
  } catch {
    // The URL still carries the language when browser storage is unavailable.
  }
  return "en";
}

let astroNotLanguage = getAstroNotLanguage();

function saveAstroNotLanguage(code) {
  astroNotLanguage = code;
  try {
    localStorage.setItem(astroNotLanguageKey, code);
  } catch {
    // Internal page links carry the preference even without storage.
  }
  const url = new URL(location.href);
  url.searchParams.set("lang", code);
  try {
    history.replaceState(history.state, "", url);
  } catch {
    // Some browsers restrict history changes for files opened directly.
  }
}

function siteAsset(path) {
  return new URL(path, astroNotRoot).href;
}

function sitePage(route) {
  const [pathname, hash] = route.split("#");
  const path = pathname.replace(/^\/+|\/+$/g, "");
  // Folder URLs end in a slash so relative assets resolve the same under any host or project subpath.
  const entry = astroNotRoot.protocol === "file:" ? (path ? path + "/index.html" : "index.html") : (path ? path + "/" : "");
  const url = new URL(entry, astroNotRoot);
  if (astroNotLanguage !== "en" || new URL(location.href).searchParams.has("lang")) {
    url.searchParams.set("lang", astroNotLanguage);
  }
  url.hash = hash ?? "";
  return url.href;
}

for (const link of document.querySelectorAll("a[data-route]")) {
  link.href = sitePage(link.dataset.route);
}
