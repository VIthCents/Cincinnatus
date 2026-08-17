# Contributing

Cincinnatus helps veterans find work. It is free to use, MIT-licensed, and local-first: there is no
server and no account, and the only calls that leave the machine are the ones
[PRIVACY.md](./PRIVACY.md) lists. Thank you for helping.

Read these before non-trivial work:

- [CLAUDE.md](./CLAUDE.md) — seven constraints that override everything else, including this file.
  They are short. Read them.
- [docs/SPEC.md](./docs/SPEC.md) — what is being built, and why.
- [docs/DECISIONS.md](./docs/DECISIONS.md) — every place reality disagreed with the plan, with the
  measurement that settled it. If you are about to wonder "why on earth is it done this way", the
  answer is probably in here.
- [docs/RELEASING.md](./docs/RELEASING.md) — signing and distribution.

Two habits this project runs on: **fixtures are truth** — record a real response once and test
against it forever, never live network in a test — and **claims get measured**. Several confident,
plausible ideas in `DECISIONS.md` turned out to be wrong when checked against real data, including a
couple that would have made the app worse for exactly the people it is for.

## Never commit a real resume

`fixtures/profile.sample.json` is synthetic and committed. **Do not edit it with your own details** to
test something.

Copy it instead:

```sh
cp fixtures/profile.sample.json .data/my-profile.json
pnpm harness --profile .data/my-profile.json
```

`.data/` is gitignored. A veteran's resume can imply disability status, so this matters more here than
in a typical project.

## Setup

You need Node 24+, pnpm 9+, and Rust (stable, MSVC toolchain on Windows).

```sh
pnpm install
pnpm test          # no network — runs against recorded fixtures
pnpm typecheck
pnpm tauri dev     # the app
```

Windows also needs the WebView2 runtime and the Visual Studio "Desktop development with C++" workload.
macOS needs the Xcode command line tools. If `pnpm tauri dev` fails at the link step with
`link.exe not found`, that workload is missing.

Check your Rust toolchain is MSVC, not GNU:

```sh
rustup show    # "Default host" should end in -pc-windows-msvc
```

## The harness

The engine runs headless, which is how most of it gets exercised:

```sh
pnpm harness --profile fixtures/profile.sample.json      # a full job search
pnpm harness analyze --resume fixtures/resumes/logistics.txt
pnpm harness tailor  --resume <resume> --job-id <id from a search>
```

Copy `.env.example` to `.env` for the optional keys. Everything runs without them; the harness says
which features are off and why.

## The shape of it

```
src/core/    the whole engine — pure TypeScript, no Tauri and no DOM
src/node/    adapters that let core run in the CLI harness
src/tauri/   adapters that let core run in the app
src/ui/      React, two tabs and a first-run wizard
src-tauri/   the Rust shell: tray, notifications, OS keychain
scripts/     harness.ts, and the build scripts for generated data
```

## Before you push

```sh
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test
```

CI runs exactly these, plus `tauri build` on Windows and macOS.

## The one architectural rule

**`src/core/` must not import Tauri, Node, React, or anything DOM-shaped.**

It has to run in three places: the CLI harness under Node, vitest, and the Tauri webview. That is what
lets the whole job pipeline be tested headlessly without a UI.

Three layers enforce it, so you will hear about a violation quickly:

1. `tsconfig.core.json` gives core no DOM library and no Node types. `fetch`, `console`, `process`, and
   `Buffer` are undeclared identifiers there — a compile error.
2. `eslint.config.js` restricts imports and globals under `src/core/**`, with messages that name the
   port to use instead.
3. `tests/boundary.test.ts` scans the source and re-reads the config, so the rule survives even if
   someone relaxes the other two.

If core needs something from the outside world, add a port to `src/core/ports.ts` and implement it in an
adapter. Do not relax the boundary.

Because of this, **tests live in `tests/`, not next to the code.** A colocated test importing `node:fs`
would trip the core lint block.

## Style

- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `build:`, `test:`, `refactor:`). CI checks
  commit messages.
- Prettier decides formatting. Run `pnpm format`.
- Intra-project imports carry explicit `.ts` extensions. Node 24 runs TypeScript directly, which is why
  there is no `tsx` dependency, and it needs the real filename.
- Plain SQL, hand-written. No ORM, no query builder.
- Any user-facing string gets a reading-level pass. Aim for 6th grade. Short sentences, common words.
  "AI access key", never bare "API key".

## Adding a job source

Only the JSON APIs listed in SPEC §6. **No scraping, ever** — no headless browsers, no HTML parsing of
job sites, no auto-discovery of company boards (discovery is crawling).

A new source must:

- Be added to `src/core/net/allowlist.ts`. The HTTP adapter throws on any host not listed there, so this
  is enforced at runtime rather than by convention.
- Be added to the `http:default` scope in `src-tauri/capabilities/default.json` as well. That file is the
  OS-level twin of the allowlist: without its line the packaged app refuses the host even though dev,
  tests, and the harness all work — a two-place change on purpose, and `tests/allowlist.test.ts` fails if
  the second half is forgotten.
- Implement `Source` from `src/core/sources/source.ts`. **`fetch()` must never throw.** One dead board
  must not empty the user's ranked list — return the error in the result instead.
- Ship recorded fixtures, including the error responses. Tests never hit the network.
- Honour any published rate limit. Lever's `robots.txt` sets `Crawl-delay: 1`; we obey it. Send
  `If-None-Match` when the source supports ETags.

## Adding to the starter watchlist

`data/starter-watchlist.json` ships employer job boards so the app returns results with zero setup.

Verify a slug before adding it, and check the **board name**, not just the HTTP status. Several slugs
return 200 with real jobs but belong to a completely different company — `greenhouse/archer` is a
veterinary clinic, `ashby/flock` is a UK motor insurer. `pnpm harness --verify-watchlist` does this
check for every entry.

Prefer employers where military experience transfers directly, and cover more than software: logistics,
maintenance, security, operations, manufacturing, field service, and technician roles.
