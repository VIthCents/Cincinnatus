#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { USAJOBS_DEFAULT_WINDOW_DAYS, estimateCostUsd } from "../src/core/config.ts";
import { parseProfile } from "../src/core/profile/parse.ts";
import { profileFromResume } from "../src/core/profile/fromResume.ts";
import { buildSearchTerms } from "../src/core/pipeline/queries.ts";
import { runPipeline } from "../src/core/pipeline/run.ts";
import {
  createGreenhouseSource,
  fetchGreenhouseBoardName,
} from "../src/core/sources/greenhouse.ts";
import { createUsaJobsSource } from "../src/core/sources/usajobs.ts";
import type { Source } from "../src/core/sources/source.ts";
import type { Llm, ProgressEvent, Reporter } from "../src/core/ports.ts";
import type { Job, Profile, RankedJob, WatchlistEntry } from "../src/core/types.ts";
import * as repo from "../src/core/db/repo.ts";
import { MATCH_WORDS, matchLevel } from "../src/core/pipeline/match.ts";

import { analyzeResume } from "../src/core/documents/analyze.ts";
import { parseResume } from "../src/core/documents/parseResume.ts";
import { reviseResume } from "../src/core/documents/revise.ts";
import { tailorResume } from "../src/core/documents/tailor.ts";
import { writeCoverLetter } from "../src/core/documents/coverletter.ts";
import {
  coverLetterToDocxBase64,
  resumeToDocxBase64,
} from "../src/core/documents/exportDocx.ts";
import type { Finding, ResumeData } from "../src/core/documents/types.ts";

import { NodeDb } from "../src/node/db.ts";
import { nodeClock, nodeHasher } from "../src/node/clock.ts";
import { nodeHttp } from "../src/node/http.ts";
import { createNodeEmbedder } from "../src/node/embedder.ts";
import { createCapturingHttp, createFixtureHttp } from "../src/node/fixtureHttp.ts";
import { createNodeLlm, llmErrorMessage } from "../src/node/llm.ts";
import { extractResumeText } from "../src/node/extractText.ts";
import { loadDotEnv } from "../src/node/env.ts";

/**
 * Headless CLI for the whole engine (SPEC §9, Phases 1 and 2).
 *
 *   pnpm harness search --profile fixtures/profile.sample.json
 *   pnpm harness analyze --resume fixtures/resumes/infantry.pdf
 *   pnpm harness parse-resume --resume fixtures/resumes/logistics.txt
 *   pnpm harness tailor --resume .data/out/resume.json --job fixtures/jobs/usajobs.json
 *   pnpm harness coverletter --resume .data/out/resume.json --job-id 3aef21 --db .data/full.db
 *   pnpm harness revise --resume .data/out/resume.json --instruction "shorten it"
 *
 * Exit codes: 0 done · 1 crashed · 2 usage problem · 3 done, but the
 * no-fabrication check flagged something that needs the user's eyes.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(repoRoot, ".data", "out");

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "output"
  );
}

function writeOut(fileName: string, content: string | Buffer): string {
  mkdirSync(OUT_DIR, { recursive: true });
  const full = join(OUT_DIR, fileName);
  writeFileSync(full, content);
  return full.replace(`${repoRoot}\\`, "").replace(/\\/g, "/");
}

/** Wraps the Llm so every subcommand can end with an honest cost line. */
function withCostTracking(inner: Llm): { llm: Llm; costLine(): string } {
  let cost = 0;
  let calls = 0;
  return {
    llm: {
      async complete(req) {
        const response = await inner.complete(req);
        calls += 1;
        cost += estimateCostUsd(
          response.modelId,
          response.inputTokens,
          response.outputTokens,
        );
        return response;
      },
    },
    costLine(): string {
      if (calls === 0) return "";
      const rounded = cost < 0.005 ? "less than a cent" : `about $${cost.toFixed(2)}`;
      return `AI used for this: ${rounded} of your credits (rough estimate).`;
    },
  };
}

function requireLlm(): { llm: Llm; costLine(): string } | null {
  const key = process.env["ANTHROPIC_API_KEY"];
  if (key === undefined || key === "") {
    out("This command needs your AI access key, and none is set.");
    out();
    out("  1. Get a key at console.anthropic.com (the developer console —");
    out("     a claude.ai Pro/Max chat plan does NOT include one).");
    out("  2. Copy .env.example to .env and paste the key after ANTHROPIC_API_KEY=");
    out();
    out("Job searching works without it: pnpm harness search --profile <path>");
    return null;
  }
  return withCostTracking(createNodeLlm(key));
}

