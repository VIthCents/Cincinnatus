import { describe, it, expect } from "vitest";
import {
  ageInDays,
  blend,
  fitFromSimilarity,
  freshnessFactor,
} from "../src/core/pipeline/score.ts";
import { assignCanonicals } from "../src/core/pipeline/dedupe.ts";
import { isWithinReach, rankJobs } from "../src/core/pipeline/rank.ts";
import {
  FRESHNESS_FLOOR,
  MAX_AGE_DAYS,
  MIN_FIT_FOR_WIDENING,
} from "../src/core/config.ts";
import { GOOD_MATCH_FIT, STRONG_MATCH_FIT } from "../src/core/pipeline/match.ts";
import type { Job, Profile } from "../src/core/types.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-08-08T12:00:00Z");

function job(overrides: Partial<Job> & { id: string }): Job {
  return {
    source: "greenhouse",
    externalId: overrides.id,
    title: "Truck Driver",
    company: "Acme",
    location: "Austin, TX",
    remote: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryInterval: null,
    url: "https://example.test/j",
    postedAt: NOW,
    postedAtIsEstimated: false,
    descriptionText: "drive a truck",
    raw: "{}",
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    dedupeKey: `k-${overrides.id}`,
    canonicalId: null,
    ...overrides,
  };
}

const profile: Profile = {
  titles: ["Truck Driver"],
  skills: [],
  mocCodes: [],
  branch: null,
  clearance: null,
  education: [],
  yearsExperience: null,
  location: { city: "Austin", state: "TX" },
  radiusMiles: 50,
  remotePreference: "any",
  salaryFloor: null,
  excludedKeywords: [],
};

describe("age and freshness", () => {
  it("clamps a future posting date to zero days rather than going negative", () => {
    expect(ageInDays(NOW, NOW + 5 * DAY)).toBe(0);
  });

  it("clamps very old postings so the decay cannot underflow to zero", () => {
    // Without the clamp, exp(-1800/7) is 0 and every ancient job ties at a
    // final score of exactly 0, making their order arbitrary.
    expect(ageInDays(NOW, NOW - 5000 * DAY)).toBe(MAX_AGE_DAYS);
    expect(freshnessFactor(ageInDays(NOW, NOW - 5000 * DAY))).toBeGreaterThan(0);
  });

  it("decays monotonically", () => {
    const ages = [0, 1, 7, 14, 30, 90];
    const values = ages.map(freshnessFactor);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeLessThan(values[i - 1] ?? Infinity);
    }
  });
});

describe("fit score", () => {
  it("clamps a negative similarity to zero rather than mapping it mid-range", () => {
    // An anti-correlated job is not a 50% match.
    expect(fitFromSimilarity(-0.4)).toBe(0);
    expect(fitFromSimilarity(0)).toBe(0);
    expect(fitFromSimilarity(1)).toBe(100);
  });
});

