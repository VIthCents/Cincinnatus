import { PROXIMITY_FAR, PROXIMITY_SAME_STATE, PROXIMITY_UNKNOWN } from "../config.ts";
import type { Job, Profile } from "../types.ts";

/**
 * How near a job is, from the only location data this app has: the strings the
 * boards print and the city and state the person gave us.
 *
 * Deliberately not distance. Real miles need a geocoder — a network service,
 * an allowlist entry, a paragraph in PRIVACY.md and, for the hosted ones, a
 * billable key the veteran would have to go and get. DECISIONS.md ruled that
 * out on 2026-08-14 and the ruling stands; what changed is that ranking now
 * uses the coarse answer it always had instead of throwing it away.
 *
 * Three tiers is all this data can honestly support. "Fayetteville, NC" and
 * "Raleigh, NC" are 60 miles apart and both read as `same_state`; that is the
 * resolution of the input, not a shortcut.
 */
export type Proximity = "same_city" | "remote" | "same_state" | "unknown" | "far";

/**
 * A remote job has no commute at all, so it ranks with the person's own city
 * rather than against it. Whether they *want* one is a separate question, and
 * `isWithinReach` already answers it — a "prefer onsite" person keeps remote
 * work out of their local list, and this factor never overrides that.
 */
export function proximityOf(job: Job, profile: Profile): Proximity {
  if (job.remote === true) return "remote";

  // Nothing was ever said about where this person is, or where the job is.
  // Guessing "far" would bury the whole list for someone who skipped the
  // question, so an unknown is a small nudge rather than a verdict.
  if (profile.location === null) return "unknown";
  if (job.location === null) return "unknown";

  const haystack = job.location.toLowerCase();
  const city = profile.location.city.trim().toLowerCase();
  const state = profile.location.state.trim().toLowerCase();

  // Same order of questions as isWithinReach, so the label on the card and the
  // weight in the sort can never disagree about a job.
  if (city !== "" && haystack.includes(city)) return "same_city";
  // Word boundary so "CA" does not match "Carlsbad" or "Chicago".
  if (state !== "" && new RegExp(`\\b${state}\\b`).test(haystack)) return "same_state";

  return "far";
}

/**
 * What that tier is worth, as a multiplier on the final score.
 *
 * Shaped like `freshnessFactor`: it never reaches zero, so proximity re-orders
 * jobs of comparable fit rather than deciding the list on its own. A job worth
 * driving to is still worth showing.
 */
export function proximityFactor(proximity: Proximity): number {
  switch (proximity) {
    case "same_city":
    case "remote":
      return 1;
    case "same_state":
      return PROXIMITY_SAME_STATE;
    case "unknown":
      return PROXIMITY_UNKNOWN;
    case "far":
      return PROXIMITY_FAR;
  }
}
