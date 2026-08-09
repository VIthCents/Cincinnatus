/**
 * Export an unlabelled ranking-evaluation candidate set from a populated
 * database.
 *
 * Ranking had no quality measurement at all, which is how a test came to assert
 * the central bug as correct behaviour. This produces the raw material for one:
 * a stratified sample of real jobs with their real cosine against a real
 * profile vector, so the evaluation can run offline, deterministically, with no
 * model and no network.
 *
 *   pnpm harness:export-eval --db .data/rank-eval.db \
 *     --profile fixtures/profile.sample.json --out fixtures/rank-eval/cdl.jsonl
 *
 * Sampling is stratified on purpose. Labelling only the top of the list would
 * measure precision and be blind to a good job buried at rank 3,000 — which is
 * exactly the failure that shipped. So: the head of the ranking, a keyword
 * sweep for work this person could plausibly do, and a random tail.
 */
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decodeVector } from "../src/core/util/base64.ts";
import { dot } from "../src/core/embed/vector.ts";
import { parseProfile } from "../src/core/profile/parse.ts";

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    profile: { type: "string" },
    out: { type: "string" },
    head: { type: "string", default: "30" },
    keyword: { type: "string", default: "20" },
    random: { type: "string", default: "10" },
  },
});

const dbPath = values.db ?? ".data/rank-eval.db";
const outPath = values.out ?? "fixtures/rank-eval/candidates.jsonl";

const parsed = parseProfile(JSON.parse(readFileSync(values.profile!, "utf8")));
if (!parsed.ok) {
  console.error(parsed.errors.join("\n"));
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const stored = db.prepare("SELECT embedding FROM profile WHERE id = 1").get() as
  { embedding: string | null } | undefined;
if (!stored?.embedding) {
  console.error(`No profile vector in ${dbPath}. Run a search against it first.`);
  process.exit(1);
}
const profileVector = decodeVector(stored.embedding);

interface Row {
  id: string;
  title: string;
  company: string;
  location: string | null;
  remote: number | null;
  posted_at: number | null;
  first_seen_at: number;
  description_text: string;
  vector: string;
}

const rows = db
  .prepare(
    `SELECT j.id, j.title, j.company, j.location, j.remote, j.posted_at,
            j.first_seen_at, j.description_text, e.vector
     FROM jobs j JOIN embeddings e ON e.content_hash = j.embed_hash
     WHERE j.canonical_id IS NULL`,
  )
  .all() as unknown as Row[];

const scored = rows
  .map((r) => ({
    id: r.id,
    title: r.title,
    company: r.company,
    location: r.location,
    remote: r.remote === null ? null : r.remote === 1,
    postedAt: r.posted_at ?? r.first_seen_at,
    postedAtIsEstimated: r.posted_at === null,
    // The cosine is what makes this fixture usable without the model. It is
    // measured, never invented — a fabricated number here would be cited as
    // evidence later.
    cosine: dot(profileVector, decodeVector(r.vector)),
    snippet: r.description_text.replace(/\s+/g, " ").trim().slice(0, 600),
  }))
  .sort((a, b) => b.cosine - a.cosine);

// Deterministic sampling: no Math.random, so re-running gives the same file.
const picked = new Map<string, (typeof scored)[number]>();
const take = (list: typeof scored, n: number) => {
  for (const item of list) {
    if (picked.size >= 1e9) break;
    if (!picked.has(item.id)) picked.set(item.id, item);
    if (--n <= 0) break;
  }
};

take(scored, Number(values.head));

// Titles this person could plausibly be hired into, drawn from their own stated
// titles and the crosswalk words already in the profile — not a hand-written
// list of what we hope to find.
const words = [...parsed.value.titles, ...parsed.value.skills]
  .flatMap((t) => t.toLowerCase().split(/[^a-z]+/))
  .filter((w) => w.length >= 4);
const keywordHits = scored.filter((j) =>
  words.some((w) => j.title.toLowerCase().includes(w)),
);
take(keywordHits, Number(values.keyword));

// Evenly spaced through the ranking rather than random, so the tail is
// reproducible and spans the whole distribution.
const stride = Math.max(1, Math.floor(scored.length / Number(values.random)));
take(
  scored.filter((_, i) => i % stride === 0),
  Number(values.random),
);

mkdirSync(dirname(outPath), { recursive: true });
const lines = [...picked.values()]
  .sort((a, b) => b.cosine - a.cosine)
  .map((j) => JSON.stringify({ ...j, label: null }));
writeFileSync(outPath, lines.join("\n") + "\n", "utf8");

console.log(`${lines.length} candidates -> ${outPath}`);
console.log(`  from ${scored.length} rankable jobs in ${dbPath}`);
console.log(
  `  cosine range ${scored[scored.length - 1]!.cosine.toFixed(3)} .. ${scored[0]!.cosine.toFixed(3)}`,
);
db.close();
