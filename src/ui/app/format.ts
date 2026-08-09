import type { RankedJob } from "../../core/types.ts";
import type { Profile } from "../../core/types.ts";

/** Plain-words rendering shared by cards and lists. */

export type MatchLevel = "fair" | "good" | "strong";

/**
 * Three levels and three words, per the design system's matching guideline:
 * the badge reads fitScore (never finalScore, which decays with age), and a
 * person never sees the number.
 *
 * The bands are NOT the guideline's 35/55/75. fitScore here is
 * `clamp(cosine,0,1) × 100`, and raw MiniLM cosines between a short profile
 * and a long posting cluster around 0.1–0.5 (see core/pipeline/score.ts). On
 * that distribution a 75 floor for "strong" would never fire and a 35 floor
 * would hide most of the list. These bands are the same ones the ranking has
 * been calibrated against; see docs/DECISIONS.md.
 */
export function matchLevel(fit: number): MatchLevel {
  if (fit >= 55) return "strong";
  if (fit >= 40) return "good";
  return "fair";
}

export function ageWords(days: number): string {
  const whole = Math.round(days);
  if (whole <= 0) return "today";
  if (whole === 1) return "yesterday";
  if (whole < 30) return `${whole} days ago`;
  return "over a month ago";
}

export function salaryWords(job: RankedJob["job"]): string | null {
  const { salaryMin: min, salaryMax: max, salaryInterval } = job;
  if (min === null && max === null) return null;
  const fmt = (n: number): string => `$${n.toLocaleString("en-US")}`;
  const range =
    min !== null && max !== null
      ? `${fmt(min)} to ${fmt(max)}`
      : fmt((min ?? max) as number);
  if (salaryInterval === "hour") return `${range} an hour`;
  if (salaryInterval === "year") return `${range} a year`;
  return range;
}

/**
 * The one-line "why" on a job card: which of the user's own words show up in
 * this posting. Honest and checkable — not a generated claim.
 */
export function whyWords(job: RankedJob["job"], profile: Profile): string | null {
  const haystack = `${job.title} ${job.descriptionText.slice(0, 2000)}`.toLowerCase();
  const candidates = [...profile.skills, ...profile.titles];
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const term of candidates) {
    const needle = term.trim().toLowerCase();
    if (needle.length < 3 || seen.has(needle)) continue;
    if (haystack.includes(needle)) {
      seen.add(needle);
      hits.push(term.trim());
    }
    if (hits.length >= 3) break;
  }
  if (hits.length === 0) return null;
  return `Mentions ${hits.join(", ")}`;
}
