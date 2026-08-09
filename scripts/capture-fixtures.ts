#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeHttp } from "../src/node/http.ts";

/**
 * Record real API responses as test fixtures.
 *
 * "Fixtures are truth" (SPEC section 12): record once, test forever, never let
 * a test touch the network. Run this only when a contract is believed to have
 * changed, and read the diff before committing it — a fixture changing is the
 * signal that an API changed under us.
 *
 *   node scripts/capture-fixtures.ts
 *
 * USAJobs capture needs USAJOBS_API_KEY and USAJOBS_USER_AGENT. Without them it
 * is skipped and the existing federal fixtures are left alone.
 *
 * Responses are trimmed to a handful of records: these are read by humans in
 * review, and a 4 MB fixture is not.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(repoRoot, "fixtures");

function save(relPath: string, value: unknown): void {
  const full = join(fixtures, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  process.stdout.write(`  wrote fixtures/${relPath.replace(/\\/g, "/")}\n`);
}

async function captureGreenhouse(): Promise<void> {
  process.stdout.write("Greenhouse:\n");

  // A deliberately tiny real board, so the fixture stays readable.
  const jobs = await nodeHttp.get({
    url: "https://boards-api.greenhouse.io/v1/boards/slingshotaerospace/jobs?content=true",
  });
  const parsed = JSON.parse(jobs.body) as { jobs: unknown[] };
  save("greenhouse/board-jobs.json", { jobs: parsed.jobs.slice(0, 3) });

  // A second, larger board. Between this, the board above and the federal
  // fixture the offline run has enough jobs (35+) for ranking and dedupe to be
  // exercised rather than merely executed.
  const second = await nodeHttp.get({
    url: "https://boards-api.greenhouse.io/v1/boards/hawkeye360/jobs?content=true",
  });
  const secondParsed = JSON.parse(second.body) as { jobs: unknown[] };
  save("greenhouse/board-jobs-2.json", { jobs: secondParsed.jobs.slice(0, 12) });

  // A third board, chosen because it does NOT use a content-intro blurb. The
  // stripper has to be a no-op here, and only a fixture without one proves it.
  const third = await nodeHttp.get({
    url: "https://boards-api.greenhouse.io/v1/boards/epirus/jobs?content=true",
  });
  const thirdParsed = JSON.parse(third.body) as { jobs: unknown[] };
  save("greenhouse/board-jobs-3.json", { jobs: thirdParsed.jobs.slice(0, 12) });

  const board = await nodeHttp.get({
    url: "https://boards-api.greenhouse.io/v1/boards/slingshotaerospace",
  });
  save("greenhouse/board-meta.json", JSON.parse(board.body));

  // One posting from a board that uses a content-intro blurb.
  //
  // Every one of Anduril's 2,187 postings carries the same intro paragraph. At
  // a 1,000-character embedding window that blurb can dominate the vector for
  // every job on the board, so stripping it is what keeps within-board ranking
  // from collapsing. This fixture is the evidence that it is still there.
  const withIntro = await nodeHttp.get({
    url: "https://boards-api.greenhouse.io/v1/boards/andurilindustries/jobs/4802172007?content=true",
  });
  save("greenhouse/job-with-content-intro.json", JSON.parse(withIntro.body));

  // A board that does not exist. The "fetch never throws" contract has to
  // survive this, and it cannot be tested without a recording of it.
  const missing = await nodeHttp.get({
    url: "https://boards-api.greenhouse.io/v1/boards/definitely-not-a-real-board-xyz/jobs",
  });
  save("greenhouse/board-404.json", {
    status: missing.status,
    body: missing.body.slice(0, 500),
  });
}

async function captureUsaJobs(): Promise<void> {
  const key = process.env["USAJOBS_API_KEY"];
  const agent = process.env["USAJOBS_USER_AGENT"];

  process.stdout.write("USAJobs:\n");
  if (key === undefined || key === "" || agent === undefined || agent === "") {
    process.stdout.write("  skipped (USAJOBS_API_KEY / USAJOBS_USER_AGENT not set)\n");
    return;
  }

  const headers = {
    host: "data.usajobs.gov",
    "user-agent": agent,
    "authorization-key": key,
  };

  const search = await nodeHttp.get({
    url:
      "https://data.usajobs.gov/api/search?Keyword=truck%20driver&ResultsPerPage=20" +
      "&HiringPath=vet%3Bpublic&Fields=Full&SortField=PublicationStartDate&SortDirection=Desc",
    headers,
  });
  const body = JSON.parse(search.body) as {
    SearchResult?: { SearchResultItems?: unknown[] };
  };
  const items = (body.SearchResult?.SearchResultItems ?? []).slice(0, 20);
  save("usajobs/search.json", {
    SearchResult: {
      SearchResultCount: items.length,
      SearchResultItems: items,
    },
  });

  // Wrong key -> 401 application/problem+json. Recorded so the plain-language
  // error path can be tested without a live bad request.
  const unauthorized = await nodeHttp.get({
    url: "https://data.usajobs.gov/api/search?Keyword=truck%20driver&ResultsPerPage=1",
    headers: { ...headers, "authorization-key": "NOT-A-REAL-KEY" },
  });
  save("usajobs/search-401.json", {
    status: unauthorized.status,
    body: unauthorized.body.slice(0, 500),
  });
}

async function main(): Promise<void> {
  await captureGreenhouse();
  await captureUsaJobs();
  process.stdout.write("\nDone. Read the diff before committing.\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
