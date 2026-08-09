import { createTransformersEmbedder, MODEL_ID } from "../shared/embedder.ts";
import type { Embedder } from "../core/ports.ts";

export { MODEL_ID };

/**
 * Webview embedder: onnxruntime-web on WASM.
 *
 * - The .wasm/.mjs runtime files are served from the app bundle at /wasm/
 *   (scripts/copy-wasm.ts puts them there), never a CDN.
 * - Single-threaded on purpose: multithreaded WASM needs SharedArrayBuffer,
 *   which needs cross-origin isolation headers the Tauri webview does not set.
 *   Embedding a search run takes minutes instead of tens of seconds; the UI
 *   shows progress either way, and search stays usable while it happens.
 * - The ~23 MB model downloads once from huggingface.co (the one webview-fetch
 *   egress, allowed in the CSP) and lands in the browser Cache API after that.
 */
export async function createTauriEmbedder(): Promise<Embedder> {
  return createTransformersEmbedder((env) => {
    const wasm = (env.backends as { onnx: { wasm: Record<string, unknown> } }).onnx
      .wasm;
    wasm["wasmPaths"] = "/wasm/";
    wasm["numThreads"] = 1;
  });
}
