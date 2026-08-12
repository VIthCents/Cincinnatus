import { describe, it, expect } from "vitest";
import { NodeDb } from "../src/node/db.ts";
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  migrate,
} from "../src/core/db/migrations.ts";
import * as repo from "../src/core/db/repo.ts";
import { AGGREGATOR_DELETE_DAYS } from "../src/core/config.ts";
import type { Job, SourceId } from "../src/core/types.ts";

/**
 * The application tracker: the record of what the veteran actually sent.
 *
 * Everything here is a database round-trip. There is no UI test stack in this
 * repo on purpose (no jsdom, no testing-library), so the contract that gets
 * pinned down is the one the tab is a thin drawing of.
 */

const NOW = Date.parse("2026-08-11T12:00:00Z");
const DAY = 86_400_000;

function makeJob(id: string, title: string, source: SourceId = "greenhouse"): Job {
  return {
    id,
    source,
    externalId: id,
    title,
    company: "Test Co",
    location: "Fayetteville, NC",
    remote: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryInterval: null,
    url: `https://example.com/${id}`,
    postedAt: NOW - DAY,
    postedAtIsEstimated: false,
    descriptionText: `${title} description`,
    raw: "{}",
    firstSeenAt: NOW - DAY,
    lastSeenAt: NOW - DAY,
    dedupeKey: `test-co|${title.toLowerCase()}|fayetteville`,
    canonicalId: null,
  };
}

async function dbWithJobs(jobs: readonly Job[]): Promise<NodeDb> {
  const db = new NodeDb(":memory:");
  await migrate(db, NOW);
  await repo.upsertJobs(db, jobs);
  return db;
}

// -----------------------------------------------------------------------------
// Migration v2
// -----------------------------------------------------------------------------

describe("the applications migration", () => {
  it("lands on top of a v1 database without touching what is already there", async () => {
    const db = new NodeDb(":memory:");

    // Bring the database up to v1 only, as an existing install would be.
    const v1 = MIGRATIONS.find((m) => m.version === 1)!;
    for (const statement of v1.statements) await db.run(statement);
    await db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
      1,
      NOW,
    ]);
    const job = makeJob("j1", "Dispatcher");
    await repo.upsertJobs(db, [job]);
    await repo.saveFeedback(db, job.id, "up", NOW);

    expect(await migrate(db, NOW)).toBe(LATEST_SCHEMA_VERSION);

    // The pre-existing row survived, and the new table is usable.
    expect(await repo.listFeedback(db, "up")).toEqual(new Set([job.id]));
    await repo.saveApplication(db, job.id, NOW);
    expect((await repo.listApplications(db)).length).toBe(1);

    db.close();
  });

  it("is idempotent — migrating twice is not an error", async () => {
    const db = new NodeDb(":memory:");
    await migrate(db, NOW);
    await migrate(db, NOW);
    expect(await migrate(db, NOW)).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });
});

// -----------------------------------------------------------------------------
// Recording an application
// -----------------------------------------------------------------------------

describe("saveApplication", () => {
  it("records the job with the date and status the person implied", async () => {
    const job = makeJob("j1", "Dispatcher");
    const db = await dbWithJobs([job]);

    await repo.saveApplication(db, job.id, NOW);

    const [tracked] = await repo.listApplications(db);
    expect(tracked!.job.id).toBe(job.id);
    expect(tracked!.job.title).toBe("Dispatcher");
    expect(tracked!.status).toBe("applied");
    expect(tracked!.appliedAt).toBe(NOW);
    expect(tracked!.updatedAt).toBe(NOW);

    db.close();
  });

  it("also records the 'applied' feedback that holds the job against purging", async () => {
    const job = makeJob("j1", "Dispatcher");
    const db = await dbWithJobs([job]);

    await repo.saveApplication(db, job.id, NOW);
    expect(await repo.listFeedback(db, "applied")).toEqual(new Set([job.id]));

    db.close();
  });

  it("does not drag a job that has moved on back to 'applied'", async () => {
    const job = makeJob("j1", "Dispatcher");
    const db = await dbWithJobs([job]);

    await repo.saveApplication(db, job.id, NOW);
    await repo.updateApplicationStatus(db, job.id, "interview", NOW + DAY);
    // Opening the same posting again a fortnight later must not undo that.
    await repo.saveApplication(db, job.id, NOW + 14 * DAY);

    const [tracked] = await repo.listApplications(db);
    expect(tracked!.status).toBe("interview");
    expect(tracked!.appliedAt).toBe(NOW);
    expect(tracked!.updatedAt).toBe(NOW + DAY);

    db.close();
  });
});

// -----------------------------------------------------------------------------
// Moving and removing
// -----------------------------------------------------------------------------

