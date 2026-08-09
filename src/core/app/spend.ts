import type { Db } from "../ports.ts";
import { getSetting, setSetting } from "../db/repo.ts";

/**
 * The plain-language running cost estimate (SPEC §7: "AI used this month:
 * about $1.20"). An estimate from list prices, accumulated per calendar month
 * in the settings table — the billing truth lives in the user's own Anthropic
 * console, and the UI says so.
 */

function monthKey(now: number): string {
  const date = new Date(now);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `ai_spend_usd_${date.getUTCFullYear()}-${month}`;
}

export async function recordSpend(db: Db, now: number, usd: number): Promise<void> {
  if (usd <= 0) return;
  const key = monthKey(now);
  const current = Number((await getSetting(db, key)) ?? "0");
  const total = (Number.isFinite(current) ? current : 0) + usd;
  await setSetting(db, key, total.toFixed(6));
}

export async function getMonthSpend(db: Db, now: number): Promise<number> {
  const raw = await getSetting(db, monthKey(now));
  if (raw === null) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** "nothing yet" | "less than 5 cents" | "about $1.20" */
export function spendInWords(usd: number): string {
  if (usd <= 0) return "nothing yet";
  if (usd < 0.05) return "less than 5 cents";
  return `about $${usd.toFixed(2)}`;
}
