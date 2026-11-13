# AstroNot Rust kernels (WebAssembly)

One crate per kernel under `crates/<name>` (`crate-type = ["cdylib"]`, no dependencies, no wasm-bindgen).
Every crate exports plain `extern "C"` functions plus `an_alloc(bytes) -> ptr` and `an_free(ptr, bytes)`;
JS copies typed arrays into wasm memory through `tools/wasm.js` (`AstroNotWasm`). `crates/probe` is the smallest
working example (alloc/free plus one function) and is only used by `tests/wasm.test.mjs`.

Build: `node scripts/build-wasm.mjs [crate-name]` (needs rustup with the `wasm32-unknown-unknown` target).
Output: `tools/wasm/<name>.wasm` (served as `application/wasm`) and `tools/wasm/<name>.wasm.js`
(the same bytes in base64, so pages opened from `file://` still work). Both are committed so the site needs no build step.
Every kernel has a JS implementation that stays as the fallback and as the reference in tests.
