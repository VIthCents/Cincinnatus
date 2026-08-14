import { redactCredentials } from "../../core/net/redact.ts";

/**
 * Turn any thrown thing into one plain sentence a person can act on.
 *
 * Errors are data (SPEC §12) and are shown rather than swallowed — but shown is
 * not the same as legible. Three places used to interpolate `err.message`
 * straight into a friendly sentence, and the friendliness made it worse: a
 * Tauri permission failure reads
 *
 *   The search hit a problem: http.fetch not allowed. Permissions associated
 *   with this command: http:default. Try again in a bit.
 *
 * for an audience the whole app is built around not making decode things. The
 * Adzuna capability bug shipped looking exactly like that.
 *
 * This is a sibling of `toPlainMessage` in core/sources, not a reuse of it:
 * that one is source-flavoured (it needs a label and promises to retry on the
 * next search), and these failures are not about a source.
 *
 * The raw error still belongs in the console — this is for the screen.
 */
export function plainErrorWords(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);

  // Order matters: the specific shapes first, the pass-through last.

  // Tauri capability denials. The person did nothing wrong and can do nothing
  // about the ACL, but a restart genuinely does clear the transient cases.
  if (/not allowed|permission|forbidden/i.test(message)) {
    return "The app was blocked from doing part of its work on this computer. Closing Cincinnatus and opening it again usually fixes this.";
  }

  // The Rust keychain commands' own wording (see src-tauri/src/lib.rs).
  if (/key store|could not (read|save|remove) the key/i.test(message)) {
    return "Cincinnatus could not open the place where this computer keeps keys.";
  }

  if (
    /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|fetch failed|network/i.test(message)
  ) {
    return "Cincinnatus could not reach the internet. Check your connection.";
  }

  if (/abort|timeout/i.test(message)) {
    return "It took too long to answer.";
  }

  if (/\bsql\b|sqlite|database/i.test(message)) {
    return "Cincinnatus could not read its saved data.";
  }

  // Much of this codebase already writes careful sentences and throws them —
  // extractResumeFile, getEmbedder, the source layer. Those must survive
  // untouched, so anything that already looks like a sentence is passed
  // through. The tests below the tell are what keep this from letting a stack
  // trace out: no error-type names, no error codes, no URLs, no `at `, no `::`.
  if (looksLikeASentence(message)) return redactCredentials(message);

  return "Something went wrong inside the app.";
}

function looksLikeASentence(message: string): boolean {
  if (message.length === 0 || message.length > 200) return false;
  if (!message.trim().endsWith(".")) return false;
  return !/[A-Za-z]+Error|E[A-Z]{4,}|\bat \w|https?:\/\/|::|invoke|tauri/.test(message);
}
