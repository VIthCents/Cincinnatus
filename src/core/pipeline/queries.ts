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

/**
 * What the thumbs on a job card actually do.
 *
 * They change what gets SEARCHED FOR next time, not how anything is scored.
 *
 * That is the opposite of the obvious design, and it is the opposite because
 * the obvious design was measured and it was harmful. Simulating thumbs from
 * the golden set's human labels — Rocchio nudges of the profile vector, k-NN
 * votes, per-company and per-title priors, every weight tried — produced a
 * NEGATIVE mean change in NDCG@10 on both profiles, costing up to 0.27 on a
 * single thumb. Worse, anything that raises `fitScore` silently trips the
 * widening rule in rank.ts: one thumbs-up is enough to push the count of
 * worthwhile nearby jobs over MIN_RESULTS_BEFORE_WIDENING, at which point the
 * list stops covering the country and collapses to the local jobs that
 * DECISIONS 2026-08-09 measured as containing nothing hireable. 46 of 48
 * labelled jobs disappear, including the one Class A Driver posting that whole
 * decision was written about.
 *
 * Search terms are where a thumb has real leverage and no way to do harm. The
 * CDL profile generates ten titles and only the first five ever reach Adzuna
 * (ADZUNA_MAX_TERMS) — and "Class A Driver" is not among them. Promoting a
 * title the person actually pointed at fixes supply, which is the measured
 * binding constraint, and it cannot corrupt an ordering, flip widening, or hide
 * anything.
 */
/**
 * Two guards, and they are the whole safety argument for the down-thumb.
 *
 * A person's OWN stated titles are never removable — they typed those into the
 * setup to say what they are looking for, and one thumbs-down on a bad posting
 * must not quietly cancel that. And the list can never be emptied, because a
 * search with no terms returns nothing at all and would look exactly like the
 * app being broken.
 */
function applyPreferences(
  profile: Profile,
  titles: readonly string[],
  preferences: TermPreferences | undefined,
): string[] {
  if (preferences === undefined || preferences.demoted.length === 0) {
    return [...titles];
  }

  const own = new Set(profile.titles.map((t) => t.trim().toLowerCase()));
  const demoted = new Set(
    preferences.demoted.map((t) => t.trim().toLowerCase()).filter((t) => !own.has(t)),
  );

  const kept = titles.filter((t) => !demoted.has(t.trim().toLowerCase()));
  return kept.length === 0 ? [...titles] : kept;
}

export interface TermPreferences {
  /** Titles from jobs the person gave a thumbs-up. Searched first. */
  readonly promoted: readonly string[];
  /** Titles from jobs they gave a thumbs-down. Dropped, unless they said it. */
  readonly demoted: readonly string[];
}

export function buildSearchTerms(
  profile: Profile,
  preferences?: TermPreferences,
): SearchTerms {
  // The user's own stated titles come first — they know what they are looking
  // for better than a lookup table does. Crosswalk titles follow, because for a
  // veteran who has only ever held a military job, those may be the only
  // civilian words that describe what they can do.
  const fromCrosswalk = profile.mocCodes.flatMap((code) => civilianTitlesFor(code));

  // A thumbed-up title goes to the front, ahead of the crosswalk guesses,
  // because only the first few terms survive the per-source caps.
  const titles = applyPreferences(
    profile,
    dedupePreservingOrder([
      ...(preferences?.promoted ?? []),
      ...profile.titles,
      ...fromCrosswalk,
    ]),
    preferences,
  );

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
