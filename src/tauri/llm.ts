import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { createAnthropicLlm, llmErrorMessage } from "../shared/llm.ts";
import type { Llm } from "../core/ports.ts";

/**
 * Webview Llm. Same shared implementation as the harness, carried by
 * plugin-http's fetch: the request leaves from the Rust side, so no CORS is
 * involved, and the capability file limits it to api.anthropic.com.
 */
export function createTauriLlm(apiKey: string): Llm {
  return createAnthropicLlm({ apiKey, fetch: tauriFetch as typeof globalThis.fetch });
}

export { llmErrorMessage };
