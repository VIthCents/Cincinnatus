import { describe, expect, it } from "vitest";
import {
  ADZUNA_MAX_PAGES,
  ADZUNA_MAX_TERMS,
  DEFAULT_REQUEST_DELAY_MS,
  REQUEST_DELAY_MS,
} from "../src/core/config.ts";
import { redactCredentials } from "../src/core/net/redact.ts";
import { locationFromArea, stateCodeFor } from "../src/core/pipeline/states.ts";
import {
  buildAdzunaSearchUrl,
  normalizeAdzunaJob,
} from "../src/core/sources/adzuna.ts";
import { toPlainMessage } from "../src/core/sources/source.ts";
import { rankJobs } from "../src/core/pipeline/rank.ts";
import { parseProfile } from "../src/core/profile/parse.ts";
import { readFileSync } from "node:fs";

const profileOf = () => {
  const parsed = parseProfile(
    JSON.parse(readFileSync("fixtures/profile.sample.json", "utf8")),
  );
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.value;
};

const ctx = { hasher: { sha256Hex: (s: string) => `h(${s})` }, now: 1_700_000_000_000 };

const OPTIONS = {
  auth: { appId: "the-id", appKey: "the-secret" },
  keywords: ["truck driver"],
  locationName: "Fayetteville, NC",
  radiusMiles: 50,
};

describe("Adzuna locations", () => {
  /**
   * The bug this prevents is silent and self-camouflaging. `isWithinReach`
   * tests the profile's TWO-LETTER state with a word boundary, so a location
   * of "Haymount, Cumberland County" matches no North Carolinian who does not
   * live in Haymount. With nothing counting as nearby, ranking widens to the
   * whole country and tells the user "only N jobs are near you" — a plausible
   * sentence describing a bug.
   */
  it("turns Adzuna's area array into City, ST", () => {
    expect(
      locationFromArea(["US", "North Carolina", "Cumberland County", "Haymount"]),
    ).toBe("Haymount, NC");
    expect(locationFromArea(["US", "Texas", "Bexar County", "San Antonio"])).toBe(
      "San Antonio, TX",
    );
  });

  it("falls back to the county only when there is nothing finer", () => {
    expect(locationFromArea(["US", "North Carolina", "Cumberland County"])).toBe(
      "Cumberland County, NC",
    );
  });

  it("never invents a state it cannot resolve", () => {
    expect(locationFromArea(["US", "Nowhereland", "Somewhere"])).toBeNull();
    expect(locationFromArea(["US"])).toBeNull();
    expect(stateCodeFor("Not A State")).toBeNull();
  });

  it("does not render a state as its own city", () => {
    expect(locationFromArea(["US", "Texas", "Texas"])).toBe("TX");
    expect(locationFromArea(["US", "Texas"])).toBe("TX");
  });
});

describe("Adzuna job normalization", () => {
  const base = {
    id: "123",
    title: "Class A Driver",
    created: "2026-07-15T15:06:30Z",
    redirect_url: "https://www.adzuna.com/land/ad/123",
    company: { display_name: "J&R Schugel" },
    location: {
      display_name: "Haymount, Cumberland County",
      area: ["US", "North Carolina", "Cumberland County", "Haymount"],
    },
    description: "Hiring CDL-A drivers.",
  };

  /**
   * `salary_is_predicted` is the STRING "0" or "1". A natural
   * `if (raw.salary_is_predicted)` is truthy for "0" and would drop every real
   * salary; the inverse keeps every guessed one. 47 of every 50 Adzuna results
   * carry a predicted salary, so the failure that matters is a number no
   * employer ever stated reaching a card — fabrication arriving through the job
   * list rather than the documents.
   *
   * We drop salary entirely regardless, because Adzuna ships no pay-interval
   * field and annualises everything itself. All four cases must be null.
   */
  it.each([["0"], ["1"], [undefined], ["unexpected"]])(
    "never publishes a salary (salary_is_predicted=%s)",
    (flag) => {
      const job = normalizeAdzunaJob(
        {
          ...base,
          salary_is_predicted: flag,
          salary_min: 143042,
          salary_max: 143042,
        } as never,
        ctx,
      );
      expect(job).not.toBeNull();
      expect(job?.salaryMin).toBeNull();
      expect(job?.salaryMax).toBeNull();
      expect(job?.salaryInterval).toBeNull();
      expect(job?.salaryCurrency).toBeNull();
    },
  );

  it("uses the resolvable state, not the display name", () => {
    expect(normalizeAdzunaJob(base, ctx)?.location).toBe("Haymount, NC");
  });

  it("falls back to what Adzuna printed rather than guessing", () => {
    const job = normalizeAdzunaJob(
      { ...base, location: { display_name: "Somewhere odd", area: ["US"] } },
      ctx,
    );
    expect(job?.location).toBe("Somewhere odd");
  });

  it("reports remote as null when the source did not say", () => {
    expect(normalizeAdzunaJob(base, ctx)?.remote).toBeNull();
  });

  it("drops the description from the stored raw blob", () => {
    const job = normalizeAdzunaJob(base, ctx);
    expect(job?.descriptionText).toContain("Hiring CDL-A drivers");
    expect(JSON.parse(job!.raw).description).toBeUndefined();
  });

  it("returns null rather than a partial job", () => {
    const { id: _id, ...noId } = base;
    expect(normalizeAdzunaJob(noId, ctx)).toBeNull();
    expect(normalizeAdzunaJob({ ...base, title: "  " }, ctx)).toBeNull();
  });
});

