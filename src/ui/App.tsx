import { useState } from "react";
import Database from "@tauri-apps/plugin-sql";

/**
 * Phase 0 placeholder.
 *
 * The button is not decoration. It does one INSERT and one SELECT through
 * @tauri-apps/plugin-sql, which is the only way to prove three things that all
 * fail *silently* otherwise:
 *
 *   1. `sql:default` does NOT include `allow-execute`. Without it, reads work
 *      and every write is rejected — which presents as a schema bug much later.
 *   2. The plugin rewrites placeholders as $1/$2, not ?.
 *   3. `PRAGMA user_version` has no declared column type, so the plugin can
 *      fail to decode it. We read it here so that surfaces now, not in Phase 2.
 *
 * Chat and Opportunities tabs arrive in Phase 3.
 */
export default function App() {
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);

  async function checkDatabase() {
    setBusy(true);
    setStatus("Checking...");
    try {
      const db = await Database.load("sqlite:cincinnatus.db");

      await db.execute(
        "CREATE TABLE IF NOT EXISTS smoke_test (id INTEGER PRIMARY KEY, note TEXT NOT NULL, at TEXT NOT NULL)",
      );
      await db.execute("DELETE FROM smoke_test");
      await db.execute("INSERT INTO smoke_test (note, at) VALUES ($1, $2)", [
        "hello",
        new Date().toISOString(),
      ]);

      const rows = await db.select<{ note: string; at: string }[]>(
        "SELECT note, at FROM smoke_test",
      );

      let version = "unknown";
      try {
        const pragma =
          await db.select<{ user_version: number }[]>("PRAGMA user_version");
        version = String(pragma[0]?.user_version ?? "unknown");
      } catch {
        // Expected on some plugin versions: PRAGMA result columns have no
        // declared type, so the decoder can reject them. Phase 1 keeps the
        // schema version in a normal table for exactly this reason.
        version = "could not read (this is a known plugin limit, not a bug)";
      }

      if (rows.length === 1 && rows[0]?.note === "hello") {
        setStatus(`The database works. Schema version: ${version}`);
      } else {
        setStatus(`Something is off. Expected 1 saved row, got ${rows.length}.`);
      }
    } catch (err) {
      setStatus(
        `The database did not work. ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 p-8">
      <h1 className="text-4xl font-bold">Cincinnatus</h1>
      <p className="text-lg">
        This app helps veterans find work. It is still being built.
      </p>

      <button
        type="button"
        onClick={checkDatabase}
        disabled={busy}
        className="rounded-lg bg-blue-700 px-6 py-4 text-lg font-semibold text-white hover:bg-blue-800 focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-400 disabled:opacity-60"
      >
        {busy ? "Checking..." : "Check the database"}
      </button>

      {status !== "" && (
        <p role="status" aria-live="polite" className="text-lg">
          {status}
        </p>
      )}
    </main>
  );
}
