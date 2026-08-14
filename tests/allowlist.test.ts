import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  ALLOWED_HOSTS,
  assertAllowed,
  BlockedHostError,
  buildQuery,
  MalformedUrlError,
} from "../src/core/net/allowlist.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

describe("host allowlist", () => {
  it("permits the documented JSON API hosts", () => {
    expect(assertAllowed("https://boards-api.greenhouse.io/v1/boards/x/jobs")).toBe(
      "boards-api.greenhouse.io",
    );
    expect(assertAllowed("https://data.usajobs.gov/api/search?Keyword=a")).toBe(
      "data.usajobs.gov",
    );
  });

  it("blocks the job sites constraint 1 names", () => {
    for (const host of [
      "www.linkedin.com",
      "www.indeed.com",
      "www.glassdoor.com",
      "www.ziprecruiter.com",
    ]) {
      expect(() => assertAllowed(`https://${host}/jobs`)).toThrow(BlockedHostError);
    }
  });

  it("blocks the HTML host of a board we otherwise use", () => {
    // job-boards.greenhouse.io serves rendered pages. Fetching it would be
    // scraping even though the employer is on our watchlist.
    expect(() => assertAllowed("https://job-boards.greenhouse.io/anduril")).toThrow(
      BlockedHostError,
    );
    expect(ALLOWED_HOSTS).not.toContain("job-boards.greenhouse.io");
  });

  it("is not fooled by a userinfo prefix", () => {
    // https://allowed-host@evil.test/ is a request to evil.test. A substring or
    // startsWith check would wave this through.
    expect(() =>
      assertAllowed("https://boards-api.greenhouse.io@evil.test/jobs"),
    ).toThrow(MalformedUrlError);
  });

  it("rejects lookalike hosts", () => {
    expect(() => assertAllowed("https://boards-api.greenhouse.io.evil.test/x")).toThrow(
      BlockedHostError,
    );
    expect(() => assertAllowed("https://evil-boards-api.greenhouse.io/x")).toThrow(
      BlockedHostError,
    );
  });

  it("rejects plaintext http", () => {
    expect(() => assertAllowed("http://boards-api.greenhouse.io/x")).toThrow(
      MalformedUrlError,
    );
  });

  it("rejects explicit ports and IP literals", () => {
    expect(() => assertAllowed("https://boards-api.greenhouse.io:8080/x")).toThrow(
      MalformedUrlError,
    );
    expect(() => assertAllowed("https://127.0.0.1/x")).toThrow(BlockedHostError);
  });

  it("names the offending host in the error, so the fix is obvious", () => {
    try {
      assertAllowed("https://www.indeed.com/jobs");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BlockedHostError);
      expect((err as BlockedHostError).host).toBe("www.indeed.com");
      expect((err as Error).message).toContain("allowlist.ts");
    }
  });
});

describe("the OS-level twin (Tauri http capability)", () => {
  // One-directional on purpose: api.anthropic.com appears only in the
  // capability file, because the LLM path (src/tauri/llm.ts) never goes
  // through core's http port. But every host core may fetch MUST also be
  // granted at the OS level, or the packaged app fails where dev and tests
  // pass — which is exactly how Adzuna shipped answering "check your
  // internet connection" to a permissions problem.
  it("grants every core-allowlisted host in src-tauri/capabilities/default.json", () => {
    const cap = JSON.parse(
      readFileSync(join(repoRoot, "src-tauri", "capabilities", "default.json"), "utf8"),
    ) as {
      permissions: (string | { identifier: string; allow?: { url: string }[] })[];
    };
    const http = cap.permissions.find(
      (p): p is { identifier: string; allow: { url: string }[] } =>
        typeof p === "object" && p.identifier === "http:default",
    );
    expect(http).toBeDefined();
    const urls = (http?.allow ?? []).map((entry) => entry.url);
    for (const host of ALLOWED_HOSTS) {
      expect(urls).toContain(`https://${host}/**`);
    }
  });

  /**
   * dialog and notification are granted command by command. Taking the
   * defaults would also hand this app a file-READ picker it never opens and
   * thirteen notification commands it never calls — on a machine holding
   * somebody's resume, medical-adjacent by implication.
   *
   * Written as "must not contain the default" rather than an exact list, so
   * adding a genuinely needed command is a one-line change while quietly
   * re-broadening to the whole plugin is a failing test.
   */
  it("keeps dialog and notification narrowed to the commands actually used", () => {
    const cap = JSON.parse(
      readFileSync(join(repoRoot, "src-tauri", "capabilities", "default.json"), "utf8"),
    ) as { permissions: (string | { identifier: string })[] };
    const named = cap.permissions.filter((p): p is string => typeof p === "string");

    expect(named).not.toContain("dialog:default");
    expect(named).not.toContain("notification:default");

    // The three the app really calls: App.tsx asks whether it may notify, asks
    // for permission if not, then notifies. Plus the save dialog behind
    // "Save as" in src/tauri/secrets.ts.
    expect(named).toContain("dialog:allow-save");
    expect(named).toContain("notification:allow-is-permission-granted");
    expect(named).toContain("notification:allow-request-permission");
    expect(named).toContain("notification:allow-notify");
  });
});

describe("buildQuery", () => {
  it("percent-encodes keys and values", () => {
    expect(
      buildQuery([
        ["Keyword", "truck driver"],
        ["HiringPath", "vet;public"],
      ]),
    ).toBe("Keyword=truck%20driver&HiringPath=vet%3Bpublic");
  });
});
