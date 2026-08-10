import { describe, expect, it } from "vitest";
import { normalizeUsLocation } from "../src/core/pipeline/states.ts";
import { normalizeLeverPosting } from "../src/core/sources/lever.ts";
import { normalizeAshbyPosting } from "../src/core/sources/ashby.ts";

const ctx = { hasher: { sha256Hex: (s: string) => `h(${s})` }, now: 1_700_000_000_000 };

describe("place names the radius test can read", () => {
  /**
   * Lever says "Dallas, Texas" and Ashby "San Mateo, California, United
   * States". isWithinReach matches the profile's two-letter code on a word
   * boundary, so both would fail for a Texan or a Californian — silently, and
   * disguised by the nationwide widening message, exactly as Adzuna's county
   * strings would have.
   */
  it("shortens a written-out state", () => {
    expect(normalizeUsLocation("Dallas, Texas")).toBe("Dallas, TX");
    expect(normalizeUsLocation("San Mateo, California, United States")).toBe(
      "San Mateo, CA",
    );
    expect(normalizeUsLocation("Washington, DC")).toBe("Washington, DC");
  });

  it("leaves alone what it cannot resolve, rather than inventing", () => {
    // All three are real answers a board gives. Rewriting them into something
    // more convenient would be making up a fact.
    expect(normalizeUsLocation("Remote")).toBe("Remote");
    expect(normalizeUsLocation("London")).toBe("London");
    expect(normalizeUsLocation("United States")).toBe("United States");
  });
});

describe("Lever postings", () => {
  const base = {
    id: "abc",
    text: "Maintenance Technician",
    descriptionPlain: "Keep the fleet running.",
    createdAt: 1_779_920_530_389,
    hostedUrl: "https://jobs.lever.co/shieldai/abc",
    workplaceType: "onsite",
    categories: { location: "Dallas, Texas" },
    salaryRange: {
      currency: "USD",
      interval: "per-year-salary",
      min: 88075,
      max: 132113,
    },
  };

  it("publishes the employer's own pay, with its stated interval", () => {
    const job = normalizeLeverPosting(base, "Shield AI", ctx);
    expect(job?.salaryMin).toBe(88075);
    expect(job?.salaryInterval).toBe("year");
    expect(job?.location).toBe("Dallas, TX");
  });

  /**
   * Measured across one board: 333 per-year, 19 per-hour, 1 per-month. Getting
   * the interval wrong turns $30 an hour into $30 a year on the card, so an
   * unrecognised one drops the amount rather than defaulting it.
   */
  it("maps hourly pay as hourly", () => {
    const job = normalizeLeverPosting(
      {
        ...base,
        salaryRange: {
          ...base.salaryRange,
          interval: "per-hour-wage",
          min: 28,
          max: 34,
        },
      },
      "Shield AI",
      ctx,
    );
    expect(job?.salaryInterval).toBe("hour");
    expect(job?.salaryMax).toBe(34);
  });

  it("drops an amount whose interval it does not recognise", () => {
    const job = normalizeLeverPosting(
      {
        ...base,
        salaryRange: { ...base.salaryRange, interval: "per-fortnight-doubloons" },
      },
      "Shield AI",
      ctx,
    );
    expect(job?.salaryMin).toBeNull();
    expect(job?.salaryInterval).toBeNull();
  });

  it("reports what the board said about remote, and null when it said nothing", () => {
    expect(normalizeLeverPosting(base, "Shield AI", ctx)?.remote).toBe(false);
    expect(
      normalizeLeverPosting({ ...base, workplaceType: "remote" }, "Shield AI", ctx)
        ?.remote,
    ).toBe(true);
    const { workplaceType: _w, ...silent } = base;
    expect(normalizeLeverPosting(silent, "Shield AI", ctx)?.remote).toBeNull();
  });
});

