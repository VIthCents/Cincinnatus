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
// Llm
// -----------------------------------------------------------------------------

export interface LlmMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface LlmRequest {
  /**
   * Logical role, not a model id. The adapter maps "doc" → DOC_MODEL and
   * "fast" → FAST_MODEL from config.ts, so a model bump is one diff in one
   * file rather than a sweep through the engine.
   */
  readonly model: "doc" | "fast";
  readonly system: string;
  readonly messages: readonly LlmMessage[];
  readonly maxTokens: number;
  /**
   * When present, the adapter enforces this JSON Schema on the output
   * (structured outputs), so `text` is guaranteed-parseable JSON matching it.
   */
  readonly jsonSchema?: Readonly<Record<string, unknown>>;
}

export interface LlmResponse {
  readonly text: string;
  /** For the plain-language running cost estimate (SPEC §7). */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** The concrete model id that served the request. */
  readonly modelId: string;
}

/**
 * The AI brain, behind a port for the same reasons as everything else: core
 * cannot do network I/O, tests must run without a key or a network, and the
 * app must degrade gracefully when no key is connected (constraint 6) — which
 * is easy to test when "no key" is just an adapter that rejects.
 *
 * PRIVACY INVARIANT (constraint 3): the ONLY user data that may ever enter an
 * LlmRequest is resume text, profile fields, and job text — and only through
 * the functions in src/core/documents/. Nothing else egresses.
 */
export interface Llm {
  complete(req: LlmRequest): Promise<LlmResponse>;
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

/**
 * The three stages a search moves through, named the way the UI says them out
 * loud: "Finding jobs", "Reading jobs", "Putting them in order". The pipeline
 * announces its own stage rather than letting the UI infer one from the event
 * stream — inference gets it wrong on a run where nothing needs embedding.
 */
export type RunPhase = "finding" | "reading" | "ranking";

export type ProgressEvent =
  | { readonly kind: "phase"; readonly phase: RunPhase }
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
