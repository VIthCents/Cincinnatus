import type { Profile } from "../types.ts";
import { civilianTitlesFor } from "../profile/crosswalk.ts";

/**
 * Turn a profile into the search terms sent to keyed search APIs.
 *
 * This is the *only* user data that ever leaves the machine during a job search
 * (constraint 3): job titles and a place name. Never the résumé, never a name,
 * never the military codes themselves — those are translated to civilian titles
 * locally, here, before anything is sent.
 *
 * Keyless ATS boards do not take a query at all; we fetch the whole board and
 * filter locally, so for those this function is not used.
 */

export interface SearchTerms {
  /** Ordered, de-duplicated. Most relevant first. */
  readonly titles: readonly string[];
  /** "City, ST" or null. */
  readonly locationName: string | null;
  readonly radiusMiles: number | null;
}

function dedupePreservingOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed === "") continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export function buildSearchTerms(profile: Profile): SearchTerms {
  // The user's own stated titles come first — they know what they are looking
  // for better than a lookup table does. Crosswalk titles follow, because for a
  // veteran who has only ever held a military job, those may be the only
  // civilian words that describe what they can do.
  const fromCrosswalk = profile.mocCodes.flatMap((code) => civilianTitlesFor(code));

  const titles = dedupePreservingOrder([...profile.titles, ...fromCrosswalk]);

  const locationName =
    profile.location === null
      ? null
      : `${profile.location.city}, ${profile.location.state}`.trim();

  return {
    titles,
    locationName,
    // Radius is meaningless to the API without a location.
    radiusMiles: locationName === null ? null : profile.radiusMiles,
  };
}

/**
 * Does this job's title or company hit one of the user's excluded keywords?
 *
 * Matched case-insensitively on whole words so that excluding "sales" does not
 * also drop "Salesforce Administrator".
 */
export function isExcluded(profile: Profile, title: string, company: string): boolean {
  if (profile.excludedKeywords.length === 0) return false;
  const haystack = `${title} ${company}`.toLowerCase();
  return profile.excludedKeywords.some((keyword) => {
    const needle = keyword.trim().toLowerCase();
    if (needle === "") return false;
    // Escape regex metacharacters in user input.
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`).test(haystack);
  });
}
