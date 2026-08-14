import { TauriDb } from "../../tauri/db.ts";
import { quotaStatus, quotaWords } from "../../core/app/quota.ts";
import { ADZUNA_QUOTA } from "../../core/config.ts";
import { tauriHttp } from "../../tauri/http.ts";
import { tauriClock, tauriHasher } from "../../tauri/clock.ts";
import { createTauriEmbedder } from "../../tauri/embedder.ts";
import { createTauriLlm } from "../../tauri/llm.ts";
import {
  SECRET_ANTHROPIC_KEY,
  SECRET_USAJOBS_EMAIL,
  SECRET_USAJOBS_KEY,
  SECRET_ADZUNA_APP_ID,
  SECRET_ADZUNA_APP_KEY,
  getSecret,
} from "../../tauri/secrets.ts";

import type { Embedder, Llm, Reporter } from "../../core/ports.ts";
import type { Profile, WatchlistEntry } from "../../core/types.ts";
import { migrate } from "../../core/db/migrations.ts";
import * as repo from "../../core/db/repo.ts";
import { runPipeline, type RunResult } from "../../core/pipeline/run.ts";
import { loadRankedFromDb } from "../../core/pipeline/loadRanked.ts";
import { buildSearchTerms } from "../../core/pipeline/queries.ts";
import { createGreenhouseSource } from "../../core/sources/greenhouse.ts";
import { createUsaJobsSource } from "../../core/sources/usajobs.ts";
import { createLeverSource } from "../../core/sources/lever.ts";
import { createAshbySource } from "../../core/sources/ashby.ts";
import { buildAdzunaSearchUrl, createAdzunaSource } from "../../core/sources/adzuna.ts";
import type { Source } from "../../core/sources/source.ts";
import { markRunNow } from "../../core/app/schedule.ts";
import { recordSpend } from "../../core/app/spend.ts";
import { USAJOBS_DEFAULT_WINDOW_DAYS, estimateCostUsd } from "../../core/config.ts";
import { MODEL_ID } from "../../tauri/embedder.ts";

import starterWatchlist from "../../../data/starter-watchlist.json";

/**
 * The webview's composition root: one Db, one lazy embedder, sources built
 * from the watchlist table plus whichever keys the user has connected. The
 * same runPipeline the harness uses, wired to the Tauri adapters.
 */

export const db = new TauriDb();

let embedderPromise: Promise<Embedder> | null = null;

/**
 * The ~23 MB model loads once, on first search, not at app start.
 *
 * A FAILED load is not cached: caching the rejected promise would make every
 * "Try again" fail with the first attempt's error until the app restarts —
 * observed live when the wasm runtime was missing. And a failed load reaches
 * the user in plain words, not onnxruntime backend jargon.
 */
export function getEmbedder(): Promise<Embedder> {
  embedderPromise ??= createTauriEmbedder().catch((err: unknown) => {
    embedderPromise = null;
    throw new Error(
      "The job-matching tool could not start on this computer. Closing Cincinnatus and opening it again usually fixes this.",
      { cause: err },
    );
  });
  return embedderPromise;
}

/**
 * Null when no key is connected — callers show the "connect AI" path.
 *
 * Every Llm handed out here counts its usage toward the monthly "AI used this
 * month" estimate, so the Settings figure covers chat, analysis, revision,
 * parsing, AND document prep — not just one flow.
 */
export async function getLlm(): Promise<Llm | null> {
  const key = await getSecret(SECRET_ANTHROPIC_KEY);
  if (key === null) return null;
  const inner = createTauriLlm(key);
  return {
    async complete(req) {
      const response = await inner.complete(req);
      const cost = estimateCostUsd(
        response.modelId,
        response.inputTokens,
        response.outputTokens,
      );
      void recordSpend(db, tauriClock.now(), cost);
      return response;
    },
  };
}

export async function hasAnthropicKey(): Promise<boolean> {
  return (await getSecret(SECRET_ANTHROPIC_KEY)) !== null;
}

export async function hasUsaJobsKey(): Promise<boolean> {
  return (
    (await getSecret(SECRET_USAJOBS_KEY)) !== null &&
    (await getSecret(SECRET_USAJOBS_EMAIL)) !== null
  );
}

export async function hasAdzunaKeys(): Promise<boolean> {
  return (
    (await getSecret(SECRET_ADZUNA_APP_ID)) !== null &&
    (await getSecret(SECRET_ADZUNA_APP_KEY)) !== null
  );
}

interface StarterWatchlistFile {
  boards: {
    ats: WatchlistEntry["ats"];
    slug: string;
    company_label: string;
    board_name?: string;
    source: WatchlistEntry["source"];
    sector?: string;
    note?: string;
  }[];
}

/** Migrate and make sure the starter boards are in the watchlist table. */
export async function ensureDbReady(): Promise<void> {
  const now = tauriClock.now();
  await migrate(db, now);

  const existing = await repo.listWatchlist(db);
  if (existing.length === 0) {
    const file = starterWatchlist as StarterWatchlistFile;
    await repo.seedWatchlist(
      db,
      file.boards.map((b) => ({
        ats: b.ats,
        slug: b.slug,
        companyLabel: b.company_label,
        boardName: b.board_name ?? null,
        source: b.source,
        sector: b.sector ?? null,
        note: b.note ?? null,
      })),
      now,
    );
  }
}

/** Assemble sources exactly the way the harness does. */
/**
 * Every board on the watchlist, whatever runs it. Until now this filtered to
 * Greenhouse, which silently dropped the 9 Lever and Ashby boards that Phase 1
 * verified live — a third of the list, gone with no message.
 */
