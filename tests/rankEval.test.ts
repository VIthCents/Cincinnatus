import { readFileSync, existsSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { rankJobs } from "../src/core/pipeline/rank.ts";
import { reachAdjustedSimilarity } from "../src/core/pipeline/reach.ts";
import { fitFromSimilarity } from "../src/core/pipeline/score.ts";
import {
  GOOD_MATCH_FIT,
  STRONG_MATCH_FIT,
  matchLevel,
} from "../src/core/pipeline/match.ts";
import { FRESHNESS_FLOOR } from "../src/core/config.ts";
import { parseProfile } from "../src/core/profile/parse.ts";
import type { Job, Profile, RankedJob } from "../src/core/types.ts";

/**
 * Does the ranking actually put the good jobs first?
 *
 * Nothing measured this before. That is not a small gap: it is how
 * `tests/ranking.test.ts` came to assert the central ordering bug as intended
 * behaviour, under the heading "this is the assertion that matters", and sit
 * there green while a CDL driver was shown software engineering roles.
 *
 * How this stays honest:
 *
 *  - **The jobs are real.** Every row is a genuine posting pulled from a live
 *    run, with its real title, employer, location and posting date.
 *  - **The cosines are measured, not invented.** Each row carries the actual
 *    cosine between that job's embedding and the profile's, computed by the
 *    real model during that run. No number in these fixtures was made up.
 *  - **The labels are human-legible judgements**, not a restatement of what the
 *    ranker already does. Each was rated by three independent judges against a
 *    written rubric — a hiring manager, a veteran employment counsellor, and
 *    the veteran herself — with disagreements adjudicated separately. The `why`
 *    on each row means a person can audit any label in seconds.
 *  - **It runs offline with no model and no network**, because the cosine is
 *    already in the file. That is the whole point of storing it.
 *
 * What this does NOT cover, stated plainly: the cosines are frozen, so this
 * gates the *scoring and ordering* layer — the blend, the widening rule, the
 * calibration — and cannot see a change to what gets embedded
 * (`buildProfileText` / `buildJobText`). Those need a live run to evaluate.
 */

interface Candidate {
  readonly id: string;
  readonly title: string;
  readonly company: string;
  readonly location: string | null;
  readonly remote: boolean | null;
  readonly postedAt: number;
  readonly postedAtIsEstimated: boolean;
  readonly cosine: number;
  readonly label: number | null;
}

/**
 * Two profiles, gated separately, so tuning for one veteran cannot quietly
 * cost another — which nearly happened: the title-affinity weight that looked
 * best on the CDL set alone (0.808 at w=0.1) was flat on the infantry set,
 * where "Security Officer" matches half the corpus. The credential gate was
 * kept because it improved BOTH; the affinity bonus was kept small for the
 * same reason.
 *
 * Label provenance differs and it matters: the CDL labels came from three
 * independent judges (unanimous on all 49); the infantry labels are a single
 * careful pass. Treat infantry floors with proportionally less reverence.
 *
 * Floors are per-set because the sets are differently hard. Every floor is a
 * ratchet: raise it when the ranking genuinely improves, never lower it to
 * make a change pass.
 */
const SETS = [
  {
    name: "CDL driver / supply specialist",
    file: "cdl",
    profile: "profile.sample.json",
    // Measured 0.561 / last-2 at rank 10 on 2026-08-10, after reach.ts.
    ndcg10Floor: 0.55,
    lastStrongWithin: 12,
  },
  {
    name: "infantry / security",
    file: "infantry",
    profile: "profile.infantry.json",
    // Measured 0.745 / last-2 at rank 18 on 2026-08-10, after reach.ts.
    ndcg10Floor: 0.7,
    lastStrongWithin: 20,
  },
] as const;

function load(file: string): Candidate[] {
  const path = `fixtures/rank-eval/${file}.jsonl`;
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Candidate)
    .filter((c) => c.label !== null);
}

function profileOf(name: string): Profile {
  const parsed = parseProfile(JSON.parse(readFileSync(`fixtures/${name}`, "utf8")));
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.value;
}

/**
 * A unit vector whose dot product with [1, 0] is exactly the measured cosine.
 *
 * This is what lets the fixture drive the REAL `rankJobs` — including the
 * location filter and the widening rule — rather than a reimplementation of the
 * scoring that could drift from it.
 */
function vectorFor(cosine: number): Float32Array {
  const c = Math.max(-1, Math.min(1, cosine));
  return new Float32Array([c, Math.sqrt(1 - c * c)]);
}

function toJob(c: Candidate): Job {
  return {
    source: "greenhouse",
    externalId: c.id,
    id: c.id,
    title: c.title,
    company: c.company,
    location: c.location,
    remote: c.remote,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryInterval: null,
    url: `https://example.test/${c.id}`,
    postedAt: c.postedAt,
    postedAtIsEstimated: c.postedAtIsEstimated,
    descriptionText: "",
    raw: "{}",
    firstSeenAt: c.postedAt,
    lastSeenAt: c.postedAt,
    dedupeKey: c.id,
    canonicalId: null,
  } as unknown as Job;
}

/** Normalised discounted cumulative gain. 1.0 is a perfect ordering. */
function ndcg(labels: readonly number[], k: number): number {
  const gain = (rel: number, i: number) => (2 ** rel - 1) / Math.log2(i + 2);
  const dcg = labels.slice(0, k).reduce((sum, rel, i) => sum + gain(rel, i), 0);
  const ideal = [...labels].sort((a, b) => b - a);
  const idcg = ideal.slice(0, k).reduce((sum, rel, i) => sum + gain(rel, i), 0);
  return idcg === 0 ? 1 : dcg / idcg;
}

