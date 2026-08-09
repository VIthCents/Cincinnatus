#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { USAJOBS_DEFAULT_WINDOW_DAYS } from "../src/core/config.ts";
import { parseProfile } from "../src/core/profile/parse.ts";
import { buildSearchTerms } from "../src/core/pipeline/queries.ts";
import { runPipeline } from "../src/core/pipeline/run.ts";
import {
  createGreenhouseSource,
  fetchGreenhouseBoardName,
} from "../src/core/sources/greenhouse.ts";
import { createUsaJobsSource } from "../src/core/sources/usajobs.ts";
import type { Source } from "../src/core/sources/source.ts";
import type { ProgressEvent, Reporter } from "../src/core/ports.ts";
import type { RankedJob, WatchlistEntry } from "../src/core/types.ts";

import { NodeDb } from "../src/node/db.ts";
import { nodeClock, nodeHasher } from "../src/node/clock.ts";
import { nodeHttp } from "../src/node/http.ts";
import { createNodeEmbedder } from "../src/node/embedder.ts";
import { createCapturingHttp, createFixtureHttp } from "../src/node/fixtureHttp.ts";

/**
 * Headless CLI for the job pipeline (SPEC section 9, Phase 1).
 *
 * This exists so the entire pipeline can be exercised and judged before any UI
 * is written. It is also what keeps src/core honest: if anything in core
 * reached for Tauri or the DOM, this would stop running.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// -----------------------------------------------------------------------------
// Output helpers
// -----------------------------------------------------------------------------

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function money(
  min: number | null,
  max: number | null,
  interval: string | null,
): string {
  if (min === null && max === null) return "";
  const fmt = (n: number): string => `$${n.toLocaleString("en-US")}`;
  const range =
    min !== null && max !== null
      ? `${fmt(min)}–${fmt(max)}`
      : fmt((min ?? max) as number);
  return interval === null ? range : `${range}/${interval}`;
}

function ageLabel(days: number): string {
  const whole = Math.round(days);
  if (whole <= 0) return "today";
  if (whole === 1) return "1 day ago";
  return `${whole} days ago`;
}

function matchLabel(fit: number): string {
  if (fit >= 55) return "Strong match";
  if (fit >= 40) return "Good match";
  if (fit >= 25) return "Possible match";
  return "Weak match";
}

function printRanked(ranked: readonly RankedJob[], top: number): void {
  out();
  out(`Top ${Math.min(top, ranked.length)} of ${ranked.length} jobs`);
  out("=".repeat(72));

  ranked.slice(0, top).forEach((r, i) => {
    const salary = money(r.job.salaryMin, r.job.salaryMax, r.job.salaryInterval);
    out();
    out(`${String(i + 1).padStart(2)}. ${r.job.title}`);
    out(`    ${r.job.company}${r.job.location === null ? "" : ` — ${r.job.location}`}`);
    out(
      `    ${matchLabel(r.fitScore)} (fit ${r.fitScore.toFixed(1)}) · posted ${ageLabel(r.ageDays)}` +
        `${r.job.postedAtIsEstimated ? " (estimated)" : ""} · score ${r.finalScore.toFixed(2)}` +
        `${salary === "" ? "" : ` · ${salary}`}`,
    );
    out(`    ${r.job.url}`);
  });
}

// -----------------------------------------------------------------------------
// Watchlist
// -----------------------------------------------------------------------------

interface WatchlistFile {
  readonly boards: readonly {
    ats: WatchlistEntry["ats"];
    slug: string;
    company_label: string;
    board_name?: string;
    source: WatchlistEntry["source"];
    sector?: string;
    note?: string;
  }[];
}

export function loadWatchlist(): WatchlistEntry[] {
  const path = join(repoRoot, "data", "starter-watchlist.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as WatchlistFile;
  return parsed.boards.map((b) => ({
    ats: b.ats,
    slug: b.slug,
    companyLabel: b.company_label,
    boardName: b.board_name ?? null,
    source: b.source,
    sector: b.sector ?? null,
    note: b.note ?? null,
  }));
}

/**
 * Confirm every starter board still resolves AND still belongs to the company
 * we claim. The name check is the point: several plausible slugs return 200
 * with real jobs but are an entirely different business.
 */
