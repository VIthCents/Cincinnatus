import { MIN_RESULTS_BEFORE_WIDENING } from "../config.ts";
import { dot } from "../embed/vector.ts";
import type { FitDistribution, Job, Profile, RankedJob } from "../types.ts";
import {
  ageInDays,
  blend,
  fitFromSimilarity,
  freshnessFactor,
  median,
} from "./score.ts";
import { isExcluded } from "./queries.ts";

/**
 * Is this job somewhere the user could actually take it?
 *
 * Coarse on purpose. Real distance needs geocoding, which needs another network
 * service, which needs another allowlist entry and another thing to explain in
 * PRIVACY.md. String matching on city and state covers the common case for a
 * fraction of that cost.
 *
 * TODO(location): revisit in Phase 4 if the ranked list proves too permissive.
 */
export function isWithinReach(job: Job, profile: Profile): boolean {
  if (job.remote === true) return true;
  if (profile.remotePreference === "remote_only") return false;

  // No stated location means everywhere is acceptable.
  if (profile.location === null) return true;
  if (job.location === null) return true;

  const haystack = job.location.toLowerCase();
  const city = profile.location.city.trim().toLowerCase();
  const state = profile.location.state.trim().toLowerCase();

  if (city !== "" && haystack.includes(city)) return true;
  // Word-boundary match so "CA" does not match "Carlsbad" or "Chicago".
  if (state !== "" && new RegExp(`\\b${state}\\b`).test(haystack)) return true;

  return false;
}

export interface RankInput {
  readonly jobs: readonly Job[];
  /** job id -> embedding. Jobs without one score 0 rather than being dropped. */
  readonly vectors: ReadonlyMap<string, Float32Array>;
  readonly profileVector: Float32Array | null;
  readonly profile: Profile;
  /** Read once per run, so every job is aged against the same instant. */
  readonly now: number;
}

export interface RankOutput {
  readonly ranked: readonly RankedJob[];
  /** True when the radius filter was dropped for lack of nearby results. */
  readonly widenedBeyondRadius: boolean;
  readonly fit: FitDistribution | null;
}

export function rankJobs(input: RankInput): RankOutput {
  const { jobs, vectors, profileVector, profile, now } = input;

  const scored: RankedJob[] = [];

  for (const job of jobs) {
    // A collapsed duplicate is represented by its canonical row.
    if (job.canonicalId !== null) continue;
    if (isExcluded(profile, job.title, job.company)) continue;

    const vector = vectors.get(job.id);
    // Vectors are L2-normalized, so the dot product is the cosine.
    const similarity =
      profileVector === null || vector === undefined ? 0 : dot(profileVector, vector);

    const fitScore = fitFromSimilarity(similarity);

    // postedAt is null only when the source gave no date. firstSeenAt is the
    // honest fallback: it is when *we* first saw it, which is an upper bound on
    // how fresh it can be.
    const effectivePostedAt = job.postedAt ?? job.firstSeenAt;
    const age = ageInDays(now, effectivePostedAt);
    const freshness = freshnessFactor(age);

    scored.push({
      job,
      fitScore,
      ageDays: age,
      freshness,
      finalScore: blend(fitScore, freshness),
      withinReach: isWithinReach(job, profile),
    });
  }

  // Sort by score, then by id so the order is total and a run is reproducible.
  const byScore = (a: RankedJob, b: RankedJob): number => {
    if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
    return a.job.id < b.job.id ? -1 : a.job.id > b.job.id ? 1 : 0;
  };

  const nearby = scored.filter((r) => r.withinReach).sort(byScore);

  // The reachable employer boards skew heavily coastal, so a user in much of
  // the country can legitimately have almost nothing commutable. An empty list
  // reads as a broken app; a long list of unreachable jobs reads as a useless
  // one. Widening and saying so plainly is the honest middle.
  const widened = nearby.length < MIN_RESULTS_BEFORE_WIDENING;
  const ranked = widened ? [...scored].sort(byScore) : nearby;

  const fits = ranked.map((r) => r.fitScore);
  const fit: FitDistribution | null =
    fits.length === 0
      ? null
      : {
          min: Math.min(...fits),
          median: median(fits),
          max: Math.max(...fits),
        };

  return { ranked, widenedBeyondRadius: widened, fit };
}
