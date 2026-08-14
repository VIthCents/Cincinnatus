import {
  LLM_RATIONALE_MAX_CHARS,
  LLM_SCORE_BATCH_SIZE,
  LLM_SCORE_DESCRIPTION_CHARS,
  LLM_SCORE_MAX_JOBS,
  LLM_SCORE_MAX_TOKENS,
} from "../config.ts";
import { buildProfileText } from "../embed/text.ts";
import type { Hasher, Llm } from "../ports.ts";
import type { Job, LlmScore, Profile, RankedJob } from "../types.ts";
import { SCORE_PROMPT_VERSION, SCORE_SYSTEM } from "./prompts/score.v1.ts";

/**
 * The AI upgrade to the match score (SPEC §5).
 *
 * The embedding answers "is this job about the same subject as this person's
 * background". That is not the question a veteran is asking, which is "could I
 * actually get this". pipeline/reach.ts corrects part of the gap with rules;
 * this asks a model, but only for the handful of jobs at the top of the list
 * that someone will actually read, and only when they have connected a key.
 *
 * PRIVACY (SPEC §7): what leaves is the STRUCTURED profile — titles, skills,
 * education, clearance — never the resume. buildProfileText is the same
 * function the embedder uses, so that guarantee holds by construction rather
 * than by remembering.
 */

export const SCORE_BATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scores"],
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "fit", "why"],
        properties: {
          id: { type: "string" },
          fit: { type: "number", minimum: 0, maximum: 100 },
          why: { type: "string", maxLength: LLM_RATIONALE_MAX_CHARS },
        },
      },
    },
  },
} as const;

/** Short enough to read in a prompt, long enough to be unambiguous. */
const ID_PREFIX_LENGTH = 8;

export interface ScoreOutcome {
  readonly scores: ReadonlyMap<string, LlmScore>;
  /** How many jobs were actually judged. */
  readonly scored: number;
  /** Plain words when scoring could not finish. Null when it did. */
  readonly note: string | null;
}

/**
 * The key a stored score is valid under: this person, as read by this version
 * of the prompt.
 */
export function profileScoreHash(hasher: Hasher, profile: Profile): string {
  return hasher.sha256Hex(`${SCORE_PROMPT_VERSION}\n${buildProfileText(profile)}`);
}

/**
 * Which jobs to spend money on: the top of the list the person will actually
 * see, minus anything already judged against this same profile and this same
 * job text, minus anything they have hidden.
 *
 * Walking the ranked list rather than "jobs first seen this run" means that
 * connecting a key judges the existing top 30 straight away, instead of
 * leaving the list looking untouched until new jobs happen to arrive.
 */
export function selectJobsToScore(args: {
  readonly ranked: readonly RankedJob[];
  readonly stored: ReadonlyMap<string, LlmScore>;
  readonly hidden: ReadonlySet<string>;
  readonly contentHashOf: ReadonlyMap<string, string>;
  readonly limit?: number;
}): readonly Job[] {
  const limit = args.limit ?? LLM_SCORE_MAX_JOBS;
  const out: Job[] = [];

  for (const entry of args.ranked) {
    if (out.length >= limit) break;
    const id = entry.job.id;
    if (args.hidden.has(id)) continue;

    const existing = args.stored.get(id);
    if (existing !== undefined) {
      // Stored under this profile (the map is already filtered by it) — but
      // the job text may have moved underneath it.
      const now = args.contentHashOf.get(id);
      if (now === undefined || now === existing.contentHash) continue;
    }
    out.push(entry.job);
  }

  return out;
}

function jobBlock(job: Job): string {
  const where = job.location === null ? "" : `, ${job.location}`;
  const description = job.descriptionText.slice(0, LLM_SCORE_DESCRIPTION_CHARS);
  return [
    `id: ${job.id.slice(0, ID_PREFIX_LENGTH)}`,
    `${job.title} at ${job.company}${where}`,
    description,
    "---",
  ].join("\n");
}

interface RawScore {
  id: string;
  fit: number;
  why: string;
}

/**
 * Score a batch of jobs. Never throws.
 *
 * A failure ends the whole pass rather than retrying: the two realistic causes
 * are a key that is not valid and credits that have run out, and neither gets
 * better by asking twice. Everything already judged and persisted stays.
 */
export async function scoreJobs(args: {
  readonly llm: Llm;
  readonly hasher: Hasher;
  readonly profile: Profile;
  readonly jobs: readonly Job[];
  readonly contentHashOf: ReadonlyMap<string, string>;
  readonly now: number;
  /** Called after each batch, so a slow pass is not a silent one. */
  readonly onBatch?: (scoredSoFar: number, total: number) => void;
  /** Called after each batch with just that batch's scores, for crash-safe saves. */
  readonly onScored?: (batch: ReadonlyMap<string, LlmScore>) => Promise<void>;
}): Promise<ScoreOutcome> {
  const scores = new Map<string, LlmScore>();
  if (args.jobs.length === 0) return { scores, scored: 0, note: null };

  const profileText = buildProfileText(args.profile);
  const profileHash = profileScoreHash(args.hasher, args.profile);

  for (let i = 0; i < args.jobs.length; i += LLM_SCORE_BATCH_SIZE) {
    const batch = args.jobs.slice(i, i + LLM_SCORE_BATCH_SIZE);
    const byPrefix = new Map(batch.map((j) => [j.id.slice(0, ID_PREFIX_LENGTH), j]));

    let parsed: RawScore[];
    try {
      const response = await args.llm.complete({
        model: "fast",
        system: SCORE_SYSTEM,
        maxTokens: LLM_SCORE_MAX_TOKENS,
        jsonSchema: SCORE_BATCH_SCHEMA,
        messages: [
          {
            role: "user",
            content: `Seeker's background:\n${profileText}\n\nJobs:\n${batch
              .map(jobBlock)
              .join("\n")}`,
          },
        ],
      });
      const body = JSON.parse(response.text) as { scores?: RawScore[] };
      parsed = Array.isArray(body.scores) ? body.scores : [];
    } catch {
      return {
        scores,
        scored: scores.size,
        note: "The AI could not check your matches this time. The list still works — it is ranked by reading the jobs on your computer.",
      };
    }

    const batchScores = new Map<string, LlmScore>();
    for (const raw of parsed) {
      const job = byPrefix.get(String(raw.id).trim());
      // An id we did not send back is not a score of anything.
      if (job === undefined) continue;
      if (typeof raw.fit !== "number" || !Number.isFinite(raw.fit)) continue;

      batchScores.set(job.id, {
        // A prompt is a request; these are the guarantee. Structured outputs
        // may or may not enforce the schema's bounds, and a fit of 140 would
        // quietly outrank everything on the screen.
        fit: Math.max(0, Math.min(100, raw.fit)),
        why: truncateWords(String(raw.why ?? ""), LLM_RATIONALE_MAX_CHARS),
        profileHash,
        contentHash: args.contentHashOf.get(job.id) ?? null,
        scoredAt: args.now,
      });
    }

    for (const [id, score] of batchScores) scores.set(id, score);
    if (args.onScored !== undefined) await args.onScored(batchScores);
    args.onBatch?.(scores.size, args.jobs.length);
  }

  return { scores, scored: scores.size, note: null };
}

/** Cut at a word boundary, so a clipped reason still reads as a sentence. */
export function truncateWords(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
}
