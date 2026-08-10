import { getSetting, setSetting } from "../db/repo.ts";
import type { Db } from "../ports.ts";

/**
 * How many requests a keyed source has left before its provider stops
 * answering.
 *
 * Adzuna's terms set four ceilings — 25 a minute, 250 a day, 1,000 a week,
 * 2,500 a month. The per-run budget in `adzuna.ts` is bounded by construction
 * and comfortably inside all of them on the default schedule, so this is not
 * what stops the app running away. It exists for the case construction cannot
 * cover: someone pressing "Search now" because they are hopeful, several times
 * a day, for a month.
 *
 * The reason to spend code on it is not the quota. It is that a source which
 * silently stops answering looks exactly like an app that has quietly got
 * worse, and the person it happens to has no way to find out otherwise. With a
 * ledger the app can say, in plain words, that the job site has a daily limit
 * and when it resets.
 *
 * Counted per calendar day and month in UTC, in the settings table, the same
 * way `spend.ts` counts money. Deliberately approximate: it is a courtesy
 * budget, not billing.
 */

function dayKey(source: string, now: number): string {
  return `calls_${source}_${new Date(now).toISOString().slice(0, 10)}`;
}

function monthKey(source: string, now: number): string {
  return `calls_${source}_${new Date(now).toISOString().slice(0, 7)}`;
}

async function bump(db: Db, key: string, by: number): Promise<void> {
  const current = Number((await getSetting(db, key)) ?? "0");
  const total = (Number.isFinite(current) ? current : 0) + by;
  await setSetting(db, key, String(total));
}

async function read(db: Db, key: string): Promise<number> {
  const raw = await getSetting(db, key);
  if (raw === null) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export async function recordCalls(
  db: Db,
  source: string,
  calls: number,
  now: number,
): Promise<void> {
  if (calls <= 0) return;
  await bump(db, dayKey(source, now), calls);
  await bump(db, monthKey(source, now), calls);
}

export interface QuotaLimits {
  readonly perDay: number;
  readonly perMonth: number;
}

export interface QuotaStatus {
  readonly remaining: number;
  /** "day" or "month" when exhausted, else null. */
  readonly exhausted: "day" | "month" | null;
}

/**
 * Headroom left today, taking whichever ceiling bites first.
 *
 * Both are held a little under the published numbers. Adzuna counts the
 * request, not the answer, and a run that dies mid-flight still spent what it
 * sent — so a ledger that tracked the limit exactly would occasionally ask for
 * one more than was really left.
 */
export async function quotaStatus(
  db: Db,
  source: string,
  limits: QuotaLimits,
  now: number,
): Promise<QuotaStatus> {
  const [today, month] = await Promise.all([
    read(db, dayKey(source, now)),
    read(db, monthKey(source, now)),
  ]);

  const leftToday = limits.perDay - today;
  const leftThisMonth = limits.perMonth - month;
  const remaining = Math.max(0, Math.min(leftToday, leftThisMonth));

  if (remaining > 0) return { remaining, exhausted: null };
  return { remaining: 0, exhausted: leftThisMonth <= 0 ? "month" : "day" };
}

/** What to tell someone whose job site has stopped answering for now. */
export function quotaWords(exhausted: "day" | "month"): string {
  return exhausted === "day"
    ? "The extra job listings have hit their daily limit. They come back tomorrow — the jobs you already have are still here."
    : "The extra job listings have hit their limit for this month. They come back at the start of next month — the jobs you already have are still here.";
}
