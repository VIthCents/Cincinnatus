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
         source        TEXT NOT NULL CHECK (source IN ('starter', 'user')),
         sector        TEXT,
         note          TEXT,
         added_at      INTEGER NOT NULL,
         PRIMARY KEY (ats, slug)
       )`,

      // API keys never go here. They live in the OS keychain (Phase 4) or, for
      // the harness, in environment variables.
      `CREATE TABLE IF NOT EXISTS settings (
         key   TEXT PRIMARY KEY,
         value TEXT NOT NULL
       )`,
    ],
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce(
  (max, m) => (m.version > max ? m.version : max),
  0,
);

async function currentVersion(db: Db): Promise<number> {
  try {
    const rows = await db.all<{ version: number }>(
      "SELECT MAX(version) AS version FROM schema_migrations",
    );
    return rows[0]?.version ?? 0;
  } catch {
    // Table does not exist yet — this is a fresh database.
    return 0;
  }
}

/**
 * Bring `db` up to {@link LATEST_SCHEMA_VERSION}. Idempotent.
 *
 * @returns the version the database is at afterwards.
 */
export async function migrate(db: Db, now: number): Promise<number> {
  const from = await currentVersion(db);

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
