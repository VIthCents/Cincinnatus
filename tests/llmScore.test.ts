import { describe, it, expect } from "vitest";
import { NodeDb } from "../src/node/db.ts";
import { migrate } from "../src/core/db/migrations.ts";
import * as repo from "../src/core/db/repo.ts";
import {
  profileScoreHash,
  scoreJobs,
  selectJobsToScore,
  truncateWords,
} from "../src/core/pipeline/llmScore.ts";
import { rankJobs } from "../src/core/pipeline/rank.ts";
import { SCORE_SYSTEM } from "../src/core/pipeline/prompts/score.v1.ts";
import { GOOD_MATCH_FIT, STRONG_MATCH_FIT } from "../src/core/pipeline/match.ts";
import { LLM_RATIONALE_MAX_CHARS } from "../src/core/config.ts";
import { fakeHasher } from "./fakes.ts";
import { createFakeLlm } from "./fakes/llm.ts";
import type { Job, LlmScore, Profile, RankedJob } from "../src/core/types.ts";

/**
 * The AI upgrade to the match score (SPEC §5). What matters most here is not
 * that it scores, but that it cannot make the list worse when it fails, cannot
 * leak the resume, and cannot disturb the widening decision.
 */

const NOW = Date.parse("2026-08-11T12:00:00Z");

const profile: Profile = {
  titles: ["Truck Driver"],
  skills: ["CDL Class A", "Dispatch"],
  mocCodes: ["88M"],
  branch: "Army",
  clearance: "Secret",
  education: ["High school diploma"],
  yearsExperience: 8,
  location: { city: "Fayetteville", state: "NC" },
  radiusMiles: 50,
  remotePreference: "any",
  salaryFloor: null,
  excludedKeywords: [],
};

function job(id: string, overrides: Partial<Job> = {}): Job {
  return {
    id,
    source: "greenhouse",
    externalId: id,
    title: "Truck Driver",
    company: "Acme",
    location: "Fayetteville, NC",
    remote: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryInterval: null,
    url: `https://example.test/${id}`,
    postedAt: NOW,
    postedAtIsEstimated: false,
    descriptionText: "Drive a truck. CDL required.",
    raw: "{}",
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    dedupeKey: `k-${id}`,
    canonicalId: null,
    ...overrides,
  };
}

function ranked(jobs: readonly Job[]): readonly RankedJob[] {
  return rankJobs({
    jobs,
    vectors: new Map(),
    profileVector: null,
    profile,
    now: NOW,
  }).ranked;
}

function batchReply(
  entries: readonly { id: string; fit: number; why: string }[],
): string {
  return JSON.stringify({ scores: entries });
}

describe("what gets sent", () => {
  it("sends the structured profile and never the resume", async () => {
    const { llm, requests } = createFakeLlm([
      batchReply([{ id: "job-1".slice(0, 8), fit: 70, why: "You have the CDL." }]),
    ]);

    await scoreJobs({
      llm,
      hasher: fakeHasher,
      profile,
      jobs: [job("job-1")],
      contentHashOf: new Map([["job-1", "h1"]]),
      now: NOW,
    });

    const sent = requests[0]!;
    expect(sent.model).toBe("fast");
    expect(sent.jsonSchema).toBeDefined();

    const body = sent.messages[0]!.content;
    // The structured profile: titles, skills, codes, clearance.
    expect(body).toContain("Truck Driver");
    expect(body).toContain("CDL Class A");
    // SPEC §7: scoring calls send the profile, never the resume. There is no
    // resume in scope here at all, which is the point — buildProfileText
    // cannot reach one.
    expect(body).not.toContain("Danielle");
    expect(body).not.toContain("189th CSSB");
  });

  it("anchors the rubric to the badge bands rather than to copied numbers", () => {
    // The bands moved once already and left two constants behind. A prompt
    // with the numbers typed into it would be the next thing to drift.
    expect(SCORE_SYSTEM).toContain(String(STRONG_MATCH_FIT));
    expect(SCORE_SYSTEM).toContain(String(GOOD_MATCH_FIT));
    expect(SCORE_SYSTEM).toContain(String(LLM_RATIONALE_MAX_CHARS));
  });

  it("batches rather than asking about everything at once", async () => {
    const jobs = Array.from({ length: 25 }, (_, i) => job(`job-${String(i)}`));
    const { llm, requests } = createFakeLlm([
      batchReply([]),
      batchReply([]),
      batchReply([]),
    ]);

    await scoreJobs({
      llm,
      hasher: fakeHasher,
      profile,
      jobs,
      contentHashOf: new Map(),
      now: NOW,
    });

    expect(requests).toHaveLength(3);
  });
});

