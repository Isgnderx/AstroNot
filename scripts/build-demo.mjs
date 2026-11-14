// Builds the publish package: only the public site files, a 404 page, a .nojekyll marker and a manifest.
//
//   node scripts/build-demo.mjs [--out dist] [--base /]
//
// --base is the URL path the site is mounted at on the host: "/" for a root or custom domain,
// "/AstroNot/" for a GitHub Pages project site. Only 404.html needs it (a 404 page is served at any
// requested depth); every other page uses relative links and routes.js.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  contentTypes, notFoundFile, publicDirectories, publicSegment, rootFiles, secretLikeName,
} from "./publish-rules.mjs";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestName = "build-manifest.json";

function option(name, fallback) {
  const index = process.argv.indexOf("--" + name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error("--" + name + " needs a value");
  return value;
}

export function normalizeBase(value) {
  if (!/^\/([a-z\d._~-]+\/)*$/i.test(value.endsWith("/") ? value : value + "/") || value.includes("//")) {
    throw new Error("--base must be a URL path such as / or /AstroNot/");
  }
  return value.endsWith("/") ? value : value + "/";
}

async function collect(directory, parts, files) {
  for (const entry of await readdir(join(repo, ...parts, directory), { withFileTypes: true })) {
    const name = entry.name;
    const path = [...parts, directory, name];
    const shown = path.join("/");
    if (!publicSegment.test(name)) {
      if (!name.startsWith(".")) throw new Error("Unexpected file name in a public folder: " + shown);
      throw new Error("Dotfile in a public folder: " + shown);
    }
    if (secretLikeName.test(name)) throw new Error("Secret-like file name in a public folder: " + shown);
    if (entry.isDirectory()) await collect(name, [...parts, directory], files);
    else if (entry.isFile()) {
      if (!contentTypes[extname(name).toLowerCase()]) throw new Error("File type is not publishable: " + shown);
      files.push(shown);
    }
  }
}

function git(...args) {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function versionInfo(publicFiles) {
  const head = git("rev-parse", "--short=12", "HEAD");
  if (!head) return { commit: "unknown", dirty: null, uncommittedPublicFiles: [] };
  const changed = (git("status", "--porcelain", "--untracked-files=all") ?? "")
    .split("\n").filter(Boolean).map((line) => line.slice(3).replace(/^"|"$/g, ""));
  const published = new Set(publicFiles);
  return {
    commit: head,
    dirty: changed.length > 0,
    uncommittedPublicFiles: changed.filter((path) => published.has(path)),
  };
}

async function clearOutput(out) {
  if (out === repo || repo.startsWith(out + sep)) throw new Error("--out must not be the project folder or a parent of it");
  let entries;
  try {
    entries = await readdir(out);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (entries.length > 0 && !entries.includes(manifestName) && !entries.every((name) => name === ".git")) {
    throw new Error(out + " is not empty and is not a previous AstroNot build; refusing to delete it");
  }
  for (const name of entries) if (name !== ".git") await rm(join(out, name), { recursive: true, force: true });
}

export async function buildDemo({ out = join(repo, "dist"), base = "/" } = {}) {
  out = resolve(out);
  base = normalizeBase(base);

  const files = [];
  for (const name of rootFiles) {
    if (!(await stat(join(repo, name))).isFile()) throw new Error("Missing public file: " + name);
    files.push(name);
  }
  for (const directory of publicDirectories) await collect(directory, [], files);
  files.push(notFoundFile);
  files.sort();

  await clearOutput(out);
  for (const file of files) {
    const target = join(out, ...file.split("/"));
    await mkdir(join(target, ".."), { recursive: true });
    if (file === notFoundFile) {
      const source = await readFile(join(repo, file), "utf8");
      const rootBase = /<base href="\/"\s*\/?>/;
      if (!rootBase.test(source)) throw new Error(notFoundFile + ' must contain <base href="/">');
      await writeFile(target, source.replace(rootBase, '<base href="' + base + '">'));
    } else {
      await cp(join(repo, ...file.split("/")), target);
    }
  }
  await writeFile(join(out, ".nojekyll"), "");

  const entries = [];
  for (const file of files) {
    const bytes = await readFile(join(out, ...file.split("/")));
    entries.push({ path: file, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const packageSha256 = createHash("sha256")
    .update(entries.map((entry) => entry.path + "\n" + entry.sha256 + "\n").join("")).digest("hex");
  const manifest = {
    name: "AstroNot demo package",
    base,
    version: { ...versionInfo(files), packageSha256 },
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    files: entries,
  };
  await writeFile(join(out, manifestName), JSON.stringify(manifest, null, 2) + "\n");
  return { out, manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { out, manifest } = await buildDemo({ out: option("out", join(repo, "dist")), base: option("base", "/") });
    const { commit, dirty, uncommittedPublicFiles } = manifest.version;
    console.log("Built " + manifest.fileCount + " files (" + manifest.totalBytes + " bytes) into " + relative(process.cwd(), out) +
      " for base " + manifest.base);
    console.log("Version " + commit + (dirty ? " (working tree has uncommitted changes" +
      (uncommittedPublicFiles.length ? "; public files: " + uncommittedPublicFiles.join(", ") : "; none in public files") + ")" : "") +
      ", package sha256 " + manifest.version.packageSha256.slice(0, 16));
  } catch (error) {
    console.error("Build failed: " + error.message);
    process.exitCode = 1;
  }
}
