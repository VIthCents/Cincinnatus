import type { Db } from "../ports.ts";
import { getSetting, setSetting } from "../db/repo.ts";

/**
 * The one-time Adzuna offer on the Jobs tab.
 *
 * Adzuna reaches the trades — driving, warehouse, maintenance — that employer
 * job boards almost never carry, but it needs a free signup, and it is
 * deliberately not in the first-run wizard (see AdzunaSection in SettingsTab).
 * So the app makes the offer once, after the person has seen a search finish.
 * Saying "no thanks" is permanent: the flag is an ordinary setting, not a
 * secret, so the settings table is the right home for it (SPEC §4).
 *
 * The offer deliberately still shows when a search found nothing. The person
 * with zero matches — the CDL driver whose jobs are all on Adzuna — is exactly
 * who it is for.
 */

const KEY_DISMISSED = "adzuna_nudge_dismissed";

/** The whole visibility rule in one testable place. */
export function shouldOfferMoreJobs(args: {
  /** A search has completed on this machine (state.hasSearched). */
  hasSearched: boolean;
  /** A run is in flight right now. */
  searching: boolean;
  adzunaConnected: boolean;
  dismissed: boolean;
}): boolean {
  return (
    args.hasSearched && !args.searching && !args.adzunaConnected && !args.dismissed
  );
}

export async function isAdzunaNudgeDismissed(db: Db): Promise<boolean> {
  return (await getSetting(db, KEY_DISMISSED)) !== null;
}

export async function dismissAdzunaNudge(db: Db): Promise<void> {
  await setSetting(db, KEY_DISMISSED, "1");
}
