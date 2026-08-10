import { EMBED_BATCH_SIZE } from "../config.ts";
import type { Clock, Db, Embedder, Hasher, Http, Reporter } from "../ports.ts";
import type { Job, Profile, RankedJob, RunReport, SourceOutcome } from "../types.ts";
import { migrate } from "../db/migrations.ts";
import * as repo from "../db/repo.ts";
import { recordCalls } from "../app/quota.ts";
import { assignCanonicals } from "./dedupe.ts";
import { buildJobText, buildProfileText } from "../embed/text.ts";
import { decodeVector, encodeVector } from "../util/base64.ts";
import { normalize } from "../embed/vector.ts";
import { rankJobs } from "./rank.ts";
import { runSource, type Source } from "../sources/source.ts";

export interface RunOptions {
  readonly db: Db;
  readonly http: Http;
  readonly clock: Clock;
  readonly hasher: Hasher;
  readonly embedder: Embedder;
  readonly reporter: Reporter;
  readonly profile: Profile;
  readonly sources: readonly Source[];
  /**
   * Cap on how many *new* jobs to embed this run. null means no cap.
   *
   * Exists for development iteration only. The product default is to embed
   * everything, which is why progress is reported: a ten-minute run with no
   * output is indistinguishable from a hang.
   */
  readonly maxEmbed: number | null;
}

export interface RunResult {
  readonly report: RunReport;
  readonly ranked: readonly RankedJob[];
}

