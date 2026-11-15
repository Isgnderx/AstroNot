import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contentTypes, isPublicPath, notFoundFile } from "./scripts/publish-rules.mjs";
import { handleSia } from "./functions/api/sia.js";

const root = fileURLToPath(new URL(".", import.meta.url));

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }

  let url;
  let parts;
  try {
    url = new URL(request.url, "http://127.0.0.1");
    parts = decodeURIComponent(url.pathname).split("/").filter(Boolean);
  } catch {
    response.writeHead(400).end("Invalid request path");
    return;
  }

  // The 404 page uses a <base> tag, so it renders correctly at any depth.
  async function notFound() {
    try {
      const page = await readFile(join(root, notFoundFile));
      response.writeHead(404, {
        "Content-Type": contentTypes[".html"],
        "Content-Length": page.byteLength,
        "Cache-Control": "no-cache",
      });
      response.end(request.method === "HEAD" ? undefined : page);
    } catch {
      response.writeHead(404).end("Page not found");
    }
  }

  // The one server route (Time Machine search). Same handler as the Cloudflare Pages Function in functions/api/sia.js.
  if (parts.length === 2 && parts[0] === "api" && parts[1] === "sia") {
    const answer = await handleSia(new Request(url, { method: request.method }));
    const body = request.method === "HEAD" ? null : Buffer.from(await answer.arrayBuffer());
    response.writeHead(answer.status, Object.fromEntries(answer.headers));
    response.end(body);
    return;
  }

  if (!isPublicPath(parts)) {
    await notFound();
    return;
  }

  try {
    let file = join(root, ...parts);
    if ((await stat(file)).isDirectory()) {
      // Like GitHub Pages: a folder without a trailing slash redirects, so relative links resolve.
      if (parts.length > 0 && !url.pathname.endsWith("/")) {
        response.writeHead(301, { Location: url.pathname + "/" + url.search }).end();
        return;
      }
      file = join(file, "index.html");
    }
    const type = contentTypes[extname(file)];
    if (!type) {
      await notFound();
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
    if (missing) await notFound();
    else response.writeHead(500).end("Could not load the page");
  }
});

server.listen(Number(process.env.ASTRONOT_PORT ?? 4173), "127.0.0.1", () => {
  console.log("AstroNot at http://127.0.0.1:" + server.address().port);
});