describe("what comes back", () => {
  it("clamps the fit and trims the reason, whatever the model returns", async () => {
    const long = "You would be great at this ".repeat(20);
    const { llm } = createFakeLlm([
      batchReply([
        { id: "job-1".slice(0, 8), fit: 140, why: long },
        { id: "job-2".slice(0, 8), fit: -20, why: "Too far." },
      ]),
    ]);

    const out = await scoreJobs({
      llm,
      hasher: fakeHasher,
      profile,
      jobs: [job("job-1"), job("job-2")],
      contentHashOf: new Map(),
      now: NOW,
    });

    // A prompt is a request; these are the guarantee. A fit of 140 would
    // outrank everything on the screen.
    expect(out.scores.get("job-1")!.fit).toBe(100);
    expect(out.scores.get("job-2")!.fit).toBe(0);
    expect(out.scores.get("job-1")!.why.length).toBeLessThanOrEqual(
      LLM_RATIONALE_MAX_CHARS,
    );
  });

  it("drops an id it was never asked about", async () => {
    const { llm } = createFakeLlm([
      batchReply([
        { id: "job-1".slice(0, 8), fit: 70, why: "Good." },
        { id: "ghost123", fit: 99, why: "Invented." },
      ]),
    ]);

    const out = await scoreJobs({
      llm,
      hasher: fakeHasher,
      profile,
      jobs: [job("job-1")],
      contentHashOf: new Map(),
      now: NOW,
    });

    expect([...out.scores.keys()]).toEqual(["job-1"]);
  });

  it("keeps earlier batches when a later one fails, and says so plainly", async () => {
    const jobs = Array.from({ length: 15 }, (_, i) => job(`job-${String(i)}`));
    const { llm } = createFakeLlm([
      batchReply(
        jobs.slice(0, 10).map((j) => ({ id: j.id.slice(0, 8), fit: 65, why: "Fits." })),
      ),
      // Second batch: the key died, or the credits ran out.
    ]);

    const out = await scoreJobs({
      llm,
      hasher: fakeHasher,
      profile,
      jobs,
      contentHashOf: new Map(),
      now: NOW,
    });

    expect(out.scored).toBe(10);
    expect(out.note).not.toBeNull();
    // Plain words, and honest about what still works.
    expect(out.note).toMatch(/list still works/);
  });

  it("truncates at a word boundary so a clipped reason still reads", () => {
    const words = truncateWords("You have driven trucks for eight years already", 30);
    expect(words.length).toBeLessThanOrEqual(30);
    expect(words.endsWith(" ")).toBe(false);
    expect(words).not.toMatch(/\bye$/);
  });
});

describe("choosing what to spend money on", () => {
  const hashes = new Map([
    ["job-1", "h1"],
    ["job-2", "h2"],
  ]);

  function score(overrides: Partial<LlmScore> = {}): LlmScore {
    return {
      fit: 70,
      why: "Fits.",
      profileHash: "p",
      contentHash: "h1",
      scoredAt: NOW,
      ...overrides,
    };
  }

  it("skips a job already judged against the same profile and the same text", () => {
    const out = selectJobsToScore({
      ranked: ranked([job("job-1"), job("job-2")]),
      stored: new Map([["job-1", score()]]),
      hidden: new Set(),
      contentHashOf: hashes,
    });
    expect(out.map((j) => j.id)).toEqual(["job-2"]);
  });

  it("re-judges a job whose text has changed underneath its score", () => {
    // Adverts get re-served and postings get edited. A score that survives
    // that describes text nobody can see any more.
    const out = selectJobsToScore({
      ranked: ranked([job("job-1")]),
      stored: new Map([["job-1", score({ contentHash: "old-hash" })]]),
      hidden: new Set(),
      contentHashOf: hashes,
    });
    expect(out.map((j) => j.id)).toEqual(["job-1"]);
  });

  it("never spends money on a job the person hid", () => {
    const out = selectJobsToScore({
      ranked: ranked([job("job-1"), job("job-2")]),
      stored: new Map(),
      hidden: new Set(["job-1"]),
      contentHashOf: hashes,
    });
    expect(out.map((j) => j.id)).toEqual(["job-2"]);
  });

  it("stops at the cap", () => {
    const jobs = Array.from({ length: 40 }, (_, i) => job(`job-${String(i)}`));
    const out = selectJobsToScore({
      ranked: ranked(jobs),
      stored: new Map(),
      hidden: new Set(),
      contentHashOf: new Map(),
      limit: 5,
    });
    expect(out).toHaveLength(5);
  });
});

