import { describe, it, expect } from "vitest";
import {
  ALLOWED_HOSTS,
  assertAllowed,
  BlockedHostError,
  buildQuery,
  MalformedUrlError,
} from "../src/core/net/allowlist.ts";

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
