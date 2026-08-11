import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildSearchTerms } from "../src/core/pipeline/queries.ts";
import { parseProfile } from "../src/core/profile/parse.ts";
import { ADZUNA_MAX_TERMS } from "../src/core/config.ts";

/**
 * The thumbs change what gets SEARCHED FOR, not how anything is scored.
 *
 * That is the opposite of the obvious design, because the obvious design was
 * measured and it was harmful: simulating thumbs from the golden set's human
 * labels — Rocchio nudges, k-NN votes, company and title priors, every weight
 * tried — gave a negative mean change in NDCG@10 on both profiles. And
 * anything that raises fitScore trips the widening rule, at which point the
 * list collapses to local jobs measured to contain nothing hireable and 46 of
 * 48 labelled jobs vanish.
 */
const profile = (() => {
  const parsed = parseProfile(
    JSON.parse(readFileSync("fixtures/profile.sample.json", "utf8")),
  );
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.value;
})();

describe("thumbs change the next search", () => {
  it("puts a thumbed-up title where the source caps can actually see it", () => {
    // The whole point. This profile generates ten titles and only the first
    // five reach Adzuna, and "Class A Driver" — the one posting the judges
    // called a strong match — is not among them until it is thumbed.
    const before = buildSearchTerms(profile).titles;
    expect(before.slice(0, ADZUNA_MAX_TERMS)).not.toContain("Class A Driver");

    const after = buildSearchTerms(profile, {
      promoted: ["Class A Driver"],
      demoted: [],
    }).titles;
    expect(after.slice(0, ADZUNA_MAX_TERMS)).toContain("Class A Driver");
  });

  it("drops a thumbed-down title", () => {
    const withIt = buildSearchTerms(profile).titles;
    expect(withIt).toContain("Dispatcher");
    const without = buildSearchTerms(profile, {
      promoted: [],
      demoted: ["Dispatcher"],
    }).titles;
    expect(without).not.toContain("Dispatcher");
  });

  /**
   * The person typed these into the setup to say what they are looking for.
   * One thumbs-down on a bad posting must not quietly cancel that.
   */
  it("never removes a title the person stated themselves", () => {
    expect(profile.titles).toContain("Truck Driver");
    const titles = buildSearchTerms(profile, {
      promoted: [],
      demoted: ["Truck Driver"],
    }).titles;
    expect(titles).toContain("Truck Driver");
  });

  /**
   * A search with no terms returns nothing at all, which looks exactly like
   * the app being broken.
   */
  it("never empties the list", () => {
    const all = buildSearchTerms(profile).titles;
    const titles = buildSearchTerms(profile, { promoted: [], demoted: all }).titles;
    expect(titles.length).toBeGreaterThan(0);
  });

  it("does not duplicate a title that was already there", () => {
    const titles = buildSearchTerms(profile, {
      promoted: ["Truck Driver"],
      demoted: [],
    }).titles;
    const count = titles.filter((t) => t.toLowerCase() === "truck driver").length;
    expect(count).toBe(1);
  });

  it("changes nothing at all when there are no thumbs", () => {
    expect(buildSearchTerms(profile, { promoted: [], demoted: [] }).titles).toEqual(
      buildSearchTerms(profile).titles,
    );
  });
});
