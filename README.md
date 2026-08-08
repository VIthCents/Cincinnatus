# Cincinnatus

A free, open-source desktop app that helps veterans get hired. It runs entirely on your own computer —
no accounts, no server, no tracking.

- **Chat** — talk through your resume. Get honest feedback and a stronger version of it.
- **Opportunities** — one ranked list of jobs, best match and most recent first. One button prepares a
  tailored resume and cover letter. You click Apply yourself; the app never applies for you.

Your resume stays on your machine. See [PRIVACY.md](./PRIVACY.md) for exactly what leaves it and when.

> **Status: in development.** Phase 0 (scaffold) and Phase 1 (job pipeline) are built. The app currently
> boots to a placeholder — the Chat and Opportunities tabs arrive in Phase 3. The job pipeline works today
> and is driven from the command line via `pnpm harness`.

## For developers

Node 24+, pnpm 9+, Rust stable. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup and the one
architectural rule that matters.

```sh
pnpm install
pnpm test                                           # no network; recorded fixtures
pnpm harness --profile fixtures/profile.sample.json # the job pipeline, headless
pnpm tauri dev                                      # the app shell
```

- [docs/SPEC.md](./docs/SPEC.md) — what is being built and why
- [docs/DECISIONS.md](./docs/DECISIONS.md) — why it departs from the spec where it does
- [CLAUDE.md](./CLAUDE.md) — the constraints that override everything

A user-facing installation guide ships in Phase 4, alongside signed installers.

## License

MIT. See [LICENSE](./LICENSE).
