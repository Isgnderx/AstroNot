// What the site publishes. serve.mjs (local preview) and scripts/build-demo.mjs (publish package)
// both read these rules, so the preview serves exactly the files that ship and nothing else.

export const rootFiles = new Set(["index.html", "workspace.html", "routes.js", "site.js", "styles.css"]);
// "presentation" is served and published but linked from nowhere: it is reached only by typing /presentation.
export const publicDirectories = new Set(["assets", "tools", "explore", "learn", "about", "presentation"]);

// Files the package adds that the local preview serves only as the 404 page.
export const notFoundFile = "404.html";

export const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".gif": "image/gif",
};

// Every path segment must look like an ordinary public name: no dotfiles, no spaces.
export const publicSegment = /^[a-z\d][a-z\d._-]*$/i;

// Names that must never reach a public folder, even if the extension is allowed.
export const secretLikeName = /(^|[._-])(env|secret|secrets|credentials?|token|tokens|private|id_rsa)([._-]|$)|\.(pem|key|p12|pfx)$/i;

export function isPublicPath(parts) {
  const listed = parts.length === 0 || publicDirectories.has(parts[0]) ||
    (parts.length === 1 && rootFiles.has(parts[0]));
  return listed && parts.every((part) => publicSegment.test(part));
}
