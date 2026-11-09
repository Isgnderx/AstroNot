const astroNotRoot = new URL(".", document.currentScript.src);

function siteAsset(path) {
  return new URL(path, astroNotRoot).href;
}

function sitePage(route) {
  const [pathname, hash] = route.split("#");
  const path = pathname.replace(/^\/+|\/+$/g, "");
  const entry = astroNotRoot.protocol === "file:" ? (path ? path + "/index.html" : "index.html") : path;
  const url = new URL(entry, astroNotRoot);
  url.hash = hash ?? "";
  return url.href;
}

for (const link of document.querySelectorAll("a[data-route]")) {
  link.href = sitePage(link.dataset.route);
}
