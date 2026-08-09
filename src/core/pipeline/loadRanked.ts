import type { Db } from "../ports.ts";
import type { Profile } from "../types.ts";
import * as repo from "../db/repo.ts";
import { decodeVector } from "../util/base64.ts";
import { rankJobs, type RankOutput } from "./rank.ts";

/**
 * Re-rank straight from the database — no network, no embedder.
 *
 * What lets the Opportunities tab show the last known list the moment the app
 * opens (or after a restart) instead of a spinner waiting on a fresh search.
 * Everything needed is already stored: jobs, their embed hashes, the vectors,
 * and the profile with its vector. Ranking 5k jobs is measured in
 * milliseconds; loading and decoding the vectors dominates and is still fast.
 *
 * Returns null when there is nothing to show yet (no profile or no jobs) —
 * the UI treats that as "run your first search", not as an error.
 */
export async function loadRankedFromDb(
  db: Db,
  modelId: string,
  now: number,
): Promise<{ ranked: RankOutput; profile: Profile } | null> {
  const profile = await repo.getStoredProfile(db);
  if (profile === null) return null;

  const jobs = await repo.listRankableJobs(db);
  if (jobs.length === 0) return null;

  const hashOf = await repo.listEmbedHashes(db);
  const uniqueHashes = [...new Set(hashOf.values())];
  const encoded = await repo.loadEmbeddings(db, modelId, uniqueHashes);

  const vectors = new Map<string, Float32Array>();
  for (const [jobId, hash] of hashOf) {
    const vector = encoded.get(hash);
    if (vector !== undefined) vectors.set(jobId, decodeVector(vector));
  }

  const encodedProfile = await repo.getStoredProfileEmbedding(db, modelId);
  const profileVector = encodedProfile === null ? null : decodeVector(encodedProfile);

  const ranked = rankJobs({ jobs, vectors, profileVector, profile, now });
  return { ranked, profile };
}

export type { RankOutput };
