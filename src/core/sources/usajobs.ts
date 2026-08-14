import type { Job, SalaryInterval } from "../types.ts";
import { htmlToText, makeDedupeKey, makeJobId } from "../pipeline/normalize.ts";
import { buildQuery } from "../net/allowlist.ts";
import {
  getWithRetry,
  HttpStatusError,
  type FetchContext,
  type Source,
  type SourceFetchResult,
} from "./source.ts";
import { USAJOBS_MAX_REQUESTS_PER_RUN } from "../config.ts";

/**
 * USAJobs Search API — federal postings, with the veterans hiring path.
 *
 * Requires a free key from https://developer.usajobs.gov/apirequest/. Two
 * things about the auth are easy to get wrong and both return 401:
 *
 *   - the header is `Authorization-Key` (hyphen, capital K). Not `Authorization`.
 *   - `User-Agent` must be the email address the key was registered with, and a
 *     generic or empty User-Agent gets a 403 Akamai HTML page rather than JSON.
 */

const SEARCH_URL = "https://data.usajobs.gov/api/search";

/** ResultsPerPage caps at 500 and Page at 20 — a hard 10,000-row ceiling. */
const RESULTS_PER_PAGE = 500;
const MAX_PAGES = 20;

/**
 * How many of the profile's titles to search.
 *
 * Each one is a separate round trip (see below), so this bounds both the run
 * time and how much we ask of a free government API.
 */
const MAX_KEYWORDS = 5;

export interface UsaJobsAuth {
  readonly apiKey: string;
  /** The email the key was registered with. */
  readonly userAgentEmail: string;
}

export interface UsaJobsOptions {
  readonly auth: UsaJobsAuth;
  /**
   * Civilian job titles. Each is searched separately and the results unioned.
   *
   * `Keyword` ANDs its terms and supports no OR operator — verified against the
   * live API: "truck driver" returns 14 results, and
   * "Truck Driver Logistics Coordinator Fleet Supervisor" returns 0, as does
   * every quoted or explicit-OR form. Joining titles therefore does not widen
   * the search, it silently empties it.
   */
  readonly keywords: readonly string[];
  /** DatePosted, in days. The API accepts 0–60. */
  readonly windowDays: number;
}

interface Remuneration {
  MinimumRange?: string;
  MaximumRange?: string;
  RateIntervalCode?: string;
}

interface MatchedObjectDescriptor {
  PositionID?: string;
  PositionTitle?: string;
  PositionURI?: string;
  ApplyURI?: string[];
  OrganizationName?: string;
  DepartmentName?: string;
  PositionLocationDisplay?: string;
  PositionRemuneration?: Remuneration[];
  PublicationStartDate?: string;
  ApplicationCloseDate?: string;
  QualificationSummary?: string;
  UserArea?: {
    Details?: {
      JobSummary?: string;
      MajorDuties?: string[] | string;
      Requirements?: string;
    };
  };
}

interface SearchResponse {
  SearchResult?: {
    SearchResultCount?: number;
    SearchResultCountAll?: number;
    SearchResultItems?: { MatchedObjectDescriptor?: MatchedObjectDescriptor }[];
  };
}

/**
 * USAJobs rate-interval codes we are willing to put a unit on.
 *
 * Only codes whose meaning is unambiguous. Anything else — including a code
 * that arrives here tomorrow — produces no salary at all rather than a number
 * with a guessed unit, because "Pay not listed" is true and "$2,037 a year"
 * might not be. See payFields below.
 *
 * PB used to map to "year" with a comment admitting it meant "per biweekly
 * period" and that normalising was "not worth the guess". That is a wrong
 * number in a veteran's face: a $2,037 biweekly salary rendered as $2,037 a
 * year, for federal work paying about $53,000.
 *
 * PW used to map to "week". Federal payroll code lists give PW as *piece work*
 * and use BY for biweekly, which would make both of the old entries wrong.
 * Attempted to verify against the authoritative list at
 * data.usajobs.gov/api/codelist/remunerationrateintervalcodes on 2026-08-14 and
 * could not reach it from this environment — so both are left out. If somebody
 * can reach that endpoint, confirm PB, PW and BY and add them back with the
 * date in this comment.
 */