/**
 * A resume argument is either a ResumeData JSON (from a prior parse-resume) or
 * a resume file (.pdf/.docx/.txt) that gets extracted and parsed on the spot.
 */
async function loadResumeData(path: string, llm: Llm): Promise<ResumeData> {
  const full = join(repoRoot, path);
  if (!existsSync(full)) {
    throw new Error(`No file at ${path}.`);
  }
  if (extname(full).toLowerCase() === ".json") {
    return JSON.parse(readFileSync(full, "utf8")) as ResumeData;
  }
  const extracted = await extractResumeText(full);
  out(
    `Read your resume (${extracted.kind}, ${extracted.text.length} characters). Understanding it...`,
  );
  return parseResume(llm, extracted.text);
}

function loadJobFromFile(path: string): Job {
  const full = join(repoRoot, path);
  if (!existsSync(full)) throw new Error(`No job file at ${path}.`);
  return JSON.parse(readFileSync(full, "utf8")) as Job;
}

async function loadJob(values: {
  job?: string;
  "job-id"?: string;
  db?: string;
}): Promise<Job> {
  if (values.job !== undefined) return loadJobFromFile(values.job);

  if (values["job-id"] !== undefined) {
    const dbPath = join(repoRoot, values.db ?? join(".data", "harness.db"));
    if (!existsSync(dbPath)) {
      throw new Error(
        `--job-id needs the search database, and there is none at ${values.db ?? ".data/harness.db"}. Run a search first.`,
      );
    }
    const db = new NodeDb(dbPath);
    try {
      const matches = await repo.findJobsByIdPrefix(db, values["job-id"]);
      if (matches.length === 1 && matches[0] !== undefined) return matches[0];
      if (matches.length === 0) {
        throw new Error(
          `No saved job starts with "${values["job-id"]}". Copy the id from the search results.`,
        );
      }
      throw new Error(
        `More than one saved job starts with "${values["job-id"]}". Use a few more characters.`,
      );
    } finally {
      db.close();
    }
  }

  throw new Error("Which job? Pass --job <file> or --job-id <id from search results>.");
}

function printFindings(
  findings: readonly Finding[],
  context: "derived" | "authored",
): boolean {
  const high = findings.filter((f) => f.severity === "high");
  const review = findings.filter((f) => f.severity === "review");

  if (high.length > 0) {
    out();
    if (context === "derived") {
      out("STOP — the check found things your resume does not back up:");
    } else {
      out("Changes that need your confirmation:");
    }
    for (const finding of high) out(`  ! ${finding.message}`);
    if (context === "derived") {
      out("  These were NOT silently accepted. Fix the base resume or regenerate.");
    }
  }
  if (review.length > 0) {
    out();
    out("Worth a quick look:");
    for (const finding of review) out(`  - ${finding.message}`);
  }
  return high.length > 0;
}

// -----------------------------------------------------------------------------
// search (Phase 1)
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
      `    ${MATCH_WORDS[matchLevel(r.fitScore)]} (fit ${r.fitScore.toFixed(1)}) · posted ${ageLabel(r.ageDays)}` +
        `${r.job.postedAtIsEstimated ? " (estimated)" : ""} · score ${r.finalScore.toFixed(2)}` +
        `${salary === "" ? "" : ` · ${salary}`}`,
    );
    out(`    id ${r.job.id.slice(0, 12)} · ${r.job.url}`);
  });

  if (ranked.length > 0) {
    out();
    out(
      `To prepare an application:  pnpm harness tailor --resume <your resume> --job-id <id>`,
    );
  }
}

interface SearchFlags {
  profile?: string;
  db?: string;
  top?: string;
  "max-embed"?: string;
  "usajobs-days"?: string;
  offline?: boolean;
  capture?: boolean;
}

async function commandSearch(values: SearchFlags): Promise<number> {
  if (values.profile === undefined) {
    out(
      "Which profile? Try: pnpm harness search --profile fixtures/profile.sample.json",
    );
    return 2;
  }

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
  const profile: Profile = parsed.value;

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
      case "phase":
        out(`\n[${event.phase}]`);
        break;
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
        keywords: terms.titles,
        windowDays: Number(values["usajobs-days"] ?? USAJOBS_DEFAULT_WINDOW_DAYS),
      }),
    );
  } else {
    out(
      "Federal jobs are turned off. Set USAJOBS_API_KEY and USAJOBS_USER_AGENT to include them.",
    );
  }

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

// -----------------------------------------------------------------------------
// verify-watchlist
// -----------------------------------------------------------------------------

