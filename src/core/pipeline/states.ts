/**
 * US state names to their two-letter postal codes.
 *
 * This exists because of one measured bug. `isWithinReach` (rank.ts) tests the
 * profile's state with `new RegExp("\\b" + state + "\\b")`, and `Profile`
 * stores the two-letter code — so the haystack has to contain "NC", not "North
 * Carolina". Adzuna reports location as
 * `["US", "North Carolina", "Cumberland County", "Fayetteville"]`, and its
 * `display_name` is "Haymount, Cumberland County" with no state at all.
 *
 * Without this table every Adzuna job in North Carolina is "outside your area"
 * for every North Carolinian who does not live in that exact town. Worse, the
 * failure hides itself: with nothing counting as nearby, ranking widens to the
 * whole country and tells the user "only N jobs are near you", which is a
 * plausible-sounding sentence describing a bug.
 *
 * A table, not a geocoder: geocoding means another network service, another
 * allowlist entry, and another paragraph in PRIVACY.md (see rank.ts).
 */

const CODES: Readonly<Record<string, string>> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "district of columbia": "DC",
  "washington dc": "DC",
  "washington d.c.": "DC",
  "puerto rico": "PR",
  guam: "GU",
  "virgin islands": "VI",
  "american samoa": "AS",
  "northern mariana islands": "MP",
};

/** Null when the name is not a US state — never a guess. */
export function stateCodeFor(name: string): string | null {
  const key = name.trim().toLowerCase();
  if (key === "") return null;
  // Already a code.
  if (/^[a-z]{2}$/.test(key)) {
    const upper = key.toUpperCase();
    return Object.values(CODES).includes(upper) ? upper : null;
  }
  return CODES[key] ?? null;
}

/**
 * A comma-separated place string with the state written out, rewritten so the
 * radius test can see it.
 *
 * Lever reports `"Dallas, Texas"` and Ashby `"San Mateo, California, United
 * States"`. `isWithinReach` matches the profile's two-letter code on a word
 * boundary, so both would fail for a Texan or a Californian in exactly the way
 * Adzuna's county strings would have — silently, and disguised by the
 * nationwide widening message.
 *
 * Returns the input unchanged when nothing resolves. "Remote", "London" and
 * "United States" are all real answers a board can give, and rewriting them
 * into something more convenient would be inventing a fact.
 */
export function normalizeUsLocation(text: string): string {
  const original = text.trim();
  if (original === "") return original;

  const parts = original
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");

  // A trailing country tells the radius test nothing.
  const withoutCountry = parts.filter(
    (p, i) => i === 0 || !/^(united states( of america)?|usa|u\.s\.a?\.?|us)$/i.test(p),
  );
  if (withoutCountry.length === 0) return original;

  const last = withoutCountry[withoutCountry.length - 1]!;
  const code = stateCodeFor(last);
  if (code === null) return original;

  const city = withoutCountry
    .slice(0, -1)
    .filter((p) => !isAdministrativeArea(p))
    .pop();

  return city === undefined ? code : `${city}, ${code}`;
}

/** "Cumberland County" and friends are not the name of a town. */
function isAdministrativeArea(name: string): boolean {
  return /\b(county|parish|borough|census area|municipality|city and borough)\b/i.test(
    name,
  );
}

/**
 * Adzuna's coarse-to-fine `area` array to the "City, ST" this codebase's
 * location matching needs.
 *
 * Returns null rather than a half-formed string when the state cannot be
 * resolved, so the caller can fall back to what the source actually said. A
 * guessed state would be a fact nobody gave us.
 */
export function locationFromArea(area: readonly string[]): string | null {
  if (area.length < 2) return null;

  const state = stateCodeFor(area[1] ?? "");
  if (state === null) return null;

  // Most specific entry that names a place rather than an administrative
  // division. Falls back to the county when there is nothing finer, because
  // "Cumberland County, NC" still tells a person roughly where the job is.
  const rest = area.slice(2);
  const place =
    [...rest].reverse().find((a) => a.trim() !== "" && !isAdministrativeArea(a)) ??
    [...rest].reverse().find((a) => a.trim() !== "");

  if (place === undefined) return state;
  // Guards a degenerate ["US", "Texas", "Texas"].
  if (stateCodeFor(place) === state) return state;
  return `${place.trim()}, ${state}`;
}