describe("updateApplicationStatus", () => {
  it("moves the status and stamps when it moved, leaving applied_at alone", async () => {
    const job = makeJob("j1", "Dispatcher");
    const db = await dbWithJobs([job]);

    await repo.saveApplication(db, job.id, NOW);
    await repo.updateApplicationStatus(db, job.id, "offer", NOW + 3 * DAY);

    const [tracked] = await repo.listApplications(db);
    expect(tracked!.status).toBe("offer");
    expect(tracked!.appliedAt).toBe(NOW);
    expect(tracked!.updatedAt).toBe(NOW + 3 * DAY);

    db.close();
  });
});

describe("deleteApplication", () => {
  it("forgets the application and releases the retention hold", async () => {
    const job = makeJob("j1", "Dispatcher");
    const db = await dbWithJobs([job]);

    await repo.saveApplication(db, job.id, NOW);
    await repo.deleteApplication(db, job.id);

    expect(await repo.listApplications(db)).toEqual([]);
    expect(await repo.listFeedback(db, "applied")).toEqual(new Set());

    db.close();
  });

  it("leaves a thumbs-up on the same job alone", async () => {
    const job = makeJob("j1", "Dispatcher");
    const db = await dbWithJobs([job]);

    await repo.saveFeedback(db, job.id, "up", NOW);
    await repo.saveApplication(db, job.id, NOW);
    await repo.deleteApplication(db, job.id);

    expect(await repo.listFeedback(db, "up")).toEqual(new Set([job.id]));

    db.close();
  });
});

// -----------------------------------------------------------------------------
// Listing
// -----------------------------------------------------------------------------

describe("listApplications", () => {
  it("is empty on a fresh database", async () => {
    const db = new NodeDb(":memory:");
    await migrate(db, NOW);
    expect(await repo.listApplications(db)).toEqual([]);
    db.close();
  });

  it("puts the newest application first", async () => {
    const older = makeJob("j1", "Dispatcher");
    const newer = makeJob("j2", "Welder");
    const db = await dbWithJobs([older, newer]);

    await repo.saveApplication(db, older.id, NOW - 5 * DAY);
    await repo.saveApplication(db, newer.id, NOW);

    const tracked = await repo.listApplications(db);
    expect(tracked.map((a) => a.job.id)).toEqual([newer.id, older.id]);

    db.close();
  });

  it("carries the whole job through, so the list can link back to the posting", async () => {
    const job = makeJob("j1", "Truck Driver", "usajobs");
    const db = await dbWithJobs([job]);

    await repo.saveApplication(db, job.id, NOW);

    const [tracked] = await repo.listApplications(db);
    expect(tracked!.job.url).toBe(job.url);
    expect(tracked!.job.company).toBe("Test Co");
    // Federal jobs are a different genre of resume, and the tracker needs to
    // be able to tell which one it is holding.
    expect(tracked!.job.source).toBe("usajobs");

    db.close();
  });
});

// -----------------------------------------------------------------------------
// Retention
// -----------------------------------------------------------------------------

describe("purgeStaleAggregatorJobs", () => {
  it("leaves a tracked job alone however long ago it was last seen", async () => {
    const long = NOW - (AGGREGATOR_DELETE_DAYS + 30) * DAY;
    const tracked: Job = {
      ...makeJob("j1", "Delivery Driver", "adzuna"),
      lastSeenAt: long,
    };
    const untouched: Job = {
      ...makeJob("j2", "Warehouse Picker", "adzuna"),
      lastSeenAt: long,
    };
    const db = await dbWithJobs([tracked, untouched]);

    await repo.saveApplication(db, tracked.id, NOW);
    await repo.purgeStaleAggregatorJobs(db, NOW);

    // The untracked one goes, as retention intends. The one the person
    // applied to must not — deleting it would erase their own record.
    expect(await repo.getJobById(db, untouched.id)).toBeNull();
    expect(await repo.getJobById(db, tracked.id)).not.toBeNull();
    expect((await repo.listApplications(db)).length).toBe(1);

    db.close();
  });
});

// -----------------------------------------------------------------------------
// Prepared documents
// -----------------------------------------------------------------------------

describe("listJobIdsWithDocuments", () => {
  it("names only the jobs that have papers saved for them", async () => {
    const prepared = makeJob("j1", "Dispatcher");
    const bare = makeJob("j2", "Welder");
    const db = await dbWithJobs([prepared, bare]);

    await repo.saveDocument(
      db,
      {
        id: "doc1",
        kind: "tailored_resume",
        jobId: prepared.id,
        content: "{}",
      },
      NOW,
    );
    // The base resume has no job, and must not make every row offer a link.
    await repo.saveDocument(
      db,
      { id: "doc2", kind: "base_resume", jobId: null, content: "{}" },
      NOW,
    );

    const ids = await repo.listJobIdsWithDocuments(db);
    expect(ids).toEqual(new Set([prepared.id]));

    db.close();
  });
});
