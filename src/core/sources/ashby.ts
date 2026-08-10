import { buildQuery } from "../net/allowlist.ts";
import { makeDedupeKey, makeJobId } from "../pipeline/normalize.ts";
import { normalizeUsLocation } from "../pipeline/states.ts";
import type { Job, SalaryInterval } from "../types.ts";
import {
  getWithRetry,
  HttpStatusError,
  readConditionalState,
  type FetchContext,
  type Source,
  type SourceFetchResult,
} from "./source.ts";

/**
 * Ashby job boards.
 *
 * One request returns the whole board, with an ETag and a 60-second
 * cache-control, so an unchanged board is free on the next run.
 *
 * `includeCompensation=true` is required or the compensation object is omitted
 * entirely — it costs about 8% more payload and it is the reason this source
 * can show pay at all.
 */

interface AshbyCompensationComponent {
  /** "Salary", but also "Equity", "Bonus", "Commission". Only pay is pay. */
  readonly compensationType?: string;
  /** "1 YEAR", "1 HOUR", "1 MONTH". */
  readonly interval?: string;
  readonly currencyCode?: string;
  readonly minValue?: number;
  readonly maxValue?: number;
}

interface AshbyPosting {
  readonly id?: string;
  readonly title?: string | null;
  readonly location?: string | null;
  readonly publishedAt?: string | null;
  readonly isRemote?: boolean;
  /** "Remote" | "OnSite" | "Hybrid" — the one that means what it says. */
  readonly workplaceType?: string | null;
  readonly isListed?: boolean;
  readonly jobUrl?: string;
  readonly applyUrl?: string;
  readonly descriptionPlain?: string | null;
  readonly employmentType?: string;
  readonly department?: string;
  readonly team?: string;
  /** The employer's own switch for whether pay may be shown. */
  readonly shouldDisplayCompensationOnJobPostings?: boolean;
  readonly compensation?: {
    readonly summaryComponents?: readonly AshbyCompensationComponent[];
  };
}

interface AshbyBoard {
  readonly jobs?: readonly AshbyPosting[];
}

const INTERVALS: Readonly<Record<string, SalaryInterval>> = {
  "1 YEAR": "year",
  "1 HOUR": "hour",
  "1 MONTH": "month",
  "1 WEEK": "week",
  "1 DAY": "day",
};

