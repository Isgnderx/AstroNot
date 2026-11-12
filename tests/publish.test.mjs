import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildDemo, normalizeBase } from "../scripts/build-demo.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));

test("package holds only public files and records the version", async () => {
  const out = await mkdtemp(join(tmpdir(), "astronot-pkg-"));
  try {
    const { manifest } = await buildDemo({ out, base: "/AstroNot" });
    const paths = manifest.files.map((file) => file.path);
    assert.equal(manifest.base, "/AstroNot/");
    assert.ok(paths.includes("index.html") && paths.includes("404.html"));
    assert.ok(paths.includes("assets/tools/spherex-example.js") && paths.includes("assets/inter-latin.woff2"));
    for (const path of paths) {
      assert.doesNotMatch(path, /^(tests|scripts|\.git)\b|\.(md|py|mjs|json)$/, path);
    }
    assert.ok(!paths.includes("serve.mjs") && !paths.includes("README.md"));
    assert.match(manifest.version.commit, /^[0-9a-f]{12}$|^unknown$/);
    assert.match(manifest.version.packageSha256, /^[0-9a-f]{64}$/);
    assert.match(await readFile(join(out, "404.html"), "utf8"), /<base href="\/AstroNot\/">/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("base paths are validated", () => {
  assert.equal(normalizeBase("/"), "/");
  assert.equal(normalizeBase("/AstroNot/"), "/AstroNot/");
  assert.throws(() => normalizeBase("AstroNot"));
  assert.throws(() => normalizeBase("//evil.example/"));
});

test("serve.mjs serves exactly the package files, redirects folders and returns the 404 page", async () => {
  const out = await mkdtemp(join(tmpdir(), "astronot-pkg-"));
  const { manifest } = await buildDemo({ out });
  const child = spawn(process.execPath, ["serve.mjs"], { cwd: repo, env: { ...process.env, ASTRONOT_PORT: "0" } });
  try {
    const origin = await new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        const match = /http:\/\/127\.0\.0\.1:\d+/.exec(String(chunk));
        if (match) resolve(match[0]);
      });
      child.on("error", reject);
      setTimeout(() => reject(new Error("server did not start")), 5000);
    });
    const get = (path, init) => fetch(origin + path, { redirect: "manual", ...init });

    for (const file of manifest.files) {
      if (file.path === "404.html" || file.path === "build-manifest.json") continue;
      const response = await get("/" + file.path);
      assert.equal(response.status, 200, file.path);
      await response.arrayBuffer();
    }
    for (const path of ["/README.md", "/TODO.md", "/BUILD-PROMPTS.md", "/serve.mjs", "/tests/wcs.test.mjs",
      "/tests/wcs-reference.py", "/.git/config", "/scripts/build-demo.mjs", "/.gitignore", "/%2e%2e/package.json", "/nope"]) {
      const response = await get(path);
      assert.equal(response.status, 404, path);
      assert.match(await response.text(), /Page not found/, path);
    }
    const redirect = await get("/tools/sky-explorer?x=1");
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get("location"), "/tools/sky-explorer/?x=1");
    assert.equal((await get("/tools/")).status, 200);
  } finally {
    child.kill();
    await rm(out, { recursive: true, force: true });
  }
});
