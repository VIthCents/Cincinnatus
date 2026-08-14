import type { Db, SqlValue } from "../ports.ts";
import {
  AGGREGATOR_DELETE_DAYS,
  AGGREGATOR_SOURCES,
  AGGREGATOR_STALE_DAYS,
} from "../config.ts";
import type {
  ApplicationStatus,
  Job,
  LlmScore,
  Profile,
  SourceId,
  TrackedApplication,
  WatchlistEntry,
} from "../types.ts";

/**
 * Thin data access. Hand-written SQL, no ORM, no query builder (constraint 7).
 *
 * SQL here is written with `?` placeholders. The Node adapter passes them
 * through; the Tauri adapter rewrites them to $1/$2 because plugin-sql expects
 * that dialect. Core never sees the difference.
 */

// -----------------------------------------------------------------------------
// Jobs
// -----------------------------------------------------------------------------

interface JobRow {
  id: string;
  source: string;
  external_id: string;
  title: string;
  company: string;
  location: string | null;
  remote: number | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_interval: string | null;
  url: string;
  posted_at: number | null;
  posted_at_is_estimated: number;
  description_text: string;
  raw: string;
  embed_hash: string | null;
  first_seen_at: number;
  last_seen_at: number;
  dedupe_key: string;
  canonical_id: string | null;
}

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    source: row.source as SourceId,
    externalId: row.external_id,
    title: row.title,
    company: row.company,
    location: row.location,
    // SQLite has no boolean. null stays null — it means "source did not say".
    remote: row.remote === null ? null : row.remote !== 0,
    salaryMin: row.salary_min,
    salaryMax: row.salary_max,
    salaryCurrency: row.salary_currency,
    salaryInterval: row.salary_interval as Job["salaryInterval"],
    url: row.url,
    postedAt: row.posted_at,
    postedAtIsEstimated: row.posted_at_is_estimated !== 0,
    descriptionText: row.description_text,
    raw: row.raw,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    dedupeKey: row.dedupe_key,
    canonicalId: row.canonical_id,
  };
}

const UPSERT_JOB = `
INSERT INTO jobs (
  id, source, external_id, title, company, location, remote,
  salary_min, salary_max, salary_currency, salary_interval,
  url, posted_at, posted_at_is_estimated, description_text, raw, embed_hash,
  first_seen_at, last_seen_at, dedupe_key, canonical_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  title                  = excluded.title,
  company                = excluded.company,
  location               = excluded.location,
  remote                 = excluded.remote,
  salary_min             = excluded.salary_min,
  salary_max             = excluded.salary_max,
  salary_currency        = excluded.salary_currency,
  salary_interval        = excluded.salary_interval,
  url                    = excluded.url,
  posted_at              = excluded.posted_at,
  posted_at_is_estimated = excluded.posted_at_is_estimated,
  description_text       = excluded.description_text,
  raw                    = excluded.raw,
  embed_hash             = excluded.embed_hash,
  last_seen_at           = excluded.last_seen_at,
  dedupe_key             = excluded.dedupe_key
`;
// first_seen_at is deliberately absent from the UPDATE list. It is the fallback
// used when a source gives no posting date, so overwriting it on every run would
// make every job permanently look brand new.

function jobToParams(job: Job): readonly SqlValue[] {
  return [
    job.id,
    job.source,
    job.externalId,
    job.title,
    job.company,
    job.location,
    job.remote === null ? null : job.remote ? 1 : 0,
    job.salaryMin,
    job.salaryMax,
    job.salaryCurrency,
    job.salaryInterval,
    job.url,
    job.postedAt,
    job.postedAtIsEstimated ? 1 : 0,
    job.descriptionText,
    job.raw,
    null, // embed_hash is set later, once the embed text is built
    job.firstSeenAt,
    job.lastSeenAt,
    job.dedupeKey,
    job.canonicalId,
  ];
}

export async function upsertJobs(db: Db, jobs: readonly Job[]): Promise<void> {
  if (jobs.length === 0) return;
  await db.runMany(UPSERT_JOB, jobs.map(jobToParams));
}

