/**
 * Tuning constants. One file, so a behaviour change is one diff and one review.
 */

/**
 * Freshness half-life, in days, for `final_score = fit * exp(-age_days / N)`.
 *
 * At 7: a job posted today keeps 100% of its fit, one posted a week ago keeps
 * 37%, two weeks 14%. That is aggressive on purpose — a veteran applying to a
 * three-week-old posting is usually behind a queue of hundreds.
 */
export const FRESHNESS_HALF_LIFE_DAYS = 7;

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
export const MIN_RESULTS_BEFORE_WIDENING = 10;

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
