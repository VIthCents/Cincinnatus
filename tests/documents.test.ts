import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import mammoth from "mammoth";

import type { Job } from "../src/core/types.ts";
import type { CoverLetter, Critique, ResumeData } from "../src/core/documents/types.ts";
import { verifyResume, verifyCoverLetter } from "../src/core/documents/verify.ts";
import { tailorResume, jobToPromptText } from "../src/core/documents/tailor.ts";
import { reviseResume } from "../src/core/documents/revise.ts";
import { analyzeResume } from "../src/core/documents/analyze.ts";
import { parseResume } from "../src/core/documents/parseResume.ts";
import { stripSignature, writeCoverLetter } from "../src/core/documents/coverletter.ts";
import {
  formatResumeDate,
  resumeToDocxBase64,
  coverLetterToDocxBase64,
} from "../src/core/documents/exportDocx.ts";
import {
  RESUME_WITH_NOTE_SCHEMA,
  RESUME_DATA_SCHEMA,
  CRITIQUE_SCHEMA,
  COVER_LETTER_SCHEMA,
} from "../src/core/documents/schemas.ts";
import { NO_FABRICATION_RULE } from "../src/core/documents/prompts/noFabrication.ts";
import { PARSE_RESUME_SYSTEM } from "../src/core/documents/prompts/parseResume.v1.ts";
import { ANALYZE_SYSTEM } from "../src/core/documents/prompts/analyze.v1.ts";
import { REVISE_SYSTEM } from "../src/core/documents/prompts/revise.v1.ts";
import {
  TAILOR_SYSTEM,
  TAILOR_FEDERAL_ADDENDUM,
} from "../src/core/documents/prompts/tailor.v1.ts";
import { COVER_LETTER_SYSTEM } from "../src/core/documents/prompts/coverletter.v1.ts";
import {
  locationFromResumeText,
  profileFromResume,
} from "../src/core/profile/fromResume.ts";
import { createFakeLlm } from "./fakes/llm.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const ghJob = JSON.parse(
  readFileSync(join(repoRoot, "fixtures", "jobs", "greenhouse.json"), "utf8"),
) as Job;
const usaJob = JSON.parse(
  readFileSync(join(repoRoot, "fixtures", "jobs", "usajobs.json"), "utf8"),
) as Job;

/** A small but complete base resume the verifier can be exercised against. */
const BASE: ResumeData = {
  name: "Danielle R. Okafor",
  email: "drokafor88m@example.com",
  phone: "(910) 555-0142",
  location: "Fayetteville, NC",
  summary: "Army motor transport NCO with 8 years moving people, fuel, and freight.",
  experience: [
    {
      org: "189th CSSB, XVIII Airborne Corps",
      title: "Motor Transport Operator / Squad Leader",
      location: "Fort Liberty, NC",
      start: "2021-04",
      end: "present",
      hoursPerWeek: null,
      bullets: [
        "Lead 9 soldier drivers; plan and dispatch 20+ missions weekly",
        "Manage PMCS program for 45 vehicles; readiness rate 96%",
      ],
    },
    {
      org: "264th CSSB",
      title: "Motor Transport Operator",
      location: "Fort Liberty, NC",
      start: "2017-08",
      end: "2021-03",
      hoursPerWeek: null,
      bullets: ["Drove 60,000+ accident-free miles"],
    },
  ],
  education: [
    {
      institution: "E.E. Smith High School",
      credential: "High School Diploma",
      year: "2017",
    },
  ],
  certifications: ["CDL Class A (NC), hazmat endorsement", "Forklift operator"],
  skills: ["Dispatch", "Convoy planning", "PMCS"],
  clearance: "Secret",
  militaryCodes: ["88M"],
};

function tailoredCopy(overrides: Partial<ResumeData>): ResumeData {
  return { ...BASE, ...overrides };
}

// -----------------------------------------------------------------------------
// verifyResume — the constraint-4 backstop
// -----------------------------------------------------------------------------

