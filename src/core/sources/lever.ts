import { buildQuery } from "../net/allowlist.ts";
import { htmlToText, makeDedupeKey, makeJobId } from "../pipeline/normalize.ts";
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
 * Lever job boards.
 *
 * One request returns the whole board — 434 postings for Shield AI — so there
 * is no pagination and the ETag makes an unchanged board free on the next run.
 *
 * Better data than most: `salaryRange` is the employer's own figure and carries
 * its own interval, and `workplaceType` says onsite, hybrid or remote outright.
 * Neither has to be guessed at, which is why this source can publish pay when
 * Adzuna could not.
 */

interface LeverSalaryRange {
  readonly currency?: string;
  readonly interval?: string;
  readonly min?: number;
  readonly max?: number;
}

interface LeverPosting {
  readonly id?: string;
  /** Lever calls the job title `text`. */
  readonly text?: string | null;
  readonly descriptionPlain?: string;
  readonly lists?: readonly { readonly text?: string; readonly content?: string }[];
  readonly descriptionBodyPlain?: string;
  readonly additionalPlain?: string;
  readonly createdAt?: number;
  readonly hostedUrl?: string;
  readonly applyUrl?: string;
  readonly workplaceType?: string | null;
  readonly salaryRange?: LeverSalaryRange;
  readonly categories?: {
    readonly location?: string | null;
    readonly commitment?: string;
    readonly department?: string;
    readonly team?: string;
  };
}

/**
 * Measured across one full board: 333 per-year, 19 per-hour, 1 per-month.
 * Anything unrecognised becomes null rather than a guessed interval — a wrong
 * interval turns $30 an hour into $30 a year on the card.
 */
const INTERVALS: Readonly<Record<string, SalaryInterval>> = {
  "per-year-salary": "year",
  "per-hour-wage": "hour",
  "per-month-salary": "month",
  "per-week-salary": "week",
  "per-day-wage": "day",
};

export function buildLeverUrl(slug: string): string {
  return `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?${buildQuery([
    ["mode", "json"],
  ])}`;
}

export function createLeverSource(slug: string, companyLabel: string): Source {
  const label = `lever:${slug}`;

  return {
    id: "lever",
    label,
    stateKey: label,

    async fetch(
      ctx: FetchContext,
    ): Promise<Omit<SourceFetchResult, "sourceId" | "label" | "error">> {
      const response = await getWithRetry(ctx, buildLeverUrl(slug), label, ctx.state);

      if (response.status === 304) {
        return { jobs: [], notModified: true, newState: ctx.state };
      }
      if (response.status !== 200) {
        throw new HttpStatusError(response.status, label, response.body.slice(0, 200));
      }

      const postings = JSON.parse(response.body) as LeverPosting[];
      const jobs: Job[] = [];
      for (const posting of postings) {
        const job = normalizeLeverPosting(posting, companyLabel, ctx);
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

export function normalizeLeverPosting(
  posting: LeverPosting,
  companyLabel: string,
  ctx: { hasher: FetchContext["hasher"]; now: number },
): Job | null {
  const externalId = posting.id;
  const title = posting.text?.trim();
  if (externalId === undefined || title === undefined || title === "") return null;

  const rawLocation = posting.categories?.location?.trim();
  const location =
    rawLocation === undefined || rawLocation === ""
      ? null
      : normalizeUsLocation(rawLocation);

  // The board says which it is, so this is reporting rather than inferring.
  // Absent stays null: "hybrid" and "onsite" are answers, "" is not.
  const workplace = posting.workplaceType?.toLowerCase();
  const remote =
    workplace === undefined || workplace === ""
      ? location !== null && /\bremote\b/i.test(location)
        ? true
        : null
      : workplace === "remote";

  const range = posting.salaryRange;
  const interval =
    range?.interval === undefined ? null : (INTERVALS[range.interval] ?? null);
  // An amount with no interval we recognise is not publishable: it would be
  // rendered in whatever unit the formatter defaults to.
  const usableSalary = range !== undefined && interval !== null;

  const posted = posting.createdAt;
  const postedValid =
    typeof posted === "number" && Number.isFinite(posted) && posted > 0;

  // NOT descriptionPlain. Measured across one 434-posting board: it already
  // contains descriptionBodyPlain on 402 of them, and it leads with
  // openingPlain — 525 characters of company blurb IDENTICAL on all 434. With
  // a 1,000-character embedding budget that boilerplate would be most of the
  // vector, and every posting on the board would look alike. It is the same
  // collapse stripContentIntro exists to prevent on Greenhouse.
  //
  // `lists` is where the job actually is — the responsibilities and the
  // qualifications, averaging 4,708 characters — and it was being discarded.
  const description = [
    posting.descriptionBodyPlain,
    ...(posting.lists ?? []).map((list) =>
      [list.text ?? "", list.content === undefined ? "" : htmlToText(list.content)]
        .filter((part) => part.trim() !== "")
        .join(" "),
    ),
    posting.additionalPlain,
  ]
    .filter((part): part is string => part !== undefined && part.trim() !== "")
    .join("\n\n");

  return {
    id: makeJobId(ctx.hasher, "lever", externalId),
    source: "lever",
    externalId,
    title,
    company: companyLabel,
    location,
    remote,
    salaryMin: usableSalary ? (range.min ?? null) : null,
    salaryMax: usableSalary ? (range.max ?? null) : null,
    salaryCurrency: usableSalary ? (range.currency ?? null) : null,
    salaryInterval: usableSalary ? interval : null,
    // Every observed posting carries hostedUrl. The fallback is the board host
    // rather than a guessed job path — a link that 404s is worse than a
    // general one, and a fabricated job URL is worse than both.
    url: posting.hostedUrl ?? posting.applyUrl ?? "https://jobs.lever.co/",
    postedAt: postedValid ? posted : null,
    postedAtIsEstimated: !postedValid,
    descriptionText: description,
    raw: JSON.stringify({
      ...posting,
      description: undefined,
      descriptionPlain: undefined,
      descriptionBodyPlain: undefined,
      descriptionBody: undefined,
      additional: undefined,
      additionalPlain: undefined,
    }),
    firstSeenAt: ctx.now,
    lastSeenAt: ctx.now,
    dedupeKey: makeDedupeKey(companyLabel, title, location),
    canonicalId: null,
  };
}
