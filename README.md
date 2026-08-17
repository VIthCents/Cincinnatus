# Cincinnatus

A free app that helps veterans get hired. It runs on your own computer — no
account, no sign-up, nothing to pay for, and nothing about you is sent anywhere
you did not ask it to go.

- **Chat** — talk through your resume. You get an honest read on it, not
  flattery, and a stronger version you can use.
- **Jobs** — one list, best fit first. Each job has one button that writes a
  resume and cover letter for that job. **You** click Apply. The app never
  applies for anything on your behalf.

---

## Download it

**[⬇ Download Cincinnatus for Windows](https://github.com/VIthCents/Cincinnatus/releases/latest/download/Cincinnatus_0.1.0_x64-setup.exe)** — 13 MB

Open the file you downloaded and follow the prompts. It installs for you only,
so it never asks for an administrator password.

Windows may still show a blue "Windows protected your PC" box the first few
days. Click **More info**, and check that it says **Hawkseye Corp.** — that is
us. Then click **Run anyway**. That box appears because the app is new, not
because anything is wrong with it, and it stops appearing as more people
install it.

**Mac is not ready yet.** The Mac version needs a separate signature from Apple
that is not finished. If you install an unsigned Mac app, macOS blocks it in a
way that is genuinely hard to undo, so we would rather wait than hand you that.

<details>
<summary>Checking the download yourself (optional)</summary>

The installer is signed by **Hawkseye Corp.** Right-click it → Properties →
Digital Signatures to see for yourself.

To check nothing changed on the way to you, open PowerShell in your Downloads
folder and run:

```powershell
Get-FileHash .\Cincinnatus_0.1.0_x64-setup.exe -Algorithm SHA256
```

It should print:

```
39A9DBE897BE883216A463FB01DC9EF7ED9AD018C8550B7683B25627D688BC03
```

</details>

---

## If you are here to use it

**You do not need to set anything up.** Install it, tell it what kind of work
you are looking for, and it goes and looks. It finds jobs on USAJobs and on the
public job boards a lot of private employers use.

**The first search is slow.** It takes 10 to 20 minutes, because your computer
reads every job it finds rather than sending them off somewhere. After the first
time, searches take about a minute. You can close the window; it keeps working.

### Two things you can turn on later, both free, neither required

- **The AI helper.** It reads your resume. It writes a resume and cover letter
  for each job you pick. You need a key from `console.anthropic.com`. That is
  the developer site, not the Claude chat app. A Claude Pro or Max plan does
  **not** include one. You pay Anthropic for what you use — usually a few cents
  per document. Job searching works fine without it.
- **More job listings.** Company job boards carry a lot of office and
  engineering work. Turning this on adds driving, warehouse, maintenance and
  trades jobs near you, which is most of what the boards miss. Free key from
  `developer.adzuna.com`. Settings walks you through it.

Federal jobs from USAJobs also need a free key, and they are worth having:
veterans get hiring preference there.

### What leaves your computer

Your resume, your chats and every document stay on your machine. Two things go
out, and nothing else:

- The words you are searching for, to the job sites. That is the same thing you
  would type into a search box.
- Your resume and the one job you picked, to Anthropic. This happens **only** if
  you turned the AI helper on, and **only** when you press the button.

No tracking. No account. One thing worth knowing: if you turn on the extra job
listings, tapping Apply opens that job on Adzuna first, and Adzuna counts the
tap. That is how they pay for letting us list their jobs.

[PRIVACY.md](./PRIVACY.md) says all of this again, in detail.

---

## If you are here to work on it

Node 24+, pnpm 9+, Rust stable.

```sh
pnpm install
pnpm test          # no network, ever — recorded fixtures
pnpm typecheck
pnpm tauri dev     # the app
```

The engine runs headless, which is how most of it gets exercised:

```sh
pnpm harness --profile fixtures/profile.sample.json      # a full job search
pnpm harness analyze --resume fixtures/resumes/logistics.txt
pnpm harness tailor  --resume <resume> --job-id <id from a search>
```

Copy `.env.example` to `.env` for the optional keys. Everything runs without
them; the harness says which features are off and why.

### The shape of it

```
src/core/    the whole engine — pure TypeScript, no Tauri and no DOM
src/node/    adapters that let core run in the CLI harness
src/tauri/   adapters that let core run in the app
src/ui/      React, two tabs and a first-run wizard
src-tauri/   the Rust shell: tray, notifications, OS keychain
scripts/     harness.ts, and the build scripts for generated data
```

`src/core` importing anything from Tauri or the DOM is the one architectural
mistake that matters, and three independent things stop it: a tsconfig with no
DOM types, an ESLint rule, and the fact that the harness would stop building.
That constraint is what lets the whole engine be tested without a browser.

### Before changing anything

- [CLAUDE.md](./CLAUDE.md) — seven constraints that override everything else.
  They are short. Read them.
- [docs/SPEC.md](./docs/SPEC.md) — what is being built, and why.
- [docs/DECISIONS.md](./docs/DECISIONS.md) — every place reality disagreed with
  the plan, with the measurement that settled it. If you are about to wonder
  "why on earth is it done this way", the answer is probably in here.
- [docs/RELEASING.md](./docs/RELEASING.md) — signing and distribution.
- [CONTRIBUTING.md](./CONTRIBUTING.md) — setup, and how not to commit a real
  résumé by accident.

Two habits this project runs on: **fixtures are truth** — record a real response
once and test against it forever, never live network in a test — and **claims
get measured**. Several confident, plausible ideas in `DECISIONS.md` turned out
to be wrong when checked against real data, including a couple that would have
made the app worse for exactly the people it is for.

---

## Licence

MIT. See [LICENSE](./LICENSE).

Military-to-civilian job code translation is derived from the
[O\*NET Military Crosswalk](https://www.onetcenter.org/crosswalks.html) by the
U.S. Department of Labor, Employment and Training Administration, used under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Titles were
simplified and military-specific codes removed.
