import type { ProgressEvent, RunPhase } from "../ports.ts";

/**
 * Turns the pipeline's progress events into something a person can watch.
 *
 * The problem this solves: a first search embeds thousands of jobs through
 * single-threaded WASM and can run for ten to twenty minutes. A spinner and a
 * changing sentence do not tell a veteran whether the app is working or stuck,
 * and "it's just slow" is indistinguishable from "it's broken" without a
 * number that keeps moving.
 *
 * The shape here is the design system's: three named phases, a real count of
 * jobs read, and one line per job site saying whether it answered. Nothing is
 * invented — every field is either something the pipeline reported or an
 * estimate measured from this run, and estimates are withheld until they mean
 * something.
 */

/** Below this many jobs read, we don't claim to know how long it will take. */
const ETA_MIN_SAMPLE = 24;

export type SourceState = "running" | "done" | "unchanged" | "error";

export interface SourceProgress {
  readonly id: string;
  /** The employer or job site, as the user should see it written. */
  readonly label: string;
  readonly state: SourceState;
  /** Jobs this site returned. null until it has answered. */
  readonly count: number | null;
}

export interface SearchProgress {
  readonly phase: RunPhase | "done";
  /** Jobs read so far, and how many there are. null while unknown. */
  readonly done: number | null;
  readonly total: number | null;
  /** One entry per job site, in the order they were checked. */
  readonly sources: readonly SourceProgress[];
  /** Plain-words time remaining, or "" when there isn't a trustworthy one. */
  readonly remaining: string;
  /** The pipeline's last aside, if it had one. Usually "". */
  readonly note: string;
}

export const INITIAL_PROGRESS: SearchProgress = {
  phase: "finding",
  done: null,
  total: null,
  sources: [],
  remaining: "",
  note: "",
};

/** "about 3 minutes left" · "less than a minute left" · "" when unknown. */
export function remainingWords(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const minutes = ms / 60_000;
  if (minutes < 1) return "less than a minute left";
  if (minutes < 1.5) return "about a minute left";
  if (minutes < 60) return `about ${Math.round(minutes)} minutes left`;
  return "over an hour left";
}

/**
 * Accumulates events into a SearchProgress. Stateful and single-run: make one
 * per search.
 */
export class SearchProgressTracker {
  #phase: SearchProgress["phase"] = "finding";
  #done: number | null = null;
  #total: number | null = null;
  #note = "";

  // Insertion-ordered, so the list reads in the order the sites were checked.
  readonly #sources = new Map<string, SourceProgress>();

  // The estimate is measured from the moment reading began, and from the count
  // it began at — a resumed run starts partway through and must not be timed
  // as though it started at zero.
  #readStartedAt: number | null = null;
  #readStartedFrom = 0;

  /** @param now epoch ms, used only for the estimate. */
  apply(event: ProgressEvent, now: number): SearchProgress {
    switch (event.kind) {
      case "phase":
        this.#phase = event.phase;
        break;

      case "source_start":
        this.#sources.set(event.source, {
          id: event.source,
          label: event.label,
          state: "running",
          count: null,
        });
        break;

      case "source_done":
        this.#sources.set(event.source, {
          id: event.source,
          label: event.label,
          state: event.notModified ? "unchanged" : "done",
          count: event.fetched,
        });
        break;

      case "source_error":
        this.#sources.set(event.source, {
          id: event.source,
          label: event.label,
          state: "error",
          count: null,
        });
        break;

      case "embed_progress":
        if (this.#readStartedAt === null) {
          this.#readStartedAt = now;
          this.#readStartedFrom = event.done;
        }
        this.#total = event.total;
        this.#done = Math.min(event.done, event.total);
        break;

      case "note":
        this.#note = event.message;
        break;
    }

    return this.#snapshot(now);
  }

  /** Called when the run finishes, so the last phase reads as complete. */
  finish(now: number): SearchProgress {
    this.#phase = "done";
    if (this.#total !== null) this.#done = this.#total;
    return this.#snapshot(now);
  }

  #snapshot(now: number): SearchProgress {
    return {
      phase: this.#phase,
      done: this.#done,
      total: this.#total,
      sources: [...this.#sources.values()],
      remaining: this.#remaining(now),
      note: this.#note,
    };
  }

  /**
   * Estimated from the measured rate of THIS run's reading, not a guess: the
   * machine, the job count, and whether the model was already downloaded all
   * vary too much to predict up front. Withheld until enough jobs have gone
   * through to make the rate meaningful.
   */
  #remaining(now: number): string {
    if (this.#phase !== "reading") return "";
    if (this.#readStartedAt === null) return "";
    if (this.#done === null || this.#total === null) return "";

    const measured = this.#done - this.#readStartedFrom;
    if (measured < ETA_MIN_SAMPLE) return "";

    const left = this.#total - this.#done;
    if (left <= 0) return "";

    const elapsed = now - this.#readStartedAt;
    if (elapsed <= 0) return "";

    return remainingWords((elapsed / measured) * left);
  }
}