/** Ids that already exist, so a run can report how many were genuinely new. */
export async function existingJobIds(
  db: Db,
  ids: readonly string[],
): Promise<ReadonlySet<string>> {
  if (ids.length === 0) return new Set();
  const found = new Set<string>();
  // Chunked to stay well under SQLite's default 999-variable limit.
  const CHUNK = 400;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const holes = chunk.map(() => "?").join(", ");
    const rows = await db.all<{ id: string }>(
      `SELECT id FROM jobs WHERE id IN (${holes})`,
      chunk,
    );
    for (const row of rows) found.add(row.id);
  }
  return found;
}

export async function getJobById(db: Db, id: string): Promise<Job | null> {
  const rows = await db.all<JobRow>("SELECT * FROM jobs WHERE id = ?", [id]);
  const row = rows[0];
  return row === undefined ? null : rowToJob(row);
}

/**
 * Ids are 64 hex chars; nobody should have to type one. A prefix of 8+ chars
 * is unambiguous in practice — and when it is not, both matches are returned
 * so the caller can say so instead of guessing.
 */
export async function findJobsByIdPrefix(db: Db, prefix: string): Promise<Job[]> {
  // The prefix is hex from our own output, but escape defensively anyway.
  const safe = prefix.toLowerCase().replace(/[^a-f0-9]/g, "");
  if (safe === "") return [];
  const rows = await db.all<JobRow>("SELECT * FROM jobs WHERE id LIKE ? LIMIT 3", [
    `${safe}%`,
  ]);
  return rows.map(rowToJob);
}

/** Every job that is not a collapsed duplicate. */
export async function listRankableJobs(db: Db, now?: number): Promise<Job[]> {
  // Aggregator listings that have not been seen for a long time are probably
  // filled. A company board says so by not returning the job; an aggregator
  // keyword search never does. See AGGREGATOR_STALE_DAYS.
  const cutoff = now === undefined ? null : now - AGGREGATOR_STALE_DAYS * 86_400_000;
  const rows =
    cutoff === null
      ? await db.all<JobRow>(
          "SELECT * FROM jobs WHERE canonical_id IS NULL ORDER BY id",
        )
      : await db.all<JobRow>(
          `SELECT * FROM jobs WHERE canonical_id IS NULL
             AND (source NOT IN (${AGGREGATOR_SOURCES.map(() => "?").join(",")})
                  OR last_seen_at >= ?)
           ORDER BY id`,
          [...AGGREGATOR_SOURCES, cutoff],
        );
  return rows.map(rowToJob);
}

/**
 * Delete long-dead aggregator rows, except any the person has touched.
 *
 * Their own thumbs, hides and prepared applications are theirs; a retention
 * rule must not quietly erase them.
 *
 * `applications` is checked directly even though saveApplication also writes a
 * `feedback` row that would spare the job anyway. Defence in depth on purpose:
 * that coupling is invisible from here, and anything that ever removes an
 * `applied` feedback row without going through deleteApplication would silently
 * make the person's own record of where they applied disappear at ninety days.
 *
 * Every subquery filters `job_id IS NOT NULL`. A single NULL inside a NOT IN
 * makes the whole predicate unknown and the DELETE matches nothing at all —
 * a retention rule that quietly stops running is worse than one that never was.
 */
export async function purgeStaleAggregatorJobs(db: Db, now: number): Promise<void> {
  const cutoff = now - AGGREGATOR_DELETE_DAYS * 86_400_000;
  const marks = AGGREGATOR_SOURCES.map(() => "?").join(",");
  await db.run(
    `DELETE FROM jobs
      WHERE source IN (${marks})
        AND last_seen_at < ?
        AND id NOT IN (SELECT job_id FROM feedback)
        AND id NOT IN (SELECT job_id FROM documents WHERE job_id IS NOT NULL)
        AND id NOT IN (SELECT job_id FROM applications WHERE job_id IS NOT NULL)`,
    [...AGGREGATOR_SOURCES, cutoff],
  );
}

