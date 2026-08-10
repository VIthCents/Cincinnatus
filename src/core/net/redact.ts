/**
 * Strip credentials out of anything that might be shown or stored.
 *
 * Most sources here authenticate with a header, which never appears in an
 * error message. Adzuna authenticates with `app_id` and `app_key` in the query
 * string, and this codebase deliberately treats errors as data: they go into
 * `SourceOutcome.error`, which `saveRun` persists to SQLite and the
 * Opportunities banner renders on screen.
 *
 * So without this, one failed Adzuna request writes the user's API key into
 * their local run history in plain text and may paint it on the screen. It is
 * their account and they would have no idea it happened.
 *
 * Applied at the funnels rather than at each call site: `toPlainMessage`, which
 * every source error passes through, and the two allowlist errors that quote a
 * whole URL.
 */

const SECRET_PARAMS =
  /\b(app_id|app_key|api_key|apikey|access_token|token|key)=[^&\s"'<>]*/gi;

export function redactCredentials(text: string): string {
  return text.replace(SECRET_PARAMS, (_m, name: string) => `${name}=***`);
}
