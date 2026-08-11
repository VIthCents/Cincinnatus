/**
 * Build the military-to-civilian crosswalk from O*NET's MOC file.
 *
 *   node scripts/build-crosswalk.ts --in .data/onet/milx0724.csv
 *
 * Source: O*NET Military Crosswalk (DMDC), CC BY 4.0. Download from
 * https://www.onetcenter.org/crosswalks.html — "Military Occupational
 * Classification (MOC) Crosswalk". The CSV is NOT vendored; the generated
 * data/crosswalk.json is, so the app ships no build-time download.
 *
 * ## Two decisions that make the output usable
 *
 * **O*NET-SOC 55-* is dropped.** That is the "Military Specific" major group,
 * and its titles are military occupations rather than civilian translations.
 * Measured: 11B Infantryman and 0311 Rifleman map to exactly one thing,
 * `55-3016.00 Infantry` — and no civilian job posting anywhere says "Infantry".
 * Importing that would replace the curated titles for the two largest combat
 * MOSs with a word that finds nothing. 1,540 of 13,757 mappings are 55-*, and
 * dropping them leaves 1,533 codes with no civilian mapping at all, which is
 * precisely where the hand-written entries earn their place.
 *
 * **Hand-written entries always win.** `CURATED` in crosswalk.ts was chosen
 * against what veterans actually search for, and it beats O*NET head to head:
 * O*NET says 88M is a "Heavy and Tractor-Trailer Truck Drivers"; the curated
 * entry says "Truck Driver", "CDL Driver", "Delivery Driver". The generated
 * file fills the long tail; it never overrides a considered answer.
 */
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const { values } = parseArgs({
  options: {
    in: { type: "string" },
    out: { type: "string", default: "data/crosswalk.json" },
    "max-titles": { type: "string", default: "4" },
  },
});

const inPath = values.in;
if (inPath === undefined) {
  console.error("Pass --in <path to milx*.csv>. See the header of this file.");
  process.exit(2);
}

/** The file is fully quoted and uses doubled quotes for literals. */
function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') inQuotes = false;
      else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const SERVICES: Readonly<Record<string, string>> = {
  A: "Army",
  M: "Marine Corps",
  N: "Navy",
  F: "Air Force",
  C: "Coast Guard",
  H: "Air Force",
  Y: "Navy",
  U: "Army",
  V: "Navy",
  G: "Air Force",
  J: "Marine Corps",
  X: "Space Force",
};

/**
 * O*NET's titles are census categories, not things people type into a job
 * search. Postings say "Truck Driver", never "Heavy and Tractor-Trailer Truck
 * Drivers". These rules are deliberately few and dull — the formal title is
 * always kept as well, so a bad simplification adds noise rather than losing
 * the original.
 */
function searchableTitles(formal: string): string[] {
  const cleaned = formal
    .replace(/,\s*All Other$/i, "")
    .replace(/^First-Line Supervisors of\s+/i, "")
    .trim();

  // Compound titles keep their source wording. Singularising only the final
  // word of "Stockers and Order Fillers" produces "Stockers and Order Filler",
  // which is broken English and would embed as noise. The formal title is left
  // exactly as O*NET wrote it, and a clean searchable phrase is ADDED beside
  // it — the tail after the last "and", which is usually the part that names
  // the job: "Order Filler", "Mechanic", "Diesel Engine Specialist".
  const lastAnd = cleaned.lastIndexOf(" and ");
  const out =
    lastAnd > 0
      ? [cleaned, singular(cleaned.slice(lastAnd + 5).trim())]
      : [singular(cleaned)];

  return out.filter((t) => t.length > 2);
}

function singular(text: string): string {
  return text
    .split(" ")
    .map((word, i, all) =>
      i === all.length - 1 ? word.replace(/ies$/i, "y").replace(/s$/i, "") : word,
    )
    .join(" ");
}

interface Entry {
  code: string;
  branches: string[];
  militaryTitle: string;
  civilianTitles: string[];
}

const lines = readFileSync(inPath, "utf8")
  .split(/\r?\n/)
  .filter((l) => l.trim() !== "");
const head = parseLine(lines[0]!);
const at = Object.fromEntries(head.map((h, i) => [h, i])) as Record<string, number>;