export function buildAshbyUrl(slug: string): string {
  return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?${buildQuery(
    [["includeCompensation", "true"]],
  )}`;
}

export function createAshbySource(slug: string, companyLabel: string): Source {
  const label = `ashby:${slug}`;

  return {
    id: "ashby",
    label,
    stateKey: label,

    async fetch(
      ctx: FetchContext,
    ): Promise<Omit<SourceFetchResult, "sourceId" | "label" | "error">> {
      const response = await getWithRetry(ctx, buildAshbyUrl(slug), label, ctx.state);

      if (response.status === 304) {
        return { jobs: [], notModified: true, newState: ctx.state };
      }
      if (response.status !== 200) {
        throw new HttpStatusError(response.status, label, response.body.slice(0, 200));
      }

      const board = JSON.parse(response.body) as AshbyBoard;
      const jobs: Job[] = [];
      for (const posting of board.jobs ?? []) {
        // `isListed: false` is the employer saying this one is not public.
        if (posting.isListed === false) continue;
        const job = normalizeAshbyPosting(posting, companyLabel, ctx);
        if (job !== null) jobs.push(job);
      }

      return {
        jobs,
        notModified: false,
        newState: readConditionalState(response),
      };
    },
  };
}

/**
 * The employer's stated pay, or nothing.
 *
 * Three gates, all of which have to pass. `shouldDisplayCompensationOnJobPostings`
 * is the employer's own switch and is respected even when the numbers are
 * present — republishing pay an employer chose to withhold is not ours to do.
 * Only `compensationType: "Salary"` counts, because an equity or bonus band
 * rendered as "$140,000 to $245,000 a year" would be a lie about wages. And an
 * interval we do not recognise means the numbers cannot be labelled, so they
 * are dropped rather than shown in a default unit.
 */
function readSalary(posting: AshbyPosting): {
  min: number | null;
  max: number | null;
  currency: string | null;
  interval: SalaryInterval | null;
} {
  const none = { min: null, max: null, currency: null, interval: null };
  if (posting.shouldDisplayCompensationOnJobPostings !== true) return none;

  const salary = (posting.compensation?.summaryComponents ?? []).find(
    (c) => c.compensationType === "Salary",
  );
  if (salary === undefined) return none;

  const interval =
    salary.interval === undefined ? null : (INTERVALS[salary.interval] ?? null);
  if (interval === null) return none;
  if (salary.minValue === undefined && salary.maxValue === undefined) return none;

  return {
    min: salary.minValue ?? null,
    max: salary.maxValue ?? null,
    currency: salary.currencyCode ?? null,
    interval,
  };
}

/**
 * Hybrid is not remote. It is an office job with some days at home, and a
 * person judging whether they can take it from another state needs it to say
 * so. Absent stays null and is never coerced to false.
 */
function workplaceRemote(workplaceType: string | null | undefined): boolean | null {
  // `null`, not just absent. Ashby sends an explicit JSON null here, and a
  // guard that only checked `undefined` threw on it — taking out Saronic,
  // Skydio and Form Energy entirely, 548 jobs, reported as nothing worse than
  // a source error line.
  if (workplaceType == null || workplaceType.trim() === "") return null;
  return workplaceType.trim().toLowerCase() === "remote";
}

export function normalizeAshbyPosting(
  posting: AshbyPosting,
  companyLabel: string,
  ctx: { hasher: FetchContext["hasher"]; now: number },
): Job | null {
  const externalId = posting.id;
  const title = posting.title?.trim();
  if (externalId === undefined || title === undefined || title === "") return null;

  const rawLocation = posting.location?.trim();
  const location =
    rawLocation === undefined || rawLocation === ""
      ? null
      : normalizeUsLocation(rawLocation);

  // `== null` covers both the absent field and the explicit JSON null, which
  // is the distinction that just cost three whole boards.
  const posted = posting.publishedAt == null ? null : Date.parse(posting.publishedAt);
  const postedValid = posted !== null && !Number.isNaN(posted);

  const pay = readSalary(posting);

  return {
    id: makeJobId(ctx.hasher, "ashby", externalId),
    source: "ashby",
    externalId,
    title,
    company: companyLabel,
    location,
    // `workplaceType`, NOT `isRemote`. Measured: isRemote is true for all 64 of
    // Skydio's "Hybrid" postings, every one of them in San Mateo, and for 4 of
    // Saronic's. It means "not strictly on site", which is not what this field
    // means to a person reading a card.
    //
    // The consequence is worse than a wrong label. `remote === true`
    // short-circuits isWithinReach, so a hybrid office job in California would
    // enter a Fayetteville veteran's list as reachable work they could take
    // from home. That is a fact nobody stated, arriving through the job list —
    // the same failure as Adzuna's predicted salaries.
    remote: workplaceRemote(posting.workplaceType),
    salaryMin: pay.min,
    salaryMax: pay.max,
    salaryCurrency: pay.currency,
    salaryInterval: pay.interval,
    url: posting.jobUrl ?? posting.applyUrl ?? "https://jobs.ashbyhq.com/",
    postedAt: postedValid ? posted : null,
    postedAtIsEstimated: !postedValid,
    descriptionText: posting.descriptionPlain?.trim() ?? "",
    raw: JSON.stringify({
      ...posting,
      descriptionPlain: undefined,
      descriptionHtml: undefined,
    }),
    firstSeenAt: ctx.now,
    lastSeenAt: ctx.now,
    dedupeKey: makeDedupeKey(companyLabel, title, location),
    canonicalId: null,
  };
}