describe("Adzuna request budget", () => {
  /**
   * Adzuna's terms allow 25 requests/minute, 250/day, 1,000/week, 2,500/month.
   * A Source is handed no database and cannot count across runs, so the budget
   * has to hold by construction. Do the arithmetic before changing these.
   */
  it("cannot exceed the monthly quota on the default schedule", () => {
    const perRun = ADZUNA_MAX_TERMS * ADZUNA_MAX_PAGES;
    // 4 scheduled searches a day (every 6 hours), plus generous manual use.
    const perMonth = perRun * 8 * 31;
    expect(perMonth).toBeLessThan(2500);
  });

  it("paces below the stated 25 requests per minute", () => {
    const delay = REQUEST_DELAY_MS["api.adzuna.com"] ?? DEFAULT_REQUEST_DELAY_MS;
    expect(delay).toBeGreaterThanOrEqual(60_000 / 25);
  });

  it("puts the page in the path and the radius in kilometres", () => {
    const url = buildAdzunaSearchUrl(OPTIONS, "truck driver", 2);
    expect(url).toContain("/v1/api/jobs/us/search/2?");
    // 50 miles is 80 km. Adzuna documents this parameter in kilometres.
    expect(url).toContain("distance=80");
    expect(url).toContain("where=Fayetteville%2C%20NC");
  });
});

describe("credentials never reach the user", () => {
  /**
   * Adzuna authenticates by query string, and this codebase treats errors as
   * data: they are persisted to SQLite by saveRun and rendered in the
   * Opportunities banner. Without redaction one failed request writes the
   * user's API key into their own run history in plain text.
   */
  it("redacts app_id and app_key from a URL", () => {
    const url = buildAdzunaSearchUrl(OPTIONS, "driver", 1);
    expect(url).toContain("the-secret");
    expect(redactCredentials(url)).not.toContain("the-secret");
    expect(redactCredentials(url)).not.toContain("the-id");
  });

  it("redacts them from the message a veteran would see", () => {
    const leaked = new Error(
      `fetch failed for https://api.adzuna.com/v1/api/jobs/us/search/1?app_id=the-id&app_key=the-secret`,
    );
    const message = toPlainMessage(leaked, "adzuna");
    expect(message).not.toContain("the-secret");
  });
});

describe("one employer cannot fill the screen", () => {
  /**
   * The first live Adzuna run put nine identical "CDL A Delivery Truck Driver"
   * postings from Mclane in the top twelve, one per North Carolina town. Each
   * is real, distinct and genuinely nearby, so collapsing them would be wrong —
   * but a person scrolling sees one job nine times.
   */
  const job = (id: string, company: string, title: string, cosine: number) => ({
    source: "adzuna" as const,
    externalId: id,
    id,
    title,
    company,
    location: "Fayetteville, NC",
    remote: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryInterval: null,
    url: "https://example.test",
    postedAt: 1_700_000_000_000,
    postedAtIsEstimated: false,
    descriptionText: "",
    raw: "{}",
    firstSeenAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_000_000,
    dedupeKey: id,
    canonicalId: null,
    cosine,
  });

  it("demotes the surplus without losing it", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      job(
        `m${i}`,
        "Mclane Company, Inc.",
        "CDL A Delivery Truck Driver",
        0.9 - i * 0.001,
      ),
    );
    const others = [
      job("a", "Hepaco", "CDL Driver", 0.5),
      job("b", "Decker", "Class A Company Driver", 0.4),
    ];
    const all = [...many, ...others];

    const { ranked } = rankJobs({
      jobs: all as never,
      vectors: new Map(
        all.map((j) => [
          j.id,
          new Float32Array([j.cosine, Math.sqrt(1 - j.cosine ** 2)]),
        ]),
      ),
      profileVector: new Float32Array([1, 0]),
      profile: profileOf(),
      now: 1_700_000_000_000 + 86_400_000,
    });

    // Nothing is dropped — the person who scrolls still finds the branch
    // nearest them.
    expect(ranked).toHaveLength(11);
    const topFive = ranked.slice(0, 5).map((r) => r.job.company);
    expect(topFive.filter((c) => c === "Mclane Company, Inc.")).toHaveLength(3);
    // The other employers are visible rather than buried under nine of one.
    expect(topFive).toContain("Hepaco");
    expect(topFive).toContain("Decker");
  });
});
