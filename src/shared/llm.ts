import Anthropic from "@anthropic-ai/sdk";
import { DOC_MODEL, FAST_MODEL } from "../core/config.ts";
import type { Llm, LlmRequest, LlmResponse } from "../core/ports.ts";

/**
 * Llm adapter over the official Anthropic SDK — shared between the Node
 * harness and the Tauri webview. The only thing that differs between those two
 * runtimes is which `fetch` carries the request: Node's own, or the
 * plugin-http fetch that runs on the Rust side (no CORS, and scoped by the
 * capability file to api.anthropic.com only).
 *
 * The port speaks logical roles ("doc" | "fast"); the mapping to real model
 * ids lives in core/config.ts so a model bump is one reviewed diff. When a
 * request carries a jsonSchema, structured outputs guarantee the response text
 * parses against it — the engine never repairs malformed JSON.
 */

const MODEL_FOR: Readonly<Record<LlmRequest["model"], string>> = {
  doc: DOC_MODEL,
  fast: FAST_MODEL,
};

export interface AnthropicLlmOptions {
  readonly apiKey: string;
  /** Override the transport. The webview passes plugin-http's fetch here. */
  readonly fetch?: typeof globalThis.fetch;
}

export function createAnthropicLlm(options: AnthropicLlmOptions): Llm {
  const client = new Anthropic({
    apiKey: options.apiKey,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    // The SDK's browser guard exists to stop websites shipping a shared key to
    // strangers. This is a local app using the user's own key, stored on their
    // own machine — the situation the guard protects against cannot arise.
    dangerouslyAllowBrowser: true,
  });

  return {
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const modelId = MODEL_FOR[req.model];

      const response = await client.messages.create({
        model: modelId,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        ...(req.jsonSchema === undefined
          ? {}
          : {
              output_config: {
                format: { type: "json_schema" as const, schema: req.jsonSchema },
              },
            }),
      });

      // Sonnet 5 thinks adaptively by default, so content may lead with
      // thinking blocks; the answer is the text block.
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");

      if (text === "") {
        throw new Error(
          `The AI returned no text (stop reason: ${response.stop_reason ?? "unknown"}).`,
        );
      }

      return {
        text,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        modelId,
      };
    },
  };
}

/**
 * Any LLM failure → one plain sentence a veteran can act on. Never a stack
 * trace, never a status code alone (SPEC §7: never a dead end, always a next
 * step in plain words).
 */
export function llmErrorMessage(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "Your AI access key was not accepted. Check it in Settings — it may have been pasted with a missing character, or turned off in your Claude Console account.";
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return "Your AI access key does not have permission for this. Check your Claude Console account.";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "The AI is busy right now. Wait a minute and try again.";
  }
  if (err instanceof Anthropic.BadRequestError) {
    const message = err.message.toLowerCase();
    if (message.includes("credit") || message.includes("billing")) {
      return "Your AI credits have run out. Add more at console.anthropic.com/settings/billing and try again — everything you were doing is saved.";
    }
    return `The AI could not handle that request. ${err.message}`;
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "Could not reach the AI service. Check your internet connection and try again.";
  }
  if (err instanceof Anthropic.APIError) {
    return "The AI service had a problem on their end. Try again in a few minutes.";
  }
  return err instanceof Error ? err.message : String(err);
}