/**
 * jobId → embed_hash for every rankable job that has one. What lets the app
 * re-rank on startup from stored vectors without running a search first.
 */
export async function listEmbedHashes(db: Db): Promise<Map<string, string>> {
  const rows = await db.all<{ id: string; embed_hash: string }>(
    "SELECT id, embed_hash FROM jobs WHERE canonical_id IS NULL AND embed_hash IS NOT NULL",
  );
  return new Map(rows.map((r) => [r.id, r.embed_hash]));
}

export async function setCanonical(
  db: Db,
  pairs: readonly (readonly [duplicateId: string, canonicalId: string])[],
): Promise<void> {
  if (pairs.length === 0) return;
  await db.runMany(
    "UPDATE jobs SET canonical_id = ? WHERE id = ?",
    pairs.map(([dup, canonical]) => [canonical, dup]),
  );
}

export async function setEmbedHashes(
  db: Db,
  pairs: readonly (readonly [jobId: string, embedHash: string])[],
): Promise<void> {
  if (pairs.length === 0) return;
  await db.runMany(
    "UPDATE jobs SET embed_hash = ? WHERE id = ?",
    pairs.map(([id, hash]) => [hash, id]),
  );
}

// -----------------------------------------------------------------------------
// Embeddings
// -----------------------------------------------------------------------------

export async function loadEmbeddings(
  db: Db,
  modelId: string,
  hashes: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (hashes.length === 0) return out;
  const CHUNK = 400;
  for (let i = 0; i < hashes.length; i += CHUNK) {
    const chunk = hashes.slice(i, i + CHUNK);
    const holes = chunk.map(() => "?").join(", ");
    const rows = await db.all<{ content_hash: string; vector: string }>(
      `SELECT content_hash, vector FROM embeddings
        WHERE model_id = ? AND content_hash IN (${holes})`,
      [modelId, ...chunk],
    );
    for (const row of rows) out.set(row.content_hash, row.vector);
  }
  return out;
}

export async function saveEmbeddings(
  db: Db,
  modelId: string,
  dim: number,
  now: number,
  entries: readonly (readonly [contentHash: string, encodedVector: string])[],
): Promise<void> {
  if (entries.length === 0) return;
  await db.runMany(
    `INSERT INTO embeddings (content_hash, model_id, dim, vector, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(content_hash, model_id) DO UPDATE SET
       vector = excluded.vector, dim = excluded.dim, created_at = excluded.created_at`,
    entries.map(([hash, vector]) => [hash, modelId, dim, vector, now]),
  );
}

// -----------------------------------------------------------------------------
// Source state (ETag / Last-Modified)
// -----------------------------------------------------------------------------

export interface SourceState {
  readonly etag: string | null;
  readonly lastModified: string | null;
}