describe("Ashby postings", () => {
  const base = {
    id: "xyz",
    title: "Security Officer",
    location: "San Mateo, California, United States",
    publishedAt: "2026-06-04T17:36:23.056+00:00",
    isRemote: false,
    workplaceType: "OnSite",
    jobUrl: "https://jobs.ashbyhq.com/skydio/xyz",
    descriptionPlain: "Guard the site.",
    shouldDisplayCompensationOnJobPostings: true,
    compensation: {
      summaryComponents: [
        {
          compensationType: "Salary",
          interval: "1 YEAR",
          currencyCode: "USD",
          minValue: 162000,
          maxValue: 192000,
        },
      ],
    },
  };

  it("publishes salary the employer chose to show", () => {
    const job = normalizeAshbyPosting(base, "Skydio", ctx);
    expect(job?.salaryMin).toBe(162000);
    expect(job?.salaryInterval).toBe("year");
    expect(job?.location).toBe("San Mateo, CA");
    expect(job?.remote).toBe(false);
  });

  /**
   * The employer's own switch. Republishing pay they chose to withhold is not
   * ours to do, even when the numbers are sitting right there in the payload.
   */
  it("respects the employer switching pay display off", () => {
    const job = normalizeAshbyPosting(
      { ...base, shouldDisplayCompensationOnJobPostings: false },
      "Skydio",
      ctx,
    );
    expect(job?.salaryMin).toBeNull();
  });

  /**
   * An equity band rendered as "$140,000 to $245,000 a year" would be a lie
   * about wages.
   */
  it("never reads an equity or bonus band as wages", () => {
    const job = normalizeAshbyPosting(
      {
        ...base,
        compensation: {
          summaryComponents: [
            {
              compensationType: "Equity",
              interval: "1 YEAR",
              currencyCode: "USD",
              minValue: 140000,
              maxValue: 245000,
            },
          ],
        },
      },
      "Skydio",
      ctx,
    );
    expect(job?.salaryMin).toBeNull();
    expect(job?.salaryInterval).toBeNull();
  });

  it("says nothing about remote when the board said nothing", () => {
    const { workplaceType: _w, ...silent } = base;
    expect(normalizeAshbyPosting(silent, "Skydio", ctx)?.remote).toBeNull();
  });

  /**
   * Measured: isRemote is true for all 64 of Skydio hybrid postings, every one
   * in San Mateo, and 4 of Saronic. It means "not strictly on site".
   *
   * remote === true short-circuits isWithinReach, so trusting it would put a
   * California office job into a Fayetteville veteran list as work they could
   * take from home — a fact nobody stated, arriving through the job list.
   */
  it("does not call a hybrid office job remote, whatever isRemote says", () => {
    const job = normalizeAshbyPosting(
      { ...base, isRemote: true, workplaceType: "Hybrid" },
      "Skydio",
      ctx,
    );
    expect(job?.remote).toBe(false);
  });

  it("reads workplaceType Remote as remote", () => {
    expect(
      normalizeAshbyPosting({ ...base, workplaceType: "Remote" }, "Skydio", ctx)
        ?.remote,
    ).toBe(true);
  });
});

describe("what Lever text actually gets embedded", () => {
  /**
   * Measured on one 434-posting board: descriptionPlain already contains
   * descriptionBodyPlain on 402 of them and leads with openingPlain — 525
   * characters of company blurb IDENTICAL across all 434. Against a
   * 1,000-character embedding budget that boilerplate would be most of the
   * vector and every posting on the board would look alike, which is the
   * collapse stripContentIntro exists to prevent on Greenhouse. Meanwhile
   * `lists` — the responsibilities and qualifications — was discarded.
   */
  const posting = {
    id: "abc",
    text: "Maintenance Technician",
    openingPlain: "SHARED COMPANY BLURB ".repeat(20),
    descriptionPlain: "SHARED COMPANY BLURB ".repeat(20) + "We keep aircraft flying.",
    descriptionBodyPlain: "We keep aircraft flying.",
    lists: [
      { text: "What you will do:", content: "<li>Service hydraulic systems</li>" },
      { text: "Required qualifications:", content: "<li>A&P licence</li>" },
    ],
    additionalPlain: "Benefits are good.",
    createdAt: 1_779_920_530_389,
    hostedUrl: "https://jobs.lever.co/x/abc",
    categories: { location: "Dallas, Texas" },
  };

  it("keeps the requirements and drops the blurb", () => {
    const text = normalizeLeverPosting(posting, "Shield AI", ctx)!.descriptionText;
    expect(text).toContain("Service hydraulic systems");
    expect(text).toContain("A&P licence");
    expect(text).not.toContain("SHARED COMPANY BLURB");
  });

  it("does not say the body twice", () => {
    const text = normalizeLeverPosting(posting, "Shield AI", ctx)!.descriptionText;
    expect(text.split("We keep aircraft flying.").length - 1).toBe(1);
  });
});

describe("fields the API sends as null, not absent", () => {
  /**
   * Ashby sends an explicit JSON null for workplaceType. A guard that only
   * checked `undefined` threw on it and took out Saronic, Skydio and Form
   * Energy entirely — 548 jobs — surfacing as one quiet source-error line
   * while every other board succeeded.
   *
   * TypeScript did not catch it because the interface said `string`, which is
   * what the payload looked like in the sample that got read.
   */
  const nullish = {
    id: "n1",
    title: "Technician",
    location: null,
    publishedAt: null,
    workplaceType: null,
    descriptionPlain: null,
    jobUrl: "https://jobs.ashbyhq.com/x/n1",
  };

  it("survives an Ashby posting whose optional fields are null", () => {
    const job = normalizeAshbyPosting(nullish, "Saronic", ctx);
    expect(job).not.toBeNull();
    expect(job?.remote).toBeNull();
    expect(job?.location).toBeNull();
    expect(job?.postedAtIsEstimated).toBe(true);
    expect(job?.descriptionText).toBe("");
  });

  it("survives a Lever posting whose optional fields are null", () => {
    const job = normalizeLeverPosting(
      {
        id: "n2",
        text: "Driver",
        workplaceType: null,
        categories: { location: null },
        createdAt: 1_779_920_530_389,
        hostedUrl: "https://jobs.lever.co/x/n2",
      },
      "Shield AI",
      ctx,
    );
    expect(job).not.toBeNull();
    expect(job?.remote).toBeNull();
    expect(job?.location).toBeNull();
  });
});
