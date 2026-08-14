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
divergence to revisit, not a rejection: the numbers are right for a score with a wider spread.

**Measured, 2026-08-09.** A live run (25 sources, 5,514 jobs, 150 embedded under `--max-embed`) put the
fit range at **0.0 to 38.8**. The best job in the list scored 27. So under the design system's thresholds
nothing would have been _strong_ or even _good_, and a 35 floor would have dropped the entire top five.
Under ours, everything reads **Fair match** — the badge is honest but carries no information, which is the
distribution collapse `core/pipeline/score.ts` warns about, now observed rather than predicted.

The fix is not the thresholds at either end: it is `fitFromSimilarity`, which maps a cosine that in
practice occupies 0.0–0.4 onto 0–100 linearly and so uses two fifths of its range. Rescaling that band
(or blending in the lexical signal `whyWords` already computes) is what would make three levels mean three
things. **TODO(matching): recalibrate `fitFromSimilarity` in Phase 4 against a full-corpus distribution,
then move the bands to the design system's 35/55/75.**

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

---

## 2026-08-09 — Widening triggers on how many nearby jobs are GOOD, not how many exist

**Context.** A CDL truck driver profile (88M/92Y, Fayetteville NC) was shown Axon "Mission Engineer" and
Samsara sales roles. Measured against a full live run: 5,514 jobs fetched, 5,293 rankable, of which
**318 passed `isWithinReach`** — and not one was work a driver could be hired into. The 318 were
overwhelmingly remote-flagged white-collar tech postings; only 21 jobs in the entire corpus are
physically in North Carolina. Meanwhile the corpus contained a literal **"Class A Driver"** posting
(Redwood Materials, McCarran NV) that the person was never shown, because `widened = nearby.length < 10`
and 318 comfortably exceeds 10.

Counting jobs measured the wrong thing: **a plentiful local list and a useless one are the same length.**

**Decision.** `MIN_FIT_FOR_WIDENING = 40` (the "good match" badge band). Widening now asks whether there
are at least `MIN_RESULTS_BEFORE_WIDENING` nearby jobs _at or above that fit_, so the question the code
asks is the one the interface answers.

**Consequence.** This is the dominant fix; the other two below are secondary and were measured to change
nothing on their own. A/B over the same 5,293 stored vectors, counting hireable jobs in the top 25:

| configuration                   | pool  | hireable in top 25             |
| ------------------------------- | ----- | ------------------------------ |
| before                          | 318   | 0                              |
| + floored freshness             | 318   | 0                              |
| + floored freshness + crosswalk | 318   | 0                              |
| + quality-aware widening        | 5,293 | 5 — _Class A Driver at rank 2_ |

The widened list is labelled: the design system's "Cincinnatus looked further out" banner and the
per-card "Outside your area" fact both already existed for exactly this case. A relocation-distance job,
shown and labelled, beats a local list of jobs the person cannot do.

---

## 2026-08-09 — Freshness is floored; SPEC §5's formula is superseded

**Context.** SPEC §5 specifies `final_score = fit_score * exp(-age_days / 7)`. Measured on the live
corpus: median job age is **54 days**, p75 is 136 days, and only 9.5% of jobs are under a week old.
`exp(-age/7)` spans eleven orders of magnitude over the 180-day clamp while `fitScore` spans about
two-fold, so the product did not blend two signals — it sorted by date. On the jobs a user actually saw,
**Spearman(final, age) = 0.99 and Spearman(final, fit) = 0.15.** The best semantic match in the corpus
sat at final-rank 1,921. The constant was also misnamed: `FRESHNESS_HALF_LIFE_DAYS = 7` was used as a
time constant, making the true half-life 4.85 days.

**Decision.** `freshnessFactor(a) = FLOOR + (1 - FLOOR) * 2 ** (-a / HALF_LIFE)`, with
`FRESHNESS_FLOOR = 0.75` and `FRESHNESS_HALF_LIFE_DAYS = 14` (now genuinely a half-life). The floor is
derived, not taste: with badge bands at 40 and 55, a floor of at least 40/55 = 0.727 guarantees that a
job the badge calls a strong match is never outranked by one it calls merely good, at any age.

**Consequence.** Age can move a job by at most 1.333x — enough to separate comparable postings, not
enough to bury a better one. `tests/ranking.test.ts` asserted the _opposite_ under the heading "this is
the assertion that matters": that a fresh weak match should beat a stale strong one. That was the bug
written down as intended behaviour, which is why nothing caught it. The assertion is now inverted and a
guarantee test added.

---

## 2026-08-09 — The MOS crosswalk feeds the embedded profile text

**Context.** `crosswalk.ts` has held the right answer since Phase 1 — 88M expands to "Truck Driver, CDL
Driver, Delivery Driver, Fleet Supervisor, Dispatcher" — but its only consumer was `buildSearchTerms`,
which runs on the keyed-search path. Constraint 6 makes "no API keys" the default install, so for most
users the table did nothing. The embedded profile instead carried the literal string
`"Military experience: Army 88M, 92Y"`, and `88M` is a token the sentence model has no meaning for.

**Decision.** `buildProfileText` expands MOC codes to civilian titles and drops the codes themselves.
Codes the crosswalk cannot translate are still written out, but last, where truncation reaches them first.

**Consequence.** Measured A/B over the same 5,293 job vectors, re-embedding only the profile: median rank
of hireable jobs **785 → 167**, and a literal "Class A Driver" posting moved from fit-rank 19 to **rank 1**.
The crosswalk is still a 17-entry hand-built stub covering common enlisted families;
`scripts/build-crosswalk.ts` referenced in its TODO **does not exist**. Generating the full O*NET Military
Crosswalk (CC BY 4.0, attribution required when shipped) remains open.

---

## 2026-08-09 — The harness loads `.env`

**Context.** `USAJOBS_API_KEY` and `USAJOBS_USER_AGENT` were present in `.env` and silently ignored: the
harness script was plain `node scripts/harness.ts`, which reads `process.env` only. Every "federal jobs
are turned off" run was a false negative.

**Decision.** `node --env-file-if-exists=.env scripts/harness.ts`. The `-if-exists` form so a contributor
without a `.env` is unaffected.

**Consequence.** Federal search now actually runs. Note what it returns: with the key live, the veterans
hiring-path search for this profile yields **13 postings nationwide**, none near Fayetteville. That is not
a bug — `usajobs.ts:182` already records that `"truck driver"` returns 14 postings nationally and 0 within
50 miles of Fayetteville, which is why `LocationName` is deliberately not sent.

---

## 2026-08-09 — Honest record: source coverage does not serve the target audience

