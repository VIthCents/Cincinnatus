import type { Llm, LlmMessage } from "../ports.ts";
import type { ResumeData } from "../documents/types.ts";
import { CHAT_SYSTEM } from "./prompts/chat.v1.ts";

/**
 * Chat orchestration (SPEC §3 chat/agent.ts): assemble context, call the fast
 * model, return the reply. Deliberately no tool use and no agent framework
 * (constraint 7) — the actions the chat can suggest (look over resume, search,
 * tailor) are buttons in the UI, wired straight to engine functions where they
 * are testable and cannot be prompt-injected into doing something else.
 */

/** How many prior turns ride along. Enough for continuity, bounded for cost. */
const HISTORY_LIMIT = 20;

export interface ChatTurnInput {
  readonly history: readonly LlmMessage[];
  readonly userMessage: string;
  /** The veteran's base resume, when one exists — so answers can be specific. */
  readonly resume: ResumeData | null;
}

export async function chatTurn(
  llm: Llm,
  input: ChatTurnInput,
): Promise<{ reply: string }> {
  const trimmed = input.userMessage.trim();
  if (trimmed === "") return { reply: "" };

  const system =
    input.resume === null
      ? CHAT_SYSTEM
      : `${CHAT_SYSTEM}\n\nThe veteran's current resume, for your reference (never invent beyond it):\n${JSON.stringify(input.resume)}`;

  // The API requires the first message to be from the user, and the visible
  // chat legitimately starts with assistant text (a chip's critique, the
  // no-key explainer). Drop leading assistant turns after windowing — a
  // greeting the model itself wrote carries no context it needs back.
  const windowed = input.history.slice(-HISTORY_LIMIT);
  const firstUser = windowed.findIndex((m) => m.role === "user");
  const history = firstUser === -1 ? [] : windowed.slice(firstUser);

  const response = await llm.complete({
    model: "fast",
    system,
    messages: [...history, { role: "user", content: trimmed }],
    maxTokens: 1024,
  });

  return { reply: response.text.trim() };
}
