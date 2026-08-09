import { readFileSync, existsSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { rankJobs } from "../src/core/pipeline/rank.ts";
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
 * Only labelled sets are gated. `fixtures/rank-eval/infantry.jsonl` is exported
 * and committed but not yet labelled — a second profile exists so that tuning
 * cannot quietly overfit to one veteran. TODO(rank-eval): label it.
 */
const SETS = [
  {
    name: "CDL driver / supply specialist",
    file: "cdl",
    profile: "profile.sample.json",
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
     * A ratchet, not an aspiration. 0.45 is what the ranking scores today
     * (measured 0.455 on 2026-08-09, after the widening and freshness fixes);
     * this fails if it gets worse. Raise the floor whenever it genuinely
     * improves, and never lower it to make a change pass.
     *
     * Note the sample is deliberately hard: the candidates are stratified
     * toward the head of the ranking, so nearly all of them score well and the
     * scorer gets little help from easy negatives. NDCG here is pessimistic
     * next to the whole corpus, which is the point of a gate.
     *
     * The gap to 0.75 is two distinct problems, and neither is the blend:
     *   1. Age still reorders fit gaps under 1/FRESHNESS_FLOOR. "Military
     *      Shipping Lead" has the highest fit in the set (57.2) and a unanimous
     *      label of 2, and lands at rank 8 because it is old.
     *   2. The embedding itself does not discriminate. "Firefighter (Basic Life
     *      Support)" scores 51.5 against a CDL driver profile and is labelled 0
     *      by all three judges; "Class A Driver" scores 47.0 and is labelled 2.
     *      No amount of blend tuning fixes an encoder that ranks those that way
     *      — that is what buildJobText/buildProfileText work is for, and this
     *      fixture cannot see it, because the cosines are frozen.
     */
    it(`${set.name}: orders the good jobs first (NDCG@10)`, () => {
      expect(ndcg(ordered, 10)).toBeGreaterThanOrEqual(0.45);
    });

    it(`${set.name}: the top 5 is not padded with jobs she cannot get`, () => {
      const zeros = ordered.slice(0, 5).filter((l) => l === 0).length;
      expect(zeros).toBeLessThanOrEqual(1);
    });

    /**
     * The failure that shipped, as a direct assertion: a job she would actually
     * take, buried under jobs she cannot get. Currently the last label-2 sits at
     * rank 15 of 49. Ratchet this down as the encoder improves.
     */
    it(`${set.name}: no strong match is buried`, () => {
      const lastTwo = ordered.lastIndexOf(2);
      expect(lastTwo).toBeGreaterThanOrEqual(0);
      expect(lastTwo).toBeLessThan(15);
    });
  }
});