**Context.** The measurements above kept pointing past the ranker. For a CDL truck driver near Fort Bragg,
the corpus contains **4 driver/CDL jobs out of 5,514**, 2 dispatch/fleet, and 2,699 engineering roles.
5,501 of 5,514 jobs come from 33 defense/aerospace/tech Greenhouse boards.

**Decision.** Record it rather than let ranking work imply it is solved.

**Consequence.** Greenhouse, Lever and Ashby are the ATSs of venture-backed technology employers. They are
reachable precisely because they publish JSON, and they hire almost none of this app's audience. The
employers who hire enlisted veterans — carriers, warehouses, hospitals, municipalities, manufacturers —
are on Workday, iCIMS, Taleo and Indeed, which constraint 1 forbids scraping. **Adzuna (SPEC §6, an
aggregator with a free tier and broad blue-collar coverage) is therefore the single highest-value
remaining source**, and is worth more to this audience than any further ranking work.

Until then the app must be honest rather than empty: the design system's "Where these jobs come from"
disclosure already names the unreachable employers and tells the person to go to those career pages
directly. That copy is not a consolation prize — for this audience it is currently the most useful thing
on the screen.

---

## 2026-08-09 — Ranking has a measured quality gate

**Context.** Ranking had no quality measurement of any kind. That is how `tests/ranking.test.ts` came to
assert the central ordering bug as intended behaviour — "this is the assertion that matters" — and sit
green while a CDL driver was shown software engineering roles. It is also why, diagnosing that bug, it
was possible to reach two confident and opposite wrong conclusions before the data settled it.

**Decision.** A golden set and an NDCG gate. `scripts/export-eval.ts` samples real jobs from a populated
database — stratified across the head of the ranking, a keyword sweep, and an evenly-spaced tail, so the
set can see a good job buried at rank 3,000 and not only measure precision at the top. Each row carries
its **measured** cosine, so `tests/rankEval.test.ts` drives the real `rankJobs` offline with no model and
no network, by synthesising a unit vector whose dot product is that cosine.

Labels came from three independent judges against a written rubric — a hiring manager, a veteran
employment counsellor, and the veteran herself — with a separate adjudication pass for disagreements.
On the first set all 49 were unanimous, which is some evidence the rubric is unambiguous.

**Consequence.** Baseline **NDCG@10 = 0.455** on 49 labelled jobs (35/12/2 across labels 0/1/2). The test
is a ratchet at 0.45: raise it when the ranking improves, never lower it to make a change pass.

The gate immediately localised the two remaining defects, and neither is the blend:

1. **Age still reorders fit gaps under 1/FRESHNESS_FLOOR.** "Military Shipping Lead" has the highest fit
   in the set (57.2) and a unanimous label of 2, and sits at rank 8 because it is old.
2. **The encoder does not discriminate.** "Firefighter (Basic Life Support)" scores 51.5 against a CDL
   driver and is labelled 0 by all three judges; "Class A Driver" scores 47.0 and is labelled 2. No blend
   tuning fixes that ordering — it is `buildJobText`/`buildProfileText` work, and this fixture cannot see
   it, because the cosines are frozen. Evaluating an embedding change needs a live run.

**Limits, stated so they are not forgotten.** The candidates are stratified toward the head, so almost
everything in the set scores well and NDCG here is pessimistic against the whole corpus — deliberate, for
a gate. `fixtures/rank-eval/infantry.jsonl` is exported and committed but **not yet labelled**; a second
profile exists specifically so tuning cannot quietly overfit to one veteran, and it is not doing that job
until it has labels.

---

## 2026-08-10 — Rank on reach, not only on subject: the credential gate and the title-affinity nudge

**Context.** With the quality gate in place, the encoder was the measured bottleneck: cosine similarity
answers _"is this text about the same subject"_, and the veteran is asking _"could I get this job"_.
The two come apart in both directions — "Firefighter (Basic Life Support)" scored above "Class A Driver"
for a CDL holder, and four degree-gated "Senior Security Operations Engineer" (cyber) roles outranked
every federal police posting for an infantry NCO.

**Decision.** `pipeline/reach.ts`, applied to the similarity before `fitFromSimilarity`:

1. **Credential gate** (−0.15 cosine): a title naming a degree-fenced role (engineer, counsel,
   scientist, recruiter, …) is demoted **only when the profile shows no degree**. Measured on 88
   labelled jobs across both profiles: fires on 43% / 60% of judge-rejected jobs, on **zero**
   judge-approved ones. That precision is what makes it safe. It demotes rather than excludes, and the
   reason is deliberately not surfaced on the card — "this needs a degree you do not have" would be a
   confident claim about a fact the posting never stated (constraint 4 territory).
2. **Title affinity** (+0.1 × overlap): how much the job title looks like the person's own titles plus
   the MOC crosswalk. Kept small on evidence: tuned alone on the CDL set it looked worth w=0.1
   (NDCG@10 0.557→0.808), but on the infantry set it was flat — "Security Officer" matches half that
   corpus. A signal that helps one veteran and does nothing for another gets a nudge, not a lever.

The near-miss is the lesson: **the second labelled profile caught the overfit before it shipped.** The
infantry set (39 jobs, labelled in a single careful pass — weaker provenance than the CDL set's three
unanimous judges, and recorded as such in the test) went from decoration to the thing that vetoed a
wrong weight on its first day.

**Measured, full ranker, before → after:**

| set      | NDCG@10           | last strong match at rank | zeros in top 5 |
| -------- | ----------------- | ------------------------- | -------------- |
| CDL      | 0.455 → **0.561** | 15 → **10**               | 1 → 1          |
| infantry | 0.421 → **0.745** | — → 18                    | — → **0**      |

The infantry top 5 is now Security Officer / Police Officer / Emergency Management, no engineers.
Floors ratcheted accordingly (0.55 / 0.70), per-set because the sets are differently hard.

**Rejected:** a seniority penalty ("Senior", "Staff", "Manager", …). It fired on half the CDL set's
judge-approved jobs — an 8-year NCO legitimately walks into supervisory roles — and NDCG confirmed it
cost more than it bought on that profile. The word "senior" is not a gate; a J.D. is.

---

## 2026-08-10 — The badge bands say what they are measured to mean

**Context.** `matchLevel` existed twice — once in `ui/app/format.ts`, once copied by hand into
`scripts/harness.ts` — with bands (55/40) that had been chosen against raw cosines before the reach
adjustment moved the whole distribution. Two copies of a number that must agree is how they stop
agreeing, and neither copy had ever been checked against a labelled job.

**What the measurement actually said.** Over 88 labelled jobs across both profiles, `fitScore`
distributes like this:

| label          | n   | median | range          |
| -------------- | --- | ------ | -------------- |
| 2 strong match | 7   | 64.0   | 52.0 – 70.6    |
| 1 worth a look | 26  | 54.9   | 14.7 – 72.7    |
| 0 not for them | 55  | 37.5   | 5.3 – **70.4** |

Those ranges overlap badly. One job every judge said was out of reach scores 70.4, above most of the
genuinely strong ones. **No threshold produces a "Strong match" bucket that is mostly label 2** — the
best any cut achieves is 26% against an 8% base rate. That is the honest finding, and it is not fixed by
choosing nicer numbers.

What fit _can_ separate is "worth your time" from "not for you": at 60 and above, 94% of jobs are label
1 or 2; at 48 and above, 57%; below that it is mostly noise.

**Decision.** One source of truth in `core/pipeline/match.ts`, with bands set to those measurements
rather than to round numbers: **STRONG ≥ 60, GOOD ≥ 48, FAIR below**. The UI, the harness and
`MatchBadge` all import it. The doc comment carries the table above, so the next person to move a band
has to argue with data.

The gate is on the _promise_, not the numbers — `tests/rankEval.test.ts` asserts that the Strong bucket
is ≥90% jobs a judge said were gettable, that Good beats a coin toss and is strictly worse than Strong,
and that the badge reads `fitScore` and not `finalScore`. Thresholds may move freely as long as those
stay true.

**Consequence, stated plainly: the CDL veteran now sees no strong matches at all.** Nothing in that
golden set reaches 60. That is deliberate and it is asserted by a test. The reachable corpus contains
almost no driving work, so "no strong matches" is the truth of that corpus; promoting the best of a bad
list to make the screen look decisive would be lying to someone about to spend an evening on an
application. It is also one more piece of evidence that **supply, not ranking, is now the binding
constraint** for this audience.

**Also.** The infantry golden set is now labelled and gating (NDCG@10 floor 0.70, measured 0.745; CDL
floor 0.55, measured 0.561). Its labels are a single careful pass, not three independent judges like the
CDL set — recorded in the test file so its floors get proportionally less reverence.

---

## 2026-08-10 — Adzuna: the supply fix, and what it costs

**Context.** Two profiles measured against the same 5,700-job corpus told the same story from
opposite ends: the infantry profile got a genuinely good list, and the CDL driver got nothing she
could apply to — no strong matches at all, which the badge bands now assert as a test. Ranking was
never her problem. The reachable employer boards carry coastal software and aerospace; they do not
carry driving. One Adzuna query returns **1,970 driving jobs within 50 miles of Fayetteville**.

**Decision.** Adzuna ships as an **optional, keyed** source. Job search still works with zero keys
(constraint 6), and everything below follows from measurement rather than from their docs, which are
thin.

### What the live API actually does

|                      | Finding                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `results_per_page`   | Caps at **50** however many you ask for                                                                     |
| Page number          | A **path segment**, not a query parameter                                                                   |
| Conditional requests | **None** — no ETag, no Last-Modified, no cache-control. `newState` is always null                           |
| `distance`           | Documented in km; behaves loosely — Raleigh (60 mi) appears at `distance=40`. A hint, not our radius filter |
| End of results       | **410 Gone**, which is an end condition and not a failure                                                   |
| Rate limits          | **25/min, 250/day, 1,000/week, 2,500/month**, from their ToS                                                |

### Three things that would have shipped as bugs

1. **Location would have silently broken the whole feature.** `isWithinReach` matches the profile's
   _two-letter_ state with a word boundary. Adzuna's `display_name` is `"Haymount, Cumberland County"` —
   no state at all. Every North Carolina job would have been "outside your area" for every North
   Carolinian who does not live in that exact town, and the failure hides itself: with nothing counting
   as nearby, ranking widens nationwide and reports "only N jobs are near you", a plausible sentence
   describing a bug. Fixed with `pipeline/states.ts`, which builds `"City, ST"` from `area[]` and
   returns null rather than guessing a state it cannot resolve.

2. **`salary_is_predicted` is the STRING `"0"`/`"1"`, and 47 of every 50 results are predicted.** A
   natural `if (raw.salary_is_predicted)` is truthy for `"0"` and drops every real salary; the inverse
   keeps every guess. We drop salary from Adzuna **entirely** — not just the predicted ones — because
   Adzuna ships no pay-interval field and annualises everything itself, so an hourly wage would be
   rendered "$X a year" in the app's own voice. "Pay not listed" is the true sentence: Adzuna did not
   tell us what the employer stated, only what Adzuna computed. Constraint 4 does not stop at the
   documents.

3. **Credentials would have been written into the user's own run history.** Adzuna authenticates by
   query string, and this codebase deliberately treats errors as data — `SourceOutcome.error` is
   persisted by `saveRun` and rendered in the Opportunities banner. `net/redact.ts` now strips
   `app_id`/`app_key` at both funnels (`toPlainMessage`, the allowlist errors).

### Staying inside the quota by construction

