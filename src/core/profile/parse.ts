import type { Profile, ProfileLocation, RemotePreference } from "../types.ts";

/**
 * Validate an untrusted profile object.
 *
 * Without this, a mistyped `"mocCodes": "88M"` (a string where an array belongs)
 * produces either a stack trace or — worse — an empty search-term list and a
 * ranked list that looks fine and is quietly garbage. Errors are collected
 * rather than thrown one at a time so a person fixes everything in one pass.
 */

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

const REMOTE_PREFERENCES: readonly RemotePreference[] = [
  "any",
  "remote_only",
  "prefer_onsite",
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(
  value: unknown,
  field: string,
  errors: string[],
): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    errors.push(
      `"${field}" should be a list, like ["one", "two"]. Found ${typeof value}.`,
    );
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      errors.push(`Every entry in "${field}" should be text in quotes.`);
      return [];
    }
    const trimmed = item.trim();
    if (trimmed !== "") out.push(trimmed);
  }
  return out;
}

function optionalString(
  value: unknown,
  field: string,
  errors: string[],
): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    errors.push(`"${field}" should be text in quotes, or left out entirely.`);
    return null;
  }
  return value.trim();
}

function optionalNumber(
  value: unknown,
  field: string,
  errors: string[],
): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(`"${field}" should be a number, or left out entirely.`);
    return null;
  }
  return value;
}

function parseLocation(value: unknown, errors: string[]): ProfileLocation | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) {
    errors.push(
      `"location" should look like { "city": "Fayetteville", "state": "NC" }.`,
    );
    return null;
  }
  const city = optionalString(value["city"], "location.city", errors);
  const state = optionalString(value["state"], "location.state", errors);

  if (city === null || state === null) {
    errors.push(`"location" needs both a "city" and a two-letter "state".`);
    return null;
  }
  if (state.length !== 2) {
    errors.push(`"location.state" should be the two-letter code, like "NC" or "TX".`);
    return null;
  }
  return { city, state: state.toUpperCase() };
}

export function parseProfile(input: unknown): ParseResult<Profile> {
  const errors: string[] = [];

  if (!isObject(input)) {
    return {
      ok: false,
      errors: [
        "The profile file should contain a single JSON object, starting with {.",
      ],
    };
  }

  const titles = stringArray(input["titles"], "titles", errors);
  const skills = stringArray(input["skills"], "skills", errors);
  const mocCodes = stringArray(input["mocCodes"], "mocCodes", errors);
  const education = stringArray(input["education"], "education", errors);
  const excludedKeywords = stringArray(
    input["excludedKeywords"],
    "excludedKeywords",
    errors,
  );

  const branch = optionalString(input["branch"], "branch", errors);
  const clearance = optionalString(input["clearance"], "clearance", errors);
  const yearsExperience = optionalNumber(
    input["yearsExperience"],
    "yearsExperience",
    errors,
  );
  const salaryFloor = optionalNumber(input["salaryFloor"], "salaryFloor", errors);
  const location = parseLocation(input["location"], errors);

  const radiusRaw = input["radiusMiles"];
  let radiusMiles = 50;
  if (radiusRaw !== undefined && radiusRaw !== null) {
    if (
      typeof radiusRaw !== "number" ||
      !Number.isFinite(radiusRaw) ||
      radiusRaw <= 0
    ) {
      errors.push(`"radiusMiles" should be a number of miles, like 50.`);
    } else {
      radiusMiles = radiusRaw;
    }
  }

  const remoteRaw = input["remotePreference"];
  let remotePreference: RemotePreference = "any";
  if (remoteRaw !== undefined && remoteRaw !== null) {
    if (
      typeof remoteRaw !== "string" ||
      !REMOTE_PREFERENCES.includes(remoteRaw as RemotePreference)
    ) {
      errors.push(
        `"remotePreference" should be one of: ${REMOTE_PREFERENCES.join(", ")}.`,
      );
    } else {
      remotePreference = remoteRaw as RemotePreference;
    }
  }

  // A profile with nothing to search on would produce a ranked list of
  // everything, which is worse than an honest error.
  if (titles.length === 0 && mocCodes.length === 0 && skills.length === 0) {
    errors.push(
      `The profile needs at least one of "titles", "mocCodes" or "skills" so there is something to search for.`,
    );
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      titles,
      skills,
      mocCodes,
      branch,
      clearance,
      education,
      yearsExperience,
      location,
      radiusMiles,
      remotePreference,
      salaryFloor,
      excludedKeywords,
    },
  };
}
