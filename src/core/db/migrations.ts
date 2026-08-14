import type { Db } from "../ports.ts";

/**
 * Forward-only schema migrations.
 *
 * This is the single definition of the schema. It is TypeScript rather than a
 * .sql file or a Rust-side `tauri_plugin_sql` migration list so that the app,
 * the CLI harness and vitest all get it from the same place. A .sql twin plus a
 * drift test would only create the drift it then tests for.
 *
 * The version is tracked in a table rather than `PRAGMA user_version`: PRAGMA
 * result columns carry no declared type, and @tauri-apps/plugin-sql decodes by
 * declared type, so reading it back can fail inside the app while working fine
 * in the harness.
 */

export interface Migration {
  readonly version: number;
  /** Executed in order, each as its own statement. */
  readonly statements: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    INTEGER PRIMARY KEY,
         applied_at INTEGER NOT NULL
       )`,

      // Single row, id = 1. JSON blob rather than columns because the shape is
      // still moving and nothing queries into it.
      `CREATE TABLE IF NOT EXISTS profile (
         id         INTEGER PRIMARY KEY CHECK (id = 1),
         json       TEXT NOT NULL,
         embedding  TEXT,
         embed_model TEXT,
         updated_at INTEGER NOT NULL
       )`,

      // remote, salary_* and posted_at are all nullable on purpose: null means
      // "the source did not say". Defaulting remote to 0 would assert that a job
      // is not remote when we simply do not know (constraint 4).
      `CREATE TABLE IF NOT EXISTS jobs (
         id                     TEXT PRIMARY KEY,
         source                 TEXT NOT NULL,
         external_id            TEXT NOT NULL,
         title                  TEXT NOT NULL,
         company                TEXT NOT NULL,
         location               TEXT,
         remote                 INTEGER,
         salary_min             INTEGER,
         salary_max             INTEGER,
         salary_currency        TEXT,
         salary_interval        TEXT,
         url                    TEXT NOT NULL,
         posted_at              INTEGER,
         posted_at_is_estimated INTEGER NOT NULL DEFAULT 0,
         description_text       TEXT NOT NULL,
         raw                    TEXT NOT NULL,
         embed_hash             TEXT,
         first_seen_at          INTEGER NOT NULL,
         last_seen_at           INTEGER NOT NULL,
         dedupe_key             TEXT NOT NULL,
         canonical_id           TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_jobs_dedupe_key ON jobs (dedupe_key)`,
      // The ranked list reads every non-duplicate job, so this index is what
      // keeps that a partial scan rather than a full one.
      `CREATE INDEX IF NOT EXISTS idx_jobs_canonical ON jobs (canonical_id)`,
      `CREATE INDEX IF NOT EXISTS idx_jobs_last_seen ON jobs (last_seen_at)`,
      `CREATE INDEX IF NOT EXISTS idx_jobs_embed_hash ON jobs (embed_hash)`,

      // Keyed by (content_hash, model_id), not by job id. Two postings with
      // identical text — the same requisition on two boards, or the public and
      // status-eligible pair of one federal announcement — then share a vector
      // and are embedded once. Changing model or quantisation is a new key
      // rather than a column-wide invalidation.
      `CREATE TABLE IF NOT EXISTS embeddings (
         content_hash TEXT NOT NULL,
         model_id     TEXT NOT NULL,
         dim          INTEGER NOT NULL,
         vector       TEXT NOT NULL,
         created_at   INTEGER NOT NULL,
         PRIMARY KEY (content_hash, model_id)
       )`,

      // ETag / Last-Modified per source, so a repeat run can send
      // If-None-Match and take a 304 instead of a multi-megabyte body.
      `CREATE TABLE IF NOT EXISTS source_state (
         source_key    TEXT PRIMARY KEY,
         etag          TEXT,
         last_modified TEXT,
         fetched_at    INTEGER NOT NULL
       )`,

      `CREATE TABLE IF NOT EXISTS scores (
         job_id    TEXT NOT NULL,
         method    TEXT NOT NULL CHECK (method IN ('embed', 'llm')),
         fit_score REAL NOT NULL,
         rationale TEXT,
         scored_at INTEGER NOT NULL,
         PRIMARY KEY (job_id, method)
       )`,

      `CREATE TABLE IF NOT EXISTS documents (
         id          TEXT PRIMARY KEY,
         kind        TEXT NOT NULL CHECK (kind IN
                       ('base_resume', 'final_resume', 'tailored_resume', 'cover_letter')),
         job_id      TEXT,
         version     INTEGER NOT NULL,
         content     TEXT NOT NULL,
         export_path TEXT,
         created_at  INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_documents_job ON documents (job_id)`,

      `CREATE TABLE IF NOT EXISTS chat_messages (
         id                  TEXT PRIMARY KEY,
         role                TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
         content             TEXT NOT NULL,
         ts                  INTEGER NOT NULL,
         related_document_id TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_chat_ts ON chat_messages (ts)`,

      `CREATE TABLE IF NOT EXISTS feedback (
         job_id  TEXT NOT NULL,
         verdict TEXT NOT NULL CHECK (verdict IN ('up', 'down', 'applied', 'hidden')),
         ts      INTEGER NOT NULL,
         PRIMARY KEY (job_id, verdict)
       )`,

      `CREATE TABLE IF NOT EXISTS runs (
         id          TEXT PRIMARY KEY,
         started_at  INTEGER NOT NULL,
         finished_at INTEGER,
         report      TEXT NOT NULL
       )`,

      `CREATE TABLE IF NOT EXISTS watchlist (
         ats           TEXT NOT NULL CHECK (ats IN ('greenhouse', 'lever', 'ashby')),
         slug          TEXT NOT NULL,
         company_label TEXT NOT NULL,
         board_name    TEXT,
         source        TEXT NOT NULL CHECK (source IN ('starter', 'user')),
         sector        TEXT,
         note          TEXT,
         added_at      INTEGER NOT NULL,
         PRIMARY KEY (ats, slug)
       )`,

      // API keys never go here. They live in the OS keychain or, for the
      // harness, in environment variables.
      `CREATE TABLE IF NOT EXISTS settings (
         key   TEXT PRIMARY KEY,
         value TEXT NOT NULL
       )`,
    ],
  },
  {
    version: 2,
    statements: [
      // The jobs the veteran has told us they applied to.
      //
      // Not folded into `feedback`, even though that table already has an
      // 'applied' verdict: its primary key is (job_id, verdict), so it models
      // a set of independent flags. A status that MOVES — applied, then an
      // answer, then an interview — needs one row per job that can be updated.
      // The 'applied' verdict is still written alongside, for the reason given
      // in repo.saveApplication.
      `CREATE TABLE IF NOT EXISTS applications (
         job_id     TEXT PRIMARY KEY,
         status     TEXT NOT NULL CHECK (status IN
                      ('applied', 'heard_back', 'interview', 'offer', 'closed')),
         applied_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_applications_applied ON applications (applied_at)`,
    ],
  },
  {
    version: 3,
    statements: [
      // What an LLM match score was judged against, so a stale one can be
      // told from a current one.
      //
      // profile_hash covers the person: their structured profile plus the
      // version of the prompt that read it. Re-parse a resume and the titles,
      // skills or education change, so every stored judgement about "could
      // they get this job" is about somebody slightly different and has to go.
      //
      // content_hash covers the job: the same embed hash the vector is keyed
      // by. Job rows are upserted on every fetch, so a re-served advert or an
      // edited posting changes the text the score was formed from. Without
      // this the embedding would correctly re-embed while the score and its
      // rationale stayed behind, describing text nobody can see any more.
      //
      // Both nullable: the columns arrive on a table that has always been
      // empty, and SQLite cannot add a NOT NULL column without a default.
      `ALTER TABLE scores ADD COLUMN profile_hash TEXT`,
      `ALTER TABLE scores ADD COLUMN content_hash TEXT`,
    ],
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce(
  (max, m) => (m.version > max ? m.version : max),
  0,
);

/**
 * The version the database is at, or 0 for a fresh one.
 *
 * Two things here are deliberate and were both wrong before.
 *
 * The fresh-database case is detected by asking `sqlite_master` whether the
 * table exists, not by running the read inside a `try` and treating any failure
 * as "fresh". A blanket catch cannot tell a new database from a broken one, and
 * answering 0 for a broken one means re-running every migration over it.
 *
 * The read itself selects a declared column and orders, rather than
 * `SELECT MAX(version)`. This is the same hazard the docblock at the top of
 * this file describes for PRAGMA: an aggregate is an expression column with no
 * declared type, and @tauri-apps/plugin-sql decodes by declared type, so
 * `MAX(version)` can decode badly inside the app while working perfectly in the
 * harness and in tests. Reading a column typed `INTEGER PRIMARY KEY` cannot.
 *
 * That combination used to be survivable only by luck: every v1 statement is
 * `IF NOT EXISTS`, so a spurious 0 re-ran them harmlessly. It stops being
 * survivable the moment a migration is not idempotent on its own — an
 * `ALTER TABLE` re-run throws "duplicate column name", and it would throw on
 * every boot and every search, which is a bricked app rather than a bad list.
 */
async function currentVersion(db: Db): Promise<number> {
  const table = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  );
  if (table.length === 0) return 0;

  const rows = await db.all<{ version: number }>(
    "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
  );
  return rows[0]?.version ?? 0;
}

/**
 * Bring `db` up to {@link LATEST_SCHEMA_VERSION}. Idempotent.
 *
 * @returns the version the database is at afterwards.
 */
export async function migrate(db: Db, now: number): Promise<number> {
  const from = await currentVersion(db);

  // Forward-only means an older build cannot read a newer build's database, and
  // it must say so rather than carry on: the migration loop would skip every
  // step, leave the newer tables in place, and then fail somewhere further in
  // on a column it does not know about. Reachable by sideloading an older
  // installer, or by rolling back a release.
  if (from > LATEST_SCHEMA_VERSION) {
    throw new Error(
      "Your saved jobs were made by a newer version of Cincinnatus. " +
        "Please update the app to open them.",
    );
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    for (const statement of migration.statements) {
      await db.run(statement);
    }
    await db.run(
      "INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      [migration.version, now],
    );
  }

  return LATEST_SCHEMA_VERSION;
}
