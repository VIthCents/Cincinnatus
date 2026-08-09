# Decisions

Append-only. Newest last. Each entry: **context → decision → consequence**.

A decision belongs here if a future contributor would otherwise reasonably ask "why is it like this?" —
especially where the code departs from [SPEC.md](./SPEC.md). Never rewrite an entry; supersede it with a
new one.

---

## 2026-08-08 — Project identity is frozen

**Context.** The Tauri bundle identifier becomes the macOS bundle ID, the Windows installer upgrade code,
and the on-disk path to the user's database (`%APPDATA%\io.github.cincinnatus\cincinnatus.db`). Changing
it after any public release orphans every existing user's local data with no migration path.

**Decision.** `io.github.cincinnatus`. Copyright holder "Cincinnatus contributors". Outbound User-Agent
`Cincinnatus/0.1 (+https://github.com/cincinnatus/cincinnatus)`.

**Consequence.** Frozen from the first release onward. The repo URL is a real contact signal to Greenhouse
and OPM, not decoration — if the repo moves, update the User-Agent. Sites marked `TODO(identity)`.

---

## 2026-08-08 — Take current dependency versions rather than the SPEC's pins

**Context.** SPEC §2 was written against React 18 and a v3-era Tailwind. `create-tauri-app`'s react-ts
template now ships React 19.1; ESLint's `latest` is 10.8.1 (9.x is on the `maintenance` tag); Tailwind 4
uses the `@tailwindcss/vite` plugin rather than the v3 PostCSS pipeline.

**Decision.** Take the current versions. Confirmed with the user before writing code.

**Consequence.** React 19, ESLint 10 flat config, Tailwind 4. Two deliberate _non_-bumps: TypeScript
stays at the template's `~5.8.3` and Vite at `^7.0.4` even though 7.0.2 and 8.2.1 exist, because TS 7 is a
ground-up compiler rewrite and Vite 8 a major — neither was in the drift list the user ruled on, and
neither buys this project anything today. Revisit when they have settled.

---

## 2026-08-08 — `node:sqlite` for the harness instead of `better-sqlite3`

**Context.** SPEC §2 names `better-sqlite3` for the harness and tests. It is now genuinely fine on Node 24
(N-API, bundled win32-x64 and darwin-arm64 prebuilds, no install script) but is a ~27 MB native
dependency. Node 24.18.0 ships `node:sqlite` in the standard library (Stability 1.2, no flag), verified
working on this machine.

**Decision.** Use `node:sqlite`.

**Consequence.** Zero native dependencies for the harness, which also removes a class of CI failure on
contributor machines. The `Db` port is unaffected — both drivers sit behind it.

---

## 2026-08-08 — Embeddings are stored as base64 TEXT, not a BLOB

