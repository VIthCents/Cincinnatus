import { AUTO_PREP_DEFAULT_COUNT, AUTO_PREP_MAX_FAILURES } from "../config.ts";
import { writeCoverLetter } from "../documents/coverletter.ts";
import { tailorResume } from "../documents/tailor.ts";
import type { CoverLetter, ResumeData } from "../documents/types.ts";
import * as repo from "../db/repo.ts";
import { matchLevel } from "../pipeline/match.ts";
import type { Db, Hasher, Llm, Reporter } from "../ports.ts";
import type { Job, RankedJob } from "../types.ts";

/**
 * Papers written ahead of being asked for (SPEC §7).
 *
 * The whole feature spends the veteran's own credits without them pressing
 * anything, which is why it is off unless they turn it on, why it runs at most
 * once a day, and why it only ever touches jobs the interface already calls a
 * strong match. See docs/DECISIONS.md — SPEC says "default 3" and this ships
 * defaulting to none, deliberately.
 */

export const KEY_AUTO_PREP_COUNT = "auto_prep_count";
export const KEY_AUTO_PREP_LAST_RAN = "auto_prep_last_ran";

/** The UTC day, as a key. Same idiom as the Adzuna quota ledger. */
function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export async function getAutoPrepCount(db: Db): Promise<number> {
  const raw = await repo.getSetting(db, KEY_AUTO_PREP_COUNT);
  if (raw === null) return AUTO_PREP_DEFAULT_COUNT;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : AUTO_PREP_DEFAULT_COUNT;
}

export async function setAutoPrepCount(db: Db, count: number): Promise<void> {
  await repo.setSetting(db, KEY_AUTO_PREP_COUNT, String(Math.max(0, count)));
}

export async function markAutoPrepRan(db: Db, now: number): Promise<void> {
  await repo.setSetting(db, KEY_AUTO_PREP_LAST_RAN, dayKey(now));
}

/**
 * Whether to write anything today.
 *
 * Once per UTC day at most, however many searches run. The person is asked for
 * nothing here; the only signal is the count they set in Settings.
 */
export async function isAutoPrepDue(db: Db, now: number): Promise<boolean> {
  if ((await getAutoPrepCount(db)) <= 0) return false;
  const last = await repo.getSetting(db, KEY_AUTO_PREP_LAST_RAN);
  return last !== dayKey(now);
}

/**
 * Which jobs to write for: the strongest matches at the top of the list that
 * nothing has been written for yet.
 *
 * Strong only. Spending somebody's money unasked on a job the interface itself
 * would call "worth a look" is not a favour, and the badge is the one judgement
 * this app has actually measured.
 */
export function pickAutoPrepJobs(args: {
  readonly ranked: readonly RankedJob[];
  readonly count: number;
  readonly withDocuments: ReadonlySet<string>;
  readonly hidden: ReadonlySet<string>;
  readonly applied: ReadonlySet<string>;
}): readonly Job[] {
  if (args.count <= 0) return [];

  const out: Job[] = [];
  for (const entry of args.ranked) {
    if (out.length >= args.count) break;
    const id = entry.job.id;
    if (matchLevel(entry.fitScore) !== "strong") continue;
    if (args.withDocuments.has(id)) continue;
    if (args.hidden.has(id)) continue;
    // Already applied: papers written now would be for something already sent.
    if (args.applied.has(id)) continue;
    out.push(entry.job);
  }
  return out;
}

export interface AutoPrepOutcome {
  readonly prepared: number;
  readonly failed: number;
  /** True when it gave up before working through the whole list. */
  readonly stoppedEarly: boolean;
  /** The last failure, for the caller to put into plain words. */
  readonly lastError: unknown;
}

/**
 * Write a tailored resume and a cover letter for each job, and save them.
 *
 * Both documents or neither. saveTailoredDocuments accepts a null letter and
 * listJobIdsWithDocuments counts any document at all, so saving a lone resume
 * would mark the job "done" forever and this would never come back to finish
 * the letter. A job whose letter fails counts as that job's failure.
 *
 * Two failures stop the run. One flaky job should not cost the rest; but a dead
 * key or spent credits fails every job identically, and finding that out twice
 * is enough.
 */
export async function runAutoPrep(args: {
  readonly db: Db;
  readonly llm: Llm;
  readonly hasher: Hasher;
  readonly now: number;
  readonly baseResume: ResumeData;
  readonly jobs: readonly Job[];
  readonly reporter?: Reporter;
}): Promise<AutoPrepOutcome> {
  let prepared = 0;
  let failed = 0;
  let lastError: unknown = null;

  for (const job of args.jobs) {
    if (failed >= AUTO_PREP_MAX_FAILURES) {
      return { prepared, failed, stoppedEarly: true, lastError };
    }

    try {
      // The no-fabrication check runs inside both of these (constraint 4).
      // Findings ride along on the documents and are recomputed when a human
      // opens them, which is the first moment anyone can confirm anything.
      const resume = await tailorResume(args.llm, args.baseResume, job);
      const letter = await writeCoverLetter(args.llm, args.baseResume, job);

      await saveTailoredPair(args.db, args.hasher, args.now, job.id, {
        resume: resume.document,
        letter: letter.document,
      });
      prepared += 1;
      args.reporter?.({
        kind: "note",
        message: `Wrote papers for ${job.title} at ${job.company}.`,
      });
    } catch (err) {
      failed += 1;
      lastError = err;
    }
  }

  return { prepared, failed, stoppedEarly: false, lastError };
}

/**
 * Persist a tailored resume and its cover letter together.
 *
 * Lives in core so both the on-demand path and auto-prep produce identical
 * rows — same id shape, same kinds, same version bump.
 */
export async function saveTailoredPair(
  db: Db,
  hasher: Hasher,
  now: number,
  jobId: string,
  documents: { readonly resume: ResumeData; readonly letter: CoverLetter | null },
): Promise<void> {
  await repo.saveDocument(
    db,
    {
      id: hasher.sha256Hex(`tailored:${jobId}:${String(now)}`),
      kind: "tailored_resume",
      jobId,
      content: JSON.stringify(documents.resume),
    },
    now,
  );
  if (documents.letter !== null) {
    await repo.saveDocument(
      db,
      {
        id: hasher.sha256Hex(`letter:${jobId}:${String(now)}`),
        kind: "cover_letter",
        jobId,
        content: JSON.stringify(documents.letter),
      },
      now,
    );
  }
}
