/**
 * Core domain types.
 *
 * A recurring rule here: **`null` means the source did not tell us**, and is
 * never quietly replaced with a default. `remote: false` asserts a job is not
 * remote; `remote: null` says we do not know. Greenhouse has no remote field at
 * all, and USAJobs' `teleworkEligible` is not the same thing as remote — so
 * defaulting either to `false` would be the app inventing a fact about a job,
 * which is constraint 4 in a different costume.
 */

// -----------------------------------------------------------------------------
// Sources
// -----------------------------------------------------------------------------

/** Every source that can appear in a job id. Adding one is a schema change. */
export type SourceId = "greenhouse" | "lever" | "ashby" | "usajobs" | "adzuna";

export type AtsKind = "greenhouse" | "lever" | "ashby";

export interface WatchlistEntry {
  readonly ats: AtsKind;
  /** Board slug as it appears in the API URL. */
  readonly slug: string;
  /** Human-readable employer name, shown to the user. */
  readonly companyLabel: string;
  /**
   * The exact name the board's own API reports, recorded when the slug was
   * verified. `--verify-watchlist` requires an exact match against this, which
   * is what catches a slug that has quietly become a different company.
   */
  readonly boardName: string | null;
  readonly source: "starter" | "user";
  /** Rough sector, so the starter list can be checked for breadth. */
  readonly sector: string | null;
  /** Why a veteran might care about this employer. */
  readonly note: string | null;
}

// -----------------------------------------------------------------------------
// Profile
// -----------------------------------------------------------------------------

export type RemotePreference = "any" | "remote_only" | "prefer_onsite";

export interface ProfileLocation {
  readonly city: string;
  /** Two-letter state code, upper-case. */
  readonly state: string;
}

export interface Profile {
  /** Civilian job titles the user is targeting, most relevant first. */
  readonly titles: readonly string[];
  readonly skills: readonly string[];
  /**
   * Military occupation codes: Army/Marine MOS, Air Force AFSC, Navy rating or
   * NEC. Used to look up civilian titles via the O*NET crosswalk.
   */
  readonly mocCodes: readonly string[];
  readonly branch: string | null;
  readonly clearance: string | null;
  readonly education: readonly string[];
  readonly yearsExperience: number | null;
  readonly location: ProfileLocation | null;
  readonly radiusMiles: number;
  readonly remotePreference: RemotePreference;
  readonly salaryFloor: number | null;
  /** Jobs whose title or company matches any of these are dropped outright. */
  readonly excludedKeywords: readonly string[];
}

// -----------------------------------------------------------------------------
// Jobs
// -----------------------------------------------------------------------------

export type SalaryInterval = "year" | "month" | "week" | "day" | "hour";

export interface Job {
  /** sha256(`${source}:${externalId}`), lower-case hex. */
  readonly id: string;
  readonly source: SourceId;
  readonly externalId: string;

  readonly title: string;
  readonly company: string;
  /** Free-text as the source gave it. Null when the source omitted it. */
  readonly location: string | null;
  /** null = the source did not say. Do not coerce to false. */
  readonly remote: boolean | null;

  readonly salaryMin: number | null;
  readonly salaryMax: number | null;
  readonly salaryCurrency: string | null;
  readonly salaryInterval: SalaryInterval | null;

  /** Absolute URL of the public posting. This is what Apply opens. */
  readonly url: string;

  /**
   * Epoch ms the job was first published. Null only if the source has no such
   * field; all three ATS sources do, at 100% coverage in sampling.
   *
   * For Greenhouse this MUST come from `first_published`, never `updated_at` —
   * an edited old posting would otherwise look brand new and outrank genuinely
   * fresh jobs.
   */
  readonly postedAt: number | null;
  /** True when postedAt fell back to firstSeenAt rather than a real field. */
  readonly postedAtIsEstimated: boolean;

  /** Plain text. HTML and entities are already decoded and stripped. */
  readonly descriptionText: string;
  /** The source record as JSON, minus the description. Kept for re-normalising. */
  readonly raw: string;

  readonly firstSeenAt: number;
  readonly lastSeenAt: number;

  /** normalize(company) + normalize(title) + metro. See pipeline/dedupe.ts. */
  readonly dedupeKey: string;
  /** Set on the losers of a dedupe group; they are hidden from the ranked list. */
  readonly canonicalId: string | null;
}

// -----------------------------------------------------------------------------
// Ranking
// -----------------------------------------------------------------------------

