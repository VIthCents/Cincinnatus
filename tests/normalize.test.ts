import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  collapseWhitespace,
  decodeEntities,
  greenhouseContentToText,
  makeDedupeKey,
  normalizeTitle,
  stripContentIntro,
  stripTags,
} from "../src/core/pipeline/normalize.ts";
import { normalizeGreenhouseJob } from "../src/core/sources/greenhouse.ts";
import { fakeHasher } from "./fakes.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function fixture(relPath: string): string {
  return readFileSync(join(repoRoot, "fixtures", relPath), "utf8");
}

describe("Greenhouse content decoding", () => {
  const board = JSON.parse(fixture("greenhouse/board-jobs.json")) as {
    jobs: { content: string; title: string }[];
  };

  it("the recorded fixture really is double-encoded", () => {
    // If this ever fails, Greenhouse changed their encoding and the double
    // decode below is now wrong — which is exactly what we want to hear about.
    const raw = fixture("greenhouse/board-jobs.json");
    expect(raw).not.toContain("<div");
    expect(raw).toContain("&lt;");
    expect(raw).toContain("&amp;nbsp;");
  });

  it("needs two decode passes, not one", () => {
    const content = board.jobs[0]?.content ?? "";

    // The point of this assertion is to pin down *why* the second pass exists.
    // A test that only checked the final output were clean would also pass if
    // someone replaced the decoder with something different but still tidy.
    const once = decodeEntities(content);
    expect(once).toContain("&nbsp;");

    const twice = decodeEntities(once);
    expect(twice).not.toContain("&nbsp;");
    expect(twice).toContain("<");
  });

  it("produces plain text with no tags or entities left", () => {
    const text = greenhouseContentToText(board.jobs[0]?.content ?? "");
    expect(text).not.toContain("<");
    expect(text).not.toContain("&nbsp;");
    expect(text).not.toContain("&amp;");
    expect(text.length).toBeGreaterThan(100);
  });

  it("strips the per-board content-intro blurb", () => {
    const job = JSON.parse(fixture("greenhouse/job-with-content-intro.json")) as {
      content: string;
    };

    const decodedTwice = decodeEntities(decodeEntities(job.content));
    expect(decodedTwice).toContain("content-intro");

    const stripped = stripContentIntro(decodedTwice);
    expect(stripped).not.toContain("content-intro");
    // Only the blurb goes; the actual posting survives.
    expect(stripped.length).toBeGreaterThan(200);
    expect(stripped.length).toBeLessThan(decodedTwice.length);
  });

  it("keeps nested markup inside the intro from leaking out", () => {
    const html =
      '<div class="content-intro"><p>Boilerplate</p><div><em>nested</em></div></div><p>Real duties here</p>';
    const stripped = stripContentIntro(html);
    expect(stripped).toBe("<p>Real duties here</p>");
    expect(stripped).not.toContain("Boilerplate");
    expect(stripped).not.toContain("nested");
  });
});

describe("posted date", () => {
  const board = JSON.parse(fixture("greenhouse/board-jobs.json")) as {
    jobs: {
      id: number;
      title: string;
      first_published: string;
      updated_at: string;
      location?: { name?: string };
    }[];
  };

  it("comes from first_published, not updated_at", () => {
    // The fixture was chosen because these differ: this posting was first
    // published on 15 May and edited on 28 May. Reading updated_at would make a
    // two-week-old posting look brand new and outrank genuinely fresh jobs —
    // the single bug most likely to silently ruin the ranking.
    const raw = board.jobs[0];
    expect(raw).toBeDefined();
    if (raw === undefined) return;
    expect(Date.parse(raw.first_published)).not.toBe(Date.parse(raw.updated_at));

    const job = normalizeGreenhouseJob(raw, "Slingshot Aerospace", {
      hasher: fakeHasher,
      now: Date.parse("2026-08-08T00:00:00Z"),
    });

    expect(job?.postedAt).toBe(Date.parse(raw.first_published));
    expect(job?.postedAt).not.toBe(Date.parse(raw.updated_at));
    expect(job?.postedAtIsEstimated).toBe(false);
  });

  it("marks the date as estimated when the source gives none", () => {
    // first_published absent entirely, as it is for a source that has no such
    // field. Not `undefined` — exactOptionalPropertyTypes draws that
    // distinction, and so does the JSON we actually receive.
    const job = normalizeGreenhouseJob({ id: 1, title: "Technician" }, "Acme", {
      hasher: fakeHasher,
      now: 1_700_000_000_000,
    });
    expect(job?.postedAt).toBeNull();
    expect(job?.postedAtIsEstimated).toBe(true);
  });

  it("does not claim a job is on-site when the source never said", () => {
    // Greenhouse has no remote field. null means unknown; false would be an
    // assertion we have no basis for (constraint 4).
    const job = normalizeGreenhouseJob(
      { id: 2, title: "Machinist", location: { name: "Costa Mesa, CA" } },
      "Acme",
      { hasher: fakeHasher, now: 1_700_000_000_000 },
    );
    expect(job?.remote).toBeNull();

    const remoteJob = normalizeGreenhouseJob(
      { id: 3, title: "Machinist", location: { name: "Remote, United States" } },
      "Acme",
      { hasher: fakeHasher, now: 1_700_000_000_000 },
    );
    expect(remoteJob?.remote).toBe(true);
  });
});

describe("dedupe keys", () => {
  it("collapses level notation that means the same thing", () => {
    expect(normalizeTitle("Maintenance Technician II")).toBe(
      normalizeTitle("Maintenance Technician 2"),
    );
    expect(makeDedupeKey("Acme Corp", "Maintenance Technician II", "Austin, TX")).toBe(
      makeDedupeKey("Acme", "Maintenance Technician 2", "Austin, TX"),
    );
  });

  it("keeps genuinely different roles apart", () => {
    // Named explicitly. "does not collapse different titles" without a stated
    // pair is a test written to pass.
    expect(makeDedupeKey("Acme", "Software Engineer", "Austin, TX")).not.toBe(
      makeDedupeKey("Acme", "Software Engineer, Security", "Austin, TX"),
    );
  });

  it("keeps the same role in different cities apart", () => {
    expect(makeDedupeKey("Acme", "Truck Driver", "Austin, TX")).not.toBe(
      makeDedupeKey("Acme", "Truck Driver", "Boston, MA"),
    );
  });
});

describe("html helpers", () => {
  it("decodes numeric and named entities", () => {
    expect(decodeEntities("a &amp; b &#39;c&#39; &#x2014; d &nbsp;e")).toBe(
      "a & b 'c' — d  e",
    );
  });

  it("leaves unknown entities alone rather than mangling them", () => {
    expect(decodeEntities("&notarealentity; stays")).toBe("&notarealentity; stays");
  });

  it("does not fuse words across block boundaries", () => {
    expect(collapseWhitespace(stripTags("<p>one</p><p>two</p>"))).toBe("one\ntwo");
  });
});
