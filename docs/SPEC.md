# CINCINNATUS — Specification

> This is the authoritative specification. Where implementation has had to depart from it — because a
> pinned version moved, or an endpoint behaves differently than documented — the departure is recorded
> as a dated entry in [DECISIONS.md](./DECISIONS.md) with the evidence. The SPEC text itself is left
> unedited so the two can be compared.

---

## 0. What you are building

A **free, open-source (MIT), local-first native desktop app** (Windows + macOS) that helps veterans —
including users with very low tech literacy — get hired. Two tabs:

1. **Chat** — the veteran talks to Cincinnatus. They upload a resume; the agent gives honest, critical
   analysis and feedback, works through revisions conversationally, and produces a final professional
   base resume.
2. **Opportunities** — a single ranked list of jobs the agent continuously finds through legitimate APIs,
   ordered by a blend of **best match × most recently posted** (one score, one list). Each job has one big
   button — **"Prepare my application"** — that generates a tailored resume and cover letter as clean,
   portal-ready DOCX/PDF. Apply opens the posting in the browser; the human applies.

No server. No accounts. One binary + SQLite. Everything sensitive stays on the machine.

---

## 1. HARD CONSTRAINTS — read before architecting anything

1. **NO SCRAPING. EVER.** Never fetch, parse, or automate LinkedIn, Indeed, Glassdoor, or any job-board
   HTML. No headless browsers, no Playwright/Puppeteer, no HTML parsing of job sites. Sources are
   official/public JSON APIs only (§6). If a source would require HTML parsing or browser automation, it
   is out of scope — do not build it, do not suggest it.
2. **NO AUTO-APPLY.** The app never submits applications or automates anything on the user's behalf. It
   finds, ranks, prepares documents, and opens the posting URL. The human clicks apply.
3. **LOCAL-FIRST PII.** Resume, profile, chat history, and generated documents live only in local
   SQLite/files (veteran resumes can imply disability status). The ONLY network egress of user data:
   (a) search terms to job APIs; (b) if — and only if — the user has connected an Anthropic key:
   resume/job text for the AI features. No telemetry, no analytics, no crash reporting.
4. **NO FABRICATION.** Tailoring may reorder, rephrase, emphasize, and translate military experience into
   civilian language — it may NEVER invent employers, titles, dates, degrees, certifications, clearances,
   or accomplishments not present in the base resume. Every document-generation prompt carries this rule,
   and a post-generation check compares named entities (orgs, dates, credentials) in the output against
   the base resume and flags additions for user confirmation. This matters doubly for federal
   applications, where misstatements have legal consequences.
5. **BUILT FOR LOW TECH LITERACY.** All UI copy and chat output at ≤ 6th-grade reading level. Zero
   required configuration — sensible defaults for everything. Big touch targets, one primary action per
   screen, no jargon ("AI access key," never bare "API key"). Every error message says what happened and
   what the app will do next, in plain words. Full keyboard navigation, screen-reader labels, large
   default type, high contrast.
6. **KEY REALITY.** Job search + ranking must work with **zero paid keys** (ATS endpoints keyless; local
   embeddings). AI features — analysis, revision, tailoring, cover letters, chat, smart scoring — require
   the **user's own Anthropic key**, connected through a hand-holding wizard (§8). Without a key the app
   still searches and ranks, and explains kindly and honestly what connecting AI unlocks. No dark
   patterns, no nagging.
7. **COMPLEXITY BUDGET.** No agent framework, no MCP, no vector database, no RAG, no Docker, no Postgres,
   no ORM. Plain TypeScript, plain SQL, one process. If a dependency can be replaced by 50 lines of code,
   write the 50 lines.

Mirror constraints 1–7 into `CLAUDE.md` (§11) so they survive context resets.

---

## 2. Settled stack (do not relitigate)

