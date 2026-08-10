import {
  ADZUNA_MAX_PAGES,
  ADZUNA_MAX_TERMS,
  ADZUNA_RESULTS_PER_PAGE,
} from "../config.ts";
import { buildQuery } from "../net/allowlist.ts";
import { redactCredentials } from "../net/redact.ts";
import { htmlToText, makeDedupeKey, makeJobId } from "../pipeline/normalize.ts";
import { locationFromArea } from "../pipeline/states.ts";
import type { Job } from "../types.ts";
import {
  getWithRetry,
  HttpStatusError,
  type FetchContext,
  type Source,
  type SourceFetchResult,
} from "./source.ts";

/**
 * Adzuna — an aggregator, and the only source here that is not an employer's
 * own board.
 *
 * Why it is worth the complexity: the reachable ATS boards skew hard to
 * coastal software and aerospace. Measured on a real corpus of 5,700 jobs, a
 * CDL driver in Fayetteville had almost nothing to apply to. One Adzuna query
 * returns 1,970 driving jobs within 50 of that same town. Ranking was never
 * the binding constraint for that person; supply was.
 *
 * What it costs, and why the shape of this file follows from it:
 *
 *  - **A hard quota.** Adzuna's terms allow 25 requests/minute, 250/day,
 *    1,000/week and 2,500/month. Nothing in a `Source` can count calls across
 *    runs, so this stays inside the caps *by construction*: at most
 *    ADZUNA_MAX_TERMS x ADZUNA_MAX_PAGES requests per run. See config.ts.
 *  - **Credentials in the query string.** Adzuna authenticates with app_id and
 *    app_key as URL parameters, and this codebase puts URLs into error
 *    messages that get persisted and shown. Every throw from here goes through
 *    `redactCredentials`.
 *  - **No conditional requests.** No ETag, no Last-Modified, no cache-control
 *    on any response. `newState` is always null.
 *  - **No usable salary.** See `normalizeAdzunaJob`.
 */

export interface AdzunaAuth {
  readonly appId: string;
  readonly appKey: string;
}

export interface AdzunaOptions {
  readonly auth: AdzunaAuth;
  /** Job titles to search, one request each. Sliced to ADZUNA_MAX_TERMS. */
  readonly keywords: readonly string[];
  /** "Fayetteville, NC", or null to search nationally. */
  readonly locationName: string | null;
  readonly radiusMiles: number | null;
  /**
   * Requests this run may issue, from the cross-run ledger. Omitted means
   * the structural budget alone applies.
   */
  readonly maxCalls?: number;
}

interface AdzunaLocation {
  readonly display_name?: string;
  readonly area?: readonly string[];
}

interface AdzunaResult {
  readonly id?: string;
  readonly title?: string;
  readonly description?: string;
  readonly created?: string;
  readonly redirect_url?: string;
  readonly company?: { readonly display_name?: string };
  readonly location?: AdzunaLocation;
  readonly salary_is_predicted?: string;
  readonly contract_time?: string;
  readonly category?: { readonly label?: string };
}

interface AdzunaResponse {
  readonly count?: number;
  readonly results?: readonly AdzunaResult[];
}

const HOST = "https://api.adzuna.com";

/**
 * Adzuna's `distance` is documented in kilometres (their Swagger; SPEC assumed
 * miles). In practice it behaves loosely — Raleigh, 60 miles from Fayetteville,
 * appears at distance=40 — so it is a hint that narrows the query, not the
 * filter we rely on. The real radius test is `isWithinReach` on our side.
 */
const MILES_TO_KM = 1.60934;

export function buildAdzunaSearchUrl(
  options: AdzunaOptions,
  keyword: string,
  page: number,
): string {
  const params: [string, string][] = [
    ["app_id", options.auth.appId],
    ["app_key", options.auth.appKey],
    ["results_per_page", String(ADZUNA_RESULTS_PER_PAGE)],
    ["content-type", "application/json"],
  ];
  if (keyword !== "") params.push(["what", keyword]);
  if (options.locationName !== null && options.locationName !== "") {
    params.push(["where", options.locationName]);
    if (options.radiusMiles !== null && options.radiusMiles > 0) {
      params.push(["distance", String(Math.round(options.radiusMiles * MILES_TO_KM))]);
    }
  }
  // The page is a PATH segment, 1-based — not a query parameter.
  return `${HOST}/v1/api/jobs/us/search/${encodeURIComponent(String(page))}?${buildQuery(params)}`;
}

