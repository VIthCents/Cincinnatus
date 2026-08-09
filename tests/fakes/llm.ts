import type { Llm, LlmRequest, LlmResponse } from "../../src/core/ports.ts";

/**
 * Deterministic Llm double. Responses are queued; every request is recorded so
 * tests can assert what the engine actually sent (which prompt, which schema,
 * which model role) — the part that matters and that a live call can't pin.
 */
export function createFakeLlm(responses: readonly unknown[]): {
  llm: Llm;
  requests: LlmRequest[];
} {
  const queue = [...responses];
  const requests: LlmRequest[] = [];

  const llm: Llm = {
    complete(req: LlmRequest): Promise<LlmResponse> {
      requests.push(req);
      const next = queue.shift();
      if (next === undefined) {
        return Promise.reject(
          new Error(`fake llm: no response queued for request #${requests.length}`),
        );
      }
      return Promise.resolve({
        text: typeof next === "string" ? next : JSON.stringify(next),
        inputTokens: 100,
        outputTokens: 50,
        modelId: "fake-model",
      });
    },
  };

  return { llm, requests };
}
