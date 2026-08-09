import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Http, HttpRequest, HttpResponse } from "../core/ports.ts";

/**
 * Recorded HTTP, so tests and `--offline` runs never touch the network.
 *
 * "Fixtures are truth" (SPEC section 12): record a real response once, then test
 * against it forever. Files are named by a hash of the URL so a query string
 * with 500 results per page does not become an unusable filename.
 */

interface ManifestEntry {
  readonly url: string;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly file: string;
}

type Manifest = Record<string, ManifestEntry>;

function keyFor(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

function manifestPath(dir: string): string {
  return join(dir, "manifest.json");
}

function loadManifest(dir: string): Manifest {
  const path = manifestPath(dir);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

/** Replay-only HTTP. Throws on a URL with no recording, rather than silently returning empty. */
export function createFixtureHttp(dir: string): Http {
  const manifest = loadManifest(dir);

  return {
    get(req: HttpRequest): Promise<HttpResponse> {
      const entry = manifest[keyFor(req.url)];
      if (entry === undefined) {
        return Promise.reject(
          new Error(
            `No recorded response for ${req.url}\n` +
              `Record one with:  pnpm harness --profile <path> --capture`,
          ),
        );
      }
      return Promise.resolve({
        status: entry.status,
        headers: entry.headers,
        body: readFileSync(join(dir, entry.file), "utf8"),
      });
    },
  };
}

/**
 * Wrap a live Http and write every response to `dir`.
 *
 * Deliberately records error responses too — a 404 from a renamed board and a
 * 401 from a bad key are exactly the cases the "fetch never throws" contract
 * has to survive, and they are impossible to test without a recording.
 */
export function createCapturingHttp(inner: Http, dir: string): Http {
  mkdirSync(dir, { recursive: true });
  const manifest = loadManifest(dir);

  return {
    async get(req: HttpRequest): Promise<HttpResponse> {
      const response = await inner.get(req);

      const key = keyFor(req.url);
      const file = `${key}.txt`;
      writeFileSync(join(dir, file), response.body, "utf8");
      manifest[key] = {
        url: req.url,
        status: response.status,
        headers: response.headers,
        file,
      };
      writeFileSync(
        manifestPath(dir),
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );

      return response;
    },
  };
}
