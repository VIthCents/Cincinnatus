import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { assertAllowed } from "../core/net/allowlist.ts";
import {
  DEFAULT_REQUEST_DELAY_MS,
  REQUEST_DELAY_MS,
  REQUEST_TIMEOUT_MS,
  USER_AGENT,
} from "../core/config.ts";
import type { Http, HttpRequest, HttpResponse } from "../core/ports.ts";

/**
 * Webview Http adapter — the twin of src/node/http.ts with plugin-http as the
 * transport. Same allowlist call, same per-host pacing, so the app is exactly
 * as polite to the job boards as the harness is. Requests execute on the Rust
 * side, where the capability file enforces the same host list a second time.
 */

const lastRequestAt = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pace(host: string): Promise<void> {
  const gap = REQUEST_DELAY_MS[host] ?? DEFAULT_REQUEST_DELAY_MS;
  const previous = lastRequestAt.get(host);
  const now = Date.now();
  if (previous !== undefined) {
    const wait = previous + gap - now;
    if (wait > 0) await sleep(wait);
  }
  lastRequestAt.set(host, Date.now());
}

export const tauriHttp: Http = {
  async get(req: HttpRequest): Promise<HttpResponse> {
    // Constraint 1's enforcement point, same call as the Node adapter.
    const host = assertAllowed(req.url);

    await pace(host);

    const response = await tauriFetch(req.url, {
      method: "GET",
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/json",
        ...req.headers,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(req.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });

    const body = response.status === 304 ? "" : await response.text();

    return { status: response.status, headers: responseHeaders, body };
  },
};
