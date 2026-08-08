import { setTimeout as delay } from "node:timers/promises";
import { assertAllowed } from "../core/net/allowlist.ts";
import {
  DEFAULT_REQUEST_DELAY_MS,
  REQUEST_DELAY_MS,
  REQUEST_TIMEOUT_MS,
  USER_AGENT,
} from "../core/config.ts";
import type { Http, HttpRequest, HttpResponse } from "../core/ports.ts";

/**
 * Node HTTP adapter: allowlist enforcement plus per-host pacing.
 *
 * Pacing is per hostname and applies across every source, so fifteen Greenhouse
 * boards are fetched politely in sequence rather than in a burst. Lever's
 * robots.txt declares Crawl-delay: 1 and we honour it; the others are
 * conservative by choice, because many installs will poll the same handful of
 * boards and the load lands on companies who published these APIs as a courtesy.
 */

/** Last request time per hostname, for spacing. */
const lastRequestAt = new Map<string, number>();

async function pace(host: string): Promise<void> {
  const gap = REQUEST_DELAY_MS[host] ?? DEFAULT_REQUEST_DELAY_MS;
  const previous = lastRequestAt.get(host);
  const now = Date.now();
  if (previous !== undefined) {
    const wait = previous + gap - now;
    if (wait > 0) await delay(wait);
  }
  lastRequestAt.set(host, Date.now());
}

export const nodeHttp: Http = {
  async get(req: HttpRequest): Promise<HttpResponse> {
    // Throws BlockedHostError for anything not in the allowlist, and
    // MalformedUrlError for anything that is not a plain https URL. This is the
    // enforcement point for constraint 1 — not a convention, a call.
    const host = assertAllowed(req.url);

    await pace(host);

    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      accept: "application/json",
      ...req.headers,
    };

    // Deliberately NOT setting accept-encoding. undici negotiates gzip and
    // decompresses transparently; setting the header by hand can bypass the
    // automatic decompression path and hand back binary, which then fails in
    // JSON.parse looking like an API change.

    const response = await fetch(req.url, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(req.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });

    // 304 has no body, and calling .text() on it is fine but pointless.
    const body = response.status === 304 ? "" : await response.text();

    return { status: response.status, headers: responseHeaders, body };
  },
};