**Context.** SPEC §4 specifies `embedding BLOB`. `@tauri-apps/plugin-sql` **cannot bind binary data at
all**: its wrapper special-cases only null, string, and number, and encodes everything else as JSON text.
Reading a real BLOB column back returns `number[]`, not a `Uint8Array`
(plugins-workspace#105). `node:sqlite` handles BLOBs correctly, so the two adapters would disagree.

**Decision.** Vectors are base64-encoded TEXT. The `SqlValue` type in `src/core/ports.ts` is
`string | number | null` — binary cannot enter the port by construction.

**Consequence.** ~2,048 characters per 384-dim vector instead of 1,536 bytes (~33% larger on disk).
Requires a base64 codec inside core, which cannot use `Buffer` or `btoa`; it is hand-written and has an
exactness test against a fixed `Float32Array`, because a round-trip test alone would pass even if the
encoder and decoder shared an endianness bug.

---

## 2026-08-08 — transformers.js v4, native ONNX runtime, 256-token window

**Context.** SPEC §2 says "transformers.js … WASM". Three things are stale. (a) `@xenova/transformers` is
frozen at 2.17.2 (last release 2024-05-29); the v3 line ended at 3.8.1; the maintained package is
`@huggingface/transformers` 4.x. (b) Under Node — the only runtime Phase 1 has — the library uses
`onnxruntime-node`, a native addon on device `cpu`; `wasm` is not a supported Node device. WASM applies
only inside the webview, which is Phase 2. (c) `all-MiniLM-L6-v2`'s `sentence_bert_config.json` sets
`max_seq_length: 256`; the 512 in SPEC comes from `tokenizer_config.json`'s `model_max_length`, which is
the BERT architectural limit, not the trained sentence-embedding window.

**Decision.** `@huggingface/transformers` v4, model `Xenova/all-MiniLM-L6-v2` with `dtype: "q8"` (22.9 MB,
384 dims, mean-pooled, L2-normalized), native CPU execution in Node, truncation at 256 tokens.

**Consequence.** Rejected `onnx-community/all-MiniLM-L6-v2-ONNX` despite it appearing in v4's own docs: it
has no q8 variant and splits weights into external `.onnx_data` files. The model cache is pinned to
`.models/` rather than the default location inside `node_modules`, which pnpm's content-addressed store
destroys on every reinstall — otherwise the 23 MB model re-downloads repeatedly.

---

## 2026-08-08 — SHA-256 moves behind a `Hasher` port

**Context.** SPEC §4 specifies job IDs as `sha256(source + external_id)`. `src/core` cannot import
`node:crypto` (it must run in the webview) and `crypto.subtle` is async, which would make ID computation
async throughout the pipeline. The obvious alternative — hand-transcribing SHA-256 into core — is ~90
lines of round constants that can be subtly wrong for a year without anyone noticing.

**Decision.** Keep SHA-256 as specified, but as a `Hasher` port. The Node adapter implements it with
`node:crypto`; Phase 3's Tauri adapter will use a Rust command.

**Consequence.** IDs stay compatible with the SPEC and with any external tooling that recomputes them. No
cryptographic code is hand-rolled. Core stays synchronous.

---

## 2026-08-08 — Three-layer enforcement of the `src/core` boundary

**Context.** Constraint 7 requires `src/core` to stay free of Tauri and DOM imports. That is the property
the entire headless-first design rests on, and a convention alone will not survive contributors.

**Decision.** Three independent layers: `tsconfig.core.json` (lib ES2023 only, `types: []`, so `fetch`,
`console`, `process`, `Buffer`, `document` are undeclared identifiers); an `src/core/**` block in
`eslint.config.js` restricting imports and globals with messages naming the port to use instead; and
`tests/boundary.test.ts`, which scans the source and re-reads the tsconfig.

**Consequence.** Tests live in `tests/`, not colocated in `src/`. Colocating would put them under the core
ESLint block, so any test importing `node:fs` would fail lint. Project references / `composite` are
deliberately not used — overlapping `include` globs across composite projects produce TS6059/TS6307, and
every config is `noEmit` so there is no build-output benefit. `pnpm typecheck` runs the three configs in
sequence instead.

---

## 2026-08-08 — No `tsx`; Node 24 runs TypeScript directly

**Context.** The harness is a TypeScript CLI. The usual answer is a `tsx` dev dependency.

**Decision.** Node 24.18.0 strips types natively, including cross-file imports. Verified before adopting.

**Consequence.** One fewer dependency (constraint 7). Intra-project imports must carry explicit `.ts`
extensions — accepted by Node, Vite, vitest, and `tsc` with `allowImportingTsExtensions`.

---

## 2026-08-08 — The `Db` port has no `transaction()`

**Context.** Bulk-inserting thousands of jobs as individual autocommit statements is one fsync per row —
on the order of a minute or more of pure I/O. The obvious fix is a transaction on the port. But
`@tauri-apps/plugin-sql` runs on an sqlx connection pool (10 connections by default), so `BEGIN` and
`COMMIT` issued as separate `execute()` calls can land on different connections; the `ROLLBACK` then
silently does nothing (plugins-workspace#886).

**Decision.** No `transaction()` on the port. Instead `runMany(sql, rows)`, which the Node adapter
implements as a real transaction and the Tauri adapter (Phase 3) implements as a sequential loop. The Node
adapter also sets `journal_mode=WAL` with `synchronous=NORMAL`.

**Consequence.** Core cannot express a multi-statement atomic unit. Phase 1 does not need one. If a later
phase does, it belongs in the adapter, not the port.

---

## 2026-08-08 — Endpoint corrections (verified live, 2026-08-08)

**Context.** SPEC §6 requires third-party endpoints be verified against current official docs, with
corrections logged.

**Decisions and findings.**

- **Greenhouse** — `https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true` is correct and
  remains the only JSON API host. `job-boards.greenhouse.io` is the _HTML_ hosted-board host and returns
  404 for `/v1/...`. The `content` field is **double HTML-entity-encoded** (raw JSON contains zero literal
  `<`, and contains `&amp;nbsp;`), so it needs two decode passes before tag stripping. The posted date is
  **`first_published`**, not `updated_at`; using `updated_at` makes stale postings look fresh. Coverage
  was 100% across 2,900+ postings on 13 boards. Content begins with a per-board
  `<div class="content-intro">` company boilerplate block, identical on every job at that employer — it is
  stripped before embedding, or it dominates every vector on the board and collapses within-board ranking.
- **Lever** — `https://api.lever.co/v0/postings/{slug}?mode=json` is correct. Ships `descriptionPlain`, so
  no decoding is needed. `createdAt` is epoch milliseconds, 388/388 coverage. `robots.txt` declares
  `Crawl-delay: 1`; we honour it.
- **Ashby** — `https://api.ashbyhq.com/posting-api/job-board/{slug}` works as written, but **omits the
  compensation object entirely** without `?includeCompensation=true`. That parameter costs ~8% payload and
  makes Ashby the only one of the three sources with structured numeric salary
  (`summaryComponents[]` with min/max/currency/interval). `publishedAt`, 58/58 coverage.
- **All three** emit ETags; Ashby also sends `cache-control: public, max-age=60`. No 429s were observed
  under burst, but conditional requests are both cheaper and more defensible for an app that will poll
  ~15 boards from many installs. ETag / `If-None-Match` support therefore ships in Phase 1 rather than
  being deferred.
- **USAJobs** — `historicjoa` is keyless and is used to record fixtures. Its `totalCount` is the number of
  records _remaining_, not the total, so it decreases across pages; paginating on it as a total loops
  forever.
- **Adzuna** (Phase 4, not built yet) — the `distance` parameter is **kilometres**, default 10 km, per
  Adzuna's own Swagger. SPEC implies miles.

**Consequence.** All of the above are encoded in the source clients and their tests.

---

## 2026-08-08 — JSearch is recommended for removal from SPEC §6

**Context.** SPEC §6 lists JSearch (RapidAPI) as an optional, off-by-default source. Verification found
its corpus is vendor-side scraping of Google for Jobs, LinkedIn, Indeed, and Glassdoor — the exact sites
constraint 1 forbids us from touching. Its free tier is also 200 requests per _month_, which is not enough
to be useful.

**Decision.** Not built in Phase 1 (it was already Phase 4). Recommending removal from the SPEC entirely.

**Consequence.** We would not be scraping, but we would be _consuming a scraped corpus_, which is hard to
reconcile with constraint 1's intent and hard to defend to the companies whose sites were scraped. Flagged
for the user to rule on before Phase 4.

---

## 2026-08-08 — Model IDs in SPEC §2 are stale

**Context.** SPEC §2 sets `DOC_MODEL` default `claude-sonnet-4-6`.

**Decision.** The current Sonnet is `claude-sonnet-5`. `FAST_MODEL`'s `claude-haiku-4-5-20251001` is still
valid (alias `claude-haiku-4-5`).

**Consequence.** Applies in Phase 2, when the config file is created. `claude-opus-5` is worth considering
for `DOC_MODEL` if document quality matters more than per-token cost.

---

## 2026-08-08 — Reachable employers skew away from the obvious veteran employers

**Context.** SPEC §6 asks for ~15 veteran-friendly employers with public ATS boards. 33 board slugs were
verified live. But the ten employers a veteran would name first — Lockheed Martin, Northrop Grumman, RTX,
Leidos, Booz Allen, GDIT, USAA, Peraton, CACI, V2X — are all on Workday, BrassRing, Phenom, or iCIMS,
none of which is an approved source.

**Decision.** Ship the 33 verified boards. Do not scrape the others. Document the gap honestly rather than
letting users assume the list is comprehensive.

**Consequence.** Day-one results skew toward defense-tech, aerospace, and public-safety companies, which
are coastal. This is why the harness reports how many results are actually within reach of the user's
stated location rather than silently returning a long uncommutable list.

---

## 2026-08-08 — USAJobs: one query per title, and no location sent

**Context.** Written against the documented contract, the USAJobs client returned zero federal jobs
while reporting success. Two causes, both found by probing the live API rather than re-reading the docs.

`Keyword` **ANDs its terms and supports no OR operator**. Measured: `truck driver` → 14 results;
`Truck Driver Logistics Coordinator Fleet Supervisor` → 0; `"Truck Driver" OR "Logistics Coordinator"`
→ 0; unquoted `OR` → 0. Joining a profile's titles into one query does not widen the search, it silently
empties it — and silently, because an empty result set is not an error.

Separately, `LocationName` is severe. `truck driver` returns 14 postings nationally and **0** within 50
miles of Fayetteville NC. Every `LocationName` form was tried (city + state code, city + full state
name, state alone, with and without `Radius`); alone it works fine (Fayetteville → 210), so this is the
intersection genuinely being empty, not a malformed parameter.

**Decision.** Issue one search per title, capped at five, and union the results, deduplicating on the job
id. Do not send `LocationName` or `Radius` at all.

**Consequence.** Federal results went from 0 to 13 on the sample profile. Not sending the location is
also the more consistent design — every other source is fetched broadly and filtered locally in
`rank.ts`, where the user can be _told_ the list was widened — and it means OPM learns which job titles
someone is searching for but not where they live, which is a small constraint-3 win.

---

## 2026-08-08 — The allowlist matches a strict shape rather than parsing a URL

**Context.** `assertAllowed` needs a hostname, and `src/core` has no URL parser: WHATWG `URL` lives in
`lib.dom`, which core deliberately does not load. Adding the DOM lib to get one would defeat the
boundary, and the obvious alternative — a permissive regex plus a suffix check — is how host-validation
bugs happen. `https://boards-api.greenhouse.io@evil.test/` is a request to **evil.test**, and both a
`startsWith` and an `includes` check wave it through.

**Decision.** Match one narrow shape: `https://` then a plain lower-case DNS name then an optional
whitespace-free path. Reject everything else — userinfo, explicit ports, IP literals, uppercase,
unicode, `http://`.

**Consequence.** For a security gate, rejecting the unusual beats interpreting it, and we never
legitimately need any of the rejected forms. Query strings are built with `encodeURIComponent` via a
small `buildQuery` helper, since `URLSearchParams` is unavailable for the same reason. Both the
userinfo attack and the lookalike-host case are covered by tests.

---

## 2026-08-08 — greenhouse/air is Air, not Govini

**Context.** Research listed the slug `air` as Govini. The board's own API reports its name as `Air`, and
a posting's body confirms it: "Air is the leader in Enterprise Readiness", serving government agencies,
with offices in Arlington VA and Pittsburgh PA.

**Decision.** Label it Air. More importantly, `--verify-watchlist` now requires an **exact** match
against a `board_name` recorded per entry, rather than a fuzzy comparison against our display label.

**Consequence.** A veteran would have seen the wrong employer on a job card. The fuzzy check that
originally caught this would also have passed several wrong-company slugs that return HTTP 200 with real
postings — `greenhouse/archer` is a veterinary clinic, `ashby/flock` a UK motor insurer. Exact matching
means a board that is sold, renamed, or reassigned fails loudly instead of quietly mislabelling jobs.

---

## 2026-08-08 — Embedding everything costs 81 seconds, not 10–20 minutes

**Context.** The plan estimated a cold first run at 10–20 minutes, based on a projected 15–40
documents/sec, and that estimate is what the "embed everything vs. prefilter" decision was made against.

**Measured.** A cold run over 25 sources: 5,514 jobs fetched, 222 duplicates collapsed, **5,292 unique
job texts embedded, 81.3 seconds wall clock** end to end — roughly 78 docs/sec on this machine with the
q8-quantized MiniLM on CPU.

**Consequence.** The prefilter the plan held in reserve is unnecessary. `--max-embed` stays as a
development convenience, not a product default, and there is no recall trade-off to document because
nothing is being skipped. Fit scores across that run spanned 10.6 to 45.8 with a median of 25.4 — a real
spread, so the ranking is discriminating rather than being dominated by the freshness term.

---

## 2026-08-08 — The location filter needs rethinking before Phase 3

**Context.** Running the sample profile (Army 88M, Fayetteville NC) surfaced a result-quality problem
that is not a bug in any single component. The top matches were Senior Program Manager, Recruiter, Sales
Operations Manager — nothing a truck driver would apply to.

The corpus is not the problem. It contains 269 technician, 177 mechanic, 104 supply, 46 maintenance and
15 machinist postings. But only **21 of 5,514 jobs are physically in North Carolina**, and those
blue-collar roles are on-site at coastal facilities. The 318 "reachable" results are almost entirely the
389 remote postings, and remote work at defense-tech employers is overwhelmingly corporate and
engineering.

So the filter removed exactly the jobs that fit and kept the ones that did not, and the widening rule
never fired because 318 comfortably exceeds the threshold of 10.

**Decision (Phase 1).** Report it honestly rather than paper over it. The harness now prints the
reachable count against _all_ candidates ("318 of 5,292 jobs are near you or remote") instead of against
the already-filtered list, which previously always read "318 of 318" and told the user nothing.

**Consequence / open for Phase 3.** A count threshold is the wrong trigger for widening. Better options,
in rough order of preference: widen when the reachable set's _best fit_ is materially worse than the
nationwide best fit; or drop the hard filter and sort with reach as a scoring term rather than a gate.
Either is a product decision, and the user has already ruled once on this behaviour, so it is flagged
rather than changed unilaterally.

---

## 2026-08-08 — First-run cost and location filtering

**Context.** Two product choices that the SPEC leaves open and that materially change how the app feels.
The 15 verified Greenhouse boards alone hold roughly 4,500–5,000 postings.

**Decision (user).** Embed everything rather than prefiltering — best ranking quality, accepting a
10–20 minute cold first run. Filter results to the user's radius plus remote, but auto-widen to nationwide
when that yields fewer than 10 results, saying so in plain words.

**Consequence.** Progress reporting is mandatory, not a nicety: without it a 10-minute run is
indistinguishable from a hang. `--max-embed` ships as an opt-in cap for fast development iteration. The
USAJobs window defaults to 7 days. Because raw MiniLM cosines cluster in a narrow band, the harness prints
min/median/max fit per run so a collapsed score distribution is visible immediately rather than being
mistaken for a working ranking.

---

## 2026-08-08 — Phase 2: model constants corrected from the SPEC

**Context.** SPEC §2 sets `DOC_MODEL` to `claude-sonnet-4-6` and asks that model ids be verified at build
time. Anthropic's current Sonnet is `claude-sonnet-5`; `claude-haiku-4-5` remains current for fast calls.

**Decision.** `DOC_MODEL = "claude-sonnet-5"`, `FAST_MODEL = "claude-haiku-4-5"`, in
`src/core/config.ts` alongside list prices for the plain-language cost estimate. The engine itself speaks
logical roles ("doc" / "fast"); only the Node adapter maps them to real ids.

**Consequence.** A future model bump is a one-line diff in one file plus a DECISIONS entry. Sonnet (not
Opus) because these calls spend the veteran's own prepaid credits: $5 should yield dozens of tailored
applications, not a handful.

---

## 2026-08-08 — The no-fabrication check is set arithmetic, not a second LLM call

**Context.** Constraint 4 requires a post-generation entity check on tailored resumes and cover letters.
An LLM checker can hallucinate an all-clear, costs money per check, and cannot run in tests.

**Decision.** Tailoring returns structured `ResumeData`, so `verify.ts` compares entity sets
deterministically: employers, titles, dates, education, certifications, clearance, identity, hours-per-week.
Free text (summary, letter) gets a targeted scan for clearance and degree claims only. `tailorResume()` and
`writeCoverLetter()` run the check internally and return findings with the document — a caller cannot skip it.

**Consequence.** Verification is free, offline, and deterministic; the fabrication tests run in CI with a
fake model. The scan knowingly does not catch subtle prose embellishment — the user reading a one-page
letter does. Findings: severity "high" = unsupported fact; "review" = plausible translation (new skill
words) surfaced for confirmation.

---

## 2026-08-08 — Revision may record user-stated facts; tailoring may not

**Context.** If revision refused every addition, a veteran could never add a real new certification to
their own base resume — a dead end, and this app never dead-ends (SPEC §7).

**Decision.** Two trust models. `revise` is _authoring_: the veteran is the authority on their own life;
facts they state are recorded exactly as stated, and verify findings are presented as "confirm your
changes". `tailor`/`coverletter` are _derivation_: the base resume is the only source of facts, and the
same findings are presented as fabrication alarms.

**Consequence.** One verifier, two framings; the harness prints them differently ("Changes that need your
confirmation" vs "STOP — the check found things your resume does not back up"). Exit code 3 signals
high-severity findings to scripts.

---

## 2026-08-08 — `docx` is permitted inside src/core; pdfjs and mammoth are not

**Context.** SPEC §3 places `exportDocx.ts` (docx) and `extractText.ts` (pdfjs-dist/mammoth) in core, but
core must run in both Node and the webview.

**Decision.** `docx` builds a zip in memory — a pure transform with no I/O — and `Packer.toBase64String`
works in both runtimes, so `exportDocx.ts` stays in core and returns base64. Text extraction does real
file I/O and pdfjs needs its Node legacy build, so it lives in `src/node/extractText.ts` instead of core,
deviating from the SPEC's layout.

**Consequence.** Core emits documents without touching a filesystem; adapters decode and write. The PDF
fixture is generated by a ~90-line hand-rolled minimal-PDF builder (`scripts/lib/minimalPdf.ts`) rather
than a PDF-writing dependency — validated against pdfjs before use, regenerable from `infantry.txt`.

---

## 2026-08-08 — Phase 2 verified without live API keys

**Context.** No `ANTHROPIC_API_KEY` (or USAJobs key) was present in the environment at Phase 2 completion,
so the SPEC's fixture-first testing had to carry the whole verification.

**Decision.** All engine behavior is proven with a deterministic fake Llm (131 tests): fabrication
catching, prompt-rule presence, schema wiring, federal-variant selection, DOCX round-trips through mammoth,
PDF extraction from the committed fixture. The no-key path itself is verified: every AI subcommand explains
in plain words how to get a key and what still works without one, and exits 2.

**Consequence.** First live run of analyze/tailor/coverletter happens when the user drops keys into `.env`
— the code path difference is only `createNodeLlm` vs the fake, both behind the same port. Recorded-fixture
capture for LLM calls is not built; revisit if prompt regressions become a concern.

---

## 2026-08-09 — Phase 3: API keys in an app-config file until the Phase 4 keychain

**Context.** The wizard (Phase 3) collects keys, but the OS keychain lands in Phase 4 per the SPEC's own
phasing — and stronghold cannot run in the harness anyway. SPEC §4 forbids keys in SQLite.

**Decision.** Two Rust commands, `get_secret`/`set_secret`, over `secrets.json` in the app config dir.
The command signatures are the contract; Phase 4 swaps the backing store without touching the UI.

**Consequence.** Keys are plaintext-at-rest until Phase 4, protected only by OS user-profile ACLs.
Documented here rather than hidden. Never in SQLite, never logged, never in state dumps.

---

## 2026-08-09 — All app networking through tauri-plugin-http; webview fetch only for the model

**Context.** Webview fetch is subject to CORS (USAJobs sends no CORS headers) and CSP; plugin-http runs
requests on the Rust side, where the capability file scopes them per host.

**Decision.** Job APIs and Anthropic go through plugin-http (the Anthropic SDK accepts a custom fetch).
The capability allowlist mirrors `src/core/net/allowlist.ts` — constraint 1 enforced at the process
boundary even if the TypeScript layer were deleted. The one webview-fetch egress is the one-time ~23 MB
model download from huggingface.co, allowed in the CSP and disclosed in Settings copy.

**Consequence.** Adding a source in Phase 4 means updating BOTH the TS allowlist and the capability file
— a deliberate two-place change, each a one-line diff, each reviewed.

---

## 2026-08-09 — Scheduler: Rust metronome, TypeScript policy

**Context.** SPEC §3 puts "scheduler tick" in src-tauri; the 6-hour policy needs settings access and unit
tests, which Rust-side policy would not get.

**Decision.** Rust emits a bare `scheduler-tick` event every 30 minutes; `src/core/app/schedule.ts`
decides whether a search is due (interval setting, last-run timestamp, 0 = off). On-launch and tray
"Search now" reuse the same TS path.

**Consequence.** Policy is tested in vitest (due-at-exact-interval, off-switch, first-run). The metronome
is 12 lines of Rust nobody needs to touch again.

---

## 2026-08-09 — Chat has no tool use; actions are buttons

**Context.** SPEC §7 scopes chat to resume/career/jobs; constraint 7 forbids agent frameworks. An LLM
that can trigger app actions is also an injection surface pointed at a vulnerable population.

**Decision.** `chat/agent.ts` is converse-only on the fast model, with the scope and the no-legal/
medical/VA-advice lines in a versioned prompt (tested for presence). The three chips call engine
functions directly — deterministic, testable, not steerable by message content.

**Consequence.** Chat cannot be talked into searching, spending credits, or editing documents. The cost
is that free text like "find me jobs" answers with words instead of running a search; the chip is beside
the input box.

---

## 2026-08-09 — Ship every CPU wasm variant of onnxruntime-web

**Context.** Live testing: onnxruntime picks its wasm build by feature detection, and WebView2 151
requested the asyncify variant while only the plain one was shipped — "no available backend found".

**Decision.** `scripts/copy-wasm.ts` ships plain + asyncify + jspi (~49 MB, gitignored, bundled). jsep is
excluded — it is the WebGPU build and we run device "wasm".

**Consequence.** ~49 MB of installer weight for boot-proof model loading across WebView versions. Phase 4
may prune to the measured-selected variant once telemetry-free evidence accumulates (i.e., our own
testing, since there is no telemetry).

---

## 2026-08-09 — js-sha256 for the webview Hasher

**Context.** The Hasher port is sync (job ids computed inside normalize loops); `crypto.subtle` is
async-only. The alternative was hand-transcribing ~90 lines of SHA-256 round constants — rejected in
Phase 1 as "subtly wrong for a year" territory.

**Decision.** `js-sha256` (small, widely exercised) as the webview adapter's implementation. Node keeps
`node:crypto`.

**Consequence.** One tiny dependency, scoped to one adapter file, replaceable behind the port whenever
WebCrypto grows a sync digest or the port goes async for other reasons.

---

## 2026-08-09 — Search progress is three named phases, not a spinner

**Context.** The product default is to embed everything, so a first search runs 10–20 minutes of
single-threaded WASM. A spinner and a changing sentence cannot distinguish "working" from "hung", and the
old `searchStatus: string` could only ever be one line at a time.

**Decision.** `ProgressEvent` gains `{ kind: "phase", phase: "finding" | "reading" | "ranking" }` and the
pipeline announces its own stage rather than letting the UI infer one. `core/app/progress.ts` accumulates
events into a `SearchProgress` — phase, jobs read of jobs to read, one entry per job site with its state,
and a plain-words estimate. `RunProgress` renders it.

The estimate is measured from this run's own rate and is withheld until 24 jobs have gone through; a
resumed run is timed from the count it resumed at, not from zero. The reading phase is skipped entirely
when nothing needs embedding, rather than showing "0 of 0".

**Consequence.** The first-run advisory ("10 to 20 minutes, because Cincinnatus reads each job on your own
computer") is shown from `hasSearched`, which is false until a run is on record — so it stops being shown
the moment it stops being true.

---

## 2026-08-09 — Vendor the design system's CSS rather than re-express it as utilities

**Context.** The Cincinnatus Design System ships tokens, a closed Tailwind 4 theme, and a reference CSS
implementation of every component. Hand-translating those rules into Tailwind utilities would have meant
re-deriving hundreds of measured values.

**Decision.** `src/ui/tokens/` carries the design system's CSS (tokens, controls, feedback, chat,
opportunities, wizard, and the kit's screen layout), unchanged in content but run through Prettier like
everything else in the repo — so re-vendoring is "re-fetch, then `pnpm format`", and the diff is real
changes only. Components are ported to TSX with the design
system's markup and class names. Two files are ours and say so: `app.css` (the shell, the modal, the
document "paper", the wizard's drop target) and the `.cn-*` additions inside it — layout only, every value
read from the same tokens.

The Tailwind theme is **closed**: `bg-blue-700` and `text-2xl` now generate no CSS at all. That is the
enforcement mechanism — drift shows up as unstyled markup rather than as an off-brand shade.

**Consequence.** Byte-fidelity to the spec, and `.dark` works through the same tokens. The cost is that
the app carries CSS it did not author; when the design system changes, these files are re-vendored rather
than edited.

---

## 2026-08-09 — The match badge takes the design system's words, not its thresholds

**Context.** `guidelines/matching.md` specifies `fair | good | strong` on `fitScore` at 35/55/75, with
jobs under 35 dropped before the UI sees them. Our `fitScore` is `clamp(cosine, 0, 1) × 100`, and raw
MiniLM cosines between a short profile and a long posting cluster around 0.1–0.5 (`core/pipeline/score.ts`
says so in its own comment).

**Decision.** Adopt the vocabulary, the chevrons, the "badge reads fitScore, never finalScore" ruling, and
"a person never sees the number". Keep the calibrated bands (55 / 40 / floor). Do **not** add the 35
ranking floor to core.

**Consequence.** On the current scoring function, a 75 floor for "strong" would essentially never fire and
a 35 floor would hide most of the list — the app would present as broken rather than as honest. This is a
divergence to revisit, not a rejection: the numbers are right for a score with a wider spread, and a live
run's fit distribution (already reported per run) is the evidence needed to either recalibrate
`fitFromSimilarity` or move the bands. **TODO(matching): revisit in Phase 4 with a real distribution.**

---

## 2026-08-09 — Window grows to 1180×800, minimum 1024×700

**Context.** `guidelines/handoff.md` rules that the app moves to a 1024×700 minimum and a 1180×800
default. The wizard's two-column grid and the review screen's side-by-side documents both need it.

**Decision.** Applied to `tauri.conf.json`.

**Consequence.** The app no longer fits a 640×520 window. Text still resizes to 200% without breakage
(no viewport units, measures in `ch`, the wizard columns stack) per `guidelines/accessibility.md`.

---

## 2026-08-09 — A dark-mode preference, because the palette was otherwise unreachable

**Context.** The vendored `colors.css` carries a full dark palette behind a `.dark` class on the root
element and no `prefers-color-scheme` of its own. Nothing in the app put that class anywhere.

**Decision.** `ui/app/theme.ts` applies it from a three-way preference (match the computer / light / dark)
stored in `settings`. "Match my computer" keeps following `prefers-color-scheme` while it is selected.

**Consequence.** Printing needed a guard: the print host forces a light three-step ink ramp, or printing
while the app is in dark mode would put pale grey text on a white page.