| Layer            | Choice                                                                                           | Notes                                                                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell            | **Tauri v2**                                                                                     | Tray, notifications, single-instance, opener plugin; updater config stubbed (signing: §9 Phase 4)                                                                                                                                               |
| UI               | **React 18 + TypeScript + Vite + Tailwind**                                                      | Two tabs + first-run wizard (§8)                                                                                                                                                                                                                |
| Agent core       | **Pure TypeScript in `src/core/`**                                                               | Zero Tauri/DOM imports — runs headless via CLI harness and in vitest                                                                                                                                                                            |
| DB               | **SQLite** via `@tauri-apps/plugin-sql` in-app; `better-sqlite3` for harness/tests               | Hand-written SQL, thin repo module                                                                                                                                                                                                              |
| Embeddings       | **transformers.js**, model `Xenova/all-MiniLM-L6-v2`, WASM                                       | Cached locally on first run; CPU is fine                                                                                                                                                                                                        |
| LLM              | Anthropic TS SDK (`@anthropic-ai/sdk`)                                                           | Two constants in one config file: `DOC_MODEL` (resume/cover-letter work; default `claude-sonnet-4-6`) and `FAST_MODEL` (chat, scoring; default `claude-haiku-4-5-20251001`). Verify current model ids at https://docs.claude.com at build time. |
| Documents        | `docx` npm package for DOCX; PDF via webview print-to-PDF of the same HTML template              | ATS-safe single-column template; no LaTeX, no wkhtmltopdf                                                                                                                                                                                       |
| Secrets          | OS keychain via Tauri plugin (stronghold or equivalent)                                          | Keys never in SQLite or plaintext config                                                                                                                                                                                                        |
| Tests            | **vitest** + recorded JSON fixtures                                                              | No live network in tests, ever                                                                                                                                                                                                                  |
| Package mgr / CI | pnpm; GitHub Actions: lint, typecheck, test, `tauri build` matrix (windows-latest, macos-latest) | Unsigned artifacts for now                                                                                                                                                                                                                      |
| License          | **MIT**                                                                                          | LICENSE, CONTRIBUTING.md, PRIVACY.md from Phase 0                                                                                                                                                                                               |

---

## 3. Repo layout

```
cincinnatus/
  CLAUDE.md                  # working rules for Claude Code (§11)
  LICENSE  CONTRIBUTING.md  PRIVACY.md
  docs/
    SPEC.md                  # this file
    DECISIONS.md             # running ADR log — append, never rewrite
  data/
    starter-watchlist.json   # curated veteran-friendly employers with public ATS boards (§6)
  src/
    core/
      types.ts               # Profile, Job, Score, RunReport, Document, ChatMessage
      sources/               # greenhouse.ts lever.ts ashby.ts usajobs.ts adzuna.ts + source.ts (iface, rate limit, backoff)
      pipeline/              # queries.ts normalize.ts dedupe.ts rank.ts score.ts run.ts
      documents/
        analyze.ts           # base-resume critique: strengths, gaps, fixes — honest, specific, kind
        revise.ts            # conversational revision loop -> final base resume
        tailor.ts            # base resume + job -> tailored resume (incl. federal-format variant for USAJobs postings)
        coverletter.ts       # base resume + job -> one-page cover letter
        verify.ts            # no-fabrication entity check (constraint #4)
        exportDocx.ts  templates/
      profile/               # extractText.ts (pdfjs-dist / mammoth), parse.ts, crosswalk.ts
      chat/
        agent.ts             # chat orchestration; scoped to resume/career/jobs (§7)
      db/                    # schema.sql, repo.ts
    ui/                      # wizard, ChatTab, OpportunitiesTab, components
  scripts/
    build-crosswalk.ts       # O*NET military crosswalk -> vendored crosswalk.json
    harness.ts               # headless CLI: run pipeline / analyze / tailor against fixtures
  fixtures/                  # recorded API responses, sample profile, sample resumes
  src-tauri/                 # Rust shell only: tray, notify, keychain, scheduler tick, print
```

---

## 4. Data model (schema.sql)

- `profile` — single row; JSON: structured profile (titles, skills, MOS codes, clearance, education,
  years, location, radius_mi, remote_pref, salary_floor, excluded_keywords) + profile embedding.
- `jobs` — id (sha256 source+external_id), source, external_id, title, company, location, remote,
  salary_min/max, url, posted_at, description_text, raw JSON, embedding BLOB, first_seen, last_seen,
  dedupe_key.
- `scores` — job_id, method (`embed` | `llm`), fit_score 0–100, rationale, scored_at.
- `documents` — id, kind (`base_resume` | `final_resume` | `tailored_resume` | `cover_letter`), job_id
  (nullable), version, content (structured JSON + markdown), export_path, created_at.
- `chat_messages` — id, role, content, ts, related_document_id (nullable).
- `feedback` — job_id, verdict (`up` | `down` | `applied` | `hidden`), ts; nudges profile vector, small
  learning rate, dumb and inspectable.
