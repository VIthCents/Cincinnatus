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
    const { isRemote: _r, ...silent } = base;
    expect(normalizeAshbyPosting(silent, "Skydio", ctx)?.remote).toBeNull();
  });
});
