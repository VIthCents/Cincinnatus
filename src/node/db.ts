import { DatabaseSync } from "node:sqlite";
import type { Db, SqlValue } from "../core/ports.ts";

/**
 * Db adapter over `node:sqlite`, the driver built into Node 24.
 *
 * Chosen over better-sqlite3 to avoid a ~27 MB native dependency for what is a
 * standard-library feature on our minimum Node version. See docs/DECISIONS.md.
 *
 * The port is async and this driver is synchronous. That mismatch is fine and
 * deliberate: the app's driver (@tauri-apps/plugin-sql) really is async, so the
 * port has to be, and wrapping sync calls in resolved promises costs nothing.
 */
export class NodeDb implements Db {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);

    // WAL plus synchronous=NORMAL is the standard safe pairing. Without it,
    // SQLite fsyncs on every commit; a run that inserts thousands of jobs then
    // spends minutes in pure I/O and looks like a hang.
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#db.exec("PRAGMA busy_timeout = 5000");
  }

  run(sql: string, params: readonly SqlValue[] = []): Promise<void> {
    this.#db.prepare(sql).run(...(params as SqlValue[]));
    return Promise.resolve();
  }

  /**
   * One transaction for the whole batch.
   *
   * This is why `runMany` exists on the port instead of a `transaction()`
   * method: batching has to happen where the driver actually supports it. The
   * Tauri adapter cannot do this safely (pooled connections) and runs a
   * sequential loop instead.
   */
  runMany(sql: string, rows: readonly (readonly SqlValue[])[]): Promise<void> {
    if (rows.length === 0) return Promise.resolve();

    const stmt = this.#db.prepare(sql);
    this.#db.exec("BEGIN");
    try {
      for (const row of rows) {
        stmt.run(...(row as SqlValue[]));
      }
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
    return Promise.resolve();
  }

  all<T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    const rows = this.#db.prepare(sql).all(...(params as SqlValue[]));
    return Promise.resolve(rows as T[]);
  }

  close(): void {
    this.#db.close();
  }
}
