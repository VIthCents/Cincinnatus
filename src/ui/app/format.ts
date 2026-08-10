import type { RankedJob } from "../../core/types.ts";
import type { Profile } from "../../core/types.ts";

/** Plain-words rendering shared by cards and lists. */

// The badge bands live in core so the app and the harness cannot drift
// apart. What they are measured to mean is documented there.
export { matchLevel, MATCH_WORDS, type MatchLevel } from "../../core/pipeline/match.ts";

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
