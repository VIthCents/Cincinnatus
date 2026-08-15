import type { Dispatch } from "react";
import {
  getAutoPrepCount,
  isAutoPrepDue,
  markAutoPrepRan,
  pickAutoPrepJobs,
  runAutoPrep,
} from "../../core/app/autoprep.ts";
import * as repo from "../../core/db/repo.ts";
import type { ResumeData } from "../../core/documents/types.ts";
import type { RankedJob } from "../../core/types.ts";
import { tauriClock, tauriHasher } from "../../tauri/clock.ts";
import { llmErrorMessage } from "../../tauri/llm.ts";
import { db, getLlm } from "./services.ts";
import type { Action } from "./state.tsx";

/**
 * Writes papers for the strongest new matches after a search, if the person
 * has turned that on.
 *
 * Kept out of runSearchNow's try block on purpose. Anything escaping into that
 * catch is reported as "The search hit a problem", and the search did not have
 * a problem — it finished. This contains its own failures.
 */
export async function runAutoPrepAfterSearch(
  dispatch: Dispatch<Action>,
  ranked: readonly RankedJob[],
  options: { notify?: (prepared: number) => void } = {},
): Promise<void> {
  try {
    const now = tauriClock.now();
    if (!(await isAutoPrepDue(db, now))) return;

    const llm = await getLlm();
    if (llm === null) return;

    const stored = await repo.getLatestDocument(db, "base_resume");
    if (stored === null) return;
    const baseResume = JSON.parse(stored.content) as ResumeData;

    const [withDocuments, hidden, applications] = await Promise.all([
      repo.listJobIdsWithDocuments(db),
      repo.listFeedback(db, "hidden"),
      repo.listApplications(db),
    ]);

    const jobs = pickAutoPrepJobs({
      ranked,
      count: await getAutoPrepCount(db),
      withDocuments,
      hidden,
      applied: new Set(applications.map((a) => a.job.id)),
    });
    if (jobs.length === 0) return;

    // Marked before the work, not after. Whatever happens next — success,
    // partial, or a dead key that fails everything — today's attempt has been
    // made, and re-attempting on every later search would spend real money
    // discovering the same thing again.
    await markAutoPrepRan(db, now);
    dispatch({ type: "auto_prep", running: true });

    const outcome = await runAutoPrep({
      db,
      llm,
      hasher: tauriHasher,
      now,
      baseResume,
      jobs,
    });

    if (outcome.prepared > 0) {
      dispatch({ type: "documents_changed" });
      options.notify?.(outcome.prepared);
    }

    if (outcome.stoppedEarly && outcome.prepared === 0) {
      dispatch({
        type: "search_warning",
        message: `Cincinnatus could not write papers for your top jobs. ${llmErrorMessage(outcome.lastError)}`,
      });
    }
  } catch (err) {
    // Never surfaces as a search failure: the search worked.
    console.error(err);
  } finally {
    dispatch({ type: "auto_prep", running: false });
  }
}
