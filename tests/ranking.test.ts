import { describe, it, expect } from "vitest";
import {
  ageInDays,
  blend,
  fitFromSimilarity,
  freshnessFactor,
} from "../src/core/pipeline/score.ts";
import { assignCanonicals } from "../src/core/pipeline/dedupe.ts";
import { isWithinReach, rankJobs } from "../src/core/pipeline/rank.ts";
import { MAX_AGE_DAYS } from "../src/core/config.ts";
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
  it("lets a fresher, weaker match beat a stale, stronger one", () => {
    // This is the assertion that matters. Pinning exp(-7/7) to 0.3678 tests
    // Math.exp; this tests the product actually reorders the list.
    const freshWeak = blend(60, freshnessFactor(0));
    const staleStrong = blend(90, freshnessFactor(21));
    expect(freshWeak).toBeGreaterThan(staleStrong);
  });

  it("still prefers the stronger match when both are equally fresh", () => {
    expect(blend(90, freshnessFactor(3))).toBeGreaterThan(
      blend(60, freshnessFactor(3)),
    );
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

  it("filters to reachable jobs when there are enough of them", () => {
    const jobs = Array.from({ length: 15 }, (_, i) =>
      job({ id: `near-${i}`, location: "Austin, TX", dedupeKey: `k${i}` }),
    );
    const result = rankJobs({
      jobs,
      vectors: new Map(),
      profileVector,
      profile,
      now: NOW,
    });
    expect(result.widenedBeyondRadius).toBe(false);
    expect(result.ranked).toHaveLength(15);
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
