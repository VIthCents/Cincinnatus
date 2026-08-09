#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/**
 * Copy the ONNX runtime's wasm assets into public/wasm/ so the webview loads
 * them from the app bundle instead of a CDN (constraint 3: the only network
 * the webview itself touches is the one-time model download).
 *
 * Runs at the front of `pnpm dev` and `pnpm build` — explicitly in the script
 * line, not as a pre-hook, so nothing depends on package-manager lifecycle
 * behavior. Idempotent and fast when files are already in place.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "public", "wasm");

// Resolve onnxruntime-web through @huggingface/transformers so we copy the
// exact version transformers.js will ask for, not whatever pnpm hoisted.
// Its `exports` map blocks "./package.json", so resolve the main entry and
// walk up to the package root.
// realpath matters: under pnpm the package dir is a symlink into .pnpm, and
// createRequire builds its lookup chain from the literal path it is given —
// from the symlink it would look in the repo's top-level node_modules, where
// pnpm deliberately does not put transitive deps.
const require = createRequire(
  realpathSync(
    join(repoRoot, "node_modules", "@huggingface", "transformers", "package.json"),
  ),
);
const ortEntry = require.resolve("onnxruntime-web");
const marker = `${sep}onnxruntime-web${sep}`;
const markerIndex = ortEntry.lastIndexOf(marker);
if (markerIndex === -1) {
  process.stderr.write(`copy-wasm: cannot locate package root in ${ortEntry}\n`);
  process.exit(1);
}
const distDir = join(ortEntry.slice(0, markerIndex + marker.length), "dist");

// The runtime picks its build by feature detection at load time — observed
// live: WebView2 151 asked for the asyncify variant, not the plain one. Ship
// every CPU variant so the pick always resolves locally. (jsep is WebGPU-only
// and deliberately excluded — we run device "wasm".)
const WANTED = [
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.asyncify.wasm",
  "ort-wasm-simd-threaded.asyncify.mjs",
  "ort-wasm-simd-threaded.jspi.wasm",
  "ort-wasm-simd-threaded.jspi.mjs",
];

mkdirSync(outDir, { recursive: true });

let copied = 0;
for (const name of WANTED) {
  const from = join(distDir, name);
  if (!existsSync(from)) {
    process.stderr.write(`copy-wasm: MISSING ${name} in ${distDir}\n`);
    process.stderr.write(
      `  present: ${readdirSync(distDir)
        .filter((f) => f.endsWith(".wasm"))
        .join(", ")}\n`,
    );
    process.exit(1);
  }
  copyFileSync(from, join(outDir, name));
  copied++;
}
process.stdout.write(`copy-wasm: ${copied} files in public/wasm/\n`);