describe("verifyResume", () => {
  it("accepts honest tailoring: reordering, cutting, and rephrasing bullets", () => {
    const tailored = tailoredCopy({
      summary:
        "Fleet operations leader with 8 years of Army motor transport experience.",
      experience: [
        {
          ...BASE.experience[1]!,
          bullets: ["Drove sixty thousand accident-free miles across two continents"],
        },
        { ...BASE.experience[0]!, bullets: [BASE.experience[0]!.bullets[0]!] },
      ],
      skills: ["Dispatch"],
    });
    expect(verifyResume(BASE, tailored)).toEqual([]);
  });

  /**
   * Bullets were not scanned at all until 2026-08-14. The structured
   * comparison checks employer, title, dates and hours and never reads bullet
   * text, so a clearance or a degree invented inside an achievement line
   * passed clean — the one place a tailoring model has room to embellish.
   */
  it("flags a clearance invented inside an experience bullet", () => {
    const tailored = tailoredCopy({
      experience: [
        {
          ...BASE.experience[0]!,
          bullets: [
            ...BASE.experience[0]!.bullets,
            "Held a TS/SCI clearance while supporting corps-level movement",
          ],
        },
        BASE.experience[1]!,
      ],
    });
    const findings = verifyResume(BASE, tailored);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "changed_clearance", severity: "high" });
  });

  it("flags a degree invented inside an experience bullet", () => {
    const tailored = tailoredCopy({
      experience: [
        {
          ...BASE.experience[0]!,
          bullets: ["Applied MBA coursework to fleet budgeting"],
        },
        BASE.experience[1]!,
      ],
    });
    const findings = verifyResume(BASE, tailored);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "unsupported_claim", severity: "high" });
    expect(findings[0]!.value).toContain("master");
  });

  it("emits one finding, not one per bullet, when a claim repeats", () => {
    // A stack of identical high-severity alarms is how someone learns to click
    // past the check that matters.
    const tailored = tailoredCopy({
      experience: [
        {
          ...BASE.experience[0]!,
          bullets: [
            "Held a TS/SCI clearance for corps movement",
            "Briefed staff while holding a TS/SCI clearance",
          ],
        },
        BASE.experience[1]!,
      ],
    });
    expect(verifyResume(BASE, tailored)).toHaveLength(1);
  });

  /**
   * The other half of the same change. Tailoring keeps bullets close to
   * verbatim, so scanning them without crediting the base resume's own prose
   * would flag a carried-over sentence as a fabrication on every single
   * document — and this is the shape that actually occurs: a 42A whose work IS
   * clearance processing, and a senior NCO who counselled soldiers through
   * degree programmes.
   */
  it("does not flag a clearance the base resume states in prose", () => {
    const proseBase: ResumeData = {
      ...BASE,
      clearance: null,
      experience: [
        {
          ...BASE.experience[0]!,
          bullets: ["Processed 200 security clearance investigations"],
        },
        BASE.experience[1]!,
      ],
    };
    const tailored: ResumeData = {
      ...proseBase,
      experience: [
        {
          ...proseBase.experience[0]!,
          bullets: [
            "Processed 200 security clearance investigations for the battalion",
          ],
        },
        proseBase.experience[1]!,
      ],
    };
    expect(verifyResume(proseBase, tailored)).toEqual([]);
  });

  it("does not flag a degree the base resume mentions for other people", () => {
    const proseBase: ResumeData = {
      ...BASE,
      experience: [
        {
          ...BASE.experience[0]!,
          bullets: ["Counseled 12 soldiers completing associate degrees"],
        },
        BASE.experience[1]!,
      ],
    };
    expect(verifyResume(proseBase, tailoredCopy({ ...proseBase }))).toEqual([]);
  });

  /**
   * The line the prose credit must not cross: a real Army course whose name
   * merely contains the word "master" cannot license a master's degree. The
   * strict pattern needs "master of/in/degree"; "Master Driver Trainer" has
   * none of them, which is exactly why prose is matched strictly and education
   * credentials loosely.
   */
  it("still flags a master's degree when the base only ran a Master Driver course", () => {
    const proseBase: ResumeData = {
      ...BASE,
      experience: [
        {
          ...BASE.experience[0]!,
          bullets: ["Completed the Master Driver Trainer course"],
        },
        BASE.experience[1]!,
      ],
    };
    const tailored: ResumeData = {
      ...proseBase,
      summary:
        "Logistics leader holding a Master of Science in Supply Chain Management",
    };
    const findings = verifyResume(proseBase, tailored);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "unsupported_claim", severity: "high" });
  });

  it("flags an added certification as high severity", () => {
    const tailored = tailoredCopy({
      certifications: [...BASE.certifications, "PMP (Project Management Professional)"],
    });
    const findings = verifyResume(BASE, tailored);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "new_certification", severity: "high" });
    expect(findings[0]!.value).toContain("PMP");
  });

  it("flags an employer the base resume never mentions", () => {
    const tailored = tailoredCopy({
      experience: [
        ...BASE.experience,
        {
          org: "Amazon Logistics",
          title: "Area Manager",
          location: null,
          start: "2016-01",
          end: "2017-07",
          hoursPerWeek: null,
          bullets: [],
        },
      ],
    });
    const findings = verifyResume(BASE, tailored);
    expect(
      findings.some((f) => f.kind === "new_employer" && f.severity === "high"),
    ).toBe(true);
  });

  it("flags a title the person never held at a real employer", () => {
    const tailored = tailoredCopy({
      experience: [
        { ...BASE.experience[0]!, title: "Director of Fleet Operations" },
        BASE.experience[1]!,
      ],
    });
    const findings = verifyResume(BASE, tailored);
    expect(findings.some((f) => f.kind === "new_title")).toBe(true);
  });

  it("flags changed dates", () => {
    const tailored = tailoredCopy({
      experience: [{ ...BASE.experience[0]!, start: "2019-04" }, BASE.experience[1]!],
    });
    const findings = verifyResume(BASE, tailored);
    expect(findings.some((f) => f.kind === "changed_dates")).toBe(true);
  });

  it("flags a clearance upgrade but allows omitting the clearance", () => {
    const upgraded = verifyResume(BASE, tailoredCopy({ clearance: "Top Secret" }));
    expect(upgraded.some((f) => f.kind === "changed_clearance")).toBe(true);

    expect(verifyResume(BASE, tailoredCopy({ clearance: null }))).toEqual([]);
  });

  it("flags a clearance invented from nothing", () => {
    const noClearanceBase = tailoredCopy({ clearance: null, summary: null });
    const findings = verifyResume(noClearanceBase, {
      ...noClearanceBase,
      clearance: "Secret",
    });
    expect(findings.some((f) => f.kind === "changed_clearance")).toBe(true);
  });

  it("flags added education", () => {
    const tailored = tailoredCopy({
      education: [
        ...BASE.education,
        { institution: "Liberty University", credential: "BS Logistics", year: "2023" },
      ],
    });
    expect(verifyResume(BASE, tailored).some((f) => f.kind === "new_education")).toBe(
      true,
    );
  });

  /**
   * Rewording is what tailoring IS. Measured live 2026-08-09, tailoring for a
   * driving job produced nine "new skill" flags, every one of them describing
   * something the resume plainly said — "Class A CDL driving" against a resume
   * reading "CDL Class A (NC)", "pre-trip inspections" against a PMCS bullet.
   * Nine false alarms on one document teaches people to click past the only
   * check standing between them and a fabricated claim.
   */
  it("does not flag a skill the resume already describes in other words", () => {
    const tailored = tailoredCopy({
      skills: [
        "Class A CDL driving", // certifications: "CDL Class A (NC), hazmat endorsement"
        "Hazmat endorsement",
        "Convoy dispatch", // skills: "Dispatch", "Convoy planning"
        "Vehicle readiness", // bullet: "45 vehicles; readiness rate 96%"
      ],
    });
    expect(verifyResume(BASE, tailored)).toHaveLength(0);
  });

  it("still catches a skill the resume does not support anywhere", () => {
    const tailored = tailoredCopy({ skills: [...BASE.skills, "Python programming"] });
    const findings = verifyResume(BASE, tailored);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "new_skill", severity: "review" });
  });

  it("surfaces new skills as review-severity, not fabrication", () => {
    const tailored = tailoredCopy({ skills: [...BASE.skills, "Fleet management"] });
    const findings = verifyResume(BASE, tailored);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "new_skill", severity: "review" });
  });

  it("flags identity changes", () => {
    const renamed = verifyResume(BASE, tailoredCopy({ name: "Dani Okafor-Smith" }));
    expect(renamed.some((f) => f.kind === "changed_identity")).toBe(true);

    const newEmail = verifyResume(BASE, tailoredCopy({ email: "other@example.com" }));
    expect(newEmail.some((f) => f.kind === "changed_identity")).toBe(true);
  });

  it("flags invented hours per week (federal trap: never assume 40)", () => {
    const tailored = tailoredCopy({
      experience: [{ ...BASE.experience[0]!, hoursPerWeek: 40 }, BASE.experience[1]!],
    });
    const findings = verifyResume(BASE, tailored);
    expect(
      findings.some((f) => f.kind === "unsupported_claim" && f.value.includes("40")),
    ).toBe(true);
  });

  it("catches clearance and degree claims smuggled into the free-text summary", () => {
    const tsClaim = verifyResume(
      BASE,
      tailoredCopy({ summary: "Top Secret cleared logistics leader." }),
    );
    expect(tsClaim.some((f) => f.kind === "changed_clearance")).toBe(true);

    const degreeClaim = verifyResume(
      BASE,
      tailoredCopy({ summary: "Holder of a Master of Science in Supply Chain." }),
    );
    expect(degreeClaim.some((f) => f.kind === "unsupported_claim")).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// verifyCoverLetter
// -----------------------------------------------------------------------------

/**
 * The guard behind the schema. Observed live on 2026-08-09: the model put the
 * name in `closing` as well, and the DOCX template adds it again, so the letter
 * signed itself twice. The prompt asks for a valediction only; this is what
 * makes it true.
 */
describe("stripSignature", () => {
  it("removes the name line and keeps the valediction", () => {
    expect(stripSignature("Sincerely,\nDanielle R. Okafor", "Danielle R. Okafor")).toBe(
      "Sincerely,",
    );
  });

  it("ignores case and surrounding whitespace on the name line", () => {
    expect(
      stripSignature("Sincerely,\n  DANIELLE R. OKAFOR  ", "Danielle R. Okafor"),
    ).toBe("Sincerely,");
  });

  it("falls back to a valediction when the closing was only the name", () => {
    expect(stripSignature("Danielle R. Okafor", "Danielle R. Okafor")).toBe(
      "Sincerely,",
    );
  });

  it("leaves the closing alone when the name is empty", () => {
    expect(stripSignature("  Warm regards,  ", "")).toBe("Warm regards,");
  });

  /**
   * Deliberately conservative: only a line that IS the name goes. A line that
   * merely contains it is prose, and deleting prose from someone's letter is a
   * worse failure than leaving a stray name.
   */
  it("keeps a line that contains the name rather than being it", () => {
    expect(
      stripSignature("Sincerely,\n— Danielle R. Okafor", "Danielle R. Okafor"),
    ).toBe("Sincerely,\n— Danielle R. Okafor");
  });
});

describe("verifyCoverLetter", () => {
  const cleanLetter: CoverLetter = {
    salutation: "Dear Hiring Team,",
    bodyParagraphs: [
      "Eight years of Army motor transport work taught me how to keep a 45-vehicle fleet moving.",
      "Your dispatcher role asks for exactly that kind of planning under pressure.",
    ],
    closing: "Sincerely,",
  };

  it("passes a letter grounded in the resume", () => {
    expect(verifyCoverLetter(BASE, cleanLetter)).toEqual([]);
  });

  it("flags a Top Secret claim when the resume says Secret", () => {
    const letter: CoverLetter = {
      ...cleanLetter,
      bodyParagraphs: ["I hold a Top Secret clearance and can start immediately."],
    };
    const findings = verifyCoverLetter(BASE, letter);
    expect(
      findings.some((f) => f.kind === "changed_clearance" && f.severity === "high"),
    ).toBe(true);
  });

  it("flags a degree the resume does not have", () => {
    const letter: CoverLetter = {
      ...cleanLetter,
      bodyParagraphs: ["My MBA prepared me to run large logistics operations."],
    };
    expect(
      verifyCoverLetter(BASE, letter).some((f) => f.kind === "unsupported_claim"),
    ).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Engine wiring — the fake Llm proves what actually gets sent and checked
// -----------------------------------------------------------------------------

describe("tailorResume", () => {
  it("runs the entity check on whatever the model returns — fabrication cannot pass through silently", async () => {
    const fabricated = tailoredCopy({
      certifications: [...BASE.certifications, "Six Sigma Black Belt"],
    });
    const { llm } = createFakeLlm([
      { resume: fabricated, note: "Emphasized fleet work." },
    ]);

    const result = await tailorResume(llm, BASE, ghJob);

    expect(result.findings.some((f) => f.kind === "new_certification")).toBe(true);
    expect(result.document).toEqual(fabricated);
    expect(result.note).toBe("Emphasized fleet work.");
  });

  it("returns no findings for an honest tailoring", async () => {
    const honest = tailoredCopy({ skills: ["Dispatch"] });
    const { llm } = createFakeLlm([{ resume: honest, note: "Trimmed." }]);
    const result = await tailorResume(llm, BASE, ghJob);
    expect(result.findings).toEqual([]);
  });

  it("uses the doc model, the resume+note schema, and the base tailor prompt", async () => {
    const { llm, requests } = createFakeLlm([{ resume: BASE, note: "" }]);
    await tailorResume(llm, BASE, ghJob);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.model).toBe("doc");
    expect(requests[0]!.jsonSchema).toBe(RESUME_WITH_NOTE_SCHEMA);
    expect(requests[0]!.system).toContain(TAILOR_SYSTEM);
    expect(requests[0]!.system).not.toContain("FEDERAL");
  });

  it("appends the federal addendum for USAJobs postings only", async () => {
    const { llm, requests } = createFakeLlm([{ resume: BASE, note: "" }]);
    await tailorResume(llm, BASE, usaJob);

    expect(usaJob.source).toBe("usajobs");
    expect(requests[0]!.system).toContain(TAILOR_FEDERAL_ADDENDUM);
  });

  it("bounds how much job description enters the prompt", () => {
    const longJob: Job = { ...ghJob, descriptionText: "x".repeat(50_000) };
    expect(jobToPromptText(longJob).length).toBeLessThan(9_000);
  });
});

describe("reviseResume", () => {
  it("surfaces user-stated additions as findings for confirmation", async () => {
    const revised = tailoredCopy({
      certifications: [...BASE.certifications, "CDL passenger endorsement"],
    });
    const { llm } = createFakeLlm([
      { resume: revised, note: "Added the passenger endorsement you mentioned." },
    ]);

    const result = await reviseResume(
      llm,
      BASE,
      "add my new CDL passenger endorsement",
    );

    expect(result.findings.some((f) => f.kind === "new_certification")).toBe(true);
    expect(result.document).toEqual(revised);
  });

  it("rejects an empty instruction before spending any credits", async () => {
    const { llm, requests } = createFakeLlm([]);
    await expect(reviseResume(llm, BASE, "   ")).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
});

describe("parseResume / analyzeResume / writeCoverLetter wiring", () => {
  it("parseResume sends the resume text against the resume schema", async () => {
    const { llm, requests } = createFakeLlm([BASE]);
    const parsed = await parseResume(llm, "RAW RESUME TEXT");
    expect(parsed).toEqual(BASE);
    expect(requests[0]!.jsonSchema).toBe(RESUME_DATA_SCHEMA);
    expect(requests[0]!.messages[0]!.content).toBe("RAW RESUME TEXT");
  });

  it("parseResume and analyzeResume refuse empty input before spending credits", async () => {
    const { llm, requests } = createFakeLlm([]);
    await expect(parseResume(llm, "  \n ")).rejects.toThrow();
    await expect(analyzeResume(llm, "")).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it("analyzeResume returns the critique against the critique schema", async () => {
    const critique: Critique = {
      summary: "Solid record, buried in jargon.",
      strengths: ["Quantified readiness rate"],
      gaps: ["MOS codes unexplained"],
      fixes: [
        {
          what: "Translate 88M",
          why: "Civilians cannot decode it",
          how: "Say truck driver and dispatcher",
        },
      ],
    };
    const { llm, requests } = createFakeLlm([critique]);
    expect(await analyzeResume(llm, "resume text")).toEqual(critique);
    expect(requests[0]!.jsonSchema).toBe(CRITIQUE_SCHEMA);
  });

  it("writeCoverLetter checks the letter it gets back", async () => {
    const letter: CoverLetter = {
      salutation: "Dear Team,",
      bodyParagraphs: ["My MBA makes me perfect for this."],
      closing: "Sincerely,",
    };
    const { llm, requests } = createFakeLlm([letter]);
    const result = await writeCoverLetter(llm, BASE, ghJob);
    expect(requests[0]!.jsonSchema).toBe(COVER_LETTER_SCHEMA);
    expect(result.findings.some((f) => f.kind === "unsupported_claim")).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Prompts — constraint 4 requires the rule to travel with every prompt
// -----------------------------------------------------------------------------

describe("prompts", () => {
  it("every document-generation prompt carries the no-fabrication rule verbatim", () => {
    for (const system of [
      PARSE_RESUME_SYSTEM,
      ANALYZE_SYSTEM,
      REVISE_SYSTEM,
      TAILOR_SYSTEM,
      COVER_LETTER_SYSTEM,
    ]) {
      expect(system).toContain(NO_FABRICATION_RULE);
    }
  });
});

// -----------------------------------------------------------------------------
// DOCX export — proven by reading the file back, not by trusting the writer
// -----------------------------------------------------------------------------

describe("exportDocx", () => {
  it("formats dates for humans", () => {
    expect(formatResumeDate("2015-06")).toBe("Jun 2015");
    expect(formatResumeDate("present")).toBe("Present");
    expect(formatResumeDate("2015")).toBe("2015");
    expect(formatResumeDate(null)).toBe("");
  });

  it("round-trips a resume through docx and back to text", async () => {
    const base64 = await resumeToDocxBase64(BASE);
    const { value: text } = await mammoth.extractRawText({
      buffer: Buffer.from(base64, "base64"),
    });

    expect(text).toContain("Danielle R. Okafor");
    expect(text).toContain("Motor Transport Operator / Squad Leader");
    expect(text).toContain("189th CSSB");
    expect(text).toContain("Lead 9 soldier drivers");
    expect(text).toContain("Security clearance: Secret");
    expect(text).toContain("CDL Class A");
    expect(text).toContain("EXPERIENCE");
    expect(text).toContain("Apr 2021 – Present");
  });

  it("renders hours per week on the federal variant only", async () => {
    const withHours = tailoredCopy({
      experience: [{ ...BASE.experience[0]!, hoursPerWeek: 40 }, BASE.experience[1]!],
    });

    const federal = await mammoth.extractRawText({
      buffer: Buffer.from(
        await resumeToDocxBase64(withHours, { federal: true }),
        "base64",
      ),
    });
    expect(federal.value).toContain("40 hours per week");

    const standard = await mammoth.extractRawText({
      buffer: Buffer.from(await resumeToDocxBase64(withHours), "base64"),
    });
    expect(standard.value).not.toContain("40 hours per week");
  });

  it("round-trips a cover letter", async () => {
    const letter: CoverLetter = {
      salutation: "Dear Hiring Team,",
      bodyParagraphs: ["Eight years keeping trucks moving."],
      closing: "Sincerely,",
    };
    const { value: text } = await mammoth.extractRawText({
      buffer: Buffer.from(await coverLetterToDocxBase64(letter, BASE), "base64"),
    });
    expect(text).toContain("Dear Hiring Team,");
    expect(text).toContain("Eight years keeping trucks moving.");
    expect(text).toContain("Danielle R. Okafor");
  });
});

// -----------------------------------------------------------------------------
// Resume → search profile
// -----------------------------------------------------------------------------

describe("profileFromResume", () => {
  it("maps titles, codes, clearance, and location deterministically", () => {
    const profile = profileFromResume(BASE, 2026);

    expect(profile.titles[0]).toBe("Motor Transport Operator / Squad Leader");
    expect(profile.titles).toHaveLength(2);
    expect(profile.mocCodes).toEqual(["88M"]);
    expect(profile.clearance).toBe("Secret");
    expect(profile.location).toEqual({ city: "Fayetteville", state: "NC" });
    // 2017 start, current role runs to nowYear.
    expect(profile.yearsExperience).toBe(9);
  });

  it("leaves unknowable fields null instead of guessing", () => {
    const sparse: ResumeData = {
      ...BASE,
      location: "somewhere in North Carolina",
      experience: [],
    };
    const profile = profileFromResume(sparse, 2026);
    expect(profile.location).toBeNull();
    expect(profile.yearsExperience).toBeNull();
    expect(profile.titles).toEqual([]);
  });

  it("reads an address the way people actually write one", () => {
    // The old rule was "City, ST" and nothing else, so all four of these
    // returned null — and a null location makes every job in the country
    // count as nearby, which is what put Seattle above a job down the road.
    expect(locationFromResumeText("Fayetteville, NC")).toEqual({
      city: "Fayetteville",
      state: "NC",
    });
    expect(locationFromResumeText("Fayetteville, NC 28303")).toEqual({
      city: "Fayetteville",
      state: "NC",
    });
    expect(locationFromResumeText("Fayetteville, North Carolina")).toEqual({
      city: "Fayetteville",
      state: "NC",
    });
    expect(locationFromResumeText("123 Main St, Fayetteville, NC 28303-1234")).toEqual({
      city: "Fayetteville",
      state: "NC",
    });
  });

  it("still refuses to invent a state", () => {
    // A city with the wrong state attached is worse than no location at all.
    expect(locationFromResumeText(null)).toBeNull();
    expect(locationFromResumeText("Remote")).toBeNull();
    expect(locationFromResumeText("somewhere in North Carolina")).toBeNull();
    expect(locationFromResumeText("London, United Kingdom")).toBeNull();
  });
});
