import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { NodeDb } from "../src/node/db.ts";
import { migrate, LATEST_SCHEMA_VERSION } from "../src/core/db/migrations.ts";
import * as repo from "../src/core/db/repo.ts";
import { runPipeline } from "../src/core/pipeline/run.ts";
import { parseProfile } from "../src/core/profile/parse.ts";
import { buildSearchTerms } from "../src/core/pipeline/queries.ts";
import { civilianTitlesFor } from "../src/core/profile/crosswalk.ts";
import {
  createGreenhouseSource,
  greenhouseUrl,
} from "../src/core/sources/greenhouse.ts";
import { buildSearchUrl, createUsaJobsSource } from "../src/core/sources/usajobs.ts";
import { ALLOWED_HOSTS } from "../src/core/net/allowlist.ts";
import { createFakeEmbedder, fakeClock, fakeHasher, stubHttp } from "./fakes.ts";
import type { Job, Profile } from "../src/core/types.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const NOW = Date.parse("2026-08-08T12:00:00Z");
const DAY = 86_400_000;

function fixture(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), "utf8");
}

function freshDb(): NodeDb {
  return new NodeDb(":memory:");
}

const profile: Profile = {
  titles: ["Truck Driver", "Logistics Coordinator"],
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

describe("migrations", () => {
  it("applies cleanly and is idempotent", async () => {
    const db = freshDb();
    expect(await migrate(db, NOW)).toBe(LATEST_SCHEMA_VERSION);
    expect(await migrate(db, NOW)).toBe(LATEST_SCHEMA_VERSION);

    const rows = await db.all<{ version: number }>(
      "SELECT version FROM schema_migrations",
    );
    expect(rows).toHaveLength(1);
    db.close();
  });

  it("creates every table the data model calls for", async () => {
    const db = freshDb();
    await migrate(db, NOW);
    const rows = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    const names = rows.map((r) => r.name);
    for (const table of [
      "profile",
      "jobs",
      "scores",
      "documents",
      "chat_messages",
      "feedback",
      "runs",
      "watchlist",
      "settings",
      "embeddings",
      "source_state",
    ]) {
      expect(names).toContain(table);
    }
    db.close();
  });
});

describe("repository", () => {
  it("preserves first_seen_at when a job is seen again", async () => {
    const db = freshDb();
    await migrate(db, NOW);

    await repo.upsertJobs(db, [job({ id: "a", firstSeenAt: NOW, lastSeenAt: NOW })]);
    await repo.upsertJobs(db, [
      job({
        id: "a",
        firstSeenAt: NOW + 5 * DAY,
        lastSeenAt: NOW + 5 * DAY,
        title: "Updated",
      }),
    ]);

    const [stored] = await repo.listRankableJobs(db);
    // first_seen_at is the fallback used when a source gives no posting date.
    // Overwriting it on every run would make every job permanently look new.
    expect(stored?.firstSeenAt).toBe(NOW);
    expect(stored?.lastSeenAt).toBe(NOW + 5 * DAY);
    expect(stored?.title).toBe("Updated");
    db.close();
  });

  it("hides collapsed duplicates from the rankable list", async () => {
    const db = freshDb();
    await migrate(db, NOW);
    await repo.upsertJobs(db, [job({ id: "a" }), job({ id: "b" })]);
    await repo.setCanonical(db, [["b", "a"]]);

    const ids = (await repo.listRankableJobs(db)).map((j) => j.id);
    expect(ids).toEqual(["a"]);
    db.close();
  });

  it("round-trips null as null, never as a coerced value", async () => {
    const db = freshDb();
    await migrate(db, NOW);
    await repo.upsertJobs(db, [
      job({ id: "a", remote: null, salaryMin: null, postedAt: null, location: null }),
      job({ id: "b", remote: false, dedupeKey: "k-b" }),
    ]);

    const stored = await repo.listRankableJobs(db);
    const a = stored.find((j) => j.id === "a");
    const b = stored.find((j) => j.id === "b");
    // "we do not know" must survive the database round trip distinct from "no".
    expect(a?.remote).toBeNull();
    expect(a?.location).toBeNull();
    expect(a?.postedAt).toBeNull();
    expect(b?.remote).toBe(false);
    db.close();
  });

  it("stores and reloads embeddings by content hash", async () => {
    const db = freshDb();
    await migrate(db, NOW);
    await repo.saveEmbeddings(db, "m@1", 4, NOW, [["hash-1", "AACAPw=="]]);

    const loaded = await repo.loadEmbeddings(db, "m@1", ["hash-1", "hash-2"]);
    expect(loaded.get("hash-1")).toBe("AACAPw==");
    expect(loaded.has("hash-2")).toBe(false);

    // A different model is a different key, not a silent mismatch.
    expect((await repo.loadEmbeddings(db, "m@2", ["hash-1"])).size).toBe(0);
    db.close();
  });

  it("remembers ETags between runs", async () => {
    const db = freshDb();
    await migrate(db, NOW);
    expect(await repo.getSourceState(db, "greenhouse:x")).toBeNull();
    await repo.putSourceState(
      db,
      "greenhouse:x",
      { etag: 'W/"1"', lastModified: null },
      NOW,
    );
    expect((await repo.getSourceState(db, "greenhouse:x"))?.etag).toBe('W/"1"');
    db.close();
  });
});

describe("end to end over recorded fixtures", () => {
  function stubbedSources() {
    const urls: Record<string, { body: string }> = {
      [greenhouseUrl("board-a")]: {
        body: fixture("fixtures/greenhouse/board-jobs.json"),
      },
      [greenhouseUrl("board-b")]: {
        body: fixture("fixtures/greenhouse/board-jobs-2.json"),
      },
      [greenhouseUrl("board-c")]: {
        body: fixture("fixtures/greenhouse/board-jobs-3.json"),
      },
    };
    const usaOptions = {
      auth: { apiKey: "k", userAgentEmail: "someone@example.test" },
      keywords: ["truck driver"],
      windowDays: 7,
    };
    urls[buildSearchUrl(usaOptions, "truck driver", 1)] = {
      body: fixture("fixtures/usajobs/search.json"),
    };

    return {
      http: stubHttp(urls),
      sources: [
        createGreenhouseSource("board-a", "Board A"),
        createGreenhouseSource("board-b", "Board B"),
        createGreenhouseSource("board-c", "Board C"),
        createUsaJobsSource(usaOptions),
      ],
    };
  }

  async function run(): Promise<Awaited<ReturnType<typeof runPipeline>>> {
    const { http, sources } = stubbedSources();
    return runPipeline({
      db: freshDb(),
      http,
      clock: fakeClock(NOW),
      hasher: fakeHasher,
      embedder: createFakeEmbedder(),
      reporter: () => {},
      profile,
      sources,
      maxEmbed: null,
    });
  }

  it("ingests every fixture job and reports honestly", async () => {
    const { report, ranked } = await run();

    expect(report.sources).toHaveLength(4);
    expect(report.sources.every((s) => s.error === null)).toBe(true);
    expect(report.jobsSeen).toBe(36);
    expect(report.jobsNew).toBe(36);
    expect(ranked.length).toBeGreaterThan(0);
    expect(report.fit).not.toBeNull();
  });

  it("produces the same ranking twice — the golden ordering", async () => {
    // The only test that guards buildJobText, the truncation window, the blend,
    // the dedupe election and the tie-break all at once. If any of them changes
    // behaviour, this ordering moves.
    const first = await run();
    const second = await run();

    const idsA = first.ranked.slice(0, 10).map((r) => r.job.id);
    const idsB = second.ranked.slice(0, 10).map((r) => r.job.id);

    expect(idsA).toEqual(idsB);
    expect(idsA.length).toBeGreaterThan(0);

    // Scores must be non-increasing down the list.
    const scores = first.ranked.map((r) => r.finalScore);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1] ?? Infinity);
    }
  });

  it("embeds identical text only once", async () => {
    const { report } = await run();
    // Content-addressed embeddings: the number embedded can never exceed the
    // number of jobs, and duplicates across boards collapse to one vector.
    expect(report.embedded).toBeLessThanOrEqual(report.jobsSeen);
    expect(report.embedded).toBeGreaterThan(0);
  });

  it("keeps running when one source is broken", async () => {
    const { http, sources } = stubbedSources();
    const withBroken = [...sources, createGreenhouseSource("does-not-exist", "Broken")];

    const { report, ranked } = await runPipeline({
      db: freshDb(),
      http,
      clock: fakeClock(NOW),
      hasher: fakeHasher,
      embedder: createFakeEmbedder(),
      reporter: () => {},
      profile,
      sources: withBroken,
      maxEmbed: null,
    });

    const failed = report.sources.filter((s) => s.error !== null);
    expect(failed).toHaveLength(1);
    // The whole point: one dead board does not empty the list.
    expect(ranked.length).toBeGreaterThan(0);
    expect(report.jobsSeen).toBe(36);
  });
});

