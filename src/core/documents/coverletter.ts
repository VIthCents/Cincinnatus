import type { Llm } from "../ports.ts";
import type { Job } from "../types.ts";
import type { CoverLetter, ResumeData, VerifiedDocument } from "./types.ts";
import { COVER_LETTER_SCHEMA } from "./schemas.ts";
import { COVER_LETTER_SYSTEM } from "./prompts/coverletter.v1.ts";
import { jobToPromptText } from "./tailor.ts";
import { verifyCoverLetter } from "./verify.ts";

/**
 * Base resume + one job → one-page cover letter (SPEC §7 task 5).
 *
 * Same mandatory-verification shape as tailoring. A letter is free text, so
 * the check is the targeted scan — clearance and degree claims, the ones with
 * legal weight on a federal application — rather than the full structured
 * comparison. See verify.ts for where that line is drawn and why.
 */
export async function writeCoverLetter(
  llm: Llm,
  base: ResumeData,
  job: Job,
): Promise<VerifiedDocument<CoverLetter>> {
  const response = await llm.complete({
    model: "doc",
    system: COVER_LETTER_SYSTEM,
    messages: [
      {
        role: "user",
        content: `The veteran's resume:\n${JSON.stringify(base, null, 2)}\n\nThe job posting:\n${jobToPromptText(job)}`,
      },
    ],
    maxTokens: 2048,
    jsonSchema: COVER_LETTER_SCHEMA,
  });

  const raw = JSON.parse(response.text) as CoverLetter;
  const letter: CoverLetter = {
    ...raw,
    closing: stripSignature(raw.closing, base.name),
  };

  return {
    document: letter,
    // The letter is its own explanation; there is no separate model note.
    note: "",
    findings: verifyCoverLetter(base, letter),
  };
}

/**
 * Drop the signature the model sometimes writes into `closing`.
 *
 * Every renderer — LetterView, the DOCX exporter, the harness — prints the
 * name after the closing, because that is what a letter is. When the model also
 * puts it in the closing the letter signs off twice:
 *
 *     Sincerely,
 *     Danielle R. Okafor
 *     DANIELLE R. OKAFOR
 *
 * Observed live on 2026-08-09. The schema now says closing is the valediction
 * only, but a prompt is a request and this is the guarantee.
 */
export function stripSignature(closing: string, name: string): string {
  const target = name.trim().toLowerCase();
  if (target === "") return closing.trim();

  const kept = closing
    .split("\n")
    .filter((line) => line.trim().toLowerCase() !== target)
    .join("\n")
    .trim();

  // If removing the name emptied it, the model put ONLY the name there.
  return kept === "" ? "Sincerely," : kept;
}
