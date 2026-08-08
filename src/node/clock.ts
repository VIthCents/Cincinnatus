import { createHash, randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Clock, Hasher } from "../core/ports.ts";

export const nodeClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => delay(ms),
  // Only used for backoff jitter, but crypto's generator costs nothing here and
  // avoids a second-guessable Math.random in the codebase.
  random: () => randomInt(0, 1_000_000) / 1_000_000,
};

/**
 * SHA-256 via node:crypto.
 *
 * Core cannot import node:crypto (it has to run in the webview) and
 * `crypto.subtle` is async, which would make job-id computation async through
 * the whole pipeline. Hashing therefore sits behind a port rather than being
 * hand-transcribed into core — ninety lines of round constants is exactly the
 * kind of code that is subtly wrong for a year. See docs/DECISIONS.md.
 */
export const nodeHasher: Hasher = {
  sha256Hex: (input: string) =>
    createHash("sha256").update(input, "utf8").digest("hex"),
};
