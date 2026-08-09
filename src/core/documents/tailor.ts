import type { Llm } from "../ports.ts";
import type { Job } from "../types.ts";
import type { ResumeData, VerifiedDocument } from "./types.ts";
import { RESUME_WITH_NOTE_SCHEMA } from "./schemas.ts";
import { TAILOR_FEDERAL_ADDENDUM, TAILOR_SYSTEM } from "./prompts/tailor.v1.ts";
import { verifyResume } from "./verify.ts";

/**
 * Bound on how much job description goes into the prompt. Postings run to
 * 10k+ characters of benefits boilerplate; the duties and qualifications that
 * matter come first. This caps the veteran's per-tailor cost.
 */
const JOB_DESCRIPTION_MAX_CHARS = 8000;

export function jobToPromptText(job: Job): string {
  const parts = [
    `Job title: ${job.title}`,
    `Company: ${job.company}`,
    job.location === null ? null : `Location: ${job.location}`,
    "",
    job.descriptionText.slice(0, JOB_DESCRIPTION_MAX_CHARS),
  ];
  return parts.filter((p) => p !== null).join("\n");
}

/**
 * Base resume + one job → tailored resume (SPEC §7 task 4).
 *
 * The no-fabrication check is not optional here and not the caller's job: it
 * runs inside this function and its findings travel with the document
 * (CLAUDE.md: "verify.ts entity check is mandatory in the tailor/cover-letter
 * path"). Findings of severity "high" mean the model added something the base
 * resume does not support; the UI surfaces them as confirmations and the
 * harness prints them loudly.
 *
 * USAJobs postings get the federal addendum: federal resumes are a different
 * genre where completeness beats brevity and reviewers score against the
 * announcement's own wording.
 */
export async function tailorResume(
  llm: Llm,
  base: ResumeData,
  job: Job,
): Promise<VerifiedDocument<ResumeData>> {
  const federal = job.source === "usajobs";
  const system = federal ? TAILOR_SYSTEM + TAILOR_FEDERAL_ADDENDUM : TAILOR_SYSTEM;

  const response = await llm.complete({
    model: "doc",
    system,
    messages: [
      {
        role: "user",
        content: `Base resume:\n${JSON.stringify(base, null, 2)}\n\nThe job posting:\n${jobToPromptText(job)}`,
      },
    ],
    maxTokens: 8192,
    jsonSchema: RESUME_WITH_NOTE_SCHEMA,
  });

  const parsed = JSON.parse(response.text) as { resume: ResumeData; note: string };

  return {
    document: parsed.resume,
    note: parsed.note,
    findings: verifyResume(base, parsed.resume),
  };
}
