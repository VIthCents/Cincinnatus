/**
 * Tuning constants. One file, so a behaviour change is one diff and one review.
 */

/**
 * Freshness half-life, in days, for the decaying part of the freshness factor.
 *
 * This is a true half-life now: `2 ** (-age / N)`. The old code wrote
 * `exp(-age / 7)` under this name, which is a time CONSTANT of 7 days — an
 * actual half-life of 4.85 days, and a name that disagreed with its own maths.
 */
export const FRESHNESS_HALF_LIFE_DAYS = 14;

/**
 * The least a job's fit can be discounted for age, however old it is.
 *
 * Derived, not taste. The badge bands are 40 (good) and 55 (strong), so for the
 * guarantee "a job the badge calls strong is never outranked by a job the badge
 * calls good, at any age" the floor must be at least 40/55 = 0.727. 0.75 is that
 * rounded up, and it caps age's total authority at 1.333x.
 *
 * Measured 2026-08-09, this is why: the corpus has a median age of 54 days and
 * 90% of it is over a week old, so the unbounded `exp(-age/7)` was not a
 * tiebreak, it was a hard filter down to the newest ~10% — Spearman correlation
 * of final score with age was 0.99, with fit 0.15. The single best semantic
 * match in a 5,293-job corpus sat at final-rank 1,921 for no reason but its date.
 */
export const FRESHNESS_FLOOR = 0.75;

/**
 * Age is clamped into this range before the decay is applied.
 *
 * The upper bound stops `exp(-1800/7)` underflowing to exactly 0, which would
 * make every old job tie at a final score of 0 and sort arbitrarily. The lower
 * bound handles sources that report a posting date slightly in the future.
 */
export const MIN_AGE_DAYS = 0;
export const MAX_AGE_DAYS = 180;

/**
 * Characters of job text fed to the embedder.
 *
 * all-MiniLM-L6-v2's trained sequence window is 256 tokens (from
 * sentence_bert_config.json — NOT the 512 in tokenizer_config.json, which is the
 * BERT architectural limit). At roughly 4 characters per token, ~1,000
 * characters is what actually survives tokenisation; anything beyond it is
 * truncated by the model and only costs time.
 */
export const JOB_TEXT_MAX_CHARS = 1000;
export const PROFILE_TEXT_MAX_CHARS = 1000;

/** Model sequence window, in tokens. Passed to the tokenizer explicitly. */
export const EMBED_MAX_TOKENS = 256;

/** How many jobs to embed per forward pass. */
export const EMBED_BATCH_SIZE = 32;

/**
 * If filtering to the user's radius leaves fewer than this many jobs, the
 * filter is dropped and the run reports nationwide results instead.
 *
 * The reachable employer boards skew heavily coastal, so a user near Fort Bragg
 * or San Antonio can legitimately have almost nothing commutable. An empty list
 * reads as a broken app; a long list of unreachable jobs reads as a useless one.
 * Widening and saying so is the honest middle.
 */
/**
 * How far a degree-gated role is pushed down for someone with no degree, in
 * cosine units. 0.15 against a corpus whose cosines span roughly 0.0-0.63, so
 * it demotes without erasing: a gated job that is still far and away the best
 * topical match survives the penalty, which is the intent. See
 * pipeline/reach.ts for the measurement behind the number.
 */
export const CREDENTIAL_GATE_PENALTY = 0.15;

/**
 * How much a job title that looks like work the person has actually done is
 * worth, at most. Small on purpose: a tiebreaker between topically similar
 * jobs, not a second ranking. See pipeline/reach.ts.
 */
export const TITLE_AFFINITY_BONUS = 0.1;

export const MIN_RESULTS_BEFORE_WIDENING = 10;

/**
 * The fit a nearby job needs before it counts toward "there is enough here".
 *
 * Widening asks how many jobs nearby are worth applying to, not how many are
 * nearby — see rank.ts. Set at the "good match" badge band, so the question the
 * code asks is the same one the interface answers: are there ten jobs near this
 * person that Cincinnatus would call a good match? Measured 2026-08-09, a CDL
 * driver in Fayetteville NC had 318 nearby jobs and none of them was one.
 */
export const MIN_FIT_FOR_WIDENING = 40;

/** Default number of days of USAJobs postings to request. */
export const USAJOBS_DEFAULT_WINDOW_DAYS = 7;

/**
 * Politeness settings, per host.
 *
 * Lever's robots.txt declares `Crawl-delay: 1`, so one request per second is not
 * a guess there. Greenhouse and Ashby publish no limit and returned no 429s
 * under burst, but many installs will poll the same ~15 boards, and the load
 * lands on companies who published these APIs as a courtesy. Conservative
 * defaults are what keep them available to us.
 */
export const REQUEST_DELAY_MS: Readonly<Record<string, number>> = {
  "boards-api.greenhouse.io": 350,
  "api.lever.co": 1000,
  "api.ashbyhq.com": 350,
  "data.usajobs.gov": 500,
};

export const DEFAULT_REQUEST_DELAY_MS = 1000;

/** Retry policy for transient failures (429, 5xx, network errors). */
export const MAX_RETRIES = 3;
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 8000;

export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Sent on every outbound request. The URL is a real contact point — if someone
 * at Greenhouse or OPM wants to know who is calling, it has to lead somewhere.
 */
// TODO(identity): update if the repository moves.
export const USER_AGENT =
  "Cincinnatus/0.1 (+https://github.com/cincinnatus/cincinnatus)";

/**
 * Titles below this token-overlap score with the profile are dropped before
 * ranking. Deliberately low: this only removes the obviously irrelevant.
 */
export const MIN_TITLE_OVERLAP = 0;

// -----------------------------------------------------------------------------
// AI models (SPEC §2: two constants in one config file)
// -----------------------------------------------------------------------------

/**
 * Resume analysis, revision, tailoring, cover letters.
 *
 * SPEC §2's default was `claude-sonnet-4-6`; the current Sonnet is
 * `claude-sonnet-5` (verified against Anthropic's docs 2026-08-08 — see
 * docs/DECISIONS.md). Sonnet rather than Opus because these calls run on the
 * user's own prepaid credits: document quality matters, but a veteran with $5
 * of credits should get dozens of tailored applications out of it, not a few.
 */
export const DOC_MODEL = "claude-sonnet-5";

/** Chat and match scoring: cheap, fast, good enough for short judgments. */
export const FAST_MODEL = "claude-haiku-4-5";

/**
 * List prices in USD per million tokens, for the plain-language running cost
 * estimate ("AI used this month: about $1.20"). Estimates only — billing truth
 * lives in the user's Anthropic console.
 */
export const MODEL_PRICES_PER_MTOK: Readonly<
  Record<string, { input: number; output: number }>
> = {
  [DOC_MODEL]: { input: 3, output: 15 },
  [FAST_MODEL]: { input: 1, output: 5 },
};

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = MODEL_PRICES_PER_MTOK[model];
  if (price === undefined) return 0;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}