const byCode = new Map<string, Entry>();
let militaryOnly = 0;

for (const line of lines.slice(1)) {
  const row = parseLine(line);
  // Active, and not superseded.
  if (row[at["STATUS"]!] !== "A" || row[at["EDATE"]!] !== "999912") continue;

  const code = (row[at["MOC"]!] ?? "").trim().toUpperCase();
  if (code === "" || code === "-") continue;

  const civilian: string[] = [];
  let sawMilitaryOnly = true;
  for (const n of [1, 2, 3, 4]) {
    const soc = row[at[`ONET${n}`]!];
    const title = row[at[`ONET${n}_TITLE`]!];
    if (!soc || soc === "-" || !title || title === "-") continue;
    if (soc.startsWith("55-")) continue; // Military Specific — see the header.
    sawMilitaryOnly = false;
    civilian.push(...searchableTitles(title));
  }
  if (sawMilitaryOnly) militaryOnly++;
  if (civilian.length === 0) continue;

  const branch = SERVICES[row[at["SVC"]!] ?? ""] ?? null;
  const existing = byCode.get(code);
  if (existing === undefined) {
    byCode.set(code, {
      code,
      branches: branch === null ? [] : [branch],
      militaryTitle: (row[at["MOC_TITLE"]!] ?? "").trim(),
      civilianTitles: civilian,
    });
  } else {
    if (branch !== null && !existing.branches.includes(branch)) {
      existing.branches.push(branch);
    }
    existing.civilianTitles.push(...civilian);
  }
}

const maxTitles = Number(values["max-titles"]);
const entries = [...byCode.values()]
  .map((e) => {
    const seen = new Set<string>();
    const titles: string[] = [];
    for (const t of e.civilianTitles) {
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      titles.push(t);
      if (titles.length >= maxTitles) break;
    }
    return { ...e, civilianTitles: titles };
  })
  .sort((a, b) => (a.code < b.code ? -1 : 1));

// Two packed strings in a JSON file, and both parts of that were measured.
//
// JSON rather than a .ts module: as a TypeScript string literal this cost 17
// to 22 seconds on every test run against 1.9 seconds with the data stubbed
// out. Every test file that reaches the crosswalk transitively pays to parse
// it, and TypeScript parsing a 112 KiB single-line literal is expensive in a
// way that JSON parsing is not. Same bytes, same laziness, 1.3 seconds.
//
// Packed rather than an object per code: only the titles are read — nothing
// outside this script uses the military title or the branch list — and titles
// live once in a dictionary referenced by index, because thousands of codes
// share a handful of phrases. Every truck-driving MOS in every branch maps to
// the same words. Spelling them out per code cost 1,179 KiB; this is 111.
//
//   titles: title\ntitle\ntitle
//   packed: CODE<tab>3,17,42\nCODE<tab>...
const titleIndex = new Map<string, number>();
for (const e of entries) {
  for (const t of e.civilianTitles) {
    if (!titleIndex.has(t)) titleIndex.set(t, titleIndex.size);
  }
}

const packed = entries
  .map((e) => `${e.code}\t${e.civilianTitles.map((t) => titleIndex.get(t)).join(",")}`)
  .join("\n");

const file = JSON.stringify({
  _generated: "scripts/build-crosswalk.ts — do not edit by hand",
  _license:
    "Derived from the O*NET Military Crosswalk by the U.S. Department of Labor, Employment and Training Administration. Used under CC BY 4.0. Titles were simplified and military-specific (SOC 55-*) mappings removed.",
  _source: "https://www.onetcenter.org/crosswalks.html",
  /** One title per line; `packed` refers to these by index. */
  titles: [...titleIndex.keys()].join("\n"),
  /** CODE<tab>comma-separated title indexes, one per line. */
  packed,
});

mkdirSync(dirname(values.out!), { recursive: true });
writeFileSync(values.out!, file, "utf8");

console.log(`${entries.length} codes -> ${values.out}`);
console.log(
  `  ${militaryOnly} rows mapped only to military-specific occupations and were dropped`,
);
console.log(`  ${(file.length / 1024).toFixed(0)} KiB`);
