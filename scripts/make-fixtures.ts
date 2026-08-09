#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildMinimalPdf } from "./lib/minimalPdf.ts";
import { normalizeGreenhouseJob } from "../src/core/sources/greenhouse.ts";
import { normalizeUsaJobsPosting } from "../src/core/sources/usajobs.ts";
import { nodeHasher } from "../src/node/clock.ts";

/**
 * Derived fixtures, regenerated deterministically:
 *
 *  - fixtures/resumes/infantry.pdf from infantry.txt, via the minimal PDF
 *    builder — so the PDF extraction path has a real file to chew on, and the
 *    binary in the repo can always be rebuilt from text.
 *  - fixtures/jobs/*.json from the recorded API fixtures, through the SAME
 *    normalize functions the pipeline uses. If the Job shape changes, rerunning
 *    this regenerates matching fixtures instead of letting them drift.
 *
 * Timestamps are pinned so output is byte-stable across runs.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const PINNED_NOW = Date.parse("2026-08-08T12:00:00Z");

function out(relPath: string, content: Buffer | string): void {
  const full = join(repoRoot, "fixtures", relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  process.stdout.write(`  wrote fixtures/${relPath.replace(/\\/g, "/")}\n`);
}

// --- infantry.pdf ------------------------------------------------------------

const infantryText = readFileSync(
  join(repoRoot, "fixtures", "resumes", "infantry.txt"),
  "utf8",
);
out("resumes/infantry.pdf", buildMinimalPdf(infantryText.split("\n")));

// --- job fixtures ------------------------------------------------------------

const board = JSON.parse(
  readFileSync(join(repoRoot, "fixtures", "greenhouse", "board-jobs.json"), "utf8"),
) as { jobs: Parameters<typeof normalizeGreenhouseJob>[0][] };

const ghRaw = board.jobs[0];
if (ghRaw === undefined) throw new Error("greenhouse fixture has no jobs");
const ghJob = normalizeGreenhouseJob(ghRaw, "Slingshot Aerospace", {
  hasher: nodeHasher,
  now: PINNED_NOW,
});
if (ghJob === null) throw new Error("greenhouse fixture job failed to normalize");
out("jobs/greenhouse.json", `${JSON.stringify(ghJob, null, 2)}\n`);

const search = JSON.parse(
  readFileSync(join(repoRoot, "fixtures", "usajobs", "search.json"), "utf8"),
) as {
  SearchResult: {
    SearchResultItems: {
      MatchedObjectDescriptor?: Parameters<typeof normalizeUsaJobsPosting>[0];
    }[];
  };
};

const usaRaw = search.SearchResult.SearchResultItems[0]?.MatchedObjectDescriptor;
if (usaRaw === undefined) throw new Error("usajobs fixture has no descriptors");
const usaJob = normalizeUsaJobsPosting(usaRaw, { hasher: nodeHasher, now: PINNED_NOW });
if (usaJob === null) throw new Error("usajobs fixture job failed to normalize");
out("jobs/usajobs.json", `${JSON.stringify(usaJob, null, 2)}\n`);

process.stdout.write("\nDone.\n");
