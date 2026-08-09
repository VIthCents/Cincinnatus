import { createAnthropicLlm, llmErrorMessage } from "../shared/llm.ts";
import type { Llm } from "../core/ports.ts";

/**
 * Node-side Llm. The implementation moved to src/shared/llm.ts when the
 * webview needed the same code with a different fetch; this wrapper keeps the
 * harness's import path stable.
 */
export function createNodeLlm(apiKey: string): Llm {
  return createAnthropicLlm({ apiKey });
}

export { llmErrorMessage };
