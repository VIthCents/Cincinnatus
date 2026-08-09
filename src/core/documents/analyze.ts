import type { Llm } from "../ports.ts";
import type { Critique } from "./types.ts";
import { CRITIQUE_SCHEMA } from "./schemas.ts";
import { ANALYZE_SYSTEM } from "./prompts/analyze.v1.ts";

/**
 * Honest, specific, kind critique of a base resume (SPEC §7 task 1).
 *
 * Takes raw text rather than ResumeData on purpose: formatting problems,
 * garbled sections, and walls of jargon are exactly what the critique should
 * see, and structuring first would launder them away.
 */
export async function analyzeResume(llm: Llm, rawText: string): Promise<Critique> {
  const trimmed = rawText.trim();
  if (trimmed === "") {
    throw new Error("The resume file is empty — there is nothing to look over.");
  }

  const response = await llm.complete({
    model: "doc",
    system: ANALYZE_SYSTEM,
    messages: [{ role: "user", content: trimmed }],
    maxTokens: 4096,
    jsonSchema: CRITIQUE_SCHEMA,
  });

  return JSON.parse(response.text) as Critique;
}
