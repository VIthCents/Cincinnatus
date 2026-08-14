import type { Clock, Hasher, Http, HttpResponse, Reporter } from "../ports.ts";
import type { Job, SourceId } from "../types.ts";
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, MAX_RETRIES } from "../config.ts";
import { redactCredentials } from "../net/redact.ts";

/** ETag / Last-Modified carried between runs. */
export interface ConditionalState {
  readonly etag: string | null;
  readonly lastModified: string | null;
}

export interface FetchContext {
  readonly http: Http;
  readonly clock: Clock;
  readonly hasher: Hasher;
  /** What we stored last run for this source, if anything. */
  readonly state: ConditionalState | null;
  readonly reporter: Reporter;
  /** Read once per run so every job in a run is aged against the same instant. */
  readonly now: number;
}

export interface SourceFetchResult {
  readonly sourceId: SourceId;
  readonly label: string;
  readonly jobs: readonly Job[];
  /** Server answered 304; `jobs` is empty and what we already had is still current. */
  readonly notModified: boolean;
  readonly newState: ConditionalState | null;
  /** Plain-language message, or null. Never a stack trace. */
  readonly error: string | null;
  /**
   * Requests actually issued, for sources whose provider enforces a quota
   * across runs. Omitted by sources with no such limit — a Source is handed no
   * database and cannot count for itself, so the pipeline records this.
   */
  readonly requests?: number;
}

export interface Source {
  readonly id: SourceId;
  /** e.g. "greenhouse:andurilindustries". Shown to the user when it fails. */
  readonly label: string;
  /** Key under which conditional-request state is stored. */
  readonly stateKey: string;
  /** May throw; always call it through {@link runSource}. */
  fetch(
    ctx: FetchContext,
  ): Promise<Omit<SourceFetchResult, "sourceId" | "label" | "error">>;
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/** An HTTP status we are not going to retry and cannot use. */
export class HttpStatusError extends Error {
  readonly status: number;

  constructor(status: number, label: string, bodyPreview: string) {
    super(`${label} returned HTTP ${status}. ${bodyPreview}`);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

/**
 * Turn any thrown value into something a veteran could read.
 *
 * Errors are data (SPEC section 12): they go into the run report and are shown,
 * never swallowed. But "ENOTFOUND boards-api.greenhouse.io" is not a sentence,
 * and the audience for this app should not have to decode one.
 */
export function toPlainMessage(err: unknown, label: string): string {
  if (err instanceof HttpStatusError) {
    if (err.status === 401 || err.status === 403) {
      return `${label} would not accept our key. Check it is correct and still active.`;
    }
    if (err.status === 404) {
      return `${label} does not exist any more. It may have been renamed or closed.`;
    }
    if (err.status === 429) {
      return `${label} asked us to slow down. We will try again on the next search.`;
    }
    if (err.status >= 500) {
      return `${label} is having trouble on their end. We will try again on the next search.`;
    }
    return redactCredentials(`${label} refused the request (error ${err.status}).`);
  }

  const message = err instanceof Error ? err.message : String(err);

  if (/abort|timeout/i.test(message)) {
    return `${label} took too long to answer. We moved on so the rest of the search could finish.`;
  }
  if (
    /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|fetch failed|network/i.test(message)
  ) {
    return `Could not reach ${label}. Check your internet connection.`;
  }
  if (/JSON|Unexpected token/i.test(message)) {
    return `${label} sent something we could not read. Their API may have changed.`;
  }
  // Adzuna's credentials live in its query string, so a raw message can
  // carry them into persisted run history and the on-screen banner.
  return redactCredentials(`${label} failed: ${message}`);
}

// -----------------------------------------------------------------------------
// Fetching
// -----------------------------------------------------------------------------

function isRetryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

/**
 * GET with conditional headers, retries and jittered exponential backoff.
 *
 * Jitter comes from the Clock port rather than Math.random so a test can replay
 * a backoff sequence exactly.
 *
 * `extraHeaders` exists for sources that must authenticate per request —
 * USAJobs needs an authorization key and a registered User-Agent. They are
 * merged over the conditional headers, which never overlap in practice.
 */
export async function getWithRetry(
  ctx: FetchContext,
  url: string,
  label: string,
  conditional: ConditionalState | null,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<HttpResponse> {
  const headers: Record<string, string> = { ...extraHeaders };
  if (conditional?.etag) headers["if-none-match"] = conditional.etag;
  if (conditional?.lastModified)
    headers["if-modified-since"] = conditional.lastModified;

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const exponential = Math.min(
        BACKOFF_BASE_MS * 2 ** (attempt - 1),
        BACKOFF_MAX_MS,
      );
      // Full jitter: uniform in [0, exponential]. Prevents many installs that
      // started together from retrying in lockstep.
      await ctx.clock.sleep(Math.floor(exponential * ctx.clock.random()));
    }

    try {
      const response = await ctx.http.get({ url, headers });

      if (
        response.status === 304 ||
        (response.status >= 200 && response.status < 300)
      ) {
        return response;
      }
      if (isRetryable(response.status)) {
        lastError = new HttpStatusError(response.status, label, "");
        continue;
      }
      throw new HttpStatusError(response.status, label, response.body.slice(0, 200));
    } catch (err) {
      // A non-retryable status is final; anything else is worth another go.
      if (err instanceof HttpStatusError && !isRetryable(err.status)) throw err;
      lastError = err;
    }
  }

  throw lastError ?? new Error(`${label} failed after ${MAX_RETRIES + 1} attempts.`);
}

export function readConditionalState(response: HttpResponse): ConditionalState | null {
  const etag = response.headers["etag"] ?? null;
  const lastModified = response.headers["last-modified"] ?? null;
  if (etag === null && lastModified === null) return null;
  return { etag, lastModified };
}

/**
 * The never-throws boundary.
 *
 * Everything calls sources through here. One board being down, renamed, or
 * rate-limited must never empty the ranked list or abort the run — SPEC section
 * 5 requires runs to survive a single source failing, and the user's experience
 * of that should be "24 of 25 boards answered", not an empty screen.
 */
export async function runSource(
  source: Source,
  ctx: FetchContext,
): Promise<SourceFetchResult> {
  ctx.reporter({ kind: "source_start", source: source.id, label: source.label });

  try {
    const result = await source.fetch(ctx);
    ctx.reporter({
      kind: "source_done",
      source: source.id,
      label: source.label,
      fetched: result.jobs.length,
      notModified: result.notModified,
    });
    return { sourceId: source.id, label: source.label, error: null, ...result };
  } catch (err) {
    const message = toPlainMessage(err, source.label);
    ctx.reporter({
      kind: "source_error",
      source: source.id,
      label: source.label,
      message,
    });
    return {
      sourceId: source.id,
      label: source.label,
      jobs: [],
      notModified: false,
      newState: null,
      error: message,
    };
  }
}
