import {
  MAX_PER_EMPLOYER_ROLE,
  MIN_FIT_FOR_WIDENING,
  MIN_RESULTS_BEFORE_WIDENING,
} from "../config.ts";
import { normalizeCompany, normalizeTitle } from "./normalize.ts";
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
import { reachAdjustedSimilarity } from "./reach.ts";

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
  /** Every job considered, before the location filter. */
  readonly candidates: number;
  /**
   * How many of those were within reach.
   *
   * Reported against `candidates`, never against `ranked`: when the filter is
   * applied, `ranked` already contains only reachable jobs, so comparing the
   * two would always print "N of N" and tell the user nothing.
   */
  readonly reachable: number;
}

/**
 * Stop one employer's identical requisition from filling the screen.
 *
 * Measured on the first live Adzuna run: nine of the top twelve jobs were
 * "CDL A Delivery Truck Driver" at Mclane, in nine different North Carolina
 * towns. Every one is a real, distinct, genuinely nearby posting — dedupe is
 * right not to collapse them — but a veteran scrolling that sees one job nine
 * times and a list that looks padded.
 *
 * So nothing is dropped, only demoted: the best few of each employer-and-role
 * group keep their earned position, and the rest move below everything else in
 * their existing order. Someone who scrolls far enough still finds the branch
 * nearest them, and the top of the list shows them a choice.
 */
function spreadEmployers(ranked: readonly RankedJob[]): RankedJob[] {
  const head: RankedJob[] = [];
  const overflow: RankedJob[] = [];
  const seen = new Map<string, number>();

  for (const entry of ranked) {
    const key = `${normalizeCompany(entry.job.company)}|${normalizeTitle(entry.job.title)}`;
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    if (count < MAX_PER_EMPLOYER_ROLE) head.push(entry);
    else overflow.push(entry);
  }

  return [...head, ...overflow];
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

    // Cosine answers "is this text about the same subject". The veteran is
    // asking "could I get this job", and those come apart badly: the encoder
    // ranks Firefighter above Class A Driver for a CDL holder, and degree-gated
    // cyber roles above every federal police posting for an infantry NCO.
    // reach.ts corrects for both. See docs/DECISIONS.md.
    const fitScore = fitFromSimilarity(
      reachAdjustedSimilarity(similarity, job.title, profile),
    );

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
  //
  // Widening triggers on how many jobs nearby are worth applying to, NOT on how
  // many are nearby. Measured 2026-08-09: a CDL driver in Fayetteville NC had
  // 318 jobs "within reach" — comfortably over the old threshold of 10, so the
  // search never widened — of which ZERO were work a driver could be hired
  // into. They were remote-flagged white-collar tech postings that happen to
  // list no city. Meanwhile the corpus held a literal "Class A Driver" job that
  // the person was never shown. Counting jobs measured the wrong thing: a
  // plentiful local list and a useless one are indistinguishable by length.
  const nearbyWorthwhile = nearby.filter((r) => r.fitScore >= MIN_FIT_FOR_WIDENING);
  const widened = nearbyWorthwhile.length < MIN_RESULTS_BEFORE_WIDENING;
  const ranked = spreadEmployers(widened ? [...scored].sort(byScore) : nearby);

  const fits = ranked.map((r) => r.fitScore);
  const fit: FitDistribution | null =
    fits.length === 0
      ? null
      : {
          min: Math.min(...fits),
          median: median(fits),
          max: Math.max(...fits),
        };

  return {
    ranked,
    widenedBeyondRadius: widened,
    fit,
    candidates: scored.length,
    reachable: nearby.length,
  };
}