export async function getSourceState(
  db: Db,
  sourceKey: string,
): Promise<SourceState | null> {
  const rows = await db.all<{ etag: string | null; last_modified: string | null }>(
    "SELECT etag, last_modified FROM source_state WHERE source_key = ?",
    [sourceKey],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return { etag: row.etag, lastModified: row.last_modified };
}

export async function putSourceState(
  db: Db,
  sourceKey: string,
  state: SourceState,
  now: number,
): Promise<void> {
  await db.run(
    `INSERT INTO source_state (source_key, etag, last_modified, fetched_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(source_key) DO UPDATE SET
       etag = excluded.etag,
       last_modified = excluded.last_modified,
       fetched_at = excluded.fetched_at`,
    [sourceKey, state.etag, state.lastModified, now],
  );
}

// -----------------------------------------------------------------------------
// Profile
// -----------------------------------------------------------------------------

export async function saveProfile(
  db: Db,
  profile: Profile,
  now: number,
  embedding: string | null,
  embedModel: string | null,
): Promise<void> {
  await db.run(
    `INSERT INTO profile (id, json, embedding, embed_model, updated_at)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       json = excluded.json,
       embedding = excluded.embedding,
       embed_model = excluded.embed_model,
       updated_at = excluded.updated_at`,
    [JSON.stringify(profile), embedding, embedModel, now],
  );
}

// -----------------------------------------------------------------------------
// Watchlist
// -----------------------------------------------------------------------------

export async function seedWatchlist(
  db: Db,
  entries: readonly WatchlistEntry[],
  now: number,
): Promise<void> {
  if (entries.length === 0) return;
  await db.runMany(
    `INSERT INTO watchlist (ats, slug, company_label, board_name, source, sector, note, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ats, slug) DO UPDATE SET
       company_label = excluded.company_label,
       board_name = excluded.board_name,
       sector = excluded.sector,
       note = excluded.note`,
    entries.map((e) => [
      e.ats,
      e.slug,
      e.companyLabel,
      e.boardName,
      e.source,
      e.sector,
      e.note,
      now,
    ]),
  );
}

export async function listWatchlist(db: Db): Promise<WatchlistEntry[]> {
  const rows = await db.all<{
    ats: string;
    slug: string;
    company_label: string;
    board_name: string | null;
    source: string;
    sector: string | null;
    note: string | null;
  }>(
    "SELECT ats, slug, company_label, board_name, source, sector, note FROM watchlist ORDER BY ats, slug",
  );
  return rows.map((r) => ({
    ats: r.ats as WatchlistEntry["ats"],
    slug: r.slug,
    companyLabel: r.company_label,
    boardName: r.board_name,
    source: r.source as WatchlistEntry["source"],
    sector: r.sector,
    note: r.note,
  }));
}

// -----------------------------------------------------------------------------
// Settings
// -----------------------------------------------------------------------------

export async function getSetting(db: Db, key: string): Promise<string | null> {
  const rows = await db.all<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    [key],
  );
  return rows[0]?.value ?? null;
}

