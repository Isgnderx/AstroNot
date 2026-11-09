import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const rootFiles = new Set(["index.html", "workspace.html", "routes.js", "site.js", "styles.css"]);
const publicDirectories = new Set(["assets", "tools", "explore", "learn", "about"]);
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }

  let parts;
  try {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    parts = decodeURIComponent(path).split("/").filter(Boolean);
  } catch {
    response.writeHead(400).end("Invalid request path");
    return;
  }

  const isPublic = parts.length === 0 || publicDirectories.has(parts[0]) ||
    (parts.length === 1 && rootFiles.has(parts[0]));
  if (!isPublic || parts.some((part) => !/^[a-z\d][a-z\d._-]*$/i.test(part))) {
    response.writeHead(404).end("Page not found");
    return;
  }

  try {
    let file = join(root, ...parts);
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    const type = contentTypes[extname(file)];
    if (!type) {
      response.writeHead(404).end("Page not found");
      return;
    }

    const content = await readFile(file);
    response.writeHead(200, {
      "Content-Type": type,
      "Content-Length": content.byteLength,
      "Cache-Control": "no-cache",
    });
    response.end(request.method === "HEAD" ? undefined : content);
  } catch (error) {
    const missing = ["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code);
    response.writeHead(missing ? 404 : 500).end(missing ? "Page not found" : "Could not load the page");
  }
});

server.listen(Number(process.env.ASTRONOT_PORT ?? 4173), "127.0.0.1", () => {
  console.log("AstroNot at http://127.0.0.1:" + server.address().port);
});
