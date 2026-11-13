import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const Wasm = require("../tools/wasm.js");

test("wasm loader runs a built kernel and moves typed arrays through memory", async () => {
  const kernel = await Wasm.load("probe");
  assert.ok(kernel, "tools/wasm/probe.wasm is missing: run node scripts/build-wasm.mjs");
  const data = new Float64Array([1.5, 2.5, -4, 1e10]);
  const region = kernel.put(data);
  assert.equal(kernel.exports.probe_sum(region.ptr, data.length), 1.5 + 2.5 - 4 + 1e10);
  kernel.free(region);
  assert.equal(await Wasm.load("does-not-exist"), null);
});
