import { describe, expect, it } from "vitest";
import {
  hasDegree,
  isCredentialGated,
  reachAdjustedSimilarity,
  titleAffinity,
} from "../src/core/pipeline/reach.ts";
import type { Profile } from "../src/core/types.ts";

/**
 * reach.ts corrects the encoder's category error: cosine answers "same
 * subject?", the veteran asks "could I get it?". The property that makes the
 * credential gate safe to act on — measured across 88 labelled jobs, two
 * profiles — is that it fired on 43–60% of judge-rejected jobs and on ZERO
 * judge-approved ones. These tests pin the cases that property rests on.
 */

const BASE: Profile = {
  titles: ["Truck Driver", "Logistics Coordinator", "Fleet Supervisor"],
  skills: ["CDL Class A", "Dispatch"],
  mocCodes: ["88M"],
  branch: "Army",
  clearance: "Secret",
  education: ["High school diploma", "CDL Class A"],
  yearsExperience: 8,
  location: { city: "Fayetteville", state: "NC" },
  radiusMiles: 50,
  remotePreference: "any",
  salaryFloor: 55000,
  excludedKeywords: [],
};

describe("hasDegree", () => {
  it("a diploma and a CDL are not a degree", () => {
    expect(hasDegree(BASE)).toBe(false);
  });

  it("recognises a degree however the person wrote it", () => {
    for (const wording of [
      "Bachelor of Science, Logistics",
      "BS in Business",
      "Associate degree",
      "Community college, general studies",
      "MBA, University of Phoenix",
    ]) {
      expect(hasDegree({ ...BASE, education: [wording] })).toBe(true);
    }
  });
});

describe("isCredentialGated", () => {
  it("gates degree-fenced titles for a person without a degree", () => {
    for (const title of [
      "Senior Software Engineer, Manufacturing Test",
      "Staff Welding Engineer",
      "Senior Privacy Counsel",
      "Robotics Software Engineer",
      "Senior Technical Recruiter, Global Logistics",
    ]) {
      expect(isCredentialGated(title, BASE)).toBe(true);
    }
  });

  /**
   * The zero-false-positive half. Every one of these is a real title from the
   * golden sets that a judge said the person could get. "Technician",
   * "Operator", "Driver" and "Assistant" are deliberately not gates — they are
   * the skilled jobs this app exists to surface.
   */
  it("never gates the work the person can actually get", () => {
    for (const title of [
      "Class A Driver",
      "Military Shipping Lead",
      "Associate Service Technician - Chicago, IL",
      "Structures Technician I, First Shift",
      "Customs Specialist",
      "SUPERVISORY LOGISTICS MANAGEMENT SPECIALIST",
      "Security Officer",
      "POLICE OFFICER",
      "Material Handler, Service Parts Distribution Warehouse",
    ]) {
      expect(isCredentialGated(title, BASE)).toBe(false);
    }
  });

  it("does not gate anything for a person with a degree", () => {
    const graduate = { ...BASE, education: ["BS, Supply Chain Management"] };
    expect(isCredentialGated("Senior Software Engineer", graduate)).toBe(false);
  });
});

describe("titleAffinity", () => {
  it("is 1 when a profile title appears whole in the job title", () => {
    expect(titleAffinity("CDL Truck Driver - Night Shift", BASE)).toBe(1);
  });

  it("is fractional on partial overlap and 0 on none", () => {
    // "Logistics Coordinator" -> "logistics" matches, "coordinator" does not.
    expect(titleAffinity("Logistics Program Manager", BASE)).toBeCloseTo(0.5);
    expect(titleAffinity("Frontend Web Developer", BASE)).toBe(0);
  });

  it("reaches through the MOC crosswalk, not just stated titles", () => {
    // "Dispatcher" comes from the 88M crosswalk; it is not in BASE.titles.
    const noTitles = { ...BASE, titles: [] };
    expect(titleAffinity("Dispatcher", noTitles)).toBeGreaterThan(0);
  });
});

describe("reachAdjustedSimilarity", () => {
  it("the measured Firefighter/Class A Driver inversion comes out right", () => {
    // Real cosines from the live run: the encoder scores Firefighter ABOVE the
    // driving job for a CDL holder. All three judges disagreed.
    const firefighter = reachAdjustedSimilarity(
      0.515,
      "Firefighter (Basic Life Support)",
      BASE,
    );
    const driver = reachAdjustedSimilarity(0.47, "Class A Driver", BASE);
    expect(driver).toBeGreaterThan(firefighter);
  });

  it("penalty and bonus stack on the raw similarity", () => {
    // Gated title, no overlap: 0.5 - 0.15.
    expect(reachAdjustedSimilarity(0.5, "Software Engineer", BASE)).toBeCloseTo(0.35);
    // Full-overlap title, not gated: 0.5 + 0.1.
    expect(reachAdjustedSimilarity(0.5, "Truck Driver", BASE)).toBeCloseTo(0.6);
  });
});
