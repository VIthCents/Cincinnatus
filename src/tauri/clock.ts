import { sha256 } from "js-sha256";
import type { Clock, Hasher } from "../core/ports.ts";

/** Webview Clock — the twin of src/node/clock.ts. */
export const tauriClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
};

/**
 * SHA-256 for the webview. `crypto.subtle` is async and the Hasher port is
 * sync (job-id computation runs inside tight normalize loops), so the adapter
 * uses js-sha256 — a small, widely-exercised implementation — instead of
 * hand-transcribing round constants. Same reasoning as the Node adapter's
 * refusal to hand-roll; see docs/DECISIONS.md.
 */
export const tauriHasher: Hasher = {
  sha256Hex: (input: string) => sha256(input),
};
