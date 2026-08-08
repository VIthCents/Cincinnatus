import { FRESHNESS_HALF_LIFE_DAYS, MAX_AGE_DAYS, MIN_AGE_DAYS } from "../config.ts";

/**
 * The scoring maths. One list, one number (SPEC section 5):
 *
 *     final_score = fit_score * exp(-age_days / FRESHNESS_HALF_LIFE_DAYS)
 */

const MS_PER_DAY = 86_400_000;

/**
 * Whole days between a posting date and the run's `now`.
 *
 * Clamped at both ends. Above {@link MAX_AGE_DAYS} the decay would underflow to
 * exactly 0, at which point every old job ties and their relative order becomes
 * whatever the sort happened to do. Below 0 handles sources whose clock is
 * slightly ahead of ours — a job cannot be posted in the future, but a timezone
 * mistake at the source can say it was.
 */
export function ageInDays(now: number, postedAt: number): number {
  const raw = (now - postedAt) / MS_PER_DAY;
  if (!Number.isFinite(raw)) return MAX_AGE_DAYS;
  return Math.min(Math.max(raw, MIN_AGE_DAYS), MAX_AGE_DAYS);
}

export function freshnessFactor(ageDays: number): number {
  return Math.exp(-ageDays / FRESHNESS_HALF_LIFE_DAYS);
}

/**
 * Cosine similarity to a 0–100 fit score.
 *
 * Negative similarity is clamped to 0 rather than mapped into the middle of the
 * range: a job that is *anti*-correlated with the profile is not a 50% match.
 *
 * Be aware that raw MiniLM cosines between a short profile and a long job
 * description cluster in a narrow band — commonly 0.1 to 0.5. The absolute
 * numbers are not meaningful on their own; only the ordering is. That is why a
 * run reports the min/median/max, so a collapsed distribution is visible rather
 * than being mistaken for a working ranking.
 */
export function fitFromSimilarity(similarity: number): number {
  if (!Number.isFinite(similarity)) return 0;
  return Math.min(Math.max(similarity, 0), 1) * 100;
}

export function blend(fitScore: number, freshness: number): number {
  return fitScore * freshness;
}

/** Median of a numeric array. Does not mutate the input. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}
