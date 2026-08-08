import type { Job } from "../types.ts";

/**
 * Collapse the same job appearing more than once.
 *
 * Two common causes: one requisition posted to two boards, and a federal
 * announcement published twice (once open to the public, once to status
 * candidates). SPEC section 4: exact on id, fuzzy on
 * normalize(company) + normalize(title) + metro, keeping the earliest
 * first_seen.
 *
 * The grouping key is computed in normalize.ts and stored on the row, so this
 * step is a group-by rather than an O(n²) similarity sweep.
 */

export interface DedupeResult {
  /** duplicate job id -> the id it defers to. */
  readonly canonicalOf: ReadonlyMap<string, string>;
  readonly collapsed: number;
}

/**
 * Pick one winner per dedupe group.
 *
 * Election is by (earliest firstSeenAt, then lowest id). The id tiebreak is not
 * decoration: without it the winner depends on the order jobs happen to arrive
 * from the sources, so the ranked list would reshuffle between runs for no
 * visible reason. Sorting on a total order makes the result identical for any
 * input permutation.
 */
export function assignCanonicals(jobs: readonly Job[]): DedupeResult {
  const groups = new Map<string, Job[]>();

  for (const job of jobs) {
    const group = groups.get(job.dedupeKey);
    if (group === undefined) groups.set(job.dedupeKey, [job]);
    else group.push(job);
  }

  const canonicalOf = new Map<string, string>();
  let collapsed = 0;

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    const sorted = [...group].sort((a, b) => {
      if (a.firstSeenAt !== b.firstSeenAt) return a.firstSeenAt - b.firstSeenAt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    const winner = sorted[0];
    if (winner === undefined) continue;

    for (let i = 1; i < sorted.length; i++) {
      const loser = sorted[i];
      if (loser === undefined) continue;
      canonicalOf.set(loser.id, winner.id);
      collapsed++;
    }
  }

  return { canonicalOf, collapsed };
}