- `runs` — id, started_at, finished_at, per-source fetched/new/error counts, error JSON.
- `watchlist` — ats, slug, company_label, source (`starter` | `user`), added_at.
- `settings` — key/value (schedule, sources, notifications, auto-prep count). Keys live in the OS
  keychain, not here.

Dedupe: exact on id; fuzzy on normalize(company)+normalize(title)+metro (token-sort ratio ≥ threshold).
Keep earliest first_seen.

---

## 5. Pipeline & ranking (one run)

`profile → queries.ts` (profile titles + crosswalk civilian titles + top skills; location/remote params)
`→` fan out across enabled sources with per-source rate caps + exponential backoff w/ jitter
`→ normalize → dedupe → embed new → rank → write → notify`.

**One list, one score:** `final_score = fit_score × exp(−age_days / 7)`. Fit (0–100) from embedding
cosine (feedback-adjusted), upgraded by LLM scoring for the top ~30 new jobs when a key is connected.
Freshness half-life constant lives in one config file. Re-rank the whole list every run. Runs are
idempotent; one source failing must not kill the run. Default schedule: every 6 hours + on launch +
"Search now."

---

## 6. Sources

Two classes. **Search APIs** answer broad queries. **ATS clients** are per-company, driven by the
`watchlist` — and the app ships with `data/starter-watchlist.json`, a curated list of veteran-friendly
employers with public Greenhouse/Lever/Ashby boards, so ATS sources produce results on day one with zero
setup. **No auto-discovery of boards — discovery = crawling = constraint #1.** Verify endpoints against
current official docs; record corrections in DECISIONS.md.

| Source     | Auth                        | Endpoint hint                                                         | Notes                                                                                |
| ---------- | --------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| USAJobs    | Free key + User-Agent email | `https://data.usajobs.gov/api/search`                                 | Veterans hiring-path filter is first-class. Key signup is guided in the wizard (§8). |
| Adzuna     | Free app_id + app_key       | `https://api.adzuna.com/v1/api/jobs/us/search/{page}`                 | Broad aggregator; optional, guided in Settings.                                      |
| Greenhouse | None                        | `https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true` | Watchlist-driven.                                                                    |
| Lever      | None                        | `https://api.lever.co/v0/postings/{slug}?mode=json`                   | Watchlist-driven.                                                                    |
| Ashby      | None                        | `https://api.ashbyhq.com/posting-api/job-board/{slug}`                | Watchlist-driven.                                                                    |

**Crosswalk:** `scripts/build-crosswalk.ts` transforms O*NET's downloadable military crosswalk (MOC → SOC
→ civilian titles, onetcenter.org) into vendored `crosswalk.json`. If the download can't be fetched in
this environment, stub the script, commit a hand-built sample covering common MOS families (03xx infantry
included) so the pipeline works end-to-end, and log a TODO.

---

## 7. The AI brain (user's Anthropic key)

Tasks: (1) resume **analysis** — specific, honest critique with concrete fixes, delivered kindly;
(2) **revision loop** in chat → final base resume; (3) profile extraction; (4) **tailoring** per job;
(5) **cover letters**; (6) match **scoring** (batched, strict JSON, score + rationale ≤ 140 chars);
(7) **chat**.

Rules:

- **On-demand generation.** Documents are generated when the user taps "Prepare my application" — never
  speculatively for every match (that burns the user's money on jobs they'll never open). Optional:
  auto-prep the top N (default 3, configurable) daily matches.
- **Scoring calls send the structured profile, never the raw resume.** Document calls send only the base
  resume + the one job.
- **Chat is scoped** to resumes, careers, and the job search. It is not a general chatbot; it warmly
  redirects off-topic requests. It gives no legal, medical, or VA-benefits advice — it points to a human
  (their DAV/VSO rep) for those.
