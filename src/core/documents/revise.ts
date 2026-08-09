import type { Llm } from "../ports.ts";
import type { ResumeData, VerifiedDocument } from "./types.ts";
import { RESUME_WITH_NOTE_SCHEMA } from "./schemas.ts";
import { REVISE_SYSTEM } from "./prompts/revise.v1.ts";
import { verifyResume } from "./verify.ts";

/**
 * One step of the conversational revision loop (SPEC §7 task 2). The loop
 * itself is driven by the caller — chat in Phase 3, a harness subcommand now.
 *
 * Revision is authoring: the veteran may state new facts about themselves and
 * they get recorded as stated. The findings are therefore not fabrication
 * alarms here — they are the list of additions and changes for the veteran to
 * confirm before the result becomes the new base resume. Same detector as
 * tailoring, different meaning, and the caller presents it accordingly.
 */
export async function reviseResume(
  llm: Llm,
  current: ResumeData,
  instruction: string,
): Promise<VerifiedDocument<ResumeData>> {
  const trimmed = instruction.trim();
  if (trimmed === "") {
    throw new Error("Tell me what to change and I will do it.");
  }

  const response = await llm.complete({
    model: "doc",
    system: REVISE_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Current resume:\n${JSON.stringify(current, null, 2)}\n\nInstruction from the veteran:\n${trimmed}`,
      },
    ],
    maxTokens: 8192,
    jsonSchema: RESUME_WITH_NOTE_SCHEMA,
  });

  const parsed = JSON.parse(response.text) as { resume: ResumeData; note: string };

  return {
    document: parsed.resume,
    note: parsed.note,
    findings: verifyResume(current, parsed.resume),
  };
}
