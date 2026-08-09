import type { Profile } from "../types.ts";
import type { ResumeData } from "../documents/types.ts";

/**
 * ResumeData → the search Profile (SPEC §7 task 3, second half).
 *
 * Deterministic — the LLM's one job was transcription in parseResume; turning
 * that into search inputs is plain code. Defaults mirror parseProfile's:
 * 50-mile radius, any remote preference, no exclusions.
 */

function yearOf(value: string | null): number | null {
  if (value === null) return null;
  const match = /^(\d{4})/.exec(value.trim());
  return match === null ? null : Number(match[1]);
}

export function profileFromResume(resume: ResumeData, nowYear: number): Profile {
  // Most recent titles first, deduplicated. The resume's order is preserved
  // because parseResume transcribes in document order, which is reverse-
  // chronological on almost every resume.
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const exp of resume.experience) {
    const key = exp.title.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      titles.push(exp.title);
    }
    if (titles.length >= 5) break;
  }

  // Span from earliest start to latest end (or now, for a current role).
  let earliest: number | null = null;
  let latest: number | null = null;
  for (const exp of resume.experience) {
    const start = yearOf(exp.start);
    if (start !== null && (earliest === null || start < earliest)) earliest = start;
    const end =
      exp.end !== null && exp.end.trim().toLowerCase() === "present"
        ? nowYear
        : yearOf(exp.end);
    if (end !== null && (latest === null || end > latest)) latest = end;
  }
  const yearsExperience =
    earliest === null || latest === null ? null : Math.max(latest - earliest, 0);

  // "City, ST" only — anything more exotic stays null rather than guessed.
  let location: Profile["location"] = null;
  if (resume.location !== null) {
    const match = /^([^,]+),\s*([A-Za-z]{2})$/.exec(resume.location.trim());
    if (match !== null && match[1] !== undefined && match[2] !== undefined) {
      location = { city: match[1].trim(), state: match[2].toUpperCase() };
    }
  }

  return {
    titles,
    skills: [...resume.skills],
    mocCodes: [...resume.militaryCodes],
    branch: null,
    clearance: resume.clearance,
    education: resume.education.map((e) => e.credential),
    yearsExperience,
    location,
    radiusMiles: 50,
    remotePreference: "any",
    salaryFloor: null,
    excludedKeywords: [],
  };
}