- **Cost transparency:** Settings shows a plain-language running estimate ("AI used this month: about
  $1.20"). Degrade gracefully on missing/invalid key or API errors — never a dead end, always a next step
  in plain words.

---

## 8. UI

**First-run wizard (conversational, one thing per screen):** welcome → upload resume (drag/drop or
Browse; big target) → "Connect the AI brain" — plain-language explanation, then a click-by-click
illustrated guide: create a **Claude Console** account (the developer platform), add starting credits
(about $5, pay-as-you-go — you only pay for what you use), create a key, copy it, paste it into the box
with live validation and a green check; **Skip for now** is always visible and shame-free. ⚠️ The in-app
copy MUST be explicit that this is the Claude _developer console_ with prepaid credits — a claude.ai chat
subscription (Pro/Max) does NOT include an API key, and the guide must steer users away from buying the
wrong thing. The same paste box lives in Settings so the key can be added or replaced anytime → optional
USAJobs key (same pattern; pitched as "unlocks federal jobs with veterans preference") → location + a few
preferences asked as chat questions, not a form → first search runs with visible progress.

**Chat tab (primary):** conversation with Cincinnatus; suggestion chips ("Look over my resume," "Find me
jobs," "Make my resume better"); inline document cards with **View / Save / Print** for anything
generated.

**Opportunities tab:** the single ranked list. Card: title, company, location, salary if known,
posted-age, plain-language match badge ("Strong match"), one-line why. Buttons: **Prepare my application**
(→ tailored resume + cover letter → review side-by-side, entity-check flags surfaced as simple
confirmations → Save/Print) · **Apply** (opens browser) · 👍/👎/Hide. Filters minimal: Remote only ·
Federal only · Hide low matches.

**Settings (gear icon, one simple page):** AI key paste box (validate + green check), USAJobs key, optional
sources (each with a plain-words signup guide), search schedule, auto-prep count, plain-language AI spend
estimate, and — under an "Advanced" fold — watchlist editing. When credits run out mid-generation, the app
says so kindly in plain words with an "add more credits" link — never a raw error.

Tray: Search now / Open / Quit; close hides to tray; scheduler keeps running; daily notification:
"Cincinnatus found 5 new jobs that fit you."

---

## 9. Phases — with stop point

**Phase 0 — Scaffold.** Tauri v2 + React/TS/Vite/Tailwind boots to placeholder; vitest, ESLint+Prettier;
CLAUDE.md, SPEC.md, empty DECISIONS.md; LICENSE (MIT), CONTRIBUTING.md, PRIVACY.md (plain-language: what
stays local, what leaves and only when); GitHub Actions. Conventional commits from first commit.
✅ App launches; CI config exists; repo committed.

**Phase 1 — Job pipeline, headless.** types, schema + repo, source interface + rate limiter, **Greenhouse

- USAJobs clients**, normalize, dedupe, queries, embedding rank + blended freshness score,
  starter-watchlist.json (seed ~15 real veteran-friendly boards; verify slugs resolve), `pnpm harness
--profile fixtures/profile.sample.json` prints the ranked list; fixtures + unit tests
  (normalize/dedupe/rank/blend).
  ✅ Harness runs on fixtures AND once, manually, against live USAJobs + one Greenhouse board; tests green.

**⛔ STOP HERE. Report: built, test results, endpoint corrections, open questions. Wait for go-ahead.**

**Phase 2 — Documents engine, headless.** analyze / revise / tailor (+ federal variant) / coverletter /
verify (entity check) / exportDocx + templates; harness subcommands (`harness analyze --resume
fixtures/resume1.pdf`, `harness tailor --job <fixture>`); prompt files in-repo, versioned; fixture resumes
(include one enlisted-infantry resume with heavy MOS jargon as the acid test).

**Phase 3 — UI + shell.** Wizard, Chat tab, Opportunities tab on core; tray, 6-hour scheduler,
notifications, print-to-PDF; reading-level pass on every string.

**Phase 4 — Breadth + distribution.** Adzuna, Lever, Ashby; crosswalk build; keychain;
feedback-adjusted ranking; README for two audiences (veterans installing / devs contributing); packaging

- updater. **Signed installers (Azure Trusted Signing + Apple notarization) are REQUIRED before public
  distribution to this audience — config now, certs before release.**

---

## 10. Non-goals (do not build, do not scaffold for)

Accounts/auth/server/proxy · LinkedIn or Indeed direct integrations · auto-apply or any browser
automation · general-purpose chatbot · VA-claims/benefits/legal/medical advice features · fabricated or
"enhanced" credentials · analytics/telemetry · mobile · multi-user · vector DBs · plugin systems.

---

## 11. CLAUDE.md

See [../CLAUDE.md](../CLAUDE.md), created with exactly the content dictated by this section.

---

## 12. Working agreements

- Deviations/refinements → dated entry in DECISIONS.md (context → decision → consequence).
- Fixtures are truth; record real responses once, test forever.
- Errors are data — into `runs`, surfaced in UI in plain language, never swallowed.
- Every user-facing string gets a reading-level pass before merge.
- Boring beats clever.