async function verifyWatchlist(): Promise<number> {
  const entries = loadWatchlist();
  const ctx = {
    http: nodeHttp,
    clock: nodeClock,
    hasher: nodeHasher,
    state: null,
    reporter: () => {},
    now: nodeClock.now(),
  };

  let failures = 0;
  out(`Checking ${entries.length} boards...`);
  out();

  for (const entry of entries) {
    if (entry.ats !== "greenhouse") {
      // Lever and Ashby clients arrive in Phase 4; their slugs are recorded but
      // not yet checkable through a client that does not exist.
      out(
        `  ?  ${entry.ats}:${entry.slug} — ${entry.companyLabel} (not checked until Phase 4)`,
      );
      continue;
    }
    try {
      const name = await fetchGreenhouseBoardName(ctx, entry.slug);
      if (name === null) {
        out(`  ✗  ${entry.ats}:${entry.slug} — no board name returned`);
        failures++;
        continue;
      }
      // Exact match against the name recorded when the slug was verified, not
      // a fuzzy comparison with our display label. A board that has been sold,
      // renamed, or reassigned should fail loudly rather than pass on a
      // substring — that is the whole point of the second signal.
      if (entry.boardName === null) {
        out(
          `  ?  ${entry.ats}:${entry.slug} — board says "${name}", nothing recorded to compare against`,
        );
        failures++;
      } else if (name === entry.boardName) {
        out(`  ok ${entry.ats}:${entry.slug} — ${name}`);
      } else {
        out(
          `  ✗  ${entry.ats}:${entry.slug} — recorded "${entry.boardName}", board now says "${name}"`,
        );
        failures++;
      }
    } catch (err) {
      out(
        `  ✗  ${entry.ats}:${entry.slug} — ${err instanceof Error ? err.message : String(err)}`,
      );
      failures++;
    }
  }

  out();
  out(
    failures === 0
      ? "All checked boards look right."
      : `${failures} board(s) need attention.`,
  );
  return failures === 0 ? 0 : 1;
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      profile: { type: "string" },
      db: { type: "string" },
      top: { type: "string", default: "25" },
      "max-embed": { type: "string" },
      "usajobs-days": { type: "string" },
      offline: { type: "boolean", default: false },
      capture: { type: "boolean", default: false },
      "verify-watchlist": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help === true) {
    out("pnpm harness --profile fixtures/profile.sample.json");
    out();
    out("  --profile <path>      profile JSON (required unless --verify-watchlist)");
    out("  --db <path>           SQLite file (default .data/harness.db)");
    out("  --top <n>             how many jobs to print (default 25)");
    out("  --max-embed <n>       cap new embeddings; for fast iteration only");
    out("  --usajobs-days <n>    how far back to search federal jobs (default 7)");
    out("  --capture             run live and record every response to fixtures/http/");
    out("  --offline             replay what --capture recorded; no network at all");
    out("                        (run --capture once first; the recordings are");
    out("                         local and gitignored, they can be ~30 MB)");
    out("  --verify-watchlist    check every starter board still resolves");
    return 0;
  }

  if (values["verify-watchlist"] === true) return verifyWatchlist();

  if (values.profile === undefined) {
    out("Which profile? Try: pnpm harness --profile fixtures/profile.sample.json");
    return 2;
  }

  // --- profile -------------------------------------------------------------

  const profilePath = join(repoRoot, values.profile);
  if (!existsSync(profilePath)) {
    out(`No profile file at ${values.profile}`);
    return 2;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(profilePath, "utf8"));
  } catch (err) {
    out(
      `${values.profile} is not valid JSON. ${err instanceof Error ? err.message : ""}`,
    );
    return 2;
  }

  const parsed = parseProfile(raw);
  if (!parsed.ok) {
    out(`There are problems with ${values.profile}:`);
    for (const message of parsed.errors) out(`  - ${message}`);
    return 2;
  }
  const profile = parsed.value;

  // --- wiring --------------------------------------------------------------

  const dbPath = join(repoRoot, values.db ?? join(".data", "harness.db"));
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new NodeDb(dbPath);

  const fixtureDir = join(repoRoot, "fixtures", "http");
  const http =
    values.offline === true
      ? createFixtureHttp(fixtureDir)
      : values.capture === true
        ? createCapturingHttp(nodeHttp, fixtureDir)
        : nodeHttp;

  const reporter: Reporter = (event: ProgressEvent) => {
    switch (event.kind) {
      case "source_start":
        process.stdout.write(`  ${event.label} ... `);
        break;
      case "source_done":
        out(event.notModified ? "unchanged" : `${event.fetched} jobs`);
        break;
      case "source_error":
        out(`could not check`);
        out(`      ${event.message}`);
        break;
      case "embed_progress":
        // Rewritten in place so a long run shows movement without scrolling.
        process.stdout.write(
          `\r  matching jobs to your profile: ${event.done}/${event.total}`,
        );
        if (event.done >= event.total) out();
        break;
      case "note":
        out(`  ${event.message}`);
        break;
    }
  };

  // --- sources -------------------------------------------------------------

  const watchlist = loadWatchlist();
  const sources: Source[] = watchlist
    .filter((entry) => entry.ats === "greenhouse")
    .map((entry) => createGreenhouseSource(entry.slug, entry.companyLabel));

  const usaKey = process.env["USAJOBS_API_KEY"];
  const usaAgent = process.env["USAJOBS_USER_AGENT"];
  const terms = buildSearchTerms(profile);

  if (
    usaKey !== undefined &&
    usaKey !== "" &&
    usaAgent !== undefined &&
    usaAgent !== ""
  ) {
    sources.push(
      createUsaJobsSource({
        auth: { apiKey: usaKey, userAgentEmail: usaAgent },
        // Searched one at a time and unioned by the client — Keyword ANDs its
        // terms, so passing them joined returns nothing.
        keywords: terms.titles,
        windowDays: Number(values["usajobs-days"] ?? USAJOBS_DEFAULT_WINDOW_DAYS),
      }),
    );
  } else {
    out(
      "Federal jobs are turned off. Set USAJOBS_API_KEY and USAJOBS_USER_AGENT to include them.",
    );
  }

  // --- run -----------------------------------------------------------------

  out();
  out(
    `Searching ${sources.length} places for jobs like "${terms.titles.slice(0, 3).join('", "')}"...`,
  );
  out();

  const embedder = await createNodeEmbedder({
    cacheDir: join(repoRoot, ".models"),
    onFirstLoad: (message) => out(`  ${message}`),
  });

  const maxEmbedRaw = values["max-embed"];
  const { report, ranked } = await runPipeline({
    db,
    http,
    clock: nodeClock,
    hasher: nodeHasher,
    embedder,
    reporter,
    profile,
    sources,
    maxEmbed: maxEmbedRaw === undefined ? null : Number(maxEmbedRaw),
  });

  // --- report --------------------------------------------------------------

  const failed = report.sources.filter((s) => s.error !== null);

  out();
  out(
    `Checked ${report.sources.length} places in ${((report.finishedAt - report.startedAt) / 1000).toFixed(1)}s. ` +
      `Found ${report.jobsSeen} jobs (${report.jobsNew} new), ` +
      `collapsed ${report.duplicatesCollapsed} duplicates, matched ${report.embedded}.`,
  );

  if (failed.length > 0) {
    out(`${failed.length} place(s) could not be checked this time:`);
    for (const source of failed) out(`  - ${source.error}`);
  }

  if (report.fit !== null) {
    // If min and max are within a point or two, final_score is really just
    // measuring recency and the ranking is not discriminating. Print it so that
    // is visible rather than assumed.
    out(
      `Match scores ranged ${report.fit.min.toFixed(1)} to ${report.fit.max.toFixed(1)} (middle ${report.fit.median.toFixed(1)}).`,
    );
  }

  if (report.widenedBeyondRadius) {
    out(
      `Only ${report.reachable} of ${report.candidates} jobs are near ${profile.location?.city ?? "you"} or remote, ` +
        `so this list covers the whole country.`,
    );
  } else {
    out(
      `${report.reachable} of ${report.candidates} jobs are near ${profile.location?.city ?? "you"} or remote. ` +
        `Showing those.`,
    );
  }

  printRanked(ranked, Number(values.top ?? 25));

  db.close();
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    out();
    out(
      `The search stopped early. ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  });