describe("ranking quality on labelled real jobs", () => {
  for (const set of SETS) {
    const candidates = load(set.file);

    // A missing or unlabelled fixture must fail loudly rather than pass by
    // vacuously iterating an empty array.
    it(`${set.name}: the golden set is present and labelled`, () => {
      expect(candidates.length).toBeGreaterThanOrEqual(30);
      expect(candidates.some((c) => c.label === 2)).toBe(true);
      expect(candidates.some((c) => c.label === 0)).toBe(true);
    });

    if (candidates.length === 0) continue;

    const profile = profileOf(set.profile);
    const now = Math.max(...candidates.map((c) => c.postedAt)) + 86_400_000;
    const ranked: readonly RankedJob[] = rankJobs({
      jobs: candidates.map(toJob),
      vectors: new Map(candidates.map((c) => [c.id, vectorFor(c.cosine)])),
      profileVector: new Float32Array([1, 0]),
      profile,
      now,
    }).ranked;

    const labelOf = new Map(candidates.map((c) => [c.id, c.label ?? 0]));
    const ordered = ranked.map((r) => labelOf.get(r.job.id) ?? 0);

    /**
     * The sample is deliberately hard: candidates are stratified toward the
     * head of the ranking, so nearly everything scores well and the scorer
     * gets little help from easy negatives. NDCG here is pessimistic next to
     * the whole corpus, which is the point of a gate.
     *
     * What moved the floors to where they are (see docs/DECISIONS.md):
     * pipeline/reach.ts corrects the encoder's category error — cosine answers
     * "same subject?", the veteran asks "could I get it?". The credential gate
     * fired on 43% and 60% of judge-rejected jobs across the two sets and on
     * zero judge-approved ones; the title-affinity bonus is small because it
     * only helps one of the two profiles.
     */
    it(`${set.name}: orders the good jobs first (NDCG@10)`, () => {
      expect(ndcg(ordered, 10)).toBeGreaterThanOrEqual(set.ndcg10Floor);
    });

    it(`${set.name}: the top 5 is not padded with jobs she cannot get`, () => {
      const zeros = ordered.slice(0, 5).filter((l) => l === 0).length;
      expect(zeros).toBeLessThanOrEqual(1);
    });

    /**
     * The failure that shipped, as a direct assertion: a job the person would
     * actually take, buried under jobs they cannot get. Ratchet these down as
     * the encoder improves.
     */
    it(`${set.name}: no strong match is buried`, () => {
      const lastTwo = ordered.lastIndexOf(2);
      expect(lastTwo).toBeGreaterThanOrEqual(0);
      expect(lastTwo).toBeLessThan(set.lastStrongWithin);
    });
  }
});

/**
 * The badge is a promise to someone deciding how to spend an evening. These
 * assertions are that promise, measured — not the threshold numbers, which are
 * free to move as long as what the words mean stays true.
 *
 * Pooled across both profiles, because a band that only holds for one veteran
 * is a band tuned to that veteran.
 */
describe("what the match badge promises", () => {
  const pooled = SETS.flatMap((set) => {
    const profile = profileOf(set.profile);
    return load(set.file).map((c) => ({
      label: c.label ?? 0,
      fit: fitFromSimilarity(reachAdjustedSimilarity(c.cosine, c.title, profile)),
    }));
  });

  it("has enough labelled jobs to say anything", () => {
    expect(pooled.length).toBeGreaterThanOrEqual(80);
  });

  it("Strong match means a job she could really get", () => {
    const strong = pooled.filter((r) => matchLevel(r.fit) === "strong");
    expect(strong.length).toBeGreaterThan(0);
    const gettable = strong.filter((r) => r.label >= 1).length / strong.length;
    expect(gettable).toBeGreaterThanOrEqual(0.9);
  });

  it("Good match beats a coin toss, and is worse than Strong", () => {
    const good = pooled.filter((r) => matchLevel(r.fit) === "good");
    const strong = pooled.filter((r) => matchLevel(r.fit) === "strong");
    const rate = (rs: typeof pooled) =>
      rs.filter((r) => r.label >= 1).length / rs.length;
    expect(good.length).toBeGreaterThan(0);
    expect(rate(good)).toBeGreaterThanOrEqual(0.5);
    // If Good were as good as Strong the badge would carry no information.
    expect(rate(good)).toBeLessThan(rate(strong));
  });

  it("never promotes the best of a bad list", () => {
    // Absolute bands, not quartiles. The CDL corpus genuinely contains almost
    // no driving work, so that veteran should see no strong matches — an empty
    // Strong bucket is the truth of that corpus, not a bug to paper over.
    const cdlProfile = profileOf("profile.sample.json");
    const cdl = load("cdl").map((c) =>
      fitFromSimilarity(reachAdjustedSimilarity(c.cosine, c.title, cdlProfile)),
    );
    // `[].every()` is true, so without this the assertion below would pass
    // loudest exactly when the fixture failed to load. The sibling tests guard
    // the same way; this one was missed.
    expect(cdl.length).toBeGreaterThanOrEqual(30);
    expect(cdl.every((f) => matchLevel(f) !== "strong")).toBe(true);
  });

  it("reads fitScore, so a job does not change badge as it ages", () => {
    // finalScore decays; fitScore does not. Guards against anyone wiring the
    // badge to the wrong number.
    expect(matchLevel(STRONG_MATCH_FIT)).toBe("strong");
    expect(matchLevel(STRONG_MATCH_FIT * FRESHNESS_FLOOR)).not.toBe("strong");
    expect(matchLevel(GOOD_MATCH_FIT)).toBe("good");
    expect(matchLevel(GOOD_MATCH_FIT - 0.1)).toBe("fair");
  });
});
