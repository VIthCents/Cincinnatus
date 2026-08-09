import { normalizeCompany, normalizeTitle } from "../pipeline/normalize.ts";
import type { CoverLetter, Finding, ResumeData } from "./types.ts";

/**
 * The no-fabrication entity check (constraint 4). Mandatory in the tailor and
 * cover-letter path — which is enforced structurally: tailor() and
 * coverLetter() call this themselves and return the findings alongside the
 * document, so a caller cannot forget to run it.
 *
 * This is deliberately NOT another LLM call grading the first one. Both sides
 * of the comparison are structured ResumeData, so "did the model add a
 * certification?" is set arithmetic — deterministic, testable offline, and
 * immune to the checker hallucinating an all-clear. The prompts carry the rule;
 * this is what makes the rule load-bearing when a model ignores it.
 *
 * The one place structure runs out is free text (the summary, letter
 * paragraphs). There we scan for the claims that matter most — clearances and
 * degrees, where a false statement on a federal application is a crime — and
 * accept that subtler embellishment in prose is caught by the user reading the
 * short document, not by us. That limit is honest and documented.
 */

/** Lower-case, strip punctuation, collapse whitespace. */
function norm(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normDate(value: string | null): string {
  return value === null ? "" : value.trim().toLowerCase();
}

// -----------------------------------------------------------------------------
// Resume vs resume
// -----------------------------------------------------------------------------

export function verifyResume(
  base: ResumeData,
  produced: ResumeData,
): readonly Finding[] {
  const findings: Finding[] = [];

  // --- identity -------------------------------------------------------------
  if (norm(produced.name) !== norm(base.name)) {
    findings.push({
      kind: "changed_identity",
      value: produced.name,
      severity: "high",
      message: `The name was changed to "${produced.name}". It should stay "${base.name}".`,
    });
  }
  for (const [field, baseValue, newValue] of [
    ["email", base.email, produced.email],
    ["phone", base.phone, produced.phone],
  ] as const) {
    if (newValue !== null && baseValue !== null && norm(newValue) !== norm(baseValue)) {
      findings.push({
        kind: "changed_identity",
        value: newValue,
        severity: "high",
        message: `The ${field} was changed to "${newValue}". Contact details must not be edited.`,
      });
    }
    if (newValue !== null && baseValue === null) {
      findings.push({
        kind: "changed_identity",
        value: newValue,
        severity: "high",
        message: `A ${field} ("${newValue}") was added that is not in your resume.`,
      });
    }
  }

  // --- experience -----------------------------------------------------------
  const baseExperience = base.experience.map((e) => ({
    org: normalizeCompany(e.org),
    title: normalizeTitle(e.title),
    start: normDate(e.start),
    end: normDate(e.end),
    hoursPerWeek: e.hoursPerWeek,
  }));
  const baseOrgs = new Set(baseExperience.map((e) => e.org));

  for (const exp of produced.experience) {
    const org = normalizeCompany(exp.org);
    const title = normalizeTitle(exp.title);

    if (!baseOrgs.has(org)) {
      findings.push({
        kind: "new_employer",
        value: exp.org,
        severity: "high",
        message: `"${exp.org}" is not an employer on your resume. It was removed from consideration — if you really worked there, add it to your base resume first.`,
      });
      continue;
    }

    const sameOrgTitle = baseExperience.filter(
      (b) => b.org === org && b.title === title,
    );
    if (sameOrgTitle.length === 0) {
      findings.push({
        kind: "new_title",
        value: `${exp.title} at ${exp.org}`,
        severity: "high",
        message: `Your resume does not show the title "${exp.title}" at ${exp.org}. Titles must stay what you were actually called.`,
      });
      continue;
    }

    const datesMatch = sameOrgTitle.some(
      (b) => b.start === normDate(exp.start) && b.end === normDate(exp.end),
    );
    if (!datesMatch) {
      findings.push({
        kind: "changed_dates",
        value: `${exp.title} at ${exp.org}: ${exp.start ?? "?"} to ${exp.end ?? "?"}`,
        severity: "high",
        message: `The dates for "${exp.title}" at ${exp.org} do not match your resume. Dates must never change.`,
      });
    }

    // Hours per week can be omitted, never invented or inflated — federal
    // reviewers use it to compute equivalent experience.
    const hoursOk = sameOrgTitle.some(
      (b) => exp.hoursPerWeek === null || b.hoursPerWeek === exp.hoursPerWeek,
    );
    if (!hoursOk) {
      findings.push({
        kind: "unsupported_claim",
        value: `${exp.hoursPerWeek} hours/week for ${exp.title} at ${exp.org}`,
        severity: "high",
        message: `Your resume does not state ${exp.hoursPerWeek} hours per week for "${exp.title}" at ${exp.org}. Hours must not be guessed.`,
      });
    }
  }

  // --- education ------------------------------------------------------------
  const baseEdu = new Set(
    base.education.map((e) => `${norm(e.institution)}::${norm(e.credential)}`),
  );
  for (const edu of produced.education) {
    if (!baseEdu.has(`${norm(edu.institution)}::${norm(edu.credential)}`)) {
      findings.push({
        kind: "new_education",
        value: `${edu.credential}, ${edu.institution}`,
        severity: "high",
        message: `"${edu.credential}" from ${edu.institution} is not on your resume. Education must never be added.`,
      });
    }
  }

  // --- certifications -------------------------------------------------------
  const baseCerts = new Set(base.certifications.map(norm));
  for (const cert of produced.certifications) {
    if (!baseCerts.has(norm(cert))) {
      findings.push({
        kind: "new_certification",
        value: cert,
        severity: "high",
        message: `"${cert}" is not a certification on your resume. Certifications must never be added.`,
      });
    }
  }

  // --- clearance ------------------------------------------------------------
  if (produced.clearance !== null) {
    if (base.clearance === null) {
      findings.push({
        kind: "changed_clearance",
        value: produced.clearance,
        severity: "high",
        message: `A security clearance ("${produced.clearance}") was added. Your resume does not state one.`,
      });
    } else if (norm(produced.clearance) !== norm(base.clearance)) {
      findings.push({
        kind: "changed_clearance",
        value: produced.clearance,
        severity: "high",
        message: `The clearance was changed from "${base.clearance}" to "${produced.clearance}". A clearance can be omitted but never changed.`,
      });
    }
  }

  // --- skills ---------------------------------------------------------------
  // New skill words are often legitimate translation ("supervision" for squad
  // leadership), so they are surfaced for confirmation rather than treated as
  // fabrication.
  const baseSkills = new Set(base.skills.map(norm));
  for (const skill of produced.skills) {
    if (!baseSkills.has(norm(skill))) {
      findings.push({
        kind: "new_skill",
        value: skill,
        severity: "review",
        message: `"${skill}" was added as a skill. If that word does not describe something you have really done, take it out.`,
      });
    }
  }

  // --- free text ------------------------------------------------------------
  if (produced.summary !== null) {
    findings.push(...scanTextForClaims(produced.summary, base));
  }

  return findings;
}

// -----------------------------------------------------------------------------
// Free-text scanning (summaries, cover letters)
// -----------------------------------------------------------------------------

// The supportedBy abbreviations are anchored at a word START (`\bm\.?s\b`),
// never just at the end — `m\.?a\.?\b` happily matches the "ma" that ends
// "Diploma", which made a high-school diploma "support" a master's claim.
// Trailing dots sit outside the boundary (`s\b\.?`) because \b between two
// non-word characters ("." and a space) never holds.
const DEGREE_PATTERNS: readonly {
  pattern: RegExp;
  label: string;
  supportedBy: RegExp;
}[] = [
  {
    pattern: /\b(bachelor(?:'s)?|b\.?s\.?|b\.?a\.?) (?:of |in |degree)/i,
    label: "a bachelor's degree",
    supportedBy: /bachelor|\bb\.?s\b\.?|\bb\.?a\b\.?/i,
  },
  {
    pattern: /\b(master(?:'s)?|m\.?s\.?|m\.?a\.?) (?:of |in |degree)|\bmba\b/i,
    label: "a master's degree",
    supportedBy: /master|\bmba\b|\bm\.?s\b\.?|\bm\.?a\b\.?/i,
  },
  {
    pattern: /\bph\.?d\b|\bdoctorate\b/i,
    label: "a doctorate",
    supportedBy: /ph\.?d|doctor/i,
  },
  {
    pattern: /\bassociate(?:'s)? (?:of |in |degree)/i,
    label: "an associate degree",
    supportedBy: /associate|\ba\.?a\b\.?|\ba\.?s\b\.?/i,
  },
];

/**
 * Scan free text for the high-stakes claims: clearances and degrees. This is a
 * targeted net, not a general fact checker — the general check is the
 * structured comparison above.
 */
export function scanTextForClaims(text: string, base: ResumeData): readonly Finding[] {
  const findings: Finding[] = [];
  const baseClearance = base.clearance === null ? "" : norm(base.clearance);

  // Clearance claims. "Top Secret"/"TS/SCI" needs a top-secret base clearance;
  // any "... clearance" phrase needs some base clearance.
  if (/\btop.secret\b|\bts\/sci\b/i.test(text)) {
    if (!/top secret|ts sci|\bts\b/.test(baseClearance)) {
      findings.push({
        kind: "changed_clearance",
        value: "Top Secret",
        severity: "high",
        message:
          base.clearance === null
            ? `The text claims a Top Secret clearance, but your resume does not state a clearance.`
            : `The text claims a Top Secret clearance, but your resume states "${base.clearance}".`,
      });
    }
  } else if (/\b(security|secret) clearance\b/i.test(text) && baseClearance === "") {
    findings.push({
      kind: "changed_clearance",
      value: "security clearance",
      severity: "high",
      message: `The text mentions a security clearance, but your resume does not state one.`,
    });
  }

  // Degree claims.
  const credentials = base.education.map((e) => e.credential).join(" ");
  for (const degree of DEGREE_PATTERNS) {
    if (degree.pattern.test(text) && !degree.supportedBy.test(credentials)) {
      findings.push({
        kind: "unsupported_claim",
        value: degree.label,
        severity: "high",
        message: `The text claims ${degree.label}, which is not on your resume.`,
      });
    }
  }

  return findings;
}

export function verifyCoverLetter(
  base: ResumeData,
  letter: CoverLetter,
): readonly Finding[] {
  const text = [letter.salutation, ...letter.bodyParagraphs, letter.closing].join("\n");
  return scanTextForClaims(text, base);
}
