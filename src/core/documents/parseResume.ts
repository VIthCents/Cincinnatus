import type { Llm } from "../ports.ts";
import type { ResumeData } from "./types.ts";
import { RESUME_DATA_SCHEMA } from "./schemas.ts";
import { PARSE_RESUME_SYSTEM } from "./prompts/parseResume.v1.ts";

/**
 * Raw resume text → structured ResumeData.
 *
 * This is transcription (SPEC §7 task 3): the prompt forbids improving or
 * inventing, and the schema guarantees the shape. The result becomes the base
 * resume every later document is derived from — and, crucially, the reference
 * that verify.ts checks derived documents against.
 */
export async function parseResume(llm: Llm, rawText: string): Promise<ResumeData> {
  const trimmed = rawText.trim();
  if (trimmed === "") {
    throw new Error("The resume file is empty — there is no text to read.");
  }

  const response = await llm.complete({
    model: "doc",
    system: PARSE_RESUME_SYSTEM,
    messages: [{ role: "user", content: trimmed }],
    maxTokens: 8192,
    jsonSchema: RESUME_DATA_SCHEMA,
  });

  return JSON.parse(response.text) as ResumeData;
}