describe("merging into the ranking", () => {
  /**
   * The trap this guards. Only the top jobs are ever sent for scoring, so they
   * are the ones most likely to come back above the band. If the widening
   * decision read the merged fit, a handful of upgraded scores would decide
   * there was plenty of work nearby and collapse the nationwide list — for
   * someone whose local corpus had not changed at all.
   */
  it("decides widening on the embedding fit, not the AI's", () => {
    const far = Array.from({ length: 12 }, (_, i) =>
      job(`far-${String(i)}`, {
        location: "Seattle, WA",
        dedupeKey: `far-${String(i)}`,
      }),
    );
    // Enough nearby jobs to clear MIN_RESULTS_BEFORE_WIDENING *if* their AI
    // scores counted. Their embedding fit is 0 (no vectors), so on the
    // embedding path there is nothing worthwhile nearby and the search must
    // widen. Fewer than the threshold here and the test could not fail.
    const near = Array.from({ length: 12 }, (_, i) =>
      job(`near-${String(i)}`, { dedupeKey: `near-${String(i)}` }),
    );
    const jobs = [...near, ...far];

    const withoutAi = rankJobs({
      jobs,
      vectors: new Map(),
      profileVector: null,
      profile,
      now: NOW,
    });

    // Every nearby job judged well above the widening bar.
    const llmScores = new Map<string, LlmScore>(
      near.map((j) => [
        j.id,
        {
          fit: 95,
          why: "You could get this.",
          profileHash: "p",
          contentHash: null,
          scoredAt: NOW,
        },
      ]),
    );

    const withAi = rankJobs({
      jobs,
      vectors: new Map(),
      profileVector: null,
      profile,
      now: NOW,
      llmScores,
    });

    expect(withAi.widenedBeyondRadius).toBe(withoutAi.widenedBeyondRadius);
    // ...and the scores did take effect on the list itself.
    expect(withAi.ranked[0]!.fitScore).toBe(95);
    expect(withAi.ranked[0]!.llmWhy).toBe("You could get this.");
  });

  it("leaves unscored jobs on their embedding fit", () => {
    const out = rankJobs({
      jobs: [job("job-1"), job("job-2")],
      vectors: new Map(),
      profileVector: null,
      profile,
      now: NOW,
      llmScores: new Map(),
    });
    expect(out.ranked.every((r) => r.llmWhy === null)).toBe(true);
  });
});

describe("storage", () => {
  it("round-trips a score and forgets one judged about someone else", async () => {
    const db = new NodeDb(":memory:");
    await migrate(db, NOW);
    await repo.upsertJobs(db, [job("job-1"), job("job-2")]);

    const mine = profileScoreHash(fakeHasher, profile);
    const theirs = profileScoreHash(fakeHasher, { ...profile, titles: ["Welder"] });

    await repo.saveLlmScores(
      db,
      new Map([
        [
          "job-1",
          {
            fit: 72,
            why: "You have the CDL.",
            profileHash: mine,
            contentHash: "h1",
            scoredAt: NOW,
          },
        ],
        [
          "job-2",
          {
            fit: 40,
            why: "Different trade.",
            profileHash: theirs,
            contentHash: "h2",
            scoredAt: NOW,
          },
        ],
      ]),
    );

    const loaded = await repo.loadLlmScores(db, mine);
    expect([...loaded.keys()]).toEqual(["job-1"]);
    expect(loaded.get("job-1")!.fit).toBe(72);
    expect(loaded.get("job-1")!.why).toBe("You have the CDL.");

    // Re-parsing a resume changes the profile, so every judgement made about
    // the old one has to go rather than linger and be compared against new ones.
    await repo.deleteStaleLlmScores(db, mine);
    expect((await repo.loadLlmScores(db, theirs)).size).toBe(0);
    expect((await repo.loadLlmScores(db, mine)).size).toBe(1);

    db.close();
  });

  it("drops scores whose job has been purged", async () => {
    const db = new NodeDb(":memory:");
    await migrate(db, NOW);
    const hash = profileScoreHash(fakeHasher, profile);

    await repo.saveLlmScores(
      db,
      new Map([
        [
          "ghost",
          {
            fit: 80,
            why: "Gone.",
            profileHash: hash,
            contentHash: null,
            scoredAt: NOW,
          },
        ],
      ]),
    );
    await repo.deleteStaleLlmScores(db, hash);

    expect((await repo.loadLlmScores(db, hash)).size).toBe(0);
    db.close();
  });
});