describe("the blend", () => {
  /**
   * This file used to assert the opposite — that a fresh weak match SHOULD beat
   * a stale strong one — under the heading "this is the assertion that matters".
   * It was the bug, written down as intended behaviour, which is why nothing
   * caught it. Measured 2026-08-09: with the old unbounded decay, the single
   * best semantic match in a 5,293-job corpus sat at final-rank 1,921, and the
   * final score correlated 0.99 with age and 0.15 with fit.
   */
  it("does not let a fresher, weaker match bury a much stronger one", () => {
    expect(blend(90, freshnessFactor(21))).toBeGreaterThan(
      blend(60, freshnessFactor(0)),
    );
  });

  it("still lets freshness separate two comparable jobs", () => {
    expect(blend(60, freshnessFactor(0))).toBeGreaterThan(
      blend(58, freshnessFactor(30)),
    );
  });

  it("still prefers the stronger match when both are equally fresh", () => {
    expect(blend(90, freshnessFactor(3))).toBeGreaterThan(
      blend(60, freshnessFactor(3)),
    );
  });

  /**
   * The guarantee the floor exists to provide: a job sitting exactly on the
   * strong band, at any age, still scores at or above the good band. Age
   * reorders inside a band; it never carries a job across one.
   *
   * Written against the band constants rather than the numbers they hold today.
   * The literals here used to be 55 and 40, and stayed 55 and 40 after the
   * bands were re-measured to 60 and 48 — the assertion kept passing and
   * stopped meaning anything, which is how the floor came to be wrong.
   *
   * The margin is thin on purpose: freshness never quite reaches the floor,
   * because MAX_AGE_DAYS clamps the decay short of it. That is what makes this
   * a strict inequality rather than an equality.
   */
  it("never lets age overturn a badge-level difference in fit", () => {
    const oldest = freshnessFactor(MAX_AGE_DAYS);
    expect(blend(STRONG_MATCH_FIT, oldest)).toBeGreaterThan(
      blend(GOOD_MATCH_FIT, freshnessFactor(0)),
    );
    expect(oldest).toBeGreaterThanOrEqual(FRESHNESS_FLOOR);
  });

  /**
   * The invariant behind the number, so the floor cannot silently fall out of
   * step with the bands again: whatever the bands become, the floor must be at
   * least their ratio.
   */
  it("keeps the floor at or above the ratio of the badge bands", () => {
    expect(FRESHNESS_FLOOR).toBeGreaterThanOrEqual(GOOD_MATCH_FIT / STRONG_MATCH_FIT);
  });

  it("asks the same question for widening that the badge answers", () => {
    expect(MIN_FIT_FOR_WIDENING).toBe(GOOD_MATCH_FIT);
  });
});

describe("dedupe", () => {
  it("keeps the earliest first_seen as canonical", () => {
    const older = job({ id: "b", firstSeenAt: NOW - 10 * DAY, dedupeKey: "same" });
    const newer = job({ id: "a", firstSeenAt: NOW, dedupeKey: "same" });
    const { canonicalOf, collapsed } = assignCanonicals([newer, older]);
    expect(collapsed).toBe(1);
    expect(canonicalOf.get("a")).toBe("b");
  });

  it("elects the same winner regardless of input order", () => {
    // Without the id tiebreak the winner depends on the order sources happened
    // to return, and the ranked list reshuffles between runs for no reason.
    const a = job({ id: "aaa", firstSeenAt: NOW, dedupeKey: "same" });
    const b = job({ id: "bbb", firstSeenAt: NOW, dedupeKey: "same" });
    const c = job({ id: "ccc", firstSeenAt: NOW, dedupeKey: "same" });

    const orders = [
      [a, b, c],
      [c, b, a],
      [b, a, c],
      [c, a, b],
    ];
    const winners = orders.map((order) => {
      const { canonicalOf } = assignCanonicals(order);
      return [...new Set(canonicalOf.values())][0];
    });
    expect(new Set(winners).size).toBe(1);
    expect(winners[0]).toBe("aaa");
  });

  it("leaves distinct jobs alone", () => {
    const { collapsed } = assignCanonicals([job({ id: "a" }), job({ id: "b" })]);
    expect(collapsed).toBe(0);
  });
});

describe("location reach", () => {
  it("counts a remote job as reachable from anywhere", () => {
    expect(
      isWithinReach(job({ id: "a", remote: true, location: "Remote" }), profile),
    ).toBe(true);
  });

  it("matches on city and on a whole-word state code", () => {
    expect(isWithinReach(job({ id: "a", location: "Austin, TX" }), profile)).toBe(true);
    expect(isWithinReach(job({ id: "b", location: "Dallas, TX" }), profile)).toBe(true);
    expect(isWithinReach(job({ id: "c", location: "Boston, MA" }), profile)).toBe(
      false,
    );
  });

  it("does not let a state code match inside another word", () => {
    // "TX" must not match "Texarkana"; more importantly "CA" must not match
    // "Carlsbad" or "Chicago" for a California profile.
    const ca: Profile = { ...profile, location: { city: "San Diego", state: "CA" } };
    expect(isWithinReach(job({ id: "a", location: "Chicago, IL" }), ca)).toBe(false);
    expect(isWithinReach(job({ id: "b", location: "Carlsbad, NM" }), ca)).toBe(false);
    expect(isWithinReach(job({ id: "c", location: "Carlsbad, CA" }), ca)).toBe(true);
  });
});