A `Source` is handed no database and cannot count calls across runs, so the budget cannot be enforced
at runtime. Instead it is bounded structurally: `ADZUNA_MAX_TERMS (5) × ADZUNA_MAX_PAGES (2)` = 10
requests per search, ~1,500/month at eight searches a day — inside every ceiling. `REQUEST_DELAY_MS`
gains `api.adzuna.com: 2600` (their limit is 25/min; the default 1,000 ms would have been 60/min and
the first run would have 429'd). 429 is **terminal, not retried**: a per-minute rejection needs a
minute to clear and a daily one never clears within a run, so retrying only spends more of a quota
that is already gone. A failure after the first success returns the jobs already paid for instead of
throwing them away. All of this is pinned by tests, including one that does the monthly arithmetic.

### One employer cannot fill the screen

The first live run put **nine identical "CDL A Delivery Truck Driver" postings from Mclane in the top
twelve**, one per North Carolina town. Each is real, distinct and genuinely nearby, so dedupe is right
not to collapse them — but a person scrolling sees one job nine times and a list that looks padded.
`spreadEmployers` demotes rather than drops: the best `MAX_PER_EMPLOYER_ROLE` (3) of each
employer-and-role group keep their earned position and the rest move below everything else in order,
so someone who scrolls still finds the branch nearest them. This applies to every source, not just
Adzuna.

### Honesty obligations

Adzuna's terms require each displayed advert to be labelled "Jobs by Adzuna" with links back, at a
stated pixel size. Every clause is drafted for web pages and they publish no native-app variant, so we
comply in substance: each Adzuna card carries **"Listed on Adzuna — opens there first"** with the word
linking to adzuna.com. Their terms also require sending people through `redirect_url`, which is moot in
practice — the API exposes no employer URL at all. The Apply button's accessible name now branches by
source, because it said "on the employer's website" for a link that opens an aggregator. Settings'
"No tracking, ever" and the Coverage note were both updated; they were describing a version of the app
that no longer existed.

### Deferred, and named so they are not forgotten

- **No cross-run call ledger.** The budget holds by construction, but a user who presses "Search now"
  many times a day could still exhaust the monthly cap. A ledger in `settings` (the `spend.ts` pattern)
  resolved in `buildSources` is the fix.
- **No retention pass.** Nothing deletes jobs. Employer boards are re-fetched whole so a pulled req
  stops arriving; an Adzuna keyword query never says a posting was removed. Aggregator rows will
  accumulate and go stale.
- **Description asymmetry is unmeasured.** Adzuna's `description` is a truncated snippet of a couple
  hundred characters against `JOB_TEXT_MAX_CHARS = 1000`. Short, title-dominated text may score
  systematically higher cosine against a title-dominated profile, which would mean Adzuna rows float up
  because their text is short rather than because they fit. The rank-eval fixtures freeze cosines and
  are structurally blind to this. It needs a third labelled set captured from a live Adzuna run.
- **Caching permission is not stated.** Their ToS covers termination and a 14-day trial clause for
  non-listing uses, but says nothing either way about storing job data locally or for how long.

**Credentials.** The app ID and key used for this work were shared in a chat transcript and should be
rotated from the Adzuna dashboard.

---

## 2026-08-10 — The three deferred Adzuna items, decided

Judged against what this app is: for people with low tech literacy, open source, and distributed as a
single binary nobody administers.

### 1. Description asymmetry — measured, and it is not there

The worry was that Adzuna's ~200-character snippet would score higher cosine against a
title-dominated profile than a 1,000-character Greenhouse description, floating Adzuna rows up for
being short rather than for fitting.

Controlled test: the same 120 jobs embedded at five text budgets, so anything that moves is length
rather than the job.

| budget      | 1000   | 600    | 400    | 250    | 150    |
| ----------- | ------ | ------ | ------ | ------ | ------ |
| mean cosine | 0.2929 | 0.2756 | 0.2745 | 0.2806 | 0.2903 |

Not monotonic, and the entire spread is 0.018 — under two points on the 0–100 fit scale. Adzuna's
median description is 500 characters against everyone else's 6,854 (truncated to 1,000), so the real
effect is roughly **1.7 fit points against Adzuna**. Real, tiny, and the opposite direction from the
fear.

**No code change.** The concern was raised, measured, and closed.

Two things worth keeping from the measurement. Shortening job text would make the first run
substantially faster, which is this app's worst experience — but the top-10 overlap between the 1,000
and 150 character budgets is only 4 of 10, so this ranking is **noisy under small text changes** and
must not be tuned for speed without a quality measurement the frozen-cosine fixtures cannot provide.

### 2. Cross-run call ledger — built, for the message rather than the quota

The per-run budget already holds by construction. The ledger exists for what construction cannot
cover: someone pressing "Search now" because they are hopeful, several times a day, for a month.

The reason to spend code on it is not the quota. A source that silently stops answering looks exactly
like an app that has quietly got worse, and the person it happens to has no way to find out otherwise.
`core/app/quota.ts` counts requests per UTC day and month in the settings table, the same way
`spend.ts` counts money. Both composition roots ask before building the source, so an exhausted quota
is a source that is absent rather than a run full of rejected requests — and the harness prints
`quotaWords()`, which says which limit was hit, when it comes back, and that the jobs already found
are still there.

Ceilings held under the published ones (220/day, 2,200/month against 250 and 2,500): Adzuna counts the
request rather than the answer, and a run that dies mid-flight still spent what it sent.

`SourceFetchResult` gains an optional `requests` count. Sources are handed no database and cannot
count for themselves; the pipeline records it.

### 3. Retention — built, because a dead link is the fastest way to lose someone

An employer board is fetched whole each run, so a filled job stops arriving and disappears on its own.
A keyword search against an aggregator never says a posting was pulled — it just is not in this slice.
Left alone the list fills with ads that were live in March, and the failure is felt directly: click
Apply, wait for the browser, follow a redirect, land on "no longer accepting applications". Three of
those in one sitting and the app has taught someone not to believe any of it.

Aggregator rows unseen for **30 days are hidden** from ranking; unseen for **90 days they are
deleted** — unless the person thumbed, hid, or prepared an application for them, which are theirs and
are never erased. Employer-board jobs are never hidden for age, because their absence is already the
signal.

30 days is deliberately generous: not being re-seen is weak evidence, since each run only asks for a
slice and a live job that drifts off the first two pages goes unseen for a while. Hiding a live job
costs a person nothing they can perceive; showing a dead one costs trust. The delete pass also bounds
the one table that would otherwise grow without limit, which matters when the whole thing is read on
every app open.

---

## 2026-08-11 — Keys move to the OS keychain; thumbs move supply, not score

### Secrets: the keyring crate, not stronghold

**Context.** Keys were written as plaintext JSON to `secrets.json` in the app config dir. SPEC §2 requires
an OS keychain. The Anthropic key has real billing attached, and the file was readable by any process
running as the user and swept into OneDrive and Time Machine backups.

**Decision.** `keyring` 4.x — Windows Credential Manager and macOS Keychain Services. Measured against the
alternative rather than assumed:

|                         | keyring 4.1.6 | tauri-plugin-stronghold             |
| ----------------------- | ------------- | ----------------------------------- |
| Actually an OS keychain | yes           | **no** — an encrypted vault file    |
| Needs a user passphrase | **no**        | yes                                 |
| Marginal binary cost    | **~51 KiB**   | +87 lockfile entries, 52 new crates |
| Builds C                | no            | yes (libsodium)                     |
| Engine last released    | 2026-08-01    | **2024-05**                         |

The argument that ends it: stronghold's passphrase would itself have to live somewhere to avoid prompting
on every launch, and the only safe place is the OS keychain — so it either prompts a veteran for a
passphrase every time they open the app, or it needs keyring underneath it anyway. It also trades a
trivially recoverable secret (revoke and regenerate in 30 seconds) for an unrecoverable one: forget the
passphrase and the vault is gone. For an audience with low tech literacy that is a new failure mode in
exchange for nothing.

Verified by round-trip against the real Windows Credential Manager — store, read back, delete, confirm
gone — with no password prompt and no consent dialog. Kept as `cargo test --lib -- --ignored`.

**Migration is one-way and interruption-safe.** Plaintext is never deleted until every key has been read
back out of the keychain and byte-compared; a successful write is not evidence a value is retrievable. If
anything fails to verify, nothing is deleted, the app keeps reading the file, and the next launch retries.
The file is truncated before it is unlinked, so an interruption leaves an empty file rather than one
holding part of a key. `get_secret` falls back to the file on NoEntry throughout.

**One consequence for distribution, and it is now blocking.** macOS binds keychain item ACLs to the
writing process's code signature. For unsigned or ad-hoc-signed builds the hash changes every release, so
every update would greet the user with "Cincinnatus wants to use your confidential information stored in
your keychain" asking for their Mac login password — which to this audience reads as malware. SPEC §2
currently says "unsigned artifacts for now". A stable Developer ID Application identity is now a
prerequisite for the macOS build, not a nice-to-have.

### Thumbs change what is searched for, not how it is scored

**Context.** The job card's two buttons said "More jobs like this" and "Fewer jobs like this". They
persisted a verdict and did nothing else. Grepping for feedback under src/core/pipeline returned nothing.
The app was making a promise it did not keep.

**The obvious design is harmful, and this was measured rather than argued.** Simulating thumbs from the
golden set's human labels, over the real 384-dimension job vectors, across Rocchio profile-nudges, k-NN
votes (raw, gated, capped), per-company priors and per-title priors, at every weight tried: **mean
held-out change in NDCG@10 was negative on both profiles**, with single thumbs costing up to 0.27.

Worse, anything that adds to `fitScore` silently trips the widening rule. One thumbs-up is enough to raise
the count of worthwhile nearby jobs past the threshold, at which point `widened` flips to false, the list
stops covering the country, and it collapses to the local jobs that DECISIONS 2026-08-09 measured as
containing **zero** hireable work — 46 of 48 labelled jobs gone, including the one Class A Driver posting
that whole decision was written about. A feature that quietly undoes the most important ranking fix in the
project.

**Decision.** A thumb changes `buildSearchTerms`. Up promotes that posting's title to the front of the next
search; down removes a term. This is where a thumb has leverage and no way to do harm: the CDL profile
generates ten titles and only the first five reach Adzuna, and "Class A Driver" is not among them. It
attacks supply, which is the measured binding constraint, and it cannot corrupt an ordering, flip
widening, or hide anything.

Two guards, and they are the whole safety argument for the down-thumb: a person's own stated titles can
never be removed — they typed those in to say what they want, and one bad posting must not cancel it — and
the term list can never be emptied, because a search with no terms looks exactly like a broken app.

The card labels now say what the buttons do: _Look for more "X" jobs next time_ and _Stop looking for "X"
jobs_.

**Not shipped, deliberately.** No scoring-level feedback until the evaluation can see it. That needs the
stored vector added to `export-eval.ts` output (it already selects it and discards it) and a labelled
stratum of the vector neighbours of thumbed jobs, then a _harm_ gate: feedback must not lower NDCG. The
measurement above proves known-good jobs get demoted; it cannot see whether the promoted unknowns are
good, because they are unlabelled by construction.

---

## 2026-08-11 — Signed installers, and the names that changed underneath them

**Context.** Hawkseye Inc has an Apple Developer account and an Azure code-signing account, which
unblocks distribution — and unblocks the macOS keychain problem recorded above, since keychain item
ACLs bind to a stable signing identity.

**The single most important finding is a rename.** Azure Trusted Signing became **Azure Artifact
Signing** when it went GA on 2026-01-14. The documentation moved, `Azure/trusted-signing-action`
became `Azure/artifact-signing-action`, the RBAC role became "**Artifact** Signing Certificate Profile
Signer", and `trusted-signing-cli` became `artifact-signing-cli`. Every guide written before 2026 uses
dead names. The underlying resources are unchanged — still the `Microsoft.CodeSigning` provider and
`*.codesigning.azure.net` endpoints.

**Decisions.**

_Signing never gates a build._ `src-tauri/tauri.conf.json` produces an unsigned app that anyone can
build with no credentials; `src-tauri/tauri.release.conf.json` adds `signCommand` and is passed
explicitly by the release workflow. A contributor, a pull request from a fork, and a fresh clone all
keep working. This also means the fork that holds the credentials is the only place that needs them.

_Windows signs through `signtool`, not the action._ `azure/artifact-signing-action` signs files already
on disk, so used alone it signs the NSIS installer and leaves `Cincinnatus.exe` unsigned **inside it**.
Driving signing through Tauri's `signCommand` signs every binary as the bundler produces it.
`artifact-signing-cli` — what the Tauri docs show — hard-requires a client secret and cannot use OIDC,
so authentication is `azure/login@v3` federated credentials and no client secret is stored anywhere.

Two `signCommand` traps, both from reading the source rather than the docs: `%1` is matched by exact
whole-argument equality, so it must be its own array element (`--file=%1` is passed through literally),
and any non-`%1` relative path that exists on disk is silently rewritten to an absolute one.

_NSIS installs per user._ `installMode: "currentUser"` puts the app in `%LOCALAPPDATA%`, so neither
installing nor updating raises a UAC prompt. For someone who has been told to be careful about what
they download, an admin prompt is a reason to stop.

_macOS uses the App Store Connect API key_ rather than Apple ID plus app-specific password: it survives
password changes and two-factor prompts. Note two things that cost time to find — Tauri's
`APPLE_API_KEY` is the Key **ID**, not key material, and `KEYCHAIN_PASSWORD`, listed as required in
Tauri's own documentation, is read nowhere in `tauri`, `tauri-cli`, `tauri-bundler` or
`tauri-macos-sign`. The bundler imports the `.p12` itself and no keychain is created by hand.

_The disk image is notarized explicitly._ Tauri notarizes and staples the `.app` but only **signs** the
`.dmg` (tauri-apps/tauri#7533). Since macOS 10.15 an un-notarized disk image under Developer ID is
refused, and the `.dmg` is the file a person double-clicks.

**Consequence, and the reason for the verification steps: the bundler does not fail when signing is
misconfigured — it warns and exits 0.** A release would ship unsigned and nobody would know until a
veteran saw a security warning. Both jobs now assert signatures before anything is uploaded, and the
release is a draft so a human installs it on a clean machine first.

**Deliberately not built: automatic updates.** The app is still changing and the user asked for build
and signing only. It is also not a free addition — an update check on launch is new recurring egress to
github.com, and SPEC §3 and PRIVACY.md promise that the only things leaving the machine are search
terms to job APIs and Anthropic calls when a key is present. That promise must be amended in plain
words, and the check should probably be opt-in on the wizard, before any code is written.

---

## 2026-08-11 — JSearch is dropped, not deferred

**Context.** Flagged on 2026-08-08 as "recommended for removal, for the user to rule on before Phase 4".
Phase 4 is here, so this closes it.

**Decision.** Dropped. Not built, not scaffolded, and it should come out of SPEC §6.

Two independent reasons, either of which is sufficient. Its corpus is vendor-side scraping of Google for
Jobs, LinkedIn, Indeed and Glassdoor — the exact sites constraint 1 forbids us from touching. We would
not be scraping, but we would be _consuming a scraped corpus_, which is impossible to reconcile with the
intent of that constraint and impossible to defend to the companies whose sites were scraped. And the
free tier is 200 requests per **month**, which is not enough to be useful even setting the first reason
aside.

**Consequence.** `api.jsearch.co` never enters `net/allowlist.ts`, so there is no code path to remove —
the allowlist is the mechanical enforcement and it simply never gained an entry. Supply is instead
covered by Adzuna (2026-08-10) and by the Lever and Ashby boards (2026-08-11), which together are a
better answer: Adzuna licenses its listings, and Lever and Ashby are the employers' own boards.

---

## 2026-08-11 — README serves two audiences, and the veteran half is measured

**Context.** The README still said "the app currently boots to a placeholder — the Chat and
Opportunities tabs arrive in Phase 3", which had been false for some time. It also mixed the two
audiences the project actually has: a veteran deciding whether to install this, and a developer deciding
whether to work on it.

**Decision.** Split explicitly, veteran first. The install-facing half states what the app does, that the
first search takes 10 to 20 minutes and why, which two optional keys exist and that neither is required,
and exactly what leaves the machine — including the one thing that is easy to omit, that tapping Apply on
an Adzuna listing lets Adzuna count the tap.

Constraint 5 requires user-facing copy at a 6th-grade level or below, so it was measured rather than
eyeballed: Flesch-Kincaid **4.9** (first draft came in at 6.3; two long sentences were the whole
difference). The developer half is deliberately not held to that bar.

**Consequence.** The status line now says plainly that there is no installer yet, which is the honest
answer until the first signed release is built and someone has installed it on a clean machine.

---

## 2026-08-11 — Public distribution: every person brings their own keys

**Context.** The app is meant for public download, and its audience is very non-technical, so the
question was asked directly: can it work with no API keys at all, or can key creation be automated for
people? Job search already works with zero keys — all 33 starter boards are keyless — so this is only
about the three optional extras: Adzuna, USAJobs, and the Anthropic key.

**Decision.** Per-user keys, obtained through guided in-app signup flows. Three alternatives were
considered and rejected. _A shared studio key embedded in the app_: any key inside a shipped binary is
extractable and therefore public, Adzuna's 250-requests-a-day ceiling is per key and one active person
uses ~80, so a shared key fails everyone at once at roughly three users, and per-application provider
terms forbid it anyway. _A proxy or Admin-API key-provisioning service_: requires running a server, and
PRIVACY.md's central promise is that there is no server at all — plus perpetual cost and an account
system for people the app promises never sign up. _Automating the third-party signups_: against those
services' terms.

**Consequence.** The work goes into making keyless mode maximal and the guided flows gentle: every
signup URL in the wizard and Settings is a real button that opens the browser rather than bold text to
retype, and the packaged app must actually be able to reach every keyed host (next entry).

---

## 2026-08-11 — The capability file and the core allowlist are tested twins

**Context.** `src-tauri/capabilities/default.json` never gained `api.adzuna.com` when the Adzuna source
shipped, while `src/core/net/allowlist.ts` had it. The 2026-08-09 networking entry called this "a
deliberate two-place change, each a one-line diff, each reviewed" — and one of the two diffs was
skipped, partly because CONTRIBUTING's new-source checklist named only the TS half. In the packaged app
every Adzuna request died at the Rust scope, and the validator's catch reported it as "Could not reach
Adzuna. Check your internet connection." — a permissions bug wearing a network costume, with advice the
person can never act their way out of.

**Decision.** The missing line is added, CONTRIBUTING's checklist now names both halves, and a vitest in
`tests/allowlist.test.ts` asserts every `ALLOWED_HOSTS` host has an `https://host/**` grant in the
capability file. The test is one-directional on purpose: `api.anthropic.com` legitimately lives only in
the capability, because the LLM path never goes through core's http port.

**Consequence.** Forgetting the second half of the two-place change is now a red test naming the exact
line to add, not a shipped bug that presents as the user's wifi.

---

## 2026-08-11 — The Adzuna offer: one card, dismissible, never in the wizard

**Context.** Adzuna is the source that reaches the trades, and it was findable only by someone who
opens Settings and reads. SPEC §6 said "wizard-guided", but the wizard already sends people to one
developer website for the AI key, and a second signup before they have seen a single job is where
people give up. The ruling: no wizard step; the app offers once, at the right moment.

**Decision.** After the first completed search, the Jobs tab shows one card: "Want driving, warehouse
and trades jobs too?" — with "Show me how" jumping to the Settings guide (scroll and focus, so a screen
reader announces the landing) and "No thanks" as a permanent dismissal stored as an ordinary setting.
The visibility rule is a pure function (`core/app/nudge.ts`) with a truth-table test. It deliberately
still shows when a search found nothing: the person with zero matches is exactly who it is for. SPEC §6
now says "guided in Settings". Alongside it, the Settings section stops lying on a spent day — when the
call ledger says the daily or monthly ceiling is hit, the green "More job listings are on." banner is
replaced by the same plain words the harness prints — and gains a "Remove these numbers" button so the
PRIVACY promise that any key can be removed in Settings is true for Adzuna too.

**Consequence.** One offer, once, at a moment when it is visibly useful; declining it is respected
forever. No nagging, and nothing about the offer appears in the SPEC's screen inventory — like every
other banner, it lives here.

---

## 2026-08-11 — A third tab: the jobs you applied to

**Context.** The app finds a job, ranks it, writes the resume and the letter — and then the story
stopped dead. `Apply` opened a browser and nothing else happened: no record, no mark on the card, and
nothing at all the next morning. A veteran who applies to twenty jobs over three weeks had no way to
see which twenty. For an audience with low tech literacy, "what did I send, and where did it get to?"
is exactly the question a spreadsheet was supposed to answer and never does.

Two things had to be settled first. SPEC §0/§8 fixes the UI at **two tabs**, and the tracker is in no
phase of SPEC §9. The user ruled on both on 2026-08-11, and also ruled **out** the obvious companions:
no follow-up reminders and no AI-written follow-up notes — following up is not part of the modern
digital application process, and an app that nags a person about it is inventing a chore.

**Decision.** A third tab, "My applications", on a new `applications` table (migration v2). Three
properties define it:

- **Nothing is inferred.** A row exists only because the person answered "Yes, I applied" to a question
  the card asks after the posting opens. Clicking Apply proves a browser opened and nothing more;
  a status Cincinnatus guessed would be a fabricated fact (constraint 4) about the subject the person
  cares most about. "Not yet" leaves no trace, and the unanswered question is gone at the next launch
  rather than waiting to be asked again.
- **It records; it does not chase.** No reminders, no notifications, no AI calls anywhere in the
  feature — the whole tab works with zero keys connected. Reopening the resume and letter reads them
  back from `documents`, so looking at what you already made never costs a cent of the veteran's own
  credits.
- **An applied job stays in the Opportunities list**, with a "You applied" fact on the card. Hiding it
  would be a job vanishing because they pressed a button — the kind of disappearance this audience
  cannot debug or undo.

Not folded into the existing `feedback` table, despite its unused `applied` verdict: its primary key is
`(job_id, verdict)`, so it models independent flags, not one status that moves. The `applied` verdict is
still written alongside, and that is not bookkeeping — `purgeStaleAggregatorJobs` spares any job in
`feedback`, so it is what stops a tracked Adzuna listing being deleted out from under the tracker at
ninety days, taking the person's own record with it.

**Consequence.** `LATEST_SCHEMA_VERSION` is 2, so the migration runner earns its keep for the first
time; `tests/pipeline.test.ts` no longer asserts that exactly one migration exists. The five statuses
(`applied`, `heard_back`, `interview`, `offer`, `closed`) are a CHECK constraint, so adding a sixth is a
migration and a deliberate act. Their words are the UI's, not the schema's: the last one reads "Not this
one", because "rejected" is a word that lands hard on someone who has had a run of them, and the app has
no business being the one to say it.

---

## 2026-08-14 — The app belongs to VIthCents/Cincinnatus (supersedes 2026-08-08)

**Context.** The 2026-08-08 entry froze the identity as `io.github.cincinnatus`, with the User-Agent
`Cincinnatus/0.1 (+https://github.com/cincinnatus/cincinnatus)`. Neither the GitHub organisation
`cincinnatus` nor that repository exists. This was not a cosmetic error: the User-Agent is sent on
every outbound request to Greenhouse, Lever, Ashby, OPM and Adzuna, and its own comment says the URL
"is a real contact point — if someone at Greenhouse or OPM wants to know who is calling, it has to
lead somewhere". It led to a 404. The same dead URL was also printed in the Settings tab as advice:
the Adzuna signup form asks for a website, and the app told the veteran to enter that address.

The freeze was written to protect released users. There are none. This is the last moment the string
can change for free.

**Decision.** The repository is `https://github.com/VIthCents/Cincinnatus`. The bundle identifier
becomes `io.github.vithcents.cincinnatus`, matching the org that actually owns the code. Copyright
holder stays "Cincinnatus contributors" — that part of the 2026-08-08 entry is not superseded.

Five sites, all of which must move together, and the grep that proves it:
`git grep -i "io.github.cincinnatus\|github.com/cincinnatus"` must return only this file's history.

- `src-tauri/tauri.conf.json` — `identifier`
- `src-tauri/src/lib.rs` — `KEYCHAIN_SERVICE`, a second independent string naming the same thing
- `src/core/config.ts` — `USER_AGENT`
- `src/ui/settings/SettingsTab.tsx` — the Adzuna signup advice
- `PRIVACY.md` — the two documented database paths

**Consequence.** Developer machines lose their stored keys once, and must re-enter them in Settings.
That is the whole cost, and it is paid now rather than by strangers later. No keychain-to-keychain
migration is built: writing migration code for zero users is how a one-line change becomes a
permanent maintenance surface. The old credentials linger orphaned under `io.github.cincinnatus` in
Credential Manager and macOS Keychain, harmlessly, as does `%APPDATA%\io.github.cincinnatus`.

`migrate_secrets` needs no change and cannot misfire: its path comes from `app_config_dir`, which is
derived from the identifier, so under the new id it looks in a new empty directory and no-ops.

Frozen from the first release onward, and this time the string names something real. The macOS
_signing_ identity is a separate thing and is unaffected — that one must also never change across
releases, for the different reason given in RELEASING.md.

`bundle.licenseFile` is deliberately not set. On NSIS it inserts a license page the person must
click through, and MIT requires no such acceptance; one more screen between this audience and a
working app is a real cost for no legal benefit.

---

## 2026-08-14 — The freshness floor follows the badge bands, and now cannot drift from them

**Context.** On 2026-08-09 `FRESHNESS_FLOOR` was derived from the badge bands, which were then 40
(good) and 55 (strong): the floor has to be at least good/strong, or age can push a job the
interface calls a strong match below one it calls merely good. 40/55 = 0.727, rounded up to 0.75.

On 2026-08-10 the bands were re-measured against 88 labelled jobs and moved to 48 and 60. The floor
did not move with them, and neither did `MIN_FIT_FOR_WIDENING`, whose comment said it "is set at the
good match badge band" while holding 40 against a band of 48. Both were copied numbers, and copied
numbers are how two things that must agree stop agreeing — the same failure `pipeline/match.ts` was
created to end when the bands themselves lived in two files.

At 0.75 the stated guarantee was simply false: a job at fit 60, at maximum age, scores 45.0, and any
fresh job at 46 to 47.9 — a _fair_ match, below the good band — outranks it.

**Decision.** Both constants are now derived, not written:

```ts
export const FRESHNESS_FLOOR = GOOD_MATCH_FIT / STRONG_MATCH_FIT; // 0.80
export const MIN_FIT_FOR_WIDENING = GOOD_MATCH_FIT; // 48
```

`pipeline/match.ts` imports nothing, so `config.ts` importing it is acyclic. A retune of the bands
now moves everything that depends on them in the same commit.

`FRESHNESS_HALF_LIFE_DAYS` moves 14 → 10, which is not cosmetic and was not free. Measured against
both golden sets (`fixtures/rank-eval/`), NDCG@10:

| floor | half-life | CDL (floor 0.55) | infantry (floor 0.70) |
| ----- | --------- | ---------------- | --------------------- |
| 0.75  | 14        | 0.5605           | 0.7452                |
| 0.80  | 14        | 0.5651           | **0.6529 — FAILS**    |
| 0.80  | 12        | 0.5651           | 0.7429                |
| 0.80  | 10        | 0.5651           | **0.7452**            |
| 0.80  | 7         | 0.5651           | 0.7266                |

Raising the floor leaves the decaying part of freshness less amplitude, and at a 14-day half-life
that was enough to readmit one job to the infantry top ten: the 16-day-old "Security Officer"
scoring 70.4 that all three judges marked out of reach — the encoder mislabel already documented in
`match.ts`. 10 is the best of the values tried, not a forced choice; 12 and 7 also clear the gates.

**Consequence.** Age's total authority is capped at 1.25x rather than 1.333x. The guarantee is now
stated precisely in the code, because the old wording overclaimed: a job on the strong band, at any
age, still scores at or above the good band. It does **not** say a strong match always outranks a
good one — a fresh fit-59 job still beats a maximally aged fit-60 job. Age reorders within a band;
it never carries a job across one.

Two tests now hold this in place. One asserts the invariant itself
(`FRESHNESS_FLOOR >= GOOD_MATCH_FIT / STRONG_MATCH_FIT`), so any future band change that forgets the
floor fails immediately. The other rewrites the badge-level test in terms of the band constants: its
literals were 55 and 40, and they kept passing after the bands moved, which is precisely why the
drift went unnoticed for four days.

`MIN_TITLE_OVERLAP` is deleted. It documented a filter that drops titles below a token-overlap score,
had no reader anywhere in the repo, and held the value 0 — a no-op even under its own description.
Documented behaviour that does not exist is worse than no documentation.

The NDCG floors are not ratcheted: 0.5651 against 0.55 is noise-level movement, not an improvement
to lock in.

---

## 2026-08-14 — USAJobs gets the retry every other source already had, and stops guessing at pay

**Context.** Three faults, found reading the source against its four siblings.

It called `ctx.http.get` directly — the only source of the five that skipped `getWithRetry`. Since
it paginates up to 20 pages across up to 5 keywords, a single 429 or 502 on any one of those pages
threw, and `runSource` turned the whole federal source into an error for that run. Every job already
fetched went with it.

It had no request budget. The structural maximum is 5 x 20 = 100 requests at 500 results each, and
it returned no `requests` count, so `recordCalls` never fired and the call ledger could not see it.

And `INTERVALS` mapped `PB` to `"year"` under a comment that admitted `PB` means _per biweekly
period_ and that normalising it was "not worth the guess". It is worth the guess: a $2,037 biweekly
rate was being printed as "$2,037 a year" for work that pays about $53,000.

**Decision.** `getWithRetry` gains an optional `extraHeaders` argument — USAJobs is the one source
that authenticates per request — and USAJobs goes through it. 401 and 403 stay non-retryable, so a
refused key still surfaces as "would not accept our key" rather than being retried four times.

Retries exhausted mid-run now keep what was already fetched, matching Adzuna. Only a run that
fetched nothing throws, which is what keeps a bad key visible.

`USAJOBS_MAX_REQUESTS_PER_RUN = 25`, enforced across both loops so one broad keyword cannot spend
the whole budget paginating, and returned as `requests`.

On pay: only codes whose meaning is unambiguous get a unit — `PA`, `PH`, `PD`, `PM`. Everything else
yields **no salary at all**, amounts included.

Dropping the amounts as well as the unit is the part that matters. Nulling only the interval leaves
`salaryWords` to fall through to a bare "$2,037 to $2,650", which reads as an annual figure to
anyone scanning a list — the same wrong impression, with the app's fingerprints wiped off.

`PW` is removed too, and that is a live question rather than a cleanup. It was mapped to `"week"`;
federal payroll code lists give `PW` as **piece work** and use `BY` for biweekly. If that is right,
the old table had two wrong entries rather than one.

Attempted to settle it against `data.usajobs.gov/api/codelist/remunerationrateintervalcodes` on
2026-08-14 and could not reach the endpoint from this environment (connection reset, twice; the
developer-portal reference page timed out). So this is deliberately unresolved and marked as such in
the code: PB, PW and BY are all left out until somebody can read the authoritative list.

**Consequence.** Federal jobs paid by any interval other than year, hour, day or month show "Pay not
listed" instead of a number. That is a real loss of information, and it is the right trade: those
codes are rare next to `PA` and `PH`, and constraint 4 is about what the app asserts, not only about
what the AI writes. A number with the wrong unit is a fabricated fact whether a model or a lookup
table produced it.

Test fixtures now cover a retry that recovers, a keyword that dies after another succeeded, the
request budget, and an unverified rate code. `stubHttp` grew sequenced responses to make the first
of those expressible at all — it served one fixed response per URL, so "fails once, then succeeds"
could not be written.

---

## 2026-08-14 — Two collected profile fields start doing something; the third is ruled out

**Context.** Three fields on `Profile` were gathered and then ignored, which is worse than not
gathering them: the app appears to accept an instruction and silently discards it.

`remotePreference` can be `"prefer_onsite"` — the wizard has offered that answer since it shipped —
but `isWithinReach` only ever branched on `"remote_only"`. Someone who said they cannot work remote
had remote jobs counted toward "there is enough work near you" exactly as if they were down the road.

`salaryFloor` is parsed by `parse.ts`, set in both committed fixture profiles (55,000 and 45,000),
and read by nothing at all.

`radiusMiles` reaches only Adzuna's `distance` parameter, which `adzuna.ts` itself documents as
unreliable ("Raleigh, 60 miles away, appears at distance=40"). The wizard never asks for it.

**Decision.**

**`prefer_onsite` is wired**, in `isWithinReach`: a remote job no longer counts as _nearby_ for that
person. It is not hidden — that is the difference between "prefer" and "never". If the local list is
thin, widening still surfaces remote work, labelled, which composes with the quality-aware widening
rule from 2026-08-09 rather than fighting it. No score adjustment: nudging scores by preference is
the path measured harmful on 2026-08-11, and this is a filter question, not a ranking one.

**`salaryFloor` is wired narrowly.** A job is dropped only when the employer _stated_ pay and the
top of the stated range, annualised, falls under the floor. Annualisation is arithmetic on a figure
the employer published — hour x 2080, day x 260, week x 52, month x 12 — not a guess.

Two deliberate limits. It tests `salaryMax`, not `salaryMin`: a range that starts low and ends high
is a job worth showing, and only a range that tops out under the floor is unambiguous. And silence
is never treated as a low offer — the majority of postings state no pay at all, every Adzuna row
among them, so this can never quietly starve a thin list.

**`radiusMiles` stays as it is, and that is now a decision rather than an oversight.** Enforcing a
real radius locally requires geocoding: another network service, another allowlist entry, another
paragraph in PRIVACY.md, against constraint 7. State-level reach is the deliberate resolution. The
wizard does not ask for the number, so nothing is being collected and ignored; it does real work
narrowing the Adzuna query, and that is all it claims to do. Revisit only if a vendored ZIP-centroid
table ever justifies itself.

**Consequence.** Neither wiring can move the measured rank-eval gates, and this was checked rather
than assumed: both golden profiles are `remotePreference: "any"`, and `rankEval`'s `toJob` nulls
every salary field. Re-measured after the change — CDL 0.5651, infantry 0.7452 — identical to
before it.

The `TODO(location)` marker in `rank.ts` stays. It refers to the geocoding question, which this
entry rules on but does not solve.