async function commandVerifyWatchlist(): Promise<number> {
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
// Document commands (Phase 2)
// -----------------------------------------------------------------------------

async function commandAnalyze(values: { resume?: string }): Promise<number> {
  if (values.resume === undefined) {
    out(
      "Which resume? Try: pnpm harness analyze --resume fixtures/resumes/infantry.pdf",
    );
    return 2;
  }
  const tracked = requireLlm();
  if (tracked === null) return 2;

  const extracted = await extractResumeText(join(repoRoot, values.resume));
  out(`Read your resume (${extracted.kind}). Looking it over...`);

  const critique = await analyzeResume(tracked.llm, extracted.text);

  out();
  out(critique.summary);
  out();
  out("What is working:");
  for (const strength of critique.strengths) out(`  + ${strength}`);
  out();
  out("What is holding it back:");
  for (const gap of critique.gaps) out(`  - ${gap}`);
  out();
  out("What to fix, one at a time:");
  critique.fixes.forEach((fix, i) => {
    out(`  ${i + 1}. ${fix.what}`);
    out(`     Why: ${fix.why}`);
    out(`     How: ${fix.how}`);
  });
  out();
  out(tracked.costLine());
  return 0;
}

async function commandParseResume(values: {
  resume?: string;
  out?: string;
  "profile-out"?: string;
}): Promise<number> {
  if (values.resume === undefined) {
    out(
      "Which resume? Try: pnpm harness parse-resume --resume fixtures/resumes/logistics.txt",
    );
    return 2;
  }
  const tracked = requireLlm();
  if (tracked === null) return 2;

  const resume = await loadResumeData(values.resume, tracked.llm);

  const outPath = values.out ?? join(".data", "out", "resume.json");
  mkdirSync(dirname(join(repoRoot, outPath)), { recursive: true });
  writeFileSync(
    join(repoRoot, outPath),
    `${JSON.stringify(resume, null, 2)}\n`,
    "utf8",
  );
  out(`Saved the structured resume to ${outPath}`);
  out(
    `  ${resume.experience.length} jobs, ${resume.certifications.length} certifications, ` +
      `${resume.skills.length} skills${resume.clearance === null ? "" : `, clearance: ${resume.clearance}`}`,
  );

  if (values["profile-out"] !== undefined) {
    const nowYear = new Date(nodeClock.now()).getUTCFullYear();
    const profile = profileFromResume(resume, nowYear);
    writeFileSync(
      join(repoRoot, values["profile-out"]),
      `${JSON.stringify(profile, null, 2)}\n`,
      "utf8",
    );
    out(
      `Saved a search profile to ${values["profile-out"]} — use it with: pnpm harness search --profile ${values["profile-out"]}`,
    );
  }

  out();
  out(tracked.costLine());
  return 0;
}

async function commandRevise(values: {
  resume?: string;
  instruction?: string;
  out?: string;
}): Promise<number> {
  if (values.resume === undefined || values.instruction === undefined) {
    out(
      'Usage: pnpm harness revise --resume <resume.json> --instruction "what to change"',
    );
    return 2;
  }
  const tracked = requireLlm();
  if (tracked === null) return 2;

  const current = await loadResumeData(values.resume, tracked.llm);
  const result = await reviseResume(tracked.llm, current, values.instruction);

  const outPath = values.out ?? join(".data", "out", "resume-revised.json");
  writeFileSync(
    join(repoRoot, outPath),
    `${JSON.stringify(result.document, null, 2)}\n`,
    "utf8",
  );

  out(result.note);
  out(`Saved to ${outPath}`);
  printFindings(result.findings, "authored");
  out();
  out(tracked.costLine());
  return 0;
}

async function commandTailor(values: {
  resume?: string;
  job?: string;
  "job-id"?: string;
  db?: string;
}): Promise<number> {
  if (values.resume === undefined) {
    out(
      "Usage: pnpm harness tailor --resume <resume file or .json> --job <file> | --job-id <id>",
    );
    return 2;
  }
  const tracked = requireLlm();
  if (tracked === null) return 2;

  const base = await loadResumeData(values.resume, tracked.llm);
  const job = await loadJob(values);
  const federal = job.source === "usajobs";

  out(
    `Tailoring your resume for: ${job.title} at ${job.company}${federal ? " (federal format)" : ""}...`,
  );

  const result = await tailorResume(tracked.llm, base, job);

  const name = `tailored-${slug(job.company)}-${slug(job.title)}`;
  const jsonPath = writeOut(
    `${name}.json`,
    `${JSON.stringify(result.document, null, 2)}\n`,
  );
  const docxBase64 = await resumeToDocxBase64(result.document, { federal });
  const docxPath = writeOut(`${name}.docx`, Buffer.from(docxBase64, "base64"));

  out();
  out(result.note);
  out(`Saved:  ${docxPath}`);
  out(`        ${jsonPath}`);

  const hasHigh = printFindings(result.findings, "derived");
  out();
  out(tracked.costLine());
  return hasHigh ? 3 : 0;
}

async function commandCoverLetter(values: {
  resume?: string;
  job?: string;
  "job-id"?: string;
  db?: string;
}): Promise<number> {
  if (values.resume === undefined) {
    out(
      "Usage: pnpm harness coverletter --resume <resume file or .json> --job <file> | --job-id <id>",
    );
    return 2;
  }
  const tracked = requireLlm();
  if (tracked === null) return 2;

  const base = await loadResumeData(values.resume, tracked.llm);
  const job = await loadJob(values);

  out(`Writing a cover letter for: ${job.title} at ${job.company}...`);

  const result = await writeCoverLetter(tracked.llm, base, job);

  out();
  out(result.document.salutation);
  for (const paragraph of result.document.bodyParagraphs) {
    out();
    out(paragraph);
  }
  out();
  out(result.document.closing);
  out(base.name);

  const name = `coverletter-${slug(job.company)}-${slug(job.title)}`;
  const docxBase64 = await coverLetterToDocxBase64(result.document, base);
  const docxPath = writeOut(`${name}.docx`, Buffer.from(docxBase64, "base64"));
  writeOut(`${name}.json`, `${JSON.stringify(result.document, null, 2)}\n`);
  out();
  out(`Saved: ${docxPath}`);

  const hasHigh = printFindings(result.findings, "derived");
  out();
  out(tracked.costLine());
  return hasHigh ? 3 : 0;
}

// -----------------------------------------------------------------------------
// Help + dispatch
// -----------------------------------------------------------------------------

function printHelp(): void {
  out("Cincinnatus harness — the whole engine, no app needed.");
  out();
  out("Finding jobs (no AI key needed):");
  out("  pnpm harness search --profile fixtures/profile.sample.json");
  out("    --db <path>          SQLite file (default .data/harness.db)");
  out("    --top <n>            how many jobs to print (default 25)");
  out("    --max-embed <n>      cap new embeddings; for fast iteration only");
  out("    --usajobs-days <n>   how far back to search federal jobs (default 7)");
  out("    --capture            run live and record every response to fixtures/http/");
  out("    --offline            replay what --capture recorded; no network at all");
  out("  pnpm harness verify-watchlist");
  out();
  out("Working on a resume (needs your AI access key in .env):");
  out("  pnpm harness analyze --resume fixtures/resumes/infantry.pdf");
  out("  pnpm harness parse-resume --resume <file> [--out p] [--profile-out p]");
  out('  pnpm harness revise --resume <resume.json> --instruction "..." [--out p]');
  out(
    "  pnpm harness tailor --resume <file|json> --job <file> | --job-id <id> [--db p]",
  );
  out(
    "  pnpm harness coverletter --resume <file|json> --job <file> | --job-id <id> [--db p]",
  );
  out();
  out("Exit codes: 0 done · 1 crashed · 2 usage problem · 3 done but the");
  out("no-fabrication check flagged something for you to look at.");
}

async function main(): Promise<number> {
  loadDotEnv(join(repoRoot, ".env"));

  const { values, positionals } = parseArgs({
    options: {
      profile: { type: "string" },
      resume: { type: "string" },
      job: { type: "string" },
      "job-id": { type: "string" },
      instruction: { type: "string" },
      out: { type: "string" },
      "profile-out": { type: "string" },
      db: { type: "string" },
      top: { type: "string" },
      "max-embed": { type: "string" },
      "usajobs-days": { type: "string" },
      offline: { type: "boolean", default: false },
      capture: { type: "boolean", default: false },
      "verify-watchlist": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const command =
    positionals[0] ??
    (values["verify-watchlist"] === true
      ? "verify-watchlist"
      : values.profile !== undefined
        ? "search"
        : "help");

  if (values.help === true) {
    printHelp();
    return 0;
  }

  switch (command) {
    case "search":
      return commandSearch(values);
    case "verify-watchlist":
      return commandVerifyWatchlist();
    case "analyze":
      return commandAnalyze(values);
    case "parse-resume":
      return commandParseResume(values);
    case "revise":
      return commandRevise(values);
    case "tailor":
      return commandTailor(values);
    case "coverletter":
      return commandCoverLetter(values);
    case "help":
      printHelp();
      return 0;
    default:
      out(`Unknown command "${command}".`);
      out();
      printHelp();
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    out();
    out(llmErrorMessage(err));
    process.exitCode = 1;
  });
