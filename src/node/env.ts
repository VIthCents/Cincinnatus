import { existsSync, readFileSync } from "node:fs";

/**
 * Minimal .env loader — the fifteen lines that replace a dependency
 * (constraint 7). KEY=VALUE lines, # comments, optional surrounding quotes.
 * Never overrides variables already present in the environment, so a real
 * environment variable always wins over the file.
 */
export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
