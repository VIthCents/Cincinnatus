import { createHash } from "node:crypto";
import type {
  Clock,
  Embedder,
  Hasher,
  Http,
  HttpRequest,
  HttpResponse,
} from "../src/core/ports.ts";
import { normalize } from "../src/core/embed/vector.ts";

/** A clock pinned to a fixed instant. Sleep resolves immediately. */
export function fakeClock(now: number, randomSeed = 0.5): Clock {
  return {
    now: () => now,
    sleep: () => Promise.resolve(),
    random: () => randomSeed,
  };
}

export const fakeHasher: Hasher = {
  sha256Hex: (input: string) =>
    createHash("sha256").update(input, "utf8").digest("hex"),
};

/**
 * A deterministic stand-in for the real model.
 *
 * Hashes words into buckets, so texts sharing vocabulary score higher than
 * texts that do not. That is enough to exercise wiring, ordering and caching
 * without loading 23 MB and without a test depending on a model's weights.
 *
 * It is explicitly NOT a measure of ranking quality: "Truck Driver" beating
 * "Nuclear Physicist" for a profile containing the word "truck" is arithmetic,
 * not evidence.
 */
export function createFakeEmbedder(dimensions = 64): Embedder {
  return {
    modelId: "fake/bag-of-words@v1",
    dimensions,
    embed(texts: readonly string[]): Promise<Float32Array[]> {
      return Promise.resolve(
        texts.map((text) => {
          const vector = new Float32Array(dimensions);
          for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
            if (word === "") continue;
            let hash = 2166136261;
            for (let i = 0; i < word.length; i++) {
              hash ^= word.charCodeAt(i);
              hash = Math.imul(hash, 16777619);
            }
            const bucket = Math.abs(hash) % dimensions;
            vector[bucket] = (vector[bucket] ?? 0) + 1;
          }
          return normalize(vector);
        }),
      );
    },
  };
}

/** An Http that serves a fixed map of url -> response and records what was asked. */
export function stubHttp(
  responses: Record<string, Partial<HttpResponse>>,
): Http & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    get(req: HttpRequest): Promise<HttpResponse> {
      calls.push(req.url);
      const match = responses[req.url];
      if (match === undefined) {
        return Promise.resolve({ status: 404, headers: {}, body: "not stubbed" });
      }
      return Promise.resolve({
        status: match.status ?? 200,
        headers: match.headers ?? {},
        body: match.body ?? "",
      });
    },
  };
}

/** An Http that always rejects, for testing the never-throws contract. */
export function failingHttp(message: string): Http {
  return {
    get: () => Promise.reject(new Error(message)),
  };
}
