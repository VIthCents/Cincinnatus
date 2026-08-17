import {
  MAX_PER_EMPLOYER_ROLE,
  MIN_FIT_FOR_WIDENING,
  MIN_RESULTS_BEFORE_WIDENING,
} from "../config.ts";
import { normalizeCompany, normalizeTitle } from "./normalize.ts";
import { dot } from "../embed/vector.ts";
import type { FitDistribution, Job, LlmScore, Profile, RankedJob } from "../types.ts";
import {
  ageInDays,
  blend,
  fitFromSimilarity,
  freshnessFactor,
  median,
} from "./score.ts";
import { isExcluded } from "./queries.ts";
import { proximityFactor, proximityOf } from "./proximity.ts";
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
  // "Prefer onsite" means a remote job does not count toward there being
  // enough work near this person — not that it is hidden. If the local list is
  // thin, widening still shows remote roles, labelled, which is what "prefer"
  // means as opposed to "never". The wizard has offered this answer since it
  // shipped and nothing had ever read it.
  if (job.remote === true) return profile.remotePreference !== "prefer_onsite";
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

/** Stated pay, expressed per year. */
const PERIODS_PER_YEAR: Readonly<Record<string, number>> = {
  hour: 2080,
  day: 260,
  week: 52,
  month: 12,
  year: 1,
};

/**
 * Drop a job only when the employer said what it pays and said it pays less
 * than this person will accept.
 *
 * Deliberately narrow. It can only ever remove a job that published a figure
 * below the floor, so it cannot quietly starve a thin list: the majority of
 * postings — every Adzuna row among them — state no salary at all and are
 * untouched. `salaryMax` is the test, not `salaryMin`, because a range that
 * tops out under the floor is the only unambiguous case; a range that starts
 * low and ends high is a job worth showing.
 *
 * Until now `salaryFloor` was parsed, stored, and read by nothing, which is
 * worse than not collecting it: both committed fixture profiles set it, so the
 * harness has been quietly ignoring an instruction it appeared to accept.
 */
function paysBelowFloor(job: Job, profile: Profile): boolean {
  const floor = profile.salaryFloor;
  if (floor === null || floor <= 0) return false;
  if (job.salaryInterval === null) return false;

  const periods = PERIODS_PER_YEAR[job.salaryInterval];
  if (periods === undefined) return false;

  const top = job.salaryMax ?? job.salaryMin;
  if (top === null) return false;

  return top * periods < floor;
}

export interface RankInput {
  readonly jobs: readonly Job[];
  /** job id -> embedding. Jobs without one score 0 rather than being dropped. */
  readonly vectors: ReadonlyMap<string, Float32Array>;
  readonly profileVector: Float32Array | null;
  readonly profile: Profile;
  /** Read once per run, so every job is aged against the same instant. */
  readonly now: number;
  /**
   * AI judgements, when the person has connected a key and a run has made
   * them. Absent everywhere else — including in the golden-set evaluation,
   * which stays a measurement of the embedding path alone.
   */
  readonly llmScores?: ReadonlyMap<string, LlmScore>;
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
  const { jobs, vectors, profileVector, profile, now, llmScores } = input;

  const scored: RankedJob[] = [];
  /** Kept beside the merged fit, for the widening decision alone. */
  const embedFitOf = new Map<string, number>();

  for (const job of jobs) {
    // A collapsed duplicate is represented by its canonical row.
    if (job.canonicalId !== null) continue;
    if (isExcluded(profile, job.title, job.company)) continue;
    if (paysBelowFloor(job, profile)) continue;

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

    // An LLM judgement replaces the embedding fit for the order, the badge and
    // the filters, because the prompt is written to these same bands — it is
    // answering the question the badge words claim to answer, which the cosine
    // never quite did.
    const judged = llmScores?.get(job.id);
    const effectiveFit = judged?.fit ?? fitScore;
    embedFitOf.set(job.id, fitScore);

    // Proximity multiplies the blend rather than the fit, for the same reason
    // freshness does: `fitScore` is what the badge, auto-prep and the widening
    // test all read, and none of them should change their mind about a job
    // because of where it is. Only the order changes.
    const nearness = proximityFactor(proximityOf(job, profile));

    scored.push({
      job,
      fitScore: effectiveFit,
      ageDays: age,
      freshness,
      finalScore: blend(effectiveFit, freshness) * nearness,
      withinReach: isWithinReach(job, profile),
      llmWhy: judged?.why ?? null,
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
  //
  // This ONE decision reads the embedding fit rather than the merged one, and
  // the difference matters. Only the top ~30 jobs are ever sent for AI scoring,
  // and those are the jobs most likely to come back above the band — so a
  // merged fit here would let a handful of upgraded scores push the count over
  // the threshold, decide there was plenty nearby, and collapse the nationwide
  // list. The widening question is "how much real work is near this person",
  // which is about the corpus, and it must be answered the same way whether or
  // not they have connected a key.
  const nearbyWorthwhile = nearby.filter(
    (r) => (embedFitOf.get(r.job.id) ?? r.fitScore) >= MIN_FIT_FOR_WIDENING,
  );
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
