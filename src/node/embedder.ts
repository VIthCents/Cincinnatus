import { env, pipeline } from "@huggingface/transformers";
import { EMBED_MAX_TOKENS } from "../core/config.ts";
import type { Embedder } from "../core/ports.ts";

/**
 * Local embeddings via transformers.js.
 *
 * Three things here differ from what a quick reading of the docs would suggest,
 * each verified rather than assumed (see docs/DECISIONS.md):
 *
 *  - The package is `@huggingface/transformers` v4. `@xenova/transformers` has
 *    been frozen at 2.17.2 since May 2024.
 *  - Under Node this runs on `onnxruntime-node`, a native addon on device
 *    "cpu". WASM is not a supported Node device; it only applies inside the
 *    webview, which is Phase 2's problem.
 *  - The model is `Xenova/all-MiniLM-L6-v2` with dtype q8, NOT the
 *    `onnx-community` repo that v4's own examples use — that one has no q8
 *    variant and splits its weights into external .onnx_data files.
 */

export const MODEL_REPO = "Xenova/all-MiniLM-L6-v2";
export const MODEL_DTYPE = "q8";
export const MODEL_DIMENSIONS = 384;

/** Stable identity for the embeddings table. Model *and* quantization. */
export const MODEL_ID = `${MODEL_REPO}@${MODEL_DTYPE}`;

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

type Extractor = (
  texts: string[],
  options: Record<string, unknown>,
) => Promise<{ data: ArrayLike<number>; dims: number[] }>;

export async function createNodeEmbedder(
  options: NodeEmbedderOptions = {},
): Promise<Embedder> {
  env.cacheDir = options.cacheDir ?? ".models";

  options.onFirstLoad?.(
    "Loading the matching model. The first run downloads about 23 MB, then it is cached.",
  );

  const extractor = (await pipeline("feature-extraction", MODEL_REPO, {
    dtype: MODEL_DTYPE,
  })) as unknown as Extractor;

  return {
    modelId: MODEL_ID,
    dimensions: MODEL_DIMENSIONS,

    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];

      const output = await extractor([...texts], {
        pooling: "mean",
        normalize: true,
        // The trained sentence-embedding window is 256 tokens. The 512 in
        // tokenizer_config.json is BERT's architectural limit, not what this
        // model was trained to represent.
        truncation: true,
        max_length: EMBED_MAX_TOKENS,
      });

      const dim = output.dims[output.dims.length - 1] ?? MODEL_DIMENSIONS;
      const flat = output.data;

      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i++) {
        const vector = new Float32Array(dim);
        for (let j = 0; j < dim; j++) {
          vector[j] = flat[i * dim + j] ?? 0;
        }
        out.push(vector);
      }
      return out;
    },
  };
}
