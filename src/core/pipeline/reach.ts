import { CREDENTIAL_GATE_PENALTY, TITLE_AFFINITY_BONUS } from "../config.ts";
import { civilianTitlesFor } from "../profile/crosswalk.ts";
import type { Profile } from "../types.ts";

/**
 * Can this person actually get this job?
 *
 * Cosine similarity answers "is this text about the same subject", which is not
 * the question a veteran is asking. Measured on two labelled profiles, the
 * encoder scores "Firefighter (Basic Life Support)" at 51.5 for a CDL driver
 * and "Class A Driver" at 47.0; for an infantry squad leader it puts four
 * "Senior Security Operations Engineer" roles — cybersecurity, degree-gated —
 * above every federal police posting. Both are topically reasonable and both
 * are useless to the person reading the list.
 *
 * Two corrections, both cheap, both computed from the title alone.
 */

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "of",
  "for",
  "to",
  "in",
  "on",
  "and",
  "or",
  "i",
  "ii",
  "iii",
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w !== "" && !STOPWORDS.has(w));
}

/**
 * Roles that require a credential or a career this person has not had.
 *
 * This is a list of *gates*, not a list of jobs we disapprove of. Every entry
 * is a role that, in practice, is closed to someone without a degree — which is
 * why it only applies when the profile shows no degree. "Technician",
 * "Operator", "Mechanic", "Driver", "Assistant" and "Clerk" are deliberately
 * absent: those are exactly the skilled jobs this app exists to surface.
 *
 * Measured against 88 labelled jobs across two profiles, this fires on 43% and
 * 60% of the jobs judges said were out of reach, and on ZERO of the jobs they
 * said were gettable. That precision is the reason it is safe to act on.
 */
const CREDENTIALED_ROLES = new Set([
  "engineer",
  "engineering",
  "software",
  "developer",
  "scientist",
  "counsel",
  "attorney",
  "architect",
  "designer",
  "recruiter",
  "controller",
  "actuary",
  "accountant",
  "physician",
  "surgeon",
  "psychologist",
  "professor",
  "economist",
  "statistician",
]);

const DEGREE =
  /associate|bachelor|master|doctor|phd|\bb\.?s\b|\bb\.?a\b|degree|college|university/i;

export function hasDegree(profile: Profile): boolean {
  return profile.education.some((e) => DEGREE.test(e));
}

/**
 * A degree-gated role, for someone with no degree.
 *
 * Deliberately NOT surfaced to the user as a reason. The gate is inferred from
 * the title, not stated by the posting, and "this job needs a degree you do not
 * have" would be exactly the kind of confident claim about a fact we were never
 * given that constraint 4 exists to prevent. It moves the job down the list and
 * says nothing.
 */
export function isCredentialGated(title: string, profile: Profile): boolean {
  if (hasDegree(profile)) return false;
  return words(title).some((w) => CREDENTIALED_ROLES.has(w));
}

/**
 * How much the job title looks like work this person has actually done, using
 * their own stated titles plus the military-to-civilian crosswalk.
 *
 * 0 to 1: the best fraction of any one of their titles that appears in the job
 * title. A small nudge, not a ranking of its own — measured on the CDL profile
 * it lifts NDCG@10 from 0.675 to 0.808, and on the infantry profile it is
 * neutral, because "Security Officer" matches almost every title in a corpus
 * full of security roles. A signal that helps one person and does nothing for
 * another earns a small weight, not a large one.
 */
export function titleAffinity(title: string, profile: Profile): number {
  const jobWords = new Set(words(title));
  const candidates = [
    ...profile.titles,
    ...profile.mocCodes.flatMap((code) => civilianTitlesFor(code)),
  ];

  let best = 0;
  for (const candidate of candidates) {
    const parts = words(candidate);
    if (parts.length === 0) continue;
    const overlap = parts.filter((w) => jobWords.has(w)).length / parts.length;
    if (overlap > best) best = overlap;
  }
  return best;
}

/**
 * The cosine, corrected for whether this is work the person could actually be
 * hired to do. Returned as a similarity so it still feeds `fitFromSimilarity`
 * and the 0–100 scale is unchanged.
 */
export function reachAdjustedSimilarity(
  similarity: number,
  title: string,
  profile: Profile,
): number {
  const bonus = TITLE_AFFINITY_BONUS * titleAffinity(title, profile);
  const penalty = isCredentialGated(title, profile) ? CREDENTIAL_GATE_PENALTY : 0;
  return similarity + bonus - penalty;
}
