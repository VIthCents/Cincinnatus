import type { Profile } from "../types.ts";
import type { ResumeData } from "../documents/types.ts";
import { normalizeUsLocation } from "../pipeline/states.ts";

/**
 * ResumeData → the search Profile (SPEC §7 task 3, second half).
 *
 * Deterministic — the LLM's one job was transcription in parseResume; turning
 * that into search inputs is plain code. Defaults mirror parseProfile's:
 * 50-mile radius, any remote preference, no exclusions.
 */

/**
 * The address line off a resume, as a city and a state code.
 *
 * The old rule was `"City, ST"` and nothing else, which is not how people
 * write their address: `"Fayetteville, NC 28303"`, `"Fayetteville, North
 * Carolina"` and `"123 Main St, Fayetteville, NC"` all returned null, and a
 * null location is what makes every job in the country count as nearby. The
 * state table already used to read the boards' place names does this job, so
 * this is one more caller rather than new parsing.
 *
 * Still refuses to guess: no recognisable state means null, because a city
 * with the wrong state attached is worse than no location at all.
 */
export function locationFromResumeText(text: string | null): Profile["location"] {
  if (text === null) return null;

  // A trailing ZIP is not part of the state's name.
  const withoutZip = text.trim().replace(/\s+\d{5}(-\d{4})?$/, "");
  if (withoutZip === "") return null;

  const normalized = normalizeUsLocation(withoutZip);
  const match = /^(.*),\s*([A-Z]{2})$/.exec(normalized);
  if (match === null || match[1] === undefined || match[2] === undefined) return null;

  // "123 Main St, Fayetteville" — the town is the part nearest the state.
  const city = match[1]
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .pop();
  if (city === undefined) return null;

  return { city, state: match[2] };
}

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

  const location = locationFromResumeText(resume.location);

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
