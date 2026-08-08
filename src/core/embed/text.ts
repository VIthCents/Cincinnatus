import { JOB_TEXT_MAX_CHARS, PROFILE_TEXT_MAX_CHARS } from "../config.ts";
import type { Job, Profile } from "../types.ts";

/**
 * What actually gets embedded.
 *
 * This is the single most ranking-relevant decision in the codebase, so it is
 * one small file with the reasoning written down rather than a line buried in
 * the pipeline.
 *
 * Two rules:
 *
 *  1. **Title first, truncate from the tail.** The model's trained window is
 *     256 tokens (~1,000 characters). A job description routinely runs to
 *     6,000+. Whatever leads is what survives, and the title plus the first
 *     paragraph of duties carries far more signal about whether a veteran can
 *     do this job than the benefits boilerplate at the bottom.
 *  2. **No invented text.** Nothing here adds a word the source did not
 *     provide. Empty fields are omitted rather than filled with a placeholder
 *     that would then be embedded as if it were content.
 */

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  // Prefer a word boundary so the final token is not a fragment.
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > maxChars * 0.8 ? cut.slice(0, lastSpace) : cut;
}

export function buildProfileText(profile: Profile): string {
  const parts: string[] = [];

  if (profile.titles.length > 0) {
    parts.push(profile.titles.join(", "));
  }
  if (profile.skills.length > 0) {
    parts.push(`Skills: ${profile.skills.join(", ")}`);
  }
  if (profile.mocCodes.length > 0) {
    const branch = profile.branch === null ? "" : `${profile.branch} `;
    parts.push(`Military experience: ${branch}${profile.mocCodes.join(", ")}`);
  }
  if (profile.education.length > 0) {
    parts.push(`Education: ${profile.education.join(", ")}`);
  }
  if (profile.clearance !== null) {
    parts.push(`Security clearance: ${profile.clearance}`);
  }
  if (profile.yearsExperience !== null) {
    parts.push(`${profile.yearsExperience} years of experience`);
  }

  return truncate(parts.join(". "), PROFILE_TEXT_MAX_CHARS);
}

/**
 * Title, then company and location, then the description body.
 *
 * The description is appended last precisely so that truncation eats it rather
 * than the title.
 */
export function buildJobText(job: Job): string {
  const head: string[] = [job.title];
  if (job.company !== "") head.push(`at ${job.company}`);
  if (job.location !== null && job.location !== "") head.push(`in ${job.location}`);

  const prefix = head.join(" ");
  const body = job.descriptionText.trim();

  if (body === "") return truncate(prefix, JOB_TEXT_MAX_CHARS);
  return truncate(`${prefix}. ${body}`, JOB_TEXT_MAX_CHARS);
}
