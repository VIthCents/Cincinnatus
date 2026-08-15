import { describe, it, expect } from "vitest";
import { NodeDb } from "../src/node/db.ts";
import { migrate } from "../src/core/db/migrations.ts";
import * as repo from "../src/core/db/repo.ts";
import {
  getAutoPrepCount,
  isAutoPrepDue,
  markAutoPrepRan,
  pickAutoPrepJobs,
  runAutoPrep,
  setAutoPrepCount,
} from "../src/core/app/autoprep.ts";
import { AUTO_PREP_DEFAULT_COUNT } from "../src/core/config.ts";
import { GOOD_MATCH_FIT, STRONG_MATCH_FIT } from "../src/core/pipeline/match.ts";
import { fakeHasher } from "./fakes.ts";
import { createFakeLlm } from "./fakes/llm.ts";
import type { Job, RankedJob } from "../src/core/types.ts";
import type { ResumeData } from "../src/core/documents/types.ts";

/**
 * Papers written before anyone asked for them. Every test here is really about
 * the same thing: this spends the veteran's own money, so it must be off by
 * default, bounded, and unable to keep spending after it starts failing.
 */

const NOW = Date.parse("2026-08-11T12:00:00Z");
const DAY = 86_400_000;

const BASE: ResumeData = {
  name: "Danielle R. Okafor",
  email: null,
  phone: null,
  location: "Fayetteville, NC",
  summary: "Army motor transport NCO.",
  experience: [
    {
      org: "189th CSSB",
      title: "Motor Transport Operator",
      location: "Fort Liberty, NC",
      start: "2021-04",
      end: "present",
      hoursPerWeek: null,
      bullets: ["Lead 9 soldier drivers"],
    },
  ],
  education: [],
  certifications: ["CDL Class A"],
  skills: ["Dispatch"],
  clearance: null,
  militaryCodes: ["88M"],
};

function job(id: string): Job {
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
    descriptionText: "Drive a truck.",
    raw: "{}",
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    dedupeKey: `k-${id}`,
    canonicalId: null,
  };
}

function rankedAt(id: string, fitScore: number): RankedJob {
  return {
    job: job(id),
    fitScore,
    ageDays: 0,
    freshness: 1,
    finalScore: fitScore,
    withinReach: true,
    llmWhy: null,
  };
}

/** tailorResume expects the resume wrapped with its note. */
const TAILOR_JSON = JSON.stringify({
  resume: { ...BASE, summary: "Tailored for this job." },
  note: "Led with your driving record.",
});
const LETTER_JSON = JSON.stringify({
  salutation: "Dear Hiring Team,",
  bodyParagraphs: ["I drive trucks."],
  closing: "Sincerely,",
});

describe("the setting", () => {
  it("is off unless the person turns it on", async () => {
    const db = new NodeDb(":memory:");
    await migrate(db, NOW);

    // SPEC §7 says default 3. This ships at 0 — see DECISIONS.md. Three a day
    // is about $11 a month of credits the wizard tells people to buy $5 of.
    expect(AUTO_PREP_DEFAULT_COUNT).toBe(0);
    expect(await getAutoPrepCount(db)).toBe(0);
    expect(await isAutoPrepDue(db, NOW)).toBe(false);

    await setAutoPrepCount(db, 3);
    expect(await getAutoPrepCount(db)).toBe(3);
    expect(await isAutoPrepDue(db, NOW)).toBe(true);

    db.close();
  });

  it("runs at most once a day, however many searches happen", async () => {
    const db = new NodeDb(":memory:");
    await migrate(db, NOW);
    await setAutoPrepCount(db, 3);

    await markAutoPrepRan(db, NOW);
    expect(await isAutoPrepDue(db, NOW)).toBe(false);
    // Later the same day: still done.
    expect(await isAutoPrepDue(db, NOW + 6 * 60 * 60 * 1000)).toBe(false);
    // Tomorrow: due again.
    expect(await isAutoPrepDue(db, NOW + DAY)).toBe(true);

    db.close();
  });
});

