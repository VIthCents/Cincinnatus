import { describe, it, expect } from "vitest";
import { NodeDb } from "../src/node/db.ts";
import { migrate } from "../src/core/db/migrations.ts";
import * as repo from "../src/core/db/repo.ts";
import { toDollarPlaceholders } from "../src/tauri/db.ts";
import { isSearchDue } from "../src/core/app/schedule.ts";
import { getMonthSpend, recordSpend, spendInWords } from "../src/core/app/spend.ts";
import { chatTurn } from "../src/core/chat/agent.ts";
import { CHAT_SYSTEM } from "../src/core/chat/prompts/chat.v1.ts";
import { loadRankedFromDb } from "../src/core/pipeline/loadRanked.ts";
import { encodeVector } from "../src/core/util/base64.ts";
import { nodeHasher } from "../src/node/clock.ts";
import type { Job, Profile } from "../src/core/types.ts";
import { createFakeLlm } from "./fakes/llm.ts";

const NOW = Date.parse("2026-08-09T12:00:00Z");

// -----------------------------------------------------------------------------
// Tauri SQL placeholder rewrite
// -----------------------------------------------------------------------------

describe("toDollarPlaceholders", () => {
  it("numbers placeholders left to right", () => {
    expect(toDollarPlaceholders("SELECT * FROM t WHERE a = ? AND b = ?")).toBe(
      "SELECT * FROM t WHERE a = $1 AND b = $2",
    );
  });

  it("handles the 21-column job upsert shape", () => {
    const sql = `INSERT INTO jobs VALUES (${Array(21).fill("?").join(", ")})`;
    const rewritten = toDollarPlaceholders(sql);
    expect(rewritten).toContain("$1");
    expect(rewritten).toContain("$21");
    expect(rewritten).not.toContain("?");
  });

  it("leaves SQL without placeholders alone", () => {
    // The rewrite is a blind left-to-right substitution. That is safe while no
    // SQL string carries a literal question mark inside quoted text — which
    // none does; a future one would fail loudly at bind time with a parameter
    // count mismatch rather than corrupting data silently.
    expect(toDollarPlaceholders("SELECT 1")).toBe("SELECT 1");
  });
});

// -----------------------------------------------------------------------------
// Scheduler policy
// -----------------------------------------------------------------------------

