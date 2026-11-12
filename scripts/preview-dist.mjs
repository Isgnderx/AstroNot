// Serves a built package the way a static host does, to test it before publishing:
//
//   node scripts/preview-dist.mjs [dist] [--prefix /AstroNot/] [--port 4181]
//
// Folders without a trailing slash redirect to one (301), folders serve index.html, paths are
// case-sensitive, and a missing path returns 404.html with status 404. Only files inside the
// package are reachable. With --prefix the site exists only under that path, like a GitHub Pages
// project site; everything outside it is the host's own 404.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { contentTypes } from "./publish-rules.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf("--" + name);
  return index === -1 ? fallback : args[index + 1];
};
const positional = args.filter((arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"));
const root = resolve(positional[0] ?? "dist");
let prefix = flag("prefix", "/");
if (!prefix.endsWith("/")) prefix += "/";
const port = Number(flag("port", 4181));
const types = { ...contentTypes, ".json": "application/json; charset=utf-8" };

export const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const send = (status, type, body) => {
    response.writeHead(status, { "Content-Type": type, "Content-Length": body.byteLength, "Cache-Control": "no-cache" });
    response.end(request.method === "HEAD" ? undefined : body);
  };
  const missing = async () => {
    if (!url.pathname.startsWith(prefix)) return send(404, "text/plain; charset=utf-8", Buffer.from("Host 404"));
    try {
      send(404, types[".html"], await readFile(join(root, "404.html")));
    } catch {
      send(404, "text/plain; charset=utf-8", Buffer.from("Not found"));
    }
  };

  let relative;
  try {
    relative = decodeURIComponent(url.pathname);
  } catch {
    return send(400, "text/plain", Buffer.from("Bad request"));
  }
  if (prefix !== "/" && url.pathname === prefix.slice(0, -1)) {
    response.writeHead(301, { Location: prefix + url.search }).end();
    return;
  }
  if (!relative.startsWith(prefix)) return missing();
  const parts = relative.slice(prefix.length).split("/").filter(Boolean);
  let file = resolve(root, ...parts);
  if (file !== root && !file.startsWith(root + sep)) return missing();
  try {
    const info = await stat(file);
    if (info.isDirectory()) {
      if (!url.pathname.endsWith("/")) {
        response.writeHead(301, { Location: url.pathname + "/" + url.search }).end();
        return;
      }
      file = join(file, "index.html");
    }
    const type = types[extname(file)];
    if (!type) return missing();
    send(200, type, await readFile(file));
  } catch {
    await missing();
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log("Package " + root + " at http://127.0.0.1:" + server.address().port + prefix);
});
