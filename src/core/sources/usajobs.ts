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
 * USAJobs rate-interval codes, verified 2026-08-15 against the authoritative
 * list at data.usajobs.gov/api/codelist/remunerationrateintervalcodes.
 *
 * All ten codes, and what this app does with each:
 *
 *   PA  Per Year               -> year
 *   PH  Per Hour               -> hour
 *   PD  Per Day                -> day
 *   PM  Per Month              -> month
 *   BW  Bi-weekly              -> annualised, x26 (see below)
 *   PW  Piece Work             -> no pay shown
 *   FB  Fee Basis              -> no pay shown
 *   SY  School Year            -> no pay shown
 *   ST  Student Stipend Paid   -> no pay shown
 *   WC  Without Compensation   -> no pay shown
 *
 * Two of these were wrong before the list was read, and both were the kind of
 * wrong that puts a false number in front of somebody deciding whether to
 * apply.
 *
 * `PW` was mapped to "week". It means **piece work** — pay per unit produced,
 * which has no time interval at all. A piece rate rendered as a weekly wage is
 * a fabricated fact.
 *
 * `PB` was mapped to "year" under a comment admitting it meant "per biweekly
 * period". There is no `PB` in the codelist: it does not exist. The real
 * biweekly code is `BW`, which was never handled, so genuinely biweekly federal
 * postings showed no pay at all.
 *
 * `BW` is annualised rather than shown as-is, because "$2,037" with no unit
 * reads as a salary and a biweekly figure is off by 26x. The multiplier is not
 * an estimate: federal pay periods are 26 per leave year by statute, so this is
 * arithmetic on a number the employer published, not a guess about it.
 *
 * The five that show nothing show nothing on purpose. Fee basis, piece work and
 * a school year are not time intervals this app can convert without inventing a
 * denominator, and "Without Compensation" is a real category of federal posting
 * — printing "$0 a year" against one would be its own small lie.
 */
const INTERVALS: Readonly<Record<string, SalaryInterval>> = {
  PA: "year",
  PH: "hour",
  PD: "day",
  PM: "month",
};

/** Federal pay periods per leave year. Statutory, not an estimate. */
const PAY_PERIODS_PER_YEAR = 26;

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
  if (code === undefined) return none;

  // Biweekly is converted rather than shown, because a bare "$2,037" reads as
  // a salary and is off by 26x. Multiplying a published figure by a statutory
  // constant is arithmetic; leaving the unit off would be the guess.
  if (code === "BW") {
    const min = parseMoney(pay.MinimumRange);
    const max = parseMoney(pay.MaximumRange);
    if (min === null && max === null) return none;
    return {
      salaryMin: min === null ? null : min * PAY_PERIODS_PER_YEAR,
      salaryMax: max === null ? null : max * PAY_PERIODS_PER_YEAR,
      salaryCurrency: "USD",
      salaryInterval: "year",
    };
  }

  const interval = INTERVALS[code] ?? null;
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