export interface RankedJob {
  readonly job: Job;
  /** 0–100. Cosine similarity of profile and job vectors, rescaled. */
  readonly fitScore: number;
  /** Whole days between postedAt (or firstSeenAt) and the run's `now`. */
  readonly ageDays: number;
  /**
   * FRESHNESS_FLOOR + (1 - FRESHNESS_FLOOR) * 2 ** (-ageDays / half-life).
   * Floored, so age can reorder within a badge band but never across one —
   * see pipeline/score.ts and the FRESHNESS_FLOOR docblock.
   */
  readonly freshness: number;
  /** fitScore * freshness. The single number the list is ordered by. */
  readonly finalScore: number;
  /**
   * The AI's one-line reason, when this job has a current LLM score. Null
   * otherwise — including for everyone with no key, who gets the local
   * "Mentions X and Y" line instead.
   */
  readonly llmWhy: string | null;
  /** Whether this job is within the user's radius, or remote. */
  readonly withinReach: boolean;
}

/**
 * An AI judgement of one job for one person (SPEC §5).
 *
 * Carries what it was judged against, because a score whose grounds have moved
 * is worse than no score: it looks current and is not. `profileHash` covers the
 * person and the prompt version; `contentHash` covers the job's own text.
 */
export interface LlmScore {
  /** 0–100, on the same scale and the same bands as the embedding fit. */
  readonly fit: number;
  /** One short sentence, spoken to the seeker. */
  readonly why: string;
  readonly profileHash: string;
  /** Null only for a job that had no embedding when it was judged. */
  readonly contentHash: string | null;
  readonly scoredAt: number;
}

// -----------------------------------------------------------------------------
// Applications
// -----------------------------------------------------------------------------

/**
 * Where one application stands.
 *
 * Every value here is something the veteran said out loud by pressing a
 * button. Nothing is inferred from a click on Apply, or from a search result,
 * or from anything else: the app cannot see into an employer's hiring system,
 * so a status it guessed would be a fact it invented (constraint 4), about the
 * one subject the person cares most about.
 */
export type ApplicationStatus =
  "applied" | "heard_back" | "interview" | "offer" | "closed";

export interface TrackedApplication {
  readonly job: Job;
  readonly status: ApplicationStatus;
  /** Epoch ms the veteran confirmed they had applied. */
  readonly appliedAt: number;
  /** Epoch ms the status last moved. Equal to appliedAt until it does. */
  readonly updatedAt: number;
}

// -----------------------------------------------------------------------------
// Run reporting
// -----------------------------------------------------------------------------

export interface SourceOutcome {
  readonly sourceId: SourceId;
  /** e.g. "greenhouse:andurilindustries" — what to show when it fails. */
  readonly label: string;
  readonly fetched: number;
  /** True when the server answered 304 and we reused what we already had. */
  readonly notModified: boolean;
  /** Plain-language message. Null on success. Never a stack trace. */
  readonly error: string | null;
}

/**
 * Distribution of fit scores across a run.
 *
 * Reported because raw MiniLM cosines between a short profile and a long job
 * description cluster in a narrow band. If min and max are within a point or
 * two, `finalScore` is really just measuring recency, and the operator should
 * be able to see that immediately rather than trusting a ranking that is not
 * actually ranking.
 */
export interface FitDistribution {
  readonly min: number;
  readonly median: number;
  readonly max: number;
}

export interface RunReport {
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly sources: readonly SourceOutcome[];
  readonly jobsSeen: number;
  readonly jobsNew: number;
  readonly duplicatesCollapsed: number;
  readonly embedded: number;
  readonly fit: FitDistribution | null;
  /**
   * True when the location filter was widened to nationwide because filtering
   * to the user's radius left too few results. Surfaced to the user in words.
   */
  readonly widenedBeyondRadius: boolean;
  /** Jobs considered for ranking, before the location filter. */
  readonly candidates: number;
  /** How many of those were within the user's reach or remote. */
  readonly reachable: number;
  /**
   * Plain-words things worth telling the person about this run that no source
   * reported, because they are not failures. A source deliberately sat out —
   * Adzuna's daily limit is spent — belongs here: the list is quietly shorter
   * and nothing else on screen would ever explain why.
   *
   * Distinct from `SourceOutcome.error`, which is a source that tried and hit
   * trouble. A limit is not a snag, and dressing one up as the other teaches
   * people to distrust a working app.
   */
  readonly notes: readonly string[];
  /** How many jobs the AI judged this run. 0 without a key. */
  readonly llmScored: number;
  /**
   * Plain words when AI scoring could not finish. Null when it did, and null
   * when there was no key to try with.
   *
   * Deliberately not surfaced on screen: the ranked list is complete and
   * useful either way, and a banner about a feature that silently improved
   * nothing is noise. It is here for the saved run and the harness.
   */
  readonly llmScoreNote: string | null;
}