describe("isSearchDue", () => {
  const HOUR = 60 * 60 * 1000;

  it("is due when nothing has ever run", () => {
    expect(isSearchDue(null, 6, NOW)).toBe(true);
  });

  it("is due exactly at the interval, not a moment before", () => {
    expect(isSearchDue(NOW - 6 * HOUR, 6, NOW)).toBe(true);
    expect(isSearchDue(NOW - 6 * HOUR + 1, 6, NOW)).toBe(false);
  });

  it("interval 0 means the schedule is off — even for a first run", () => {
    expect(isSearchDue(null, 0, NOW)).toBe(false);
    expect(isSearchDue(NOW - 100 * HOUR, 0, NOW)).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Spend tracking
// -----------------------------------------------------------------------------

describe("spend", () => {
  it("accumulates within a month and resets across months", async () => {
    const db = new NodeDb(":memory:");
    await migrate(db, NOW);

    await recordSpend(db, NOW, 0.031);
    await recordSpend(db, NOW, 0.02);
    expect(await getMonthSpend(db, NOW)).toBeCloseTo(0.051, 6);

    const nextMonth = Date.parse("2026-09-02T00:00:00Z");
    expect(await getMonthSpend(db, nextMonth)).toBe(0);

    db.close();
  });

  it("speaks plainly", () => {
    expect(spendInWords(0)).toBe("nothing yet");
    expect(spendInWords(0.01)).toBe("less than 5 cents");
    expect(spendInWords(1.204)).toBe("about $1.20");
  });
});

// -----------------------------------------------------------------------------
// Chat agent
// -----------------------------------------------------------------------------

describe("chatTurn", () => {
  it("uses the fast model and includes the resume when there is one", async () => {
    const { llm, requests } = createFakeLlm(["Here's a thought."]);
    const resume = {
      name: "Test Vet",
      email: null,
      phone: null,
      location: null,
      summary: null,
      experience: [],
      education: [],
      certifications: [],
      skills: ["dispatch"],
      clearance: null,
      militaryCodes: ["88M"],
    };

    const { reply } = await chatTurn(llm, {
      history: [],
      userMessage: "How do I explain my Army job?",
      resume,
    });

    expect(reply).toBe("Here's a thought.");
    expect(requests[0]!.model).toBe("fast");
    expect(requests[0]!.system).toContain(CHAT_SYSTEM);
    expect(requests[0]!.system).toContain("88M");
  });

  it("caps how much history rides along", async () => {
    const { llm, requests } = createFakeLlm(["ok"]);
    const history = Array.from({ length: 60 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `message ${i}`,
    }));

    await chatTurn(llm, { history, userMessage: "hi", resume: null });

    // 20 of history + the new user message.
    expect(requests[0]!.messages.length).toBe(21);
    expect(requests[0]!.messages[0]!.content).toBe("message 40");
  });

  it("never sends a history that leads with an assistant turn (the API rejects it)", async () => {
    const { llm, requests } = createFakeLlm(["ok", "ok"]);

    // A chat that opens with chip output: assistant first.
    await chatTurn(llm, {
      history: [
        { role: "assistant", content: "Here's my honest read of your resume:" },
        { role: "assistant", content: "That needs the AI helper." },
      ],
      userMessage: "which fix first?",
      resume: null,
    });
    expect(requests[0]!.messages[0]!.role).toBe("user");
    expect(requests[0]!.messages).toHaveLength(1);

    // Mixed: leading assistant dropped, later turns kept in order.
    await chatTurn(llm, {
      history: [
        { role: "assistant", content: "welcome" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ],
      userMessage: "next",
      resume: null,
    });
    expect(requests[1]!.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
  });

  it("never bothers the model with an empty message", async () => {
    const { llm, requests } = createFakeLlm([]);
    const { reply } = await chatTurn(llm, {
      history: [],
      userMessage: "   ",
      resume: null,
    });
    expect(reply).toBe("");
    expect(requests).toHaveLength(0);
  });

  it("the prompt draws the lines that matter", () => {
    // Scope: not a general chatbot; no legal/medical/VA-claims advice; the
    // human alternative is named. These are product commitments (SPEC §7).
    expect(CHAT_SYSTEM).toContain("not a general chatbot");
    expect(CHAT_SYSTEM).toMatch(/No legal advice/i);
    expect(CHAT_SYSTEM).toMatch(/DAV or VSO/);
    expect(CHAT_SYSTEM).toMatch(/Never invent/i);
  });
});

// -----------------------------------------------------------------------------
// Rank-from-db (what the Opportunities tab shows on a cold start)
// -----------------------------------------------------------------------------

function makeJob(id: string, title: string, postedAt: number, embedHash: string): Job {
  return {
    id,
    source: "greenhouse",
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
    postedAt,
    postedAtIsEstimated: false,
    descriptionText: `${title} description`,
    raw: "{}",
    firstSeenAt: postedAt,
    lastSeenAt: postedAt,
    dedupeKey: `test-co|${title.toLowerCase()}|fayetteville`,
    canonicalId: null,
    ...(embedHash === "" ? {} : {}),
  };
}

describe("loadRankedFromDb", () => {
  const MODEL = "test-model@q0";

  const profile: Profile = {
    titles: ["Dispatcher"],
    skills: [],
    mocCodes: [],
    branch: null,
    clearance: null,
    education: [],
    yearsExperience: null,
    location: { city: "Fayetteville", state: "NC" },
    radiusMiles: 50,
    remotePreference: "any",
    salaryFloor: null,
    excludedKeywords: [],
  };

  it("returns null with no profile, and ranks stored jobs once one exists", async () => {
    const db = new NodeDb(":memory:");
    await migrate(db, NOW);

    expect(await loadRankedFromDb(db, MODEL, NOW)).toBeNull();

    // Two jobs, same age, different stored vectors. The profile vector points
    // at [1,0], so jobA (aligned) must outrank jobB (orthogonal).
    const day = 24 * 60 * 60 * 1000;
    const jobA = makeJob(nodeHasher.sha256Hex("a"), "Dispatcher", NOW - day, "ha");
    const jobB = makeJob(nodeHasher.sha256Hex("b"), "Welder", NOW - day, "hb");
    await repo.upsertJobs(db, [jobA, jobB]);

    const alignedWithProfile = new Float32Array([1, 0]);
    const orthogonal = new Float32Array([0, 1]);
    await repo.saveEmbeddings(db, MODEL, 2, NOW, [
      ["hash-a", encodeVector(alignedWithProfile)],
      ["hash-b", encodeVector(orthogonal)],
    ]);
    await repo.setEmbedHashes(db, [
      [jobA.id, "hash-a"],
      [jobB.id, "hash-b"],
    ]);

    await repo.saveProfile(
      db,
      profile,
      NOW,
      encodeVector(new Float32Array([1, 0])),
      MODEL,
    );

    const loaded = await loadRankedFromDb(db, MODEL, NOW);
    expect(loaded).not.toBeNull();
    const ranked = loaded!.ranked.ranked;
    expect(ranked.length).toBe(2);
    expect(ranked[0]!.job.id).toBe(jobA.id);
    expect(ranked[0]!.fitScore).toBeGreaterThan(ranked[1]!.fitScore);

    db.close();
  });

  it("ignores a stored profile vector from a different model", async () => {
    const db = new NodeDb(":memory:");
    await migrate(db, NOW);
    await repo.saveProfile(
      db,
      profile,
      NOW,
      encodeVector(new Float32Array([1, 0])),
      "some-other-model@q8",
    );
    expect(await repo.getStoredProfileEmbedding(db, MODEL)).toBeNull();
    db.close();
  });
});
