/**
 * Tuning constants. One file, so a behaviour change is one diff and one review.
 */

import { GOOD_MATCH_FIT, STRONG_MATCH_FIT } from "./pipeline/match.ts";

/**
 * Freshness half-life, in days, for the decaying part of the freshness factor.
 *
 * This is a true half-life: `2 ** (-age / N)`. The old code wrote
 * `exp(-age / 7)` under this name, which is a time CONSTANT of 7 days — an
 * actual half-life of 4.85 days, and a name that disagreed with its own maths.
 *
 * 10 rather than 14, measured 2026-08-14 when FRESHNESS_FLOOR moved to 0.80.
 * A higher floor leaves the decaying part less amplitude, and at a 14-day
 * half-life that was enough to let one job back into the infantry top ten: the
 * 16-day-old "Security Officer" scoring 70.4 that every judge marked out of
 * reach — the encoder mislabel documented in pipeline/match.ts. NDCG@10 on that
 * golden set fell to 0.653, under its 0.70 floor. At 10 days it decays past
 * rank 10 and the set returns to 0.745, with the CDL set unchanged at 0.565.
 *
 * 12 and 7 also pass; 10 was the best of the values tried, not a forced choice.
 */
export const FRESHNESS_HALF_LIFE_DAYS = 10;

/**
 * The least a job's fit can be discounted for age, however old it is.
 *
 * Derived, not taste, from the badge bands in pipeline/match.ts — which are the
 * single source of those numbers, and which moved to 48/60 on 2026-08-10 while
 * this constant was left behind at a value derived from the old 40/55.
 *
 * The guarantee is: a job sitting exactly on the strong band, at any age, still
 * scores at or above the good band — age can cost a job its place in the order,
 * but never drops a strong match below what the interface calls a good one.
 * That needs the floor to be at least GOOD/STRONG = 48/60 = 0.80, and caps
 * age's total authority at 1.25x. Note what it does NOT say: a fresh fit-59
 * "good" job still outranks a maximally aged fit-60 "strong" one. Ordering
 * inside a band is age's job. The floor only stops age crossing a band.
 *
 * Measured 2026-08-09, why a floor exists at all: the corpus has a median age
 * of 54 days and 90% of it is over a week old, so the unbounded `exp(-age/7)`
 * was not a tiebreak, it was a hard filter down to the newest ~10% — Spearman
 * correlation of final score with age was 0.99, with fit 0.15. The single best
 * semantic match in a 5,293-job corpus sat at final-rank 1,921 for no reason
 * but its date.
 */
export const FRESHNESS_FLOOR = GOOD_MATCH_FIT / STRONG_MATCH_FIT;

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

/**
 * If filtering to the user's radius leaves fewer than this many jobs worth
 * applying to, the filter is dropped and the run reports nationwide results
 * instead.
 *
 * The reachable employer boards skew heavily coastal, so a user near Fort Bragg
 * or San Antonio can legitimately have almost nothing commutable. An empty list
 * reads as a broken app; a long list of unreachable jobs reads as a useless one.
 * Widening and saying so is the honest middle.
 */
export const MIN_RESULTS_BEFORE_WIDENING = 10;

/**
 * The fit a nearby job needs before it counts toward "there is enough here".
 *
 * Widening asks how many jobs nearby are worth applying to, not how many are
 * nearby — see rank.ts. This IS the "good match" badge band, by construction
 * rather than by a copied number, so the question the code asks is the same one
 * the interface answers: are there ten jobs near this person that Cincinnatus
 * would call a good match? Measured 2026-08-09, a CDL driver in Fayetteville NC
 * had 318 nearby jobs and none of them was one.
 */
export const MIN_FIT_FOR_WIDENING = GOOD_MATCH_FIT;

/** Default number of days of USAJobs postings to request. */
export const USAJOBS_DEFAULT_WINDOW_DAYS = 7;

/**
 * Most requests one search may spend against USAJobs.
 *
 * Politeness, not a published quota: OPM states no rate limit, but the
 * structural maximum here is 5 keywords x 20 pages = 100 requests, and at 500
 * results per page a run that actually needed all of them would be asking a
 * free government API for 50,000 postings. 25 still allows 12,500, far past
 * what the veterans-path filter returns in practice — one measured profile
 * returned 13 postings nationwide.
 *
 * The cap is a whole-run budget, not a per-keyword one: a single broad keyword
 * paginating forever is exactly the case worth stopping.
 */
export const USAJOBS_MAX_REQUESTS_PER_RUN = 25;

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

  // Adzuna publishes a hard ceiling of 25 requests per minute in its terms
  // (60000/25 = 2400ms). The margin covers clock skew and the fact that
  // Adzuna counts the request, not the response.
  "api.adzuna.com": 2600,
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
export const USER_AGENT = "Cincinnatus/0.1 (+https://github.com/VIthCents/Cincinnatus)";

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

