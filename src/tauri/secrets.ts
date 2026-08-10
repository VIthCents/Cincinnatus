import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

/**
 * API keys, via the Rust `get_secret`/`set_secret` commands — a JSON file in
 * the app's config directory. Interim until the OS keychain in Phase 4; the
 * function signatures are the contract that will not change when it lands.
 * Keys are never written to SQLite (SPEC §4) and never logged.
 */

export const SECRET_ANTHROPIC_KEY = "anthropic_api_key";
export const SECRET_USAJOBS_KEY = "usajobs_api_key";
export const SECRET_USAJOBS_EMAIL = "usajobs_user_agent_email";
export const SECRET_ADZUNA_APP_ID = "adzuna_app_id";
export const SECRET_ADZUNA_APP_KEY = "adzuna_app_key";

export async function getSecret(name: string): Promise<string | null> {
  const value = await invoke<string | null>("get_secret", { name });
  return value === null || value === "" ? null : value;
}

/** Empty string deletes the key. */
export async function setSecret(name: string, value: string): Promise<void> {
  await invoke("set_secret", { name, value });
}

/**
 * Ask the user where to save a file, then write it. Returns the chosen path,
 * or null if they cancelled. The dialog is the consent step; the Rust command
 * only writes what our UI hands it.
 */
export async function saveFileAs(
  suggestedName: string,
  contentsBase64: string,
): Promise<string | null> {
  const path = await save({
    defaultPath: suggestedName,
    filters: [{ name: "Word document", extensions: ["docx"] }],
  });
  if (path === null) return null;
  await invoke("write_user_file", { path, contentsBase64 });
  return path;
}
