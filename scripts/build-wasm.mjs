// Builds every crate in rust/crates (or one, by name) to WebAssembly and writes
//   tools/wasm/<name>.wasm      (what an http(s) page fetches)
//   tools/wasm/<name>.wasm.js   (the same bytes as base64, for pages opened from file://)
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const crates = join(root, "rust", "crates");
const out = join(root, "tools", "wasm");
const only = process.argv[2];
// simd128 is supported by Chrome 91+, Firefox 89+ and Safari 16.4+; a browser without it fails to instantiate and the JS fallback runs.
const env = { ...process.env, RUSTFLAGS: "-C target-feature=+simd128", PATH: join(homedir(), ".cargo", "bin") + delimiter + process.env.PATH };

mkdirSync(out, { recursive: true });
const names = readdirSync(crates).filter((name) => statSync(join(crates, name)).isDirectory() && (!only || name === only));
if (!names.length) throw new Error("No crate to build" + (only ? ": " + only : ""));

for (const name of names) {
  const build = spawnSync("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown", "--manifest-path", join(root, "rust", "Cargo.toml"), "-p", name], { stdio: "inherit", env });
  if (build.status !== 0) process.exit(build.status ?? 1);
  const wasm = join(root, "rust", "target", "wasm32-unknown-unknown", "release", name.replaceAll("-", "_") + ".wasm");
  copyFileSync(wasm, join(out, name + ".wasm"));
  const base64 = readFileSync(wasm).toString("base64");
  writeFileSync(join(out, name + ".wasm.js"), `(globalThis.AstroNotWasmBytes ||= {})[${JSON.stringify(name)}] = "${base64}";\n`);
  console.log(`${name}: ${statSync(wasm).size} bytes`);
}