// -----------------------------------------------------------------------------
// LLM match scoring (SPEC §5, §7 task 6)
// -----------------------------------------------------------------------------

/**
 * How many jobs one search may ask the AI to judge.
 *
 * SPEC §5 says "the top ~30 new jobs". Enough to cover what a person actually
 * reads before deciding, and small enough that a full pass costs about two
 * cents of their own credits. Steady-state runs score far fewer, because a job
 * already judged for this profile is not judged again.
 */
export const LLM_SCORE_MAX_JOBS = 30;

/**
 * Jobs per request. Ten keeps a single call's output near 500 tokens and means
 * a malformed or refused batch costs at most ten scores rather than thirty.
 */
export const LLM_SCORE_BATCH_SIZE = 10;

/**
 * Characters of each job's description sent for judging. Enough for the duties
 * and the requirements, which is what the rubric turns on; the rest is usually
 * benefits boilerplate and equal-opportunity text.
 */
export const LLM_SCORE_DESCRIPTION_CHARS = 1200;

export const LLM_SCORE_MAX_TOKENS = 1500;

/** SPEC §7: "score + rationale <= 140 chars". Enforced in code, not just asked for. */
export const LLM_RATIONALE_MAX_CHARS = 140;

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

/**
 * Adzuna's quota, and how this app stays inside it.
 *
 * Their terms state four ceilings: 25 requests per minute, 250 per day,
 * 1,000 per week and 2,500 per month. A `Source` is handed no database and
 * cannot count its own calls across runs, so the budget is enforced by
 * construction instead: at most TERMS x PAGES requests per search.
 *
 * 5 x 2 = 10 per search. The scheduler defaults to every 6 hours, so 4
 * scheduled searches plus a few manual ones is ~50/day and ~1,500/month —
 * inside every ceiling with room for the user pressing Search now.
 *
 * Raising either number risks the monthly cap, and running out means Adzuna
 * goes quiet two thirds of the way through a month with no way for the app
 * to explain why. Do the arithmetic before changing them.
 */
export const ADZUNA_MAX_TERMS = 5;
export const ADZUNA_MAX_PAGES = 2;

/** Adzuna caps this at 50 regardless of what is requested. */
export const ADZUNA_RESULTS_PER_PAGE = 50;

/**
 * How many of one employer's postings for the same role may sit in the top
 * of the list before the rest are demoted below everything else.
 *
 * Three, measured: the first live Adzuna run put nine identical
 * 'CDL A Delivery Truck Driver' postings from one company in the top twelve,
 * one per North Carolina town. They are all real and all nearby, so dropping
 * them would be wrong — but a list that shows one job nine times reads as
 * padded, and buries the variety the person actually needs to see.
 */
export const MAX_PER_EMPLOYER_ROLE = 3;

/**
 * Sources that gather listings from elsewhere, rather than being an
 * employer's own board. The distinction matters for staleness: a company
 * board is fetched whole every run, so a filled job simply stops arriving
 * and disappears on its own. A keyword search against an aggregator never
 * says a posting was pulled — it just is not in this slice.
 */
export const AGGREGATOR_SOURCES: readonly string[] = ["adzuna"];

/**
 * How long an aggregator listing may go unseen before it stops being shown.
 *
 * Aggregator ads die faster than a company's own board, and a dead link is
 * the fastest way to teach someone the list cannot be trusted: they click
 * Apply, wait for the browser, follow a redirect, and land on 'no longer
 * accepting applications'. Three of those in one sitting and the app has
 * taught them not to believe any of it.
 *
 * 30 days is deliberately generous, because not being re-seen is weak
 * evidence: each run only asks for a slice, so a live job that drifts off
 * the first two pages goes unseen for a while. Hiding a live job costs a
 * person nothing they can perceive; showing a dead one costs trust.
 */
export const AGGREGATOR_STALE_DAYS = 30;

/**
 * When an unseen aggregator row is deleted rather than merely hidden.
 *
 * Nothing else in this app deletes a job. Aggregator rows are the one source
 * that grows without bound — every run returns a different slice of a
 * national corpus — and the whole table is read on every app open. Rows the
 * person has touched (thumbed, hidden, or prepared an application for) are
 * never deleted, whatever their age.
 */
export const AGGREGATOR_DELETE_DAYS = 90;

/**
 * Held under Adzuna's published 250/day and 2,500/month. They count the
 * request, not the answer, and a run that dies mid-flight still spent what it
 * sent — so a ledger tracking the limit exactly would occasionally ask for one
 * more than was really left.
 */
export const ADZUNA_QUOTA = { perDay: 220, perMonth: 2200 };
