import type { Db } from "../ports.ts";
import { getSetting, setSetting } from "../db/repo.ts";

/**
 * Scheduler policy. The Rust side is only a metronome (a tick every half
 * hour); whether a search is actually due is decided here, where it can read
 * settings and be unit-tested.
 *
 * Default: every 6 hours, plus on launch, plus the tray's "Search for jobs
 * now" (SPEC §5).
 */

export const DEFAULT_INTERVAL_HOURS = 6;

const KEY_INTERVAL = "search_interval_hours";
const KEY_LAST_RUN = "last_search_at";

export function isSearchDue(
  lastRunAt: number | null,
  intervalHours: number,
  now: number,
): boolean {
  if (intervalHours <= 0) return false; // 0 = schedule turned off
  if (lastRunAt === null) return true;
  return now - lastRunAt >= intervalHours * 60 * 60 * 1000;
}

export async function getIntervalHours(db: Db): Promise<number> {
  const raw = await getSetting(db, KEY_INTERVAL);
  if (raw === null) return DEFAULT_INTERVAL_HOURS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_INTERVAL_HOURS;
}

export async function setIntervalHours(db: Db, hours: number): Promise<void> {
  await setSetting(db, KEY_INTERVAL, String(hours));
}

export async function getLastRunAt(db: Db): Promise<number | null> {
  const raw = await getSetting(db, KEY_LAST_RUN);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function markRunNow(db: Db, now: number): Promise<void> {
  await setSetting(db, KEY_LAST_RUN, String(now));
}

/** One call for the tick handler: is a scheduled search due right now? */
export async function isScheduledSearchDue(db: Db, now: number): Promise<boolean> {
  const interval = await getIntervalHours(db);
  const lastRun = await getLastRunAt(db);
  return isSearchDue(lastRun, interval, now);
}