describe("choosing jobs", () => {
  const args = {
    count: 3,
    withDocuments: new Set<string>(),
    hidden: new Set<string>(),
    applied: new Set<string>(),
  };

  it("takes only strong matches, in order", () => {
    const picked = pickAutoPrepJobs({
      ...args,
      ranked: [
        rankedAt("a", STRONG_MATCH_FIT + 5),
        rankedAt("b", GOOD_MATCH_FIT), // good, not strong
        rankedAt("c", STRONG_MATCH_FIT),
      ],
    });
    // Spending somebody's money unasked on "worth a look" is not a favour.
    expect(picked.map((j) => j.id)).toEqual(["a", "c"]);
  });

  it("skips jobs that already have papers, are hidden, or were applied to", () => {
    const ranked = [
      rankedAt("done", 90),
      rankedAt("hidden", 90),
      rankedAt("applied", 90),
      rankedAt("fresh", 90),
    ];
    const picked = pickAutoPrepJobs({
      ...args,
      ranked,
      withDocuments: new Set(["done"]),
      hidden: new Set(["hidden"]),
      applied: new Set(["applied"]),
    });
    expect(picked.map((j) => j.id)).toEqual(["fresh"]);
  });

  it("writes nothing at all when the count is zero", () => {
    expect(
      pickAutoPrepJobs({ ...args, count: 0, ranked: [rankedAt("a", 90)] }),
    ).toEqual([]);
  });
});

describe("writing the papers", () => {
  async function dbWith(jobs: readonly Job[]): Promise<NodeDb> {
    const db = new NodeDb(":memory:");
    await migrate(db, NOW);
    await repo.upsertJobs(db, jobs);
    return db;
  }

  it("saves a resume and a letter for each job", async () => {
    const jobs = [job("a"), job("b")];
    const db = await dbWith(jobs);
    const { llm } = createFakeLlm([TAILOR_JSON, LETTER_JSON, TAILOR_JSON, LETTER_JSON]);

    const out = await runAutoPrep({
      db,
      llm,
      hasher: fakeHasher,
      now: NOW,
      baseResume: BASE,
      jobs,
    });

    expect(out.prepared).toBe(2);
    expect(out.failed).toBe(0);
    expect(await repo.listJobIdsWithDocuments(db)).toEqual(new Set(["a", "b"]));

    db.close();
  });

  /**
   * Pair-atomicity. listJobIdsWithDocuments counts ANY document, so saving a
   * lone resume would mark the job done forever and nothing would ever come
   * back to write the letter.
   */
  it("saves nothing for a job whose letter fails", async () => {
    const jobs = [job("a")];
    const db = await dbWith(jobs);
    // The tailored resume comes back; the letter call finds nothing queued.
    const { llm } = createFakeLlm([TAILOR_JSON]);

    const out = await runAutoPrep({
      db,
      llm,
      hasher: fakeHasher,
      now: NOW,
      baseResume: BASE,
      jobs,
    });

    expect(out.prepared).toBe(0);
    expect(out.failed).toBe(1);
    expect(await repo.listJobIdsWithDocuments(db)).toEqual(new Set());

    db.close();
  });

  it("tolerates one failure but stops at the second", async () => {
    const jobs = [job("a"), job("b"), job("c"), job("d")];
    const db = await dbWith(jobs);
    // a succeeds; b's letter finds nothing queued; c's resume likewise. That
    // is two failures, so d is never attempted.
    const { llm } = createFakeLlm([TAILOR_JSON, LETTER_JSON, TAILOR_JSON]);

    const out = await runAutoPrep({
      db,
      llm,
      hasher: fakeHasher,
      now: NOW,
      baseResume: BASE,
      jobs,
    });

    // A dead key or spent credits fails every job identically, and paying to
    // learn that four times over is exactly what this prevents.
    expect(out.stoppedEarly).toBe(true);
    expect(out.failed).toBe(2);
    expect(out.prepared).toBe(1);

    db.close();
  });
});
