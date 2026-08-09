/**
 * The structured resume is the load-bearing type of the documents engine.
 *
 * Everything flows through it: raw text is parsed INTO it, tailoring
 * transforms one INTO another, and the no-fabrication check (constraint 4) is
 * a *set comparison between two of them* — which is what makes verification
 * deterministic instead of another LLM call grading the first one. DOCX export
 * renders it. If a fact is not representable here, the engine cannot claim it.
 */

export interface ResumeExperience {
  readonly org: string;
  readonly title: string;
  readonly location: string | null;
  /** "YYYY-MM", "YYYY", or "present". Null when the resume does not say. */
  readonly start: string | null;
  readonly end: string | null;
  /** Federal-format resumes state hours per week per position. Never guessed. */
  readonly hoursPerWeek: number | null;
  readonly bullets: readonly string[];
}

export interface ResumeEducation {
  readonly institution: string;
  readonly credential: string;
  readonly year: string | null;
}

export interface ResumeData {
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly location: string | null;
  readonly summary: string | null;
  readonly experience: readonly ResumeExperience[];
  readonly education: readonly ResumeEducation[];
  readonly certifications: readonly string[];
  readonly skills: readonly string[];
  readonly clearance: string | null;
  /** Military occupation codes as written in the resume (e.g. "11B", "0311"). */
  readonly militaryCodes: readonly string[];
}

// -----------------------------------------------------------------------------
// Analysis
// -----------------------------------------------------------------------------

export interface CritiqueFix {
  /** What to change, concretely. */
  readonly what: string;
  /** Why it matters, in plain words. */
  readonly why: string;
  /** How to do it — ideally with example wording. */
  readonly how: string;
}

export interface Critique {
  /** Two or three sentences, honest and kind. */
  readonly summary: string;
  readonly strengths: readonly string[];
  readonly gaps: readonly string[];
  readonly fixes: readonly CritiqueFix[];
}

// -----------------------------------------------------------------------------
// Cover letters
// -----------------------------------------------------------------------------

export interface CoverLetter {
  /** e.g. "Dear Hiring Team," */
  readonly salutation: string;
  readonly bodyParagraphs: readonly string[];
  /** e.g. "Sincerely," — the name is appended from the resume at render time. */
  readonly closing: string;
}

// -----------------------------------------------------------------------------
// Verification (constraint 4)
// -----------------------------------------------------------------------------

export type FindingKind =
  | "new_employer"
  | "new_title"
  | "changed_dates"
  | "new_education"
  | "new_certification"
  | "changed_clearance"
  | "changed_identity"
  | "new_skill"
  | "unsupported_claim";

export interface Finding {
  readonly kind: FindingKind;
  /** The specific value that was added or changed. */
  readonly value: string;
  /**
   * "high": a fact the base resume does not support — employers, titles,
   * dates, degrees, certifications, clearances. These matter doubly for
   * federal applications, where misstatements have legal consequences.
   * "review": plausibly a translation of real experience (a new skill word),
   * still surfaced for the user to confirm.
   */
  readonly severity: "high" | "review";
  /** Plain-words explanation shown to the user. */
  readonly message: string;
}

/** What tailor/coverletter return: the document plus its mandatory check. */
export interface VerifiedDocument<T> {
  readonly document: T;
  /** What the model said it emphasized or changed — shown to the user. */
  readonly note: string;
  /** Result of the no-fabrication entity check. Empty means clean. */
  readonly findings: readonly Finding[];
}