export async function runPipeline(options: RunOptions): Promise<RunResult> {
  const { db, http, clock, hasher, embedder, reporter, profile, sources } = options;

  // Read the clock exactly once. Every age in this run is measured against the
  // same instant, so two jobs posted at the same moment cannot land on
  // different sides of a day boundary because one was processed later.
  const startedAt = clock.now();

  await migrate(db, startedAt);

  // --- fetch ---------------------------------------------------------------

  reporter({ kind: "phase", phase: "finding" });

  const outcomes: SourceOutcome[] = [];
  const fetched: Job[] = [];

  for (const source of sources) {
    const state = await repo.getSourceState(db, source.stateKey);
    const result = await runSource(source, {
      http,
      clock,
      hasher,
      state,
      reporter,
      now: startedAt,
    });

    outcomes.push({
      sourceId: result.sourceId,
      label: result.label,
      fetched: result.jobs.length,
      notModified: result.notModified,
      error: result.error,
    });

    fetched.push(...result.jobs);

    // Sources cannot count their own calls across runs — they are handed no
    // database. A provider with a daily ceiling needs someone to remember.
    if (result.requests !== undefined) {
      await recordCalls(db, result.sourceId, result.requests, startedAt);
    }

    if (result.newState !== null) {
      await repo.putSourceState(db, source.stateKey, result.newState, startedAt);
    }
  }

  // --- persist -------------------------------------------------------------

  const known = await repo.existingJobIds(
    db,
    fetched.map((j) => j.id),
  );
  const jobsNew = fetched.filter((j) => !known.has(j.id)).length;

  await repo.upsertJobs(db, fetched);

  // --- dedupe --------------------------------------------------------------

  await repo.purgeStaleAggregatorJobs(db, startedAt);
  const all = await repo.listRankableJobs(db, startedAt);
  const { canonicalOf, collapsed } = assignCanonicals(all);
  await repo.setCanonical(db, [...canonicalOf.entries()]);

  const survivors = all.filter((job) => !canonicalOf.has(job.id));

  // --- embed ---------------------------------------------------------------

  // Content-addressed: two postings with identical text share one vector, so a
  // requisition cross-posted to two boards is embedded once.
  const textOf = new Map<string, string>();
  const hashOf = new Map<string, string>();
  for (const job of survivors) {
    const text = buildJobText(job);
    const hash = hasher.sha256Hex(text);
    textOf.set(job.id, text);
    hashOf.set(job.id, hash);
  }

  const uniqueHashes = [...new Set(hashOf.values())];
  const cached = await repo.loadEmbeddings(db, embedder.modelId, uniqueHashes);

  const missing = uniqueHashes.filter((h) => !cached.has(h));
  const toEmbed =
    options.maxEmbed === null ? missing : missing.slice(0, options.maxEmbed);

  if (toEmbed.length < missing.length) {
    reporter({
      kind: "note",
      message: `Embedding only ${toEmbed.length} of ${missing.length} new jobs (--max-embed). Ranking will be incomplete.`,
    });
  }

  // One text per hash. Any job carrying that hash produced identical text.
  const textForHash = new Map<string, string>();
  for (const [jobId, hash] of hashOf) {
    if (!textForHash.has(hash)) {
      textForHash.set(hash, textOf.get(jobId) ?? "");
    }
  }

  let embeddedCount = 0;

  // Announce the denominator before the first batch, not after it. On a first
  // run the first batch can take a while, and a bar with no scale for that
  // whole stretch is the thing this phase exists to prevent. A run with
  // nothing new to read skips the phase entirely rather than showing 0 of 0.
  if (toEmbed.length > 0) {
    reporter({ kind: "phase", phase: "reading" });
    reporter({ kind: "embed_progress", done: 0, total: toEmbed.length });
  }

  for (let i = 0; i < toEmbed.length; i += EMBED_BATCH_SIZE) {
    const batchHashes = toEmbed.slice(i, i + EMBED_BATCH_SIZE);
    const batchTexts = batchHashes.map((h) => textForHash.get(h) ?? "");
    const vectors = await embedder.embed(batchTexts);

    const batchEncoded: [string, string][] = [];
    for (let j = 0; j < batchHashes.length; j++) {
      const hash = batchHashes[j];
      const vector = vectors[j];
      if (hash === undefined || vector === undefined) continue;
      const encoded = encodeVector(vector);
      batchEncoded.push([hash, encoded]);
      cached.set(hash, encoded);
    }

    // Persist per batch, not at the end. A first run embeds thousands of jobs
    // over many minutes; if the app closes partway, everything embedded so far
    // must survive — the next run picks up where this one stopped instead of
    // starting over.
    await repo.saveEmbeddings(
      db,
      embedder.modelId,
      embedder.dimensions,
      startedAt,
      batchEncoded,
    );
    embeddedCount += batchEncoded.length;

    reporter({
      kind: "embed_progress",
      done: Math.min(i + EMBED_BATCH_SIZE, toEmbed.length),
      total: toEmbed.length,
    });
  }

  await repo.setEmbedHashes(db, [...hashOf.entries()]);

  const vectorsByJob = new Map<string, Float32Array>();
  for (const [jobId, hash] of hashOf) {
    const encoded = cached.get(hash);
    if (encoded !== undefined) vectorsByJob.set(jobId, decodeVector(encoded));
  }

  // --- profile vector ------------------------------------------------------

  reporter({ kind: "phase", phase: "ranking" });

  const profileText = buildProfileText(profile);
  const profileVectors = await embedder.embed([profileText]);
  const profileVector = profileVectors[0] ?? null;
  if (profileVector !== null) normalize(profileVector);

  await repo.saveProfile(
    db,
    profile,
    startedAt,
    profileVector === null ? null : encodeVector(profileVector),
    embedder.modelId,
  );

  // --- rank ----------------------------------------------------------------

  const { ranked, widenedBeyondRadius, fit, candidates, reachable } = rankJobs({
    jobs: survivors,
    vectors: vectorsByJob,
    profileVector,
    profile,
    now: startedAt,
  });

  const finishedAt = clock.now();

  const report: RunReport = {
    startedAt,
    finishedAt,
    sources: outcomes,
    jobsSeen: fetched.length,
    jobsNew,
    duplicatesCollapsed: collapsed,
    embedded: embeddedCount,
    fit,
    widenedBeyondRadius,
    candidates,
    reachable,
  };

  await repo.saveRun(
    db,
    hasher.sha256Hex(`run:${startedAt}`),
    startedAt,
    finishedAt,
    report,
  );

  return { report, ranked };
}
