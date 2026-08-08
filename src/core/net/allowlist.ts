/**
 * The only hosts Cincinnatus may ever contact.
 *
 * This is constraint 1 made mechanical. Every HTTP adapter runs a URL through
 * here before issuing a request and throws otherwise, so "no scraping" is a
 * runtime property rather than a promise in a markdown file. A new source means
 * a line here plus a test — a change a reviewer will notice.
 *
 * Note what is *not* here and never will be: linkedin.com, indeed.com,
 * glassdoor.com, ziprecruiter.com. Also absent are the HTML hosts of the very
 * boards we do use — `job-boards.greenhouse.io` serves rendered pages rather
 * than JSON, and fetching it would be scraping even though the employer is on
 * our watchlist.
 */
export const ALLOWED_HOSTS: readonly string[] = [
  // Keyless ATS job-board JSON APIs.
  "boards-api.greenhouse.io",
  "api.lever.co",
  "api.ashbyhq.com",

  // Federal jobs. Free key; the User-Agent must carry the registered email.
  "data.usajobs.gov",

  // Phase 4. Listed now so the allowlist is reviewed as a single thing.
  "api.adzuna.com",
];

/**
 * Deliberately strict: `https://` then a plain lower-case DNS name, then an
 * optional path with no whitespace.
 *
 * This rejects rather than interprets. No `http://`, no `user:pass@host`, no
 * explicit port, no IP literal, no uppercase, no unicode. We never legitimately
 * need any of those, and each is a known way to smuggle a different host past a
 * naive check — `https://boards-api.greenhouse.io@evil.test/` parses as a
 * request to evil.test, and a suffix test on the raw string would wave it
 * through.
 *
 * Core has no URL parser available: WHATWG `URL` lives in lib.dom, which
 * tsconfig.core.json does not load, because core must also run under Node and
 * in the webview. Matching a narrow shape is both portable and safer here than
 * parsing a broad one.
 */
const URL_SHAPE =
  /^https:\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(\/[^\s]*)?$/;

export class BlockedHostError extends Error {
  readonly host: string;

  constructor(host: string, url: string) {
    super(
      `Refusing to contact "${host}". Cincinnatus may only call the JSON APIs listed ` +
        `in src/core/net/allowlist.ts, and that host is not one of them. If this is a ` +
        `new job source, add it there and record it in docs/DECISIONS.md — but never ` +
        `add a host whose response is an HTML page. (url: ${url})`,
    );
    this.name = "BlockedHostError";
    this.host = host;
  }
}

export class MalformedUrlError extends Error {
  constructor(url: string) {
    super(
      `Refusing to fetch "${url}". Cincinnatus only issues https requests to a plain ` +
        `host name with no credentials, port, or IP literal.`,
    );
    this.name = "MalformedUrlError";
  }
}

/**
 * Throws unless `url` is a well-formed https URL on an allowlisted host.
 *
 * @returns the hostname, so callers need not re-extract it.
 */
export function assertAllowed(url: string): string {
  const match = URL_SHAPE.exec(url);
  if (match === null) throw new MalformedUrlError(url);

  const host = match[1];
  if (host === undefined) throw new MalformedUrlError(url);

  if (!ALLOWED_HOSTS.includes(host)) throw new BlockedHostError(host, url);

  return host;
}

export function isAllowedHost(host: string): boolean {
  return ALLOWED_HOSTS.includes(host);
}

/**
 * Percent-encode a query string. Core cannot use `URLSearchParams` for the same
 * reason it cannot use `URL`.
 */
export function buildQuery(params: readonly (readonly [string, string])[]): string {
  return params
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}