function sourceForBoard(entry: WatchlistEntry): Source | null {
  if (entry.ats === "greenhouse") {
    return createGreenhouseSource(entry.slug, entry.companyLabel);
  }
  if (entry.ats === "lever") return createLeverSource(entry.slug, entry.companyLabel);
  if (entry.ats === "ashby") return createAshbySource(entry.slug, entry.companyLabel);
  return null;
}

/**
 * Search terms, with the person thumbs folded in. Thumbs change what gets
 * searched for, never how anything is scored — see pipeline/queries.ts.
 */
async function termsFor(profile: Profile) {
  const [promoted, demoted] = await Promise.all([
    repo.listFeedbackTitles(db, "up"),
    repo.listFeedbackTitles(db, "down"),
  ]);
  return buildSearchTerms(profile, { promoted, demoted });
}

async function buildSources(
  profile: Profile,
): Promise<{ sources: Source[]; notes: string[] }> {
  const watchlist = await repo.listWatchlist(db);
  const sources: Source[] = watchlist
    .map(sourceForBoard)
    .filter((source): source is Source => source !== null);
  const notes: string[] = [];

  const key = await getSecret(SECRET_USAJOBS_KEY);
  const email = await getSecret(SECRET_USAJOBS_EMAIL);
  if (key !== null && email !== null) {
    const terms = await termsFor(profile);
    sources.push(
      createUsaJobsSource({
        auth: { apiKey: key, userAgentEmail: email },
        keywords: terms.titles,
        windowDays: USAJOBS_DEFAULT_WINDOW_DAYS,
      }),
    );
  }
  const adzunaId = await getSecret(SECRET_ADZUNA_APP_ID);
  const adzunaKey = await getSecret(SECRET_ADZUNA_APP_KEY);
  if (adzunaId !== null && adzunaKey !== null) {
    // Adzuna enforces a daily and monthly ceiling. Ask the ledger before
    // building the source at all, so an exhausted quota is a source that is
    // quietly absent rather than a run full of rejected requests.
    const quota = await quotaStatus(db, "adzuna", ADZUNA_QUOTA, tauriClock.now());
    if (quota.remaining > 0) {
      const terms = await termsFor(profile);
      sources.push(
        createAdzunaSource({
          auth: { appId: adzunaId, appKey: adzunaKey },
          keywords: terms.titles,
          locationName: terms.locationName,
          radiusMiles: terms.radiusMiles,
          maxCalls: quota.remaining,
        }),
      );
    } else if (quota.exhausted !== null) {
      // Say so. quotaWords exists precisely for this and was only ever shown
      // in Settings, so the person watching the Jobs tab got a shorter list
      // with no explanation anywhere on the screen they were looking at.
      notes.push(quotaWords(quota.exhausted));
    }
  }

  return { sources, notes };
}

export async function runSearch(
  profile: Profile,
  reporter: Reporter,
): Promise<RunResult> {
  const embedder = await getEmbedder();
  const { sources, notes } = await buildSources(profile);

  const result = await runPipeline({
    db,
    http: tauriHttp,
    clock: tauriClock,
    hasher: tauriHasher,
    embedder,
    reporter,
    profile,
    sources,
    notes,
    maxEmbed: null, // the product default: embed everything, show progress
  });

  await markRunNow(db, tauriClock.now());
  return result;
}

/** The last known ranking, straight from the database — instant, no network. */
export function loadLastRanking(): ReturnType<typeof loadRankedFromDb> {
  return loadRankedFromDb(db, MODEL_ID, tauriClock.now());
}

// -----------------------------------------------------------------------------
// Key validation (the wizard's live checks with the green tick)
// -----------------------------------------------------------------------------

/** Costs a fraction of a cent when it works — one tiny fast-model request. */
export async function validateAnthropicKey(
  key: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { createTauriLlm, llmErrorMessage } = await import("../../tauri/llm.ts");
  try {
    await createTauriLlm(key).complete({
      model: "fast",
      system: "Answer with the single word OK.",
      messages: [{ role: "user", content: "OK?" }],
      maxTokens: 4,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: llmErrorMessage(err) };
  }
}

export async function validateUsaJobsKey(
  key: string,
  email: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await tauriHttp.get({
      url: "https://data.usajobs.gov/api/search?ResultsPerPage=1&Keyword=logistics",
      headers: {
        "authorization-key": key,
        "user-agent": email,
        host: "data.usajobs.gov",
      },
    });
    if (response.status === 200) return { ok: true };
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        message:
          "USAJobs did not accept the key. Check that the key is complete and the email matches the one you signed up with.",
      };
    }
    return {
      ok: false,
      message: "USAJobs had a problem on their end. Wait a minute and try again.",
    };
  } catch {
    return {
      ok: false,
      message: "Could not reach USAJobs. Check your internet connection and try again.",
    };
  }
}

/**
 * One tiny real search, so a wrong paste is caught here rather than showing
 * up as a silently shorter job list six hours later.
 */
export async function validateAdzunaKeys(
  appId: string,
  appKey: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await tauriHttp.get({
      url: buildAdzunaSearchUrl(
        {
          auth: { appId, appKey },
          keywords: [],
          locationName: null,
          radiusMiles: null,
        },
        "driver",
        1,
      ),
      headers: {},
    });
    if (response.status === 200) return { ok: true };
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        message:
          "Those numbers did not work. Copy them again from the Adzuna page and paste them here.",
      };
    }
    return {
      ok: false,
      message: "Adzuna had a problem on their end. Wait a minute and try again.",
    };
  } catch {
    return {
      ok: false,
      message: "Could not reach Adzuna. Check your internet connection.",
    };
  }
}
