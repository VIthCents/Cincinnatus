import type { Dispatch } from "react";
import { SearchProgressTracker } from "../../core/app/progress.ts";
import * as repo from "../../core/db/repo.ts";
import type { ProgressEvent } from "../../core/ports.ts";
import { db, runSearch } from "./services.ts";
import type { Action } from "./state.tsx";

/**
 * The one way a search runs outside the wizard — used by the Jobs tab button,
 * the tray's "Search for jobs now", the scheduler tick, and the chat chip.
 * Serialized: a second request while one is running is ignored rather than
 * queued, because the second run would just re-fetch the same boards.
 */

let searchInFlight = false;

export async function runSearchNow(
  dispatch: Dispatch<Action>,
  options: { notify?: (newJobs: number) => void } = {},
): Promise<void> {
  if (searchInFlight) return;

  const profile = await repo.getStoredProfile(db);
  if (profile === null) {
    dispatch({
      type: "search_failed",
      message: "Finish the setup first, then I can search.",
    });
    return;
  }

  searchInFlight = true;
  dispatch({ type: "search_start" });

  const tracker = new SearchProgressTracker();

  const report = (event: ProgressEvent): void => {
    dispatch({ type: "search_progress", progress: tracker.apply(event, Date.now()) });
  };

  try {
    const { report: runReport, ranked } = await runSearch(profile, report);
    dispatch({
      type: "search_done",
      ranked: [...ranked],
      report: runReport,
      warning: sourceTroubleWords(runReport),
    });
    options.notify?.(runReport.jobsNew);
  } catch (err) {
    dispatch({
      type: "search_failed",
      message: `The search hit a problem: ${err instanceof Error ? err.message : String(err)}. Try again in a bit.`,
    });
  } finally {
    searchInFlight = false;
  }
}

/**
 * A search where some (or all) job sites failed must say so — a quietly
 * shorter list looks identical to a healthy one, and a fully failed search
 * would otherwise present as "no jobs match you".
 */
export function sourceTroubleWords(report: {
  readonly sources: readonly { readonly error: string | null }[];
}): string {
  const failed = report.sources.filter((s) => s.error !== null).length;
  const total = report.sources.length;
  if (failed === 0) return "";
  if (failed === total) {
    return "I could not reach any of the job sites this time. Check your internet connection and try again in a few minutes.";
  }
  const plural = failed === 1 ? "1 job site" : `${failed} job sites`;
  return `${plural} could not be checked this time. The jobs below came from the others — search again later to catch up.`;
}