export function createAdzunaSource(options: AdzunaOptions): Source {
  const label = "adzuna";

  return {
    id: "adzuna",
    label,
    stateKey: label,

    async fetch(
      ctx: FetchContext,
    ): Promise<Omit<SourceFetchResult, "sourceId" | "label" | "error">> {
      const jobs: Job[] = [];
      const seen = new Set<string>();

      const keywords = options.keywords.slice(0, ADZUNA_MAX_TERMS);
      if (keywords.length === 0) keywords.push("");

      let requests = 0;
      let stopped = false;

      for (const keyword of keywords) {
        if (stopped) break;

        for (let page = 1; page <= ADZUNA_MAX_PAGES; page++) {
          // The ledger has the last word: it knows about days this run does not.
          if (options.maxCalls !== undefined && requests >= options.maxCalls) {
            stopped = true;
            break;
          }
          let response;
          try {
            response = await getWithRetry(
              ctx,
              buildAdzunaSearchUrl(options, keyword, page),
              label,
              null,
            );
          } catch (err) {
            // Once anything has succeeded, a later failure must not throw away
            // what the quota already paid for. Those requests are spent whether
            // or not we keep the jobs, and the next run starts from term one
            // and would hit the same wall in the same place.
            if (requests > 0) {
              stopped = true;
              break;
            }
            throw new Error(redactCredentials(String(err)), { cause: err });
          }

          requests += 1;

          // Past the last page Adzuna answers 410. That is the end of the
          // results, not a failure.
          if (response.status === 410) break;

          if (response.status === 429) {
            // Terminal, deliberately. A per-minute rejection needs up to a
            // minute to clear and a daily one never clears within a run, so
            // retrying only spends more of a quota that is already gone.
            ctx.reporter({
              kind: "note",
              message:
                "Adzuna asked us to slow down, so this search used what it already had.",
            });
            stopped = true;
            break;
          }

          if (response.status !== 200) {
            if (requests > 1) {
              stopped = true;
              break;
            }
            throw new HttpStatusError(
              response.status,
              label,
              redactCredentials(response.body.slice(0, 200)),
            );
          }

          const parsed = JSON.parse(response.body) as AdzunaResponse;
          const results = parsed.results ?? [];

          for (const raw of results) {
            const job = normalizeAdzunaJob(raw, ctx);
            // The same posting comes back under several search terms.
            if (job !== null && !seen.has(job.id)) {
              seen.add(job.id);
              jobs.push(job);
            }
          }

          // Driven by what actually arrived, never by the claimed `count`,
          // which is an estimate of total matches rather than a page count.
          if (results.length < ADZUNA_RESULTS_PER_PAGE) break;
        }
      }

      if (stopped && keywords.length > 1) {
        ctx.reporter({
          kind: "note",
          message: `Checked ${jobs.length} jobs from Adzuna this time. It limits how much we can ask for at once.`,
        });
      }

      return { jobs, notModified: false, newState: null, requests };
    },
  };
}

export function normalizeAdzunaJob(
  raw: AdzunaResult,
  ctx: { hasher: FetchContext["hasher"]; now: number },
): Job | null {
  const externalId = raw.id;
  const title = raw.title?.trim();
  if (externalId === undefined || title === undefined || title === "") return null;

  // "City, ST" so the radius test can match the profile's two-letter state.
  // Falls back to whatever Adzuna printed rather than inventing a state.
  const location =
    (raw.location?.area === undefined ? null : locationFromArea(raw.location.area)) ??
    raw.location?.display_name?.trim() ??
    null;

  const postedRaw = raw.created;
  const postedAt = postedRaw === undefined ? null : Date.parse(postedRaw);
  const postedValid = postedAt !== null && !Number.isNaN(postedAt);

  const company = raw.company?.display_name?.trim();

  return {
    id: makeJobId(ctx.hasher, "adzuna", externalId),
    source: "adzuna",
    externalId,
    title,
    company: company === undefined || company === "" ? "Not named" : company,
    location,
    // Adzuna has no remote field. The location string is the only signal, and
    // `null` means "the source did not say" — never false.
    remote: location !== null && /\bremote\b/i.test(location) ? true : null,

    // Salary is dropped entirely, on purpose.
    //
    // `salary_is_predicted` is the STRING "1" on 47 of every 50 results, which
    // means the number is Adzuna's regression output and not something an
    // employer ever said. Publishing that as the job's pay is fabrication
    // (constraint 4) arriving through the job list instead of the documents.
    //
    // The remaining 3 are no safer to print. Adzuna ships no pay-interval
    // field: it normalises everything to a yearly figure of its own
    // calculation, so an hourly wage would be rendered "$X a year" in the
    // app's own voice. "Pay not listed" is the true sentence — Adzuna did not
    // tell us what the employer stated, only what Adzuna computed.
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryInterval: null,

    // Adzuna exposes no employer URL at all, and their terms require sending
    // people through this redirect. The human still does the applying.
    url: raw.redirect_url ?? "https://www.adzuna.com/",
    postedAt: postedValid ? postedAt : null,
    postedAtIsEstimated: !postedValid,
    // Already plain text, and already truncated by Adzuna to a couple of
    // hundred characters. Decoded once — unlike Greenhouse's double-encoded
    // content — and never parsed as markup.
    descriptionText: htmlToText(raw.description ?? ""),
    raw: JSON.stringify({ ...raw, description: undefined }),
    firstSeenAt: ctx.now,
    lastSeenAt: ctx.now,
    dedupeKey: makeDedupeKey(
      company === undefined || company === "" ? "Not named" : company,
      title,
      location,
    ),
    canonicalId: null,
  };
}
