import { env, pipeline } from "@huggingface/transformers";
import { EMBED_MAX_TOKENS } from "../core/config.ts";
import type { Embedder } from "../core/ports.ts";

/**
 * Local embeddings via transformers.js — shared between Node (onnxruntime-node,
 * native CPU) and the webview (onnxruntime-web, WASM). The runtime picks its
 * backend; callers only differ in how they configure `env` before the model
 * loads. Verified details (see docs/DECISIONS.md):
 *
 *  - The package is `@huggingface/transformers` v4. `@xenova/transformers` has
 *    been frozen at 2.17.2 since May 2024.
 *  - The model is `Xenova/all-MiniLM-L6-v2` with dtype q8, NOT the
 *    `onnx-community` repo that v4's own examples use — that one has no q8
 *    variant and splits its weights into external .onnx_data files.
 *  - The trained sentence-embedding window is 256 tokens; the 512 in
 *    tokenizer_config.json is BERT's architectural limit.
 */

export const MODEL_REPO = "Xenova/all-MiniLM-L6-v2";
export const MODEL_DTYPE = "q8";
export const MODEL_DIMENSIONS = 384;

/** Stable identity for the embeddings table. Model *and* quantization. */
export const MODEL_ID = `${MODEL_REPO}@${MODEL_DTYPE}`;

type TransformersEnv = typeof env;

type Extractor = (
  texts: string[],
  options: Record<string, unknown>,
) => Promise<{ data: ArrayLike<number>; dims: number[] }>;

export async function createTransformersEmbedder(
  configureEnv: (environment: TransformersEnv) => void,
): Promise<Embedder> {
  configureEnv(env);

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