export async function setSetting(db: Db, key: string, value: string): Promise<void> {
  await db.run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

export async function getStoredProfile(db: Db): Promise<Profile | null> {
  const rows = await db.all<{ json: string; embedding: string | null }>(
    "SELECT json, embedding FROM profile WHERE id = 1",
  );
  const row = rows[0];
  return row === undefined ? null : (JSON.parse(row.json) as Profile);
}

export async function getStoredProfileEmbedding(
  db: Db,
  modelId: string,
): Promise<string | null> {
  const rows = await db.all<{ embedding: string | null; embed_model: string | null }>(
    "SELECT embedding, embed_model FROM profile WHERE id = 1",
  );
  const row = rows[0];
  if (row === undefined || row.embedding === null) return null;
  // A vector from a different model or quantization is not comparable.
  return row.embed_model === modelId ? row.embedding : null;
}

// -----------------------------------------------------------------------------
// Feedback
// -----------------------------------------------------------------------------

export type FeedbackVerdict = "up" | "down" | "applied" | "hidden";

export async function saveFeedback(
  db: Db,
  jobId: string,
  verdict: FeedbackVerdict,
  now: number,
): Promise<void> {
  await db.run(
    `INSERT INTO feedback (job_id, verdict, ts) VALUES (?, ?, ?)
     ON CONFLICT(job_id, verdict) DO UPDATE SET ts = excluded.ts`,
    [jobId, verdict, now],
  );
}

export async function removeFeedback(
  db: Db,
  jobId: string,
  verdict: FeedbackVerdict,
): Promise<void> {
  await db.run("DELETE FROM feedback WHERE job_id = ? AND verdict = ?", [
    jobId,
    verdict,
  ]);
}

export async function listFeedback(
  db: Db,
  verdict: FeedbackVerdict,
): Promise<ReadonlySet<string>> {
  const rows = await db.all<{ job_id: string }>(
    "SELECT job_id FROM feedback WHERE verdict = ?",
    [verdict],
  );
  return new Set(rows.map((r) => r.job_id));
}

// -----------------------------------------------------------------------------
// LLM match scores
// -----------------------------------------------------------------------------

/**
 * Only `llm` rows are ever written here.
 *
 * The `scores` table has always allowed `method IN ('embed','llm')`, and the
 * embed half stays unused deliberately: an embedding fit is recomputed from
 * stored vectors in milliseconds on every rank, so persisting five thousand of
 * them per run would be write churn with no reader. LLM scores are different —
 * they cost the person money, so losing one has a price.
 */
export async function saveLlmScores(
  db: Db,
  scores: ReadonlyMap<string, LlmScore>,
): Promise<void> {
  if (scores.size === 0) return;
  await db.runMany(
    `INSERT INTO scores (job_id, method, fit_score, rationale, scored_at, profile_hash, content_hash)
     VALUES (?, 'llm', ?, ?, ?, ?, ?)
     ON CONFLICT(job_id, method) DO UPDATE SET
       fit_score    = excluded.fit_score,
       rationale    = excluded.rationale,
       scored_at    = excluded.scored_at,
       profile_hash = excluded.profile_hash,
       content_hash = excluded.content_hash`,
    [...scores].map(([jobId, s]) => [
      jobId,
      s.fit,
      s.why,
      s.scoredAt,
      s.profileHash,
      s.contentHash,
    ]),
  );
}

/**
 * Stored judgements that are still about this person. Job-text staleness is
 * checked by the caller, which is the only place that knows the current hashes.
 */
export async function loadLlmScores(
  db: Db,
  profileHash: string,
): Promise<Map<string, LlmScore>> {
  const rows = await db.all<{
    job_id: string;
    fit_score: number;
    rationale: string | null;
    scored_at: number;
    content_hash: string | null;
  }>(
    `SELECT job_id, fit_score, rationale, scored_at, content_hash
       FROM scores WHERE method = 'llm' AND profile_hash = ?`,
    [profileHash],
  );
  return new Map(
    rows.map((r) => [
      r.job_id,
      {
        fit: r.fit_score,
        why: r.rationale ?? "",
        profileHash,
        contentHash: r.content_hash,
        scoredAt: r.scored_at,
      },
    ]),
  );
}

/**
 * Drop judgements made about a different person, or under an older prompt.
 *
 * Also drops rows whose job is gone: purgeStaleAggregatorJobs deletes jobs
 * without knowing this table exists, and a score with no job is a row nothing
 * will ever read again.
 */
export async function deleteStaleLlmScores(db: Db, profileHash: string): Promise<void> {
  await db.run(
    `DELETE FROM scores
      WHERE method = 'llm'
        AND (profile_hash IS NULL
             OR profile_hash <> ?
             OR job_id NOT IN (SELECT id FROM jobs))`,
    [profileHash],
  );
}

// -----------------------------------------------------------------------------
// Applications
// -----------------------------------------------------------------------------

/**
 * Record that the veteran applied to a job.
 *
 * Only ever called because the person answered "Yes, I applied" — clicking
 * Apply opens a browser and proves nothing about what happened next.
 *
 * `DO NOTHING` rather than an upsert: someone who opens the same posting again
 * a fortnight later must not have an application that reached `interview`
 * dragged back to `applied`, and `applied_at` is the date they told us, not
 * the date they last looked.
 */
export async function saveApplication(
  db: Db,
  jobId: string,
  now: number,
): Promise<boolean> {
  // Read first, because the Db port exposes no rows-affected count (see
  // updateApplicationStatus). Single-writer local database, so there is no
  // race worth defending against here.
  const existing = await db.all<{ job_id: string }>(
    "SELECT job_id FROM applications WHERE job_id = ?",
    [jobId],
  );
  await db.run(
    `INSERT INTO applications (job_id, status, applied_at, updated_at)
     VALUES (?, 'applied', ?, ?)
     ON CONFLICT(job_id) DO NOTHING`,
    [jobId, now, now],
  );
  // The matching feedback row is not bookkeeping for its own sake:
  // purgeStaleAggregatorJobs spares any job that appears in `feedback`, so
  // this is what stops a tracked Adzuna listing from being deleted out from
  // under the tracker sixty days later, taking the person's record with it.
  await saveFeedback(db, jobId, "applied", now);
  // False means "already tracked, and its status was left alone" — the caller
  // may want to say so rather than imply a second application was recorded.
  return existing.length === 0;
}

/**
 * Move an application's status. Returns false when there was no such row.
 *
 * Read-then-write rather than checking rows-affected, because the `Db` port
 * returns void from `run` — both drivers underneath do report a count, but
 * widening the port for one caller is a worse trade than one extra SELECT
 * against a single-writer local database.
 *
 * The caller needs the answer: without it, tapping a status on a row that is no
 * longer there looks exactly like success, and the screen keeps showing an
 * application the database does not have.
 */
export async function updateApplicationStatus(
  db: Db,
  jobId: string,
  status: ApplicationStatus,
  now: number,
): Promise<boolean> {
  const existing = await db.all<{ job_id: string }>(
    "SELECT job_id FROM applications WHERE job_id = ?",
    [jobId],
  );
  if (existing.length === 0) return false;

  await db.run("UPDATE applications SET status = ?, updated_at = ? WHERE job_id = ?", [
    status,
    now,
    jobId,
  ]);
  return true;
}

/** Undo a mis-click, including the retention hold saveApplication took. */
export async function deleteApplication(db: Db, jobId: string): Promise<void> {
  await db.run("DELETE FROM applications WHERE job_id = ?", [jobId]);
  await removeFeedback(db, jobId, "applied");
}

/**
 * Every tracked application, newest first.
 *
 * An INNER JOIN, so an application whose job row is gone simply does not
 * appear. That cannot happen through the retention path — the feedback row
 * saveApplication writes holds the job — and showing a headless entry with no
 * title, employer or link would be worse than showing nothing.
 */
export async function listApplications(db: Db): Promise<TrackedApplication[]> {
  const rows = await db.all<
    JobRow & { status: string; applied_at: number; updated_at: number }
  >(
    `SELECT j.*, a.status, a.applied_at, a.updated_at
       FROM applications a JOIN jobs j ON j.id = a.job_id
      ORDER BY a.applied_at DESC, j.id`,
  );
  return rows.map((row) => ({
    job: rowToJob(row),
    status: row.status as ApplicationStatus,
    appliedAt: row.applied_at,
    updatedAt: row.updated_at,
  }));
}

/**
 * Job ids that already have a prepared resume or cover letter saved, so the
 * tracker can offer to reopen them without asking once per row.
 */
export async function listJobIdsWithDocuments(db: Db): Promise<ReadonlySet<string>> {
  const rows = await db.all<{ job_id: string }>(
    "SELECT DISTINCT job_id FROM documents WHERE job_id IS NOT NULL",
  );
  return new Set(rows.map((r) => r.job_id));
}

// -----------------------------------------------------------------------------
// Documents
// -----------------------------------------------------------------------------

export type DocumentKind =
  "base_resume" | "final_resume" | "tailored_resume" | "cover_letter";

export interface StoredDocument {
  readonly id: string;
  readonly kind: DocumentKind;
  readonly jobId: string | null;
  readonly version: number;
  /** JSON — ResumeData for resume kinds, CoverLetter for letters. */
  readonly content: string;
  readonly createdAt: number;
}

export async function saveDocument(
  db: Db,
  document: {
    readonly id: string;
    readonly kind: DocumentKind;
    readonly jobId: string | null;
    readonly content: string;
  },
  now: number,
): Promise<void> {
  const rows = await db.all<{ v: number | null }>(
    "SELECT MAX(version) AS v FROM documents WHERE kind = ? AND job_id IS ?",
    [document.kind, document.jobId],
  );
  const version = (rows[0]?.v ?? 0) + 1;
  // export_path is written NULL and read by nothing. It is reserved, not dead:
  // SPEC §4 lists it for the save flow, which will record where a person put
  // the file so the app can answer "where did I save it?". Kept rather than
  // dropped so that lands as one UPDATE instead of a migration.
  await db.run(
    `INSERT INTO documents (id, kind, job_id, version, content, export_path, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    [document.id, document.kind, document.jobId, version, document.content, now],
  );
}

/** The newest document of a kind (optionally for one job). */
export async function getLatestDocument(
  db: Db,
  kind: DocumentKind,
  jobId: string | null = null,
): Promise<StoredDocument | null> {
  const rows = await db.all<{
    id: string;
    kind: string;
    job_id: string | null;
    version: number;
    content: string;
    created_at: number;
  }>(
    `SELECT id, kind, job_id, version, content, created_at FROM documents
      WHERE kind = ? AND job_id IS ?
      ORDER BY version DESC LIMIT 1`,
    [kind, jobId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    kind: row.kind as DocumentKind,
    jobId: row.job_id,
    version: row.version,
    content: row.content,
    createdAt: row.created_at,
  };
}

// -----------------------------------------------------------------------------
// Chat history
// -----------------------------------------------------------------------------

export interface StoredChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly ts: number;
  /** Document this message carries (e.g. a revised resume card). */
  readonly relatedDocumentId?: string | null;
}

export async function saveChatMessage(
  db: Db,
  message: StoredChatMessage,
  relatedDocumentId: string | null = null,
): Promise<void> {
  await db.run(
    `INSERT INTO chat_messages (id, role, content, ts, related_document_id)
     VALUES (?, ?, ?, ?, ?)`,
    [message.id, message.role, message.content, message.ts, relatedDocumentId],
  );
}

export async function listRecentChatMessages(
  db: Db,
  limit: number,
): Promise<StoredChatMessage[]> {
  const rows = await db.all<{
    id: string;
    role: string;
    content: string;
    ts: number;
    related_document_id: string | null;
  }>(
    `SELECT id, role, content, ts, related_document_id FROM chat_messages
      WHERE role IN ('user', 'assistant')
      ORDER BY ts DESC, id DESC LIMIT ?`,
    [limit],
  );
  return rows.reverse().map((r) => ({
    id: r.id,
    role: r.role as "user" | "assistant",
    content: r.content,
    ts: r.ts,
    relatedDocumentId: r.related_document_id,
  }));
}

export async function getDocumentById(
  db: Db,
  id: string,
): Promise<StoredDocument | null> {
  const rows = await db.all<{
    id: string;
    kind: string;
    job_id: string | null;
    version: number;
    content: string;
    created_at: number;
  }>(
    "SELECT id, kind, job_id, version, content, created_at FROM documents WHERE id = ?",
    [id],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    kind: row.kind as DocumentKind,
    jobId: row.job_id,
    version: row.version,
    content: row.content,
    createdAt: row.created_at,
  };
}

// -----------------------------------------------------------------------------
// Runs
// -----------------------------------------------------------------------------

export async function saveRun(
  db: Db,
  id: string,
  startedAt: number,
  finishedAt: number,
  report: unknown,
): Promise<void> {
  await db.run(
    `INSERT INTO runs (id, started_at, finished_at, report) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET finished_at = excluded.finished_at, report = excluded.report`,
    [id, startedAt, finishedAt, JSON.stringify(report)],
  );
}

/**
 * The job titles behind a person's thumbs, newest first.
 *
 * Feeds `buildSearchTerms`: an up-thumb promotes that title into the next
 * search, a down-thumb drops it. See pipeline/queries.ts for why thumbs move
 * search terms rather than scores — the scoring version was measured and it
 * made the ranking worse.
 */
export async function listFeedbackTitles(
  db: Db,
  verdict: FeedbackVerdict,
  limit = 10,
): Promise<string[]> {
  const rows = await db.all<{ title: string }>(
    `SELECT j.title FROM feedback f JOIN jobs j ON j.id = f.job_id
     WHERE f.verdict = ? ORDER BY f.ts DESC LIMIT ?`,
    [verdict, limit],
  );
  return rows.map((r) => r.title).filter((t) => t.trim() !== "");
}