describe("rankJobs", () => {
  const vectors = new Map<string, Float32Array>();
  const profileVector = new Float32Array([1, 0]);
  vectors.set("near-strong", new Float32Array([1, 0]));
  vectors.set("near-weak", new Float32Array([0.2, 0.98]));
  vectors.set("far-strong", new Float32Array([1, 0]));

  /** Every listed id matches the profile exactly, so its fit is 100. */
  const strongVectors = (ids: readonly string[]) =>
    new Map(ids.map((id) => [id, new Float32Array([1, 0])]));

  it("filters to reachable jobs when enough of them are good matches", () => {
    const ids = Array.from({ length: 15 }, (_, i) => `near-${i}`);
    const jobs = ids.map((id, i) =>
      job({ id, location: "Austin, TX", dedupeKey: `k${i}` }),
    );
    const result = rankJobs({
      jobs,
      vectors: strongVectors(ids),
      profileVector,
      profile,
      now: NOW,
    });
    expect(result.widenedBeyondRadius).toBe(false);
    expect(result.ranked).toHaveLength(15);
  });

  /**
   * The bug this replaced: widening used to trigger on how many jobs were
   * nearby, so a long list of nearby jobs that fit nobody read as "plenty here"
   * and the search never widened. Measured 2026-08-09, a CDL driver in
   * Fayetteville NC had 318 nearby jobs, none of them work a driver could do,
   * while the corpus held a "Class A Driver" posting they were never shown.
   */
  it("widens when there are plenty of jobs nearby but none worth applying to", () => {
    const jobs = [
      ...Array.from({ length: 40 }, (_, i) =>
        job({ id: `near-poor-${i}`, location: "Austin, TX", dedupeKey: `np${i}` }),
      ),
      job({ id: "far-strong", location: "Boston, MA", dedupeKey: "fs" }),
    ];
    // Only the distant job matches; the 40 nearby ones score near zero.
    const vecs = new Map<string, Float32Array>([
      ["far-strong", new Float32Array([1, 0])],
      ...jobs
        .filter((j) => j.id.startsWith("near-poor"))
        .map((j) => [j.id, new Float32Array([0.05, 0.999])] as const),
    ]);

    const result = rankJobs({ jobs, vectors: vecs, profileVector, profile, now: NOW });

    expect(result.reachable).toBe(40);
    expect(result.widenedBeyondRadius).toBe(true);
    expect(result.ranked[0]?.job.id).toBe("far-strong");
  });

  it("widens beyond the radius rather than showing an almost-empty list", () => {
    const jobs = [
      job({ id: "near-strong", location: "Austin, TX" }),
      ...Array.from({ length: 20 }, (_, i) =>
        job({ id: `far-${i}`, location: "Boston, MA", dedupeKey: `f${i}` }),
      ),
    ];
    const result = rankJobs({ jobs, vectors, profileVector, profile, now: NOW });
    expect(result.widenedBeyondRadius).toBe(true);
    expect(result.ranked.length).toBe(21);
  });

  it("excludes collapsed duplicates", () => {
    const jobs = [
      job({ id: "a" }),
      job({ id: "b", canonicalId: "a" }),
      ...Array.from({ length: 12 }, (_, i) => job({ id: `n${i}`, dedupeKey: `k${i}` })),
    ];
    const result = rankJobs({
      jobs,
      vectors: new Map(),
      profileVector,
      profile,
      now: NOW,
    });
    expect(result.ranked.map((r) => r.job.id)).not.toContain("b");
  });

  it("honours excluded keywords on whole words only", () => {
    const withExclusion: Profile = { ...profile, excludedKeywords: ["sales"] };
    const jobs = [
      job({ id: "a", title: "Sales Representative" }),
      job({ id: "b", title: "Salesforce Administrator", dedupeKey: "k2" }),
      ...Array.from({ length: 12 }, (_, i) =>
        job({ id: `n${i}`, dedupeKey: `k${i}x` }),
      ),
    ];
    const ids = rankJobs({
      jobs,
      vectors: new Map(),
      profileVector,
      profile: withExclusion,
      now: NOW,
    }).ranked.map((r) => r.job.id);

    expect(ids).not.toContain("a");
    expect(ids).toContain("b");
  });

  it("reports the fit distribution so a collapsed spread is visible", () => {
    const jobs = [
      job({ id: "near-strong" }),
      job({ id: "near-weak", dedupeKey: "k2" }),
      ...Array.from({ length: 12 }, (_, i) =>
        job({ id: `n${i}`, dedupeKey: `k${i}y` }),
      ),
    ];
    const result = rankJobs({ jobs, vectors, profileVector, profile, now: NOW });
    expect(result.fit).not.toBeNull();
    expect(result.fit?.max).toBeGreaterThan(result.fit?.min ?? 0);
  });

  it("falls back to first_seen when the source gave no posting date", () => {
    const jobs = [
      job({
        id: "a",
        postedAt: null,
        postedAtIsEstimated: true,
        firstSeenAt: NOW - 3 * DAY,
      }),
      ...Array.from({ length: 12 }, (_, i) =>
        job({ id: `n${i}`, dedupeKey: `k${i}z` }),
      ),
    ];
    const result = rankJobs({
      jobs,
      vectors: new Map(),
      profileVector,
      profile,
      now: NOW,
    });
    const entry = result.ranked.find((r) => r.job.id === "a");
    expect(entry?.ageDays).toBeCloseTo(3, 5);
  });

  it("counts reachable jobs against all candidates, not against the filtered list", () => {
    // When the filter applies, `ranked` already contains only reachable jobs,
    // so reporting reachable/ranked always prints "N of N" and tells the user
    // nothing. The honest denominator is everything considered.
    const nearIds = Array.from({ length: 12 }, (_, i) => `near${i}`);
    const jobs = [
      ...nearIds.map((id, i) =>
        job({ id, location: "Austin, TX", dedupeKey: `n${i}` }),
      ),
      ...Array.from({ length: 40 }, (_, i) =>
        job({ id: `far${i}`, location: "Boston, MA", dedupeKey: `f${i}` }),
      ),
    ];
    const result = rankJobs({
      jobs,
      vectors: strongVectors(nearIds),
      profileVector,
      profile,
      now: NOW,
    });

    expect(result.widenedBeyondRadius).toBe(false);
    expect(result.candidates).toBe(52);
    expect(result.reachable).toBe(12);
    expect(result.ranked).toHaveLength(12);
    expect(result.reachable).toBeLessThan(result.candidates);
  });

  it("is deterministic for equal scores", () => {
    const jobs = Array.from({ length: 12 }, (_, i) =>
      job({ id: `z${i}`, dedupeKey: `d${i}` }),
    );
    const once = rankJobs({
      jobs,
      vectors: new Map(),
      profileVector,
      profile,
      now: NOW,
    });
    const twice = rankJobs({
      jobs: [...jobs].reverse(),
      vectors: new Map(),
      profileVector,
      profile,
      now: NOW,
    });
    expect(once.ranked.map((r) => r.job.id)).toEqual(twice.ranked.map((r) => r.job.id));
  });
});
