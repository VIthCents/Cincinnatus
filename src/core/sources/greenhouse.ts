import type { Job } from "../types.ts";
import {
  greenhouseContentToText,
  makeDedupeKey,
  makeJobId,
} from "../pipeline/normalize.ts";
import {
  getWithRetry,
  readConditionalState,
  type FetchContext,
  type Source,
  type SourceFetchResult,
} from "./source.ts";

/**
 * Greenhouse job-board API. Keyless, one request per board.
 *
 * `boards-api.greenhouse.io` is the only documented JSON host.
 * `job-boards.greenhouse.io` is the *rendered HTML* host and returns 404 for
 * /v1/ paths — it is deliberately absent from the allowlist.
 */

const HOST = "https://boards-api.greenhouse.io";

interface GreenhouseJob {
  id: number;
  title?: string;
  updated_at?: string;
  first_published?: string;
  absolute_url?: string;
  content?: string;
  location?: { name?: string } | null;
  departments?: { name?: string }[];
  offices?: { name?: string }[];
}

interface GreenhouseResponse {
  jobs?: GreenhouseJob[];
}

function parseTimestamp(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function greenhouseUrl(slug: string): string {
  return `${HOST}/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
}

export function greenhouseBoardUrl(slug: string): string {
  return `${HOST}/v1/boards/${encodeURIComponent(slug)}`;
}

export function normalizeGreenhouseJob(
  raw: GreenhouseJob,
  companyLabel: string,
  ctx: { hasher: FetchContext["hasher"]; now: number },
): Job | null {
  if (typeof raw.id !== "number" || raw.title === undefined) return null;

  const externalId = String(raw.id);
  const location = raw.location?.name?.trim() ?? null;

  // first_published, NOT updated_at. An old posting that was edited yesterday
  // would otherwise look brand new and outrank genuinely fresh jobs — which is
  // exactly the bug the freshness decay is supposed to prevent.
  const postedAt = parseTimestamp(raw.first_published);

  // Greenhouse has no remote field. If the location literally says "Remote",
  // that is the source telling us; otherwise we do not know, and null says so
  // rather than asserting the job is on-site (constraint 4).
  const remote = location !== null && /\bremote\b/i.test(location) ? true : null;

  const descriptionText =
    raw.content === undefined ? "" : greenhouseContentToText(raw.content);

  // The description is dropped from `raw` — it is already stored decoded in its
  // own column, and keeping both roughly doubles the database for no gain.
  const { content: _dropped, ...rawWithoutContent } = raw;

  return {
    id: makeJobId(ctx.hasher, "greenhouse", externalId),
    source: "greenhouse",
    externalId,
    title: raw.title.trim(),
    company: companyLabel,
    location,
    remote,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryInterval: null,
    // absolute_url points at the HTML posting. That is correct: it is what the
    // human opens to apply. We never fetch it.
    url: raw.absolute_url ?? `https://boards.greenhouse.io/${externalId}`,
    postedAt,
    postedAtIsEstimated: postedAt === null,
    descriptionText,
    raw: JSON.stringify(rawWithoutContent),
    firstSeenAt: ctx.now,
    lastSeenAt: ctx.now,
    dedupeKey: makeDedupeKey(companyLabel, raw.title, location),
    canonicalId: null,
  };
}

export function createGreenhouseSource(slug: string, companyLabel: string): Source {
  const label = `greenhouse:${slug}`;

  return {
    id: "greenhouse",
    label,
    stateKey: label,

    async fetch(
      ctx: FetchContext,
    ): Promise<Omit<SourceFetchResult, "sourceId" | "label" | "error">> {
      const response = await getWithRetry(ctx, greenhouseUrl(slug), label, ctx.state);

      if (response.status === 304) {
        return { jobs: [], notModified: true, newState: ctx.state };
      }

      const parsed = JSON.parse(response.body) as GreenhouseResponse;
      const jobs: Job[] = [];
      for (const raw of parsed.jobs ?? []) {
        const job = normalizeGreenhouseJob(raw, companyLabel, ctx);
        if (job !== null) jobs.push(job);
      }

      return { jobs, notModified: false, newState: readConditionalState(response) };
    },
  };
}

/**
 * Confirm a slug belongs to the company we think it does.
 *
 * Status-and-count is not enough. Several plausible slugs return HTTP 200 with
 * real postings but belong to an entirely different business —
 * `greenhouse/archer` is a veterinary clinic, `ashby/flock` is a UK motor
 * insurer. Only the board's own `name` catches those.
 */
export async function fetchGreenhouseBoardName(
  ctx: FetchContext,
  slug: string,
): Promise<string | null> {
  const response = await getWithRetry(
    ctx,
    greenhouseBoardUrl(slug),
    `greenhouse:${slug}`,
    null,
  );
  if (response.status !== 200) return null;
  const parsed = JSON.parse(response.body) as { name?: string };
  return parsed.name ?? null;
}
