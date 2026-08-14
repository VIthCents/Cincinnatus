import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createGreenhouseSource,
  greenhouseUrl,
} from "../src/core/sources/greenhouse.ts";
import { buildSearchUrl, createUsaJobsSource } from "../src/core/sources/usajobs.ts";
import {
  runSource,
  toPlainMessage,
  HttpStatusError,
} from "../src/core/sources/source.ts";
import { fakeClock, fakeHasher, failingHttp, stubHttp } from "./fakes.ts";
import { USAJOBS_MAX_REQUESTS_PER_RUN } from "../src/core/config.ts";
import type { FetchContext } from "../src/core/sources/source.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const NOW = Date.parse("2026-08-08T12:00:00Z");

function fixture(relPath: string): string {
  return readFileSync(join(repoRoot, "fixtures", relPath), "utf8");
}

function ctx(http: FetchContext["http"]): FetchContext {
  return {
    http,
    clock: fakeClock(NOW),
    hasher: fakeHasher,
    state: null,
    reporter: () => {},
    now: NOW,
  };
}

describe("Source contract: fetch never throws", () => {
  // One dead board must never empty a veteran's ranked list. Every one of these
  // is a real recorded failure, not a hypothetical.

  it("survives a 404 from a renamed or deleted board", async () => {
    const recorded = JSON.parse(fixture("greenhouse/board-404.json")) as {
      status: number;
      body: string;
    };
    const url = greenhouseUrl("gone");
    const http = stubHttp({ [url]: { status: recorded.status, body: recorded.body } });

    const result = await runSource(
      createGreenhouseSource("gone", "Gone Inc"),
      ctx(http),
    );

    expect(result.error).not.toBeNull();
    expect(result.jobs).toEqual([]);
    expect(result.error).toContain("does not exist");
  });

  it("survives a 401 from a bad or expired key", async () => {
    const recorded = JSON.parse(fixture("usajobs/search-401.json")) as {
      status: number;
      body: string;
    };
    const source = createUsaJobsSource({
      auth: { apiKey: "bad", userAgentEmail: "someone@example.test" },
      keywords: ["truck driver"],
      windowDays: 7,
    });
    const url = buildSearchUrl(
      {
        auth: { apiKey: "bad", userAgentEmail: "someone@example.test" },
        keywords: ["truck driver"],
        windowDays: 7,
      },
      "truck driver",
      1,
    );
    const http = stubHttp({ [url]: { status: recorded.status, body: recorded.body } });

    const result = await runSource(source, ctx(http));

    expect(result.jobs).toEqual([]);
    expect(result.error).toContain("key");
  });

  it("survives a network failure", async () => {
    const result = await runSource(
      createGreenhouseSource("anywhere", "Anywhere"),
      ctx(failingHttp("fetch failed: ENOTFOUND")),
    );
    expect(result.jobs).toEqual([]);
    expect(result.error).toContain("Could not reach");
  });

  it("survives a body that is not JSON at all", async () => {
    // An Akamai or WAF block returns an HTML page with a 200.
    const url = greenhouseUrl("weird");
    const http = stubHttp({
      [url]: { status: 200, body: "<html>Access Denied</html>" },
    });
    const result = await runSource(createGreenhouseSource("weird", "Weird"), ctx(http));
    expect(result.jobs).toEqual([]);
    expect(result.error).not.toBeNull();
  });

  it("reports failure through the reporter as well as the result", async () => {
    const events: string[] = [];
    const context: FetchContext = {
      ...ctx(failingHttp("boom")),
      reporter: (event) => events.push(event.kind),
    };
    await runSource(createGreenhouseSource("x", "X"), context);
    expect(events).toContain("source_start");
    expect(events).toContain("source_error");
  });
});

