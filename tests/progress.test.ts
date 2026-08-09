import { describe, expect, it } from "vitest";
import { SearchProgressTracker, remainingWords } from "../src/core/app/progress.ts";
import type { ProgressEvent } from "../src/core/ports.ts";

/**
 * The progress model is what stands between a veteran and the conclusion that
 * a twenty-minute first search is a hung app. These tests pin the parts that
 * would be wrong quietly: an estimate offered too early, a source list that
 * loses its order, and a resumed run whose rate is measured from zero.
 */

const T0 = 1_700_000_000_000;

function feed(
  tracker: SearchProgressTracker,
  events: readonly (readonly [ProgressEvent, number])[],
) {
  let last = tracker.apply(events[0]![0], events[0]![1]);
  for (const [event, at] of events.slice(1)) last = tracker.apply(event, at);
  return last;
}

describe("remainingWords", () => {
  it("says nothing rather than guessing", () => {
    expect(remainingWords(0)).toBe("");
    expect(remainingWords(-5)).toBe("");
    expect(remainingWords(Number.NaN)).toBe("");
    expect(remainingWords(Number.POSITIVE_INFINITY)).toBe("");
  });

  it("uses plain words, not digits, at the short end", () => {
    expect(remainingWords(30_000)).toBe("less than a minute left");
    expect(remainingWords(80_000)).toBe("about a minute left");
    expect(remainingWords(6 * 60_000)).toBe("about 6 minutes left");
    expect(remainingWords(3 * 3_600_000)).toBe("over an hour left");
  });
});

describe("SearchProgressTracker", () => {
  it("keeps sources in the order they were checked, one entry each", () => {
    const t = new SearchProgressTracker();
    const progress = feed(t, [
      [{ kind: "phase", phase: "finding" }, T0],
      [{ kind: "source_start", source: "gh:a", label: "Anduril" }, T0],
      [
        {
          kind: "source_done",
          source: "gh:a",
          label: "Anduril",
          fetched: 12,
          notModified: false,
        },
        T0,
      ],
      [{ kind: "source_start", source: "gh:b", label: "Rocket Lab" }, T0],
      [
        {
          kind: "source_error",
          source: "gh:b",
          label: "Rocket Lab",
          message: "timed out",
        },
        T0,
      ],
      [{ kind: "source_start", source: "gh:c", label: "Axon" }, T0],
      [
        {
          kind: "source_done",
          source: "gh:c",
          label: "Axon",
          fetched: 0,
          notModified: true,
        },
        T0,
      ],
    ]);

    expect(progress.sources.map((s) => [s.label, s.state, s.count])).toEqual([
      ["Anduril", "done", 12],
      ["Rocket Lab", "error", null],
      ["Axon", "unchanged", 0],
    ]);
  });

  it("withholds the estimate until the rate means something", () => {
    const t = new SearchProgressTracker();

    // Ten jobs in one second would extrapolate to a confident, wrong number.
    const early = feed(t, [
      [{ kind: "phase", phase: "reading" }, T0],
      [{ kind: "embed_progress", done: 0, total: 5_000 }, T0],
      [{ kind: "embed_progress", done: 10, total: 5_000 }, T0 + 1_000],
    ]);
    expect(early.remaining).toBe("");

    // 100 jobs in 10s → 0.1s each → 4,900 left ≈ 8.2 minutes.
    const later = t.apply(
      { kind: "embed_progress", done: 100, total: 5_000 },
      T0 + 10_000,
    );
    expect(later.remaining).toBe("about 8 minutes left");
  });

  it("measures a resumed run from where it actually started", () => {
    const t = new SearchProgressTracker();
    // Picks up at 4,000 of 5,000 already read. Timing this as though 4,000
    // jobs took two seconds would promise the rest in under a second.
    const progress = feed(t, [
      [{ kind: "phase", phase: "reading" }, T0],
      [{ kind: "embed_progress", done: 4_000, total: 5_000 }, T0],
      [{ kind: "embed_progress", done: 4_100, total: 5_000 }, T0 + 10_000],
    ]);
    // 100 jobs in 10s → 900 left ≈ 90s.
    expect(progress.remaining).toBe("about 2 minutes left");
  });

  it("offers no estimate outside the reading phase", () => {
    const t = new SearchProgressTracker();
    feed(t, [
      [{ kind: "phase", phase: "reading" }, T0],
      [{ kind: "embed_progress", done: 0, total: 500 }, T0],
      [{ kind: "embed_progress", done: 250, total: 500 }, T0 + 30_000],
    ]);
    const ranking = t.apply({ kind: "phase", phase: "ranking" }, T0 + 30_000);
    expect(ranking.remaining).toBe("");
  });

  it("never reports more read than there are to read", () => {
    const t = new SearchProgressTracker();
    const progress = feed(t, [
      [{ kind: "phase", phase: "reading" }, T0],
      // The last batch overshoots: the loop reports the batch boundary.
      [{ kind: "embed_progress", done: 96, total: 90 }, T0],
    ]);
    expect(progress.done).toBe(90);
    expect(progress.total).toBe(90);
  });

  it("lands on complete when the run finishes", () => {
    const t = new SearchProgressTracker();
    feed(t, [
      [{ kind: "phase", phase: "reading" }, T0],
      [{ kind: "embed_progress", done: 300, total: 900 }, T0],
    ]);
    const done = t.finish(T0 + 1_000);
    expect(done.phase).toBe("done");
    expect(done.done).toBe(900);
    expect(done.remaining).toBe("");
  });

  it("carries the pipeline's aside through without rewriting it", () => {
    const t = new SearchProgressTracker();
    const progress = t.apply(
      { kind: "note", message: "Embedding only 50 of 900 new jobs (--max-embed)." },
      T0,
    );
    expect(progress.note).toBe("Embedding only 50 of 900 new jobs (--max-embed).");
  });
});
