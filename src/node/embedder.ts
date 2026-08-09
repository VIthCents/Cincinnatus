import {
  MODEL_DIMENSIONS,
  MODEL_DTYPE,
  MODEL_ID,
  MODEL_REPO,
  createTransformersEmbedder,
} from "../shared/embedder.ts";
import type { Embedder } from "../core/ports.ts";

export { MODEL_DIMENSIONS, MODEL_DTYPE, MODEL_ID, MODEL_REPO };

export interface NodeEmbedderOptions {
  /**
   * Where to cache the ~23 MB model.
   *
   * Defaults to `.models/` in the repo rather than the library default, which
   * is inside node_modules and is therefore destroyed by every pnpm install —
   * re-downloading the model each time.
   */
  readonly cacheDir?: string;
  readonly onFirstLoad?: (message: string) => void;
}

/** Node runs onnxruntime-node (native, device "cpu"); WASM is webview-only. */
export async function createNodeEmbedder(
  options: NodeEmbedderOptions = {},
): Promise<Embedder> {
  options.onFirstLoad?.(
    "Loading the matching model. The first run downloads about 23 MB, then it is cached.",
  );
  return createTransformersEmbedder((env) => {
    env.cacheDir = options.cacheDir ?? ".models";
  });
}
