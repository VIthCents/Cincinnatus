/**
 * The seams that keep src/core portable.
 *
 * Everything src/core needs from the outside world arrives through one of these
 * interfaces. Nothing here imports Node, Tauri, React, or the DOM — that is
 * enforced by tsconfig.core.json (no `lib.dom`, no `@types/node`) and by the
 * `src/core/**` block in eslint.config.js.
 *
 * Implementations live outside core:
 *   src/node/*    for the CLI harness and vitest
 *   src/tauri/*   for the app (Phase 3)
 *   tests/fakes/* deterministic doubles
 */

// -----------------------------------------------------------------------------
// Clock
// -----------------------------------------------------------------------------

/**
 * Time and randomness. Injected rather than ambient so that a run is
 * reproducible: `now` is read exactly once per pipeline run, and backoff jitter
 * replays identically in tests.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** Resolves after roughly `ms`. Fakes resolve immediately. */
  sleep(ms: number): Promise<void>;
  /** Uniform in [0, 1). Used only for backoff jitter. */
  random(): number;
}

// -----------------------------------------------------------------------------
// Http
// -----------------------------------------------------------------------------

export interface HttpRequest {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Abandon the request after this many milliseconds. */
  readonly timeoutMs?: number;
}

export interface HttpResponse {
  readonly status: number;
  /** Header names are lower-cased by the adapter. */
  readonly headers: Readonly<Record<string, string>>;
  /** Empty string for 304 and other bodiless responses. */
  readonly body: string;
}

/**
 * Read-only HTTP. There is deliberately no `post` — Cincinnatus never submits
 * anything anywhere (SPEC constraint 2), and the type is the cheapest place to
 * say so.
 *
 * Adapters MUST reject any URL whose host is not in src/core/net/allowlist.ts.
 */
export interface Http {
  get(req: HttpRequest): Promise<HttpResponse>;
}

// -----------------------------------------------------------------------------
// Db
// -----------------------------------------------------------------------------

/**
 * Note what is absent: no Uint8Array, no ArrayBuffer, no boolean.
 *
 * @tauri-apps/plugin-sql cannot bind binary data at all — non-string,
 * non-number, non-null values are silently encoded as JSON text, and a real
 * BLOB column reads back as number[] (plugins-workspace#105). Rather than have
 * the two adapters disagree, binary never enters the port: embeddings are
 * base64 TEXT. Booleans are stored as 0/1 integers.
 */
export type SqlValue = string | number | null;

export interface Db {
  /** One statement, no result rows. */
  run(sql: string, params?: readonly SqlValue[]): Promise<void>;

  /**
   * The same statement once per row of `rows`.
   *
   * The Node adapter wraps this in a transaction; without it, ten thousand
   * autocommit inserts is one fsync per row and the harness appears to hang.
   * Batching lives here rather than as a `transaction()` method on the port
   * because plugin-sql runs on a connection pool: BEGIN and COMMIT issued as
   * separate calls can land on different connections, and the ROLLBACK then
   * silently does nothing (plugins-workspace#886).
   */
  runMany(sql: string, rows: readonly (readonly SqlValue[])[]): Promise<void>;

  /** One statement, all result rows. */
  all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
}

// -----------------------------------------------------------------------------
// Embedder
// -----------------------------------------------------------------------------

export interface Embedder {
  /**
   * Stable identity of the model AND its quantization, e.g.
   * "Xenova/all-MiniLM-L6-v2@q8". Stored alongside every vector so a model
   * change is a different key rather than a silent mismatch.
   */
  readonly modelId: string;
  readonly dimensions: number;
  /** Returns one L2-normalized vector per input, in input order. */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

// -----------------------------------------------------------------------------
// Hasher
// -----------------------------------------------------------------------------

export interface Hasher {
  /** Lower-case hex SHA-256 of the UTF-8 bytes of `input`. */
  sha256Hex(input: string): string;
}

// -----------------------------------------------------------------------------
// Progress
// -----------------------------------------------------------------------------

export type ProgressEvent =
  | { readonly kind: "source_start"; readonly source: string; readonly label: string }
  | {
      readonly kind: "source_done";
      readonly source: string;
      readonly label: string;
      readonly fetched: number;
      readonly notModified: boolean;
    }
  | {
      readonly kind: "source_error";
      readonly source: string;
      readonly label: string;
      readonly message: string;
    }
  | { readonly kind: "embed_progress"; readonly done: number; readonly total: number }
  | { readonly kind: "note"; readonly message: string };

/**
 * How core reports progress without logging. The harness prints these; the UI
 * (Phase 3) will render them. A run with no reporter is still valid.
 */
export type Reporter = (event: ProgressEvent) => void;