const INTERVALS: Readonly<Record<string, SalaryInterval>> = {
  PA: "year",
  PH: "hour",
  PD: "day",
  PM: "month",
};

function parseMoney(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  // MinimumRange/MaximumRange are strings, sometimes with decimals.
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * The three pay fields, together, because they only make sense together.
 *
 * An unrecognised rate interval drops the amounts as well as the unit. Keeping
 * the amounts and nulling only the interval looks careful and is not: the card
 * falls through to a bare range and prints "$2,037 to $2,650" with no unit at
 * all, which reads as an annual salary to anyone scanning a list. Adzuna
 * already drops both for the same reason.
 */
function payFields(
  pay: Remuneration | undefined,
): Pick<Job, "salaryMin" | "salaryMax" | "salaryCurrency" | "salaryInterval"> {
  const none = {
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryInterval: null,
  };
  if (pay === undefined) return none;

  const code = pay.RateIntervalCode;
  const interval = code === undefined ? null : (INTERVALS[code] ?? null);
  if (interval === null) return none;

  return {
    salaryMin: parseMoney(pay.MinimumRange),
    salaryMax: parseMoney(pay.MaximumRange),
    salaryCurrency: "USD",
    salaryInterval: interval,
  };
}

function buildDescription(d: MatchedObjectDescriptor): string {
  const duties = Array.isArray(d.UserArea?.Details?.MajorDuties)
    ? d.UserArea.Details.MajorDuties.join("\n")
    : (d.UserArea?.Details?.MajorDuties ?? "");

  // QualificationSummary is a sibling of UserArea, not inside it — an easy
  // field to lose, and it is where most of the skill language lives.
  const parts = [
    d.UserArea?.Details?.JobSummary ?? "",
    duties,
    d.QualificationSummary ?? "",
  ].filter((p) => p !== "");

  return htmlToText(parts.join("\n\n"));
}

export function normalizeUsaJobsPosting(
  d: MatchedObjectDescriptor,
  ctx: { hasher: FetchContext["hasher"]; now: number },
): Job | null {
  const externalId = d.PositionID;
  const title = d.PositionTitle;
  if (externalId === undefined || title === undefined) return null;

  const company = d.OrganizationName ?? d.DepartmentName ?? "Federal government";
  const location = d.PositionLocationDisplay?.trim() ?? null;

  const pay = d.PositionRemuneration?.[0];
  const postedRaw = d.PublicationStartDate;
  const postedAt = postedRaw === undefined ? null : Date.parse(postedRaw);
  const postedValid = postedAt !== null && !Number.isNaN(postedAt);

  return {
    id: makeJobId(ctx.hasher, "usajobs", externalId),
    source: "usajobs",
    externalId,
    title: title.trim(),
    company,
    location,
    // USAJobs exposes UserArea.Details.TeleworkEligible, which is NOT the same
    // as remote — a telework-eligible job can still require weekly office days.
    // Reporting it as remote would be inventing a fact (constraint 4).
    remote: location !== null && /\bremote\b/i.test(location) ? true : null,
    ...payFields(pay),
    // ApplyURI is an array; its first entry carries the RESTAPI posting channel.
    url: d.ApplyURI?.[0] ?? d.PositionURI ?? "https://www.usajobs.gov/",
    postedAt: postedValid ? postedAt : null,
    postedAtIsEstimated: !postedValid,
    descriptionText: buildDescription(d),
    raw: JSON.stringify({ ...d, UserArea: undefined, QualificationSummary: undefined }),
    firstSeenAt: ctx.now,
    lastSeenAt: ctx.now,
    dedupeKey: makeDedupeKey(company, title, location),
    canonicalId: null,
  };
}

export function buildSearchUrl(
  options: UsaJobsOptions,
  keyword: string,
  page: number,
): string {
  const params: [string, string][] = [];

  if (keyword !== "") params.push(["Keyword", keyword]);

  // LocationName is deliberately NOT sent.
  //
  // Two reasons. Practically, the API's location filter is severe: "truck
  // driver" returns 14 postings nationally and 0 within 50 miles of
  // Fayetteville, NC, so sending it silently empties the federal results for
  // most of the country. Structurally, we already treat every other source the
  // same way — fetch broadly, then filter and widen locally in rank.ts, where
  // the user can be told what happened. Not sending it also means OPM learns
  // the job titles someone is searching for but not where they live.

  params.push(["ResultsPerPage", String(RESULTS_PER_PAGE)]);
  params.push(["Page", String(page)]);
  params.push(["DatePosted", String(Math.min(Math.max(options.windowDays, 0), 60))]);
  // The veterans lane, plus everything open to the public. WhoMayApply is a
  // different axis, and its useful values ('All', 'Status') require special
  // authorization that a self-service key does not have — so it is omitted.
  params.push(["HiringPath", "vet;public"]);
  // Without Fields=Full the response carries no UserArea.Details, which is
  // where the duties and job summary live.
  params.push(["Fields", "Full"]);
  params.push(["SortField", "PublicationStartDate"]);
  params.push(["SortDirection", "Desc"]);

  return `${SEARCH_URL}?${buildQuery(params)}`;
}

export function createUsaJobsSource(options: UsaJobsOptions): Source {
  const label = "usajobs";

  return {
    id: "usajobs",
    label,
    stateKey: label,

    async fetch(
      ctx: FetchContext,
    ): Promise<Omit<SourceFetchResult, "sourceId" | "label" | "error">> {
      const jobs: Job[] = [];
      const seen = new Set<string>();

      // One search per title, unioned. Keyword ANDs its terms and has no OR
      // operator, so a single combined query returns nothing at all.
      const keywords = options.keywords.slice(0, MAX_KEYWORDS);
      if (keywords.length === 0) keywords.push("");

      const headers = {
        host: "data.usajobs.gov",
        // Must be the email the key was registered with. A generic or
        // empty User-Agent gets a 403 Akamai HTML page, not JSON.
        "user-agent": options.auth.userAgentEmail,
        "authorization-key": options.auth.apiKey,
      };

      let requests = 0;
      // A whole-run budget, so one broad keyword cannot paginate away the
      // politeness margin. Checked across both loops, not just the inner one.
      let budgetSpent = false;

      for (const keyword of keywords) {
        if (budgetSpent) break;

        for (let page = 1; page <= MAX_PAGES; page++) {
          if (requests >= USAJOBS_MAX_REQUESTS_PER_RUN) {
            budgetSpent = true;
            break;
          }

          let response;
          try {
            requests++;
            response = await getWithRetry(
              ctx,
              buildSearchUrl(options, keyword, page),
              label,
              null,
              headers,
            );
          } catch (err) {
            // Retries are exhausted, or the key was refused. Anything already
            // fetched is real and still useful, so keep it rather than throwing
            // a whole run's federal results away over one bad page — the same
            // partial-keep Adzuna does. With nothing fetched there is nothing
            // to salvage and the error is the honest answer, which is also what
            // keeps a rejected key surfacing as "would not accept our key".
            if (jobs.length > 0) {
              return { jobs, notModified: false, newState: null, requests };
            }
            throw err;
          }

          if (response.status !== 200) {
            throw new HttpStatusError(
              response.status,
              label,
              response.body.slice(0, 200),
            );
          }

          const parsed = JSON.parse(response.body) as SearchResponse;
          const items = parsed.SearchResult?.SearchResultItems ?? [];

          for (const item of items) {
            const descriptor = item.MatchedObjectDescriptor;
            if (descriptor === undefined) continue;
            const job = normalizeUsaJobsPosting(descriptor, ctx);
            // Deduplicates across keyword queries and within one: a federal
            // announcement is often published twice, once open to the public
            // and once to status candidates, under the same PositionID.
            if (job !== null && !seen.has(job.id)) {
              seen.add(job.id);
              jobs.push(job);
            }
          }

          // Drive pagination off what actually came back, not off an assumed
          // page size and not off UserArea.NumberOfPages (which is a string).
          if (items.length < RESULTS_PER_PAGE) break;
        }
      }

      // The search endpoint does not offer useful conditional-request support.
      return { jobs, notModified: false, newState: null, requests };
    },
  };
}