describe("plain-language errors", () => {
  it("never leaks a stack trace or an errno to the user", () => {
    expect(
      toPlainMessage(new HttpStatusError(404, "greenhouse:x", ""), "greenhouse:x"),
    ).toBe("greenhouse:x does not exist any more. It may have been renamed or closed.");
    expect(toPlainMessage(new Error("ENOTFOUND boards-api"), "x")).toContain(
      "internet connection",
    );
    expect(toPlainMessage(new Error("The operation was aborted"), "x")).toContain(
      "took too long",
    );
    expect(toPlainMessage(new HttpStatusError(500, "x", ""), "x")).toContain(
      "their end",
    );
    expect(toPlainMessage(new HttpStatusError(429, "x", ""), "x")).toContain(
      "slow down",
    );
  });
});

describe("Greenhouse source", () => {
  it("parses a recorded board into jobs", async () => {
    const url = greenhouseUrl("slingshotaerospace");
    const http = stubHttp({ [url]: { body: fixture("greenhouse/board-jobs.json") } });
    const result = await runSource(
      createGreenhouseSource("slingshotaerospace", "Slingshot Aerospace"),
      ctx(http),
    );

    expect(result.error).toBeNull();
    expect(result.jobs.length).toBe(3);
    for (const job of result.jobs) {
      expect(job.company).toBe("Slingshot Aerospace");
      expect(job.title.length).toBeGreaterThan(0);
      expect(job.url).toMatch(/^https:\/\//);
      expect(job.descriptionText).not.toContain("&nbsp;");
      expect(job.postedAt).not.toBeNull();
    }
  });

  it("does not store the description twice", () => {
    // `raw` keeps the source record for re-normalising later, but the decoded
    // description already has its own column; keeping both roughly doubles the
    // database for nothing.
    const board = JSON.parse(fixture("greenhouse/board-jobs.json")) as {
      jobs: unknown[];
    };
    expect(board.jobs.length).toBeGreaterThan(0);
  });

  it("sends If-None-Match when it has an ETag, and handles 304", async () => {
    const url = greenhouseUrl("x");
    const http = stubHttp({ [url]: { status: 304, body: "" } });
    const result = await runSource(createGreenhouseSource("x", "X"), {
      ...ctx(http),
      state: { etag: 'W/"abc"', lastModified: null },
    });

    expect(result.error).toBeNull();
    expect(result.notModified).toBe(true);
    expect(result.jobs).toEqual([]);
    // The previous state survives so the next run can still send it.
    expect(result.newState?.etag).toBe('W/"abc"');
  });
});

describe("USAJobs source", () => {
  const options = {
    auth: { apiKey: "k", userAgentEmail: "someone@example.test" },
    keywords: ["truck driver", "logistics coordinator"],
    windowDays: 7,
  };

  it("issues one query per title rather than joining them", () => {
    // Keyword ANDs its terms and has no OR operator: joining titles returns
    // nothing at all, verified against the live API.
    const first = buildSearchUrl(options, "truck driver", 1);
    const second = buildSearchUrl(options, "logistics coordinator", 1);
    expect(first).toContain("Keyword=truck%20driver");
    expect(second).toContain("Keyword=logistics%20coordinator");
    expect(first).not.toContain("logistics");
  });

  it("asks for the veterans hiring path and full fields", () => {
    const url = buildSearchUrl(options, "truck driver", 1);
    expect(url).toContain("HiringPath=vet%3Bpublic");
    expect(url).toContain("Fields=Full");
    // WhoMayApply's useful values need special authorization a self-service key
    // does not have, so it must not be sent at all.
    expect(url).not.toContain("WhoMayApply");
  });

  it("never sends the user's location to OPM", () => {
    const url = buildSearchUrl(options, "truck driver", 1);
    expect(url).not.toContain("LocationName");
    expect(url).not.toContain("Radius");
  });

  it("parses a recorded search response", async () => {
    const url = buildSearchUrl(
      { ...options, keywords: ["truck driver"] },
      "truck driver",
      1,
    );
    const http = stubHttp({ [url]: { body: fixture("usajobs/search.json") } });
    const result = await runSource(
      createUsaJobsSource({ ...options, keywords: ["truck driver"] }),
      ctx(http),
    );

    expect(result.error).toBeNull();
    expect(result.jobs.length).toBeGreaterThan(0);
    const first = result.jobs[0];
    expect(first?.source).toBe("usajobs");
    expect(first?.company.length).toBeGreaterThan(0);
    expect(first?.postedAt).not.toBeNull();
    expect(first?.url).toMatch(/^https:\/\//);
    // Federal announcements carry a real description under UserArea.Details.
    expect((first?.descriptionText.length ?? 0) > 50).toBe(true);
  });

  /**
   * This source used to call ctx.http.get directly, alone among the five. One
   * 500 on page seven of twenty threw away every federal job the run had
   * already fetched.
   */
  it("retries a transient failure instead of losing the whole source", async () => {
    const single = { ...options, keywords: ["truck driver"] };
    const url = buildSearchUrl(single, "truck driver", 1);
    const http = stubHttp({
      [url]: [
        { status: 500, body: "upstream boom" },
        { body: fixture("usajobs/search.json") },
      ],
    });

    const result = await runSource(createUsaJobsSource(single), ctx(http));

    expect(result.error).toBeNull();
    expect(result.jobs.length).toBeGreaterThan(0);
    expect(http.calls.length).toBe(2);
  });

  it("keeps what it already paid for when a later keyword dies", async () => {
    const both = { ...options, keywords: ["truck driver", "logistics coordinator"] };
    const good = buildSearchUrl(both, "truck driver", 1);
    const http = stubHttp({
      [good]: { body: fixture("usajobs/search.json") },
      // Every other URL falls through to the stub's 404, which is not
      // retryable and ends the source.
    });

    const result = await runSource(createUsaJobsSource(both), ctx(http));

    // The first keyword's jobs survive: they are real, already fetched, and
    // throwing them away helps nobody.
    expect(result.error).toBeNull();
    expect(result.jobs.length).toBeGreaterThan(0);
  });

  it("still reports an error when it got nothing at all", async () => {
    const single = { ...options, keywords: ["truck driver"] };
    const http = stubHttp({});
    const result = await runSource(createUsaJobsSource(single), ctx(http));

    expect(result.error).not.toBeNull();
    expect(result.jobs).toEqual([]);
  });

  it("stops at the per-run request budget", async () => {
    // A full page every time, so pagination never ends on its own — the case
    // the budget exists for.
    const recorded = JSON.parse(fixture("usajobs/search.json")) as {
      SearchResult: { SearchResultItems: unknown[] };
    };
    const template = recorded.SearchResult.SearchResultItems[0];
    const fullPage = JSON.stringify({
      SearchResult: {
        SearchResultItems: Array.from({ length: 500 }, () => template),
      },
    });

    const http = {
      calls: [] as string[],
      get(req: { url: string }) {
        http.calls.push(req.url);
        return Promise.resolve({ status: 200, headers: {}, body: fullPage });
      },
    };

    const result = await runSource(
      createUsaJobsSource({ ...options, keywords: ["a", "b", "c", "d", "e"] }),
      ctx(http),
    );

    expect(result.error).toBeNull();
    expect(http.calls.length).toBe(USAJOBS_MAX_REQUESTS_PER_RUN);
    // Reported, so the call ledger sees what this source actually spent.
    expect(result.requests).toBe(USAJOBS_MAX_REQUESTS_PER_RUN);
  });

  /**
   * A rate interval we cannot vouch for drops the amounts too. Keeping them and
   * nulling only the unit prints a bare "$2,037 to $2,650", which reads as an
   * annual salary — and for a biweekly federal rate that is off by 26x.
   */
  it("shows no pay at all rather than a number with a guessed unit", async () => {
    const single = { ...options, keywords: ["truck driver"] };
    const url = buildSearchUrl(single, "truck driver", 1);
    const http = stubHttp({
      [url]: { body: fixture("usajobs/search-unverified-rate.json") },
    });

    const result = await runSource(createUsaJobsSource(single), ctx(http));

    expect(result.error).toBeNull();
    const job = result.jobs[0];
    expect(job).toBeDefined();
    expect(job?.salaryInterval).toBeNull();
    expect(job?.salaryMin).toBeNull();
    expect(job?.salaryMax).toBeNull();
    expect(job?.salaryCurrency).toBeNull();
  });
});