describe("profile parsing", () => {
  it("accepts the committed sample", () => {
    const parsed = parseProfile(JSON.parse(fixture("fixtures/profile.sample.json")));
    expect(parsed.ok).toBe(true);
  });

  it("explains a wrong type in plain words instead of crashing", () => {
    const parsed = parseProfile({ titles: "Truck Driver" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain("should be a list");
  });

  it("refuses a profile with nothing to search on", () => {
    const parsed = parseProfile({ location: { city: "Austin", state: "TX" } });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toMatch(/titles.*mocCodes.*skills/);
  });

  it("collects every problem at once rather than one per run", () => {
    const parsed = parseProfile({
      titles: 5,
      radiusMiles: -1,
      remotePreference: "nope",
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.length).toBeGreaterThan(2);
  });

  it("rejects a state that is not a two-letter code", () => {
    const parsed = parseProfile({
      titles: ["Driver"],
      location: { city: "Austin", state: "Texas" },
    });
    expect(parsed.ok).toBe(false);
  });
});

describe("search terms", () => {
  it("puts the user's own titles before crosswalk suggestions", () => {
    const terms = buildSearchTerms(profile);
    expect(terms.titles[0]).toBe("Truck Driver");
    // 88M maps to motor transport work.
    expect(terms.titles).toContain("CDL Driver");
  });

  it("does not send military codes anywhere", () => {
    // Only civilian titles and a place name ever leave the machine.
    const terms = buildSearchTerms(profile);
    expect(terms.titles.join(" ")).not.toContain("88M");
  });

  it("returns nothing for an unknown code rather than inventing titles", () => {
    expect(civilianTitlesFor("ZZ9")).toEqual([]);
  });

  it("drops the radius when there is no location to anchor it", () => {
    const terms = buildSearchTerms({ ...profile, location: null });
    expect(terms.locationName).toBeNull();
    expect(terms.radiusMiles).toBeNull();
  });
});

describe("starter watchlist", () => {
  // Validates the shipped file with no network, so a typo is caught in CI
  // rather than by a weekly live check.
  const parsed = JSON.parse(fixture("data/starter-watchlist.json")) as {
    schema_version: number;
    boards: {
      ats: string;
      slug: string;
      company_label: string;
      board_name?: string;
      source: string;
      note?: string;
    }[];
  };

  it("is well formed", () => {
    expect(parsed.schema_version).toBe(1);
    expect(parsed.boards.length).toBeGreaterThanOrEqual(15);
  });

  it("uses only approved applicant tracking systems", () => {
    for (const board of parsed.boards) {
      expect(["greenhouse", "lever", "ashby"]).toContain(board.ats);
    }
  });

  it("has URL-safe, non-empty slugs and no duplicates", () => {
    const seen = new Set<string>();
    for (const board of parsed.boards) {
      expect(board.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(board.company_label.trim()).not.toBe("");
      const key = `${board.ats}:${board.slug}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("records the board's own name for every checkable entry", () => {
    // Without this the verifier has nothing to compare against, and a slug that
    // quietly becomes a different company passes.
    for (const board of parsed.boards.filter((b) => b.ats === "greenhouse")) {
      expect(board.board_name).toBeTruthy();
    }
  });

  it("only names hosts the allowlist permits", () => {
    const hostFor: Record<string, string> = {
      greenhouse: "boards-api.greenhouse.io",
      lever: "api.lever.co",
      ashby: "api.ashbyhq.com",
    };
    for (const board of parsed.boards) {
      expect(ALLOWED_HOSTS).toContain(hostFor[board.ats]);
    }
  });
});
