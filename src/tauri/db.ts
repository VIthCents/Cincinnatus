import Database from "@tauri-apps/plugin-sql";
import type { Db, SqlValue } from "../core/ports.ts";

/**
 * Db adapter over @tauri-apps/plugin-sql.
 *
 * Core writes SQL with `?` placeholders; plugin-sql's sqlite dialect wants
 * $1/$2. The rewrite is a plain left-to-right substitution, which is safe
 * because repo.ts never puts a literal question mark inside a SQL string — and
 * tests/tauriDb.test.ts pins that rewrite so a future literal `?` breaks loudly.
 *
 * What this adapter must NOT do (verified limits, see docs/DECISIONS.md):
 *  - No BLOBs. plugin-sql cannot bind binary; embeddings are base64 TEXT.
 *  - No BEGIN/COMMIT. The plugin runs a connection pool, so a transaction's
 *    statements can land on different connections and a ROLLBACK silently
 *    no-ops (plugins-workspace#886). runMany is a sequential loop instead —
 *    slower than the harness, fine for the app's incremental writes.
 */

export function toDollarPlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
}

export class TauriDb implements Db {
  #db: Database | null = null;
  readonly #name: string;

  /** @param name Database file name, e.g. "cincinnatus.db". Lands in the app config dir. */
  constructor(name = "cincinnatus.db") {
    this.#name = name;
  }

  async #connection(): Promise<Database> {
    if (this.#db === null) {
      this.#db = await Database.load(`sqlite:${this.#name}`);
    }
    return this.#db;
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<void> {
    const db = await this.#connection();
    await db.execute(toDollarPlaceholders(sql), [...params]);
  }

  async runMany(sql: string, rows: readonly (readonly SqlValue[])[]): Promise<void> {
    if (rows.length === 0) return;
    const db = await this.#connection();
    const rewritten = toDollarPlaceholders(sql);
    for (const row of rows) {
      await db.execute(rewritten, [...row]);
    }
  }

  async all<T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    const db = await this.#connection();
    return db.select<T[]>(toDollarPlaceholders(sql), [...params]);
  }
}
