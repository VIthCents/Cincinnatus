import { describe, it, expect } from "vitest";
import { plainErrorWords } from "../src/ui/app/errorWords.ts";

/**
 * The sanitiser that stands between a thrown thing and someone who should
 * never have to read one.
 */
describe("plainErrorWords", () => {
  it("turns a Tauri permission failure into something actionable", () => {
    // The exact shape that shipped: Adzuna was missing from the capability
    // file, and this string went on screen inside "The search hit a problem: ".
    const words = plainErrorWords(
      new Error(
        "http.fetch not allowed. Permissions associated with this command: http:default",
      ),
    );
    expect(words).toMatch(/blocked from doing part of its work/);
    expect(words).not.toMatch(/http\.fetch|http:default/);
  });

  it("turns a network failure into a sentence about the internet", () => {
    expect(plainErrorWords(new Error("getaddrinfo ENOTFOUND api.adzuna.com"))).toMatch(
      /could not reach the internet/,
    );
  });

  it("recognises the keychain's own wording", () => {
    expect(
      plainErrorWords(
        new Error("could not read the key: platform secure storage error"),
      ),
    ).toMatch(/place where this computer keeps keys/);
  });

  it("keeps a sentence the app already wrote carefully", () => {
    // extractResumeFile, getEmbedder and friends throw plain sentences on
    // purpose. Replacing those with a generic line would be a regression.
    const curated = "That PDF has no text in it. It may be a scan or a photo.";
    expect(plainErrorWords(new Error(curated))).toBe(curated);
  });

  it("redacts credentials from anything it passes through", () => {
    const leaky = "Adzuna refused the request for app_key=abc123secret.";
    expect(plainErrorWords(new Error(leaky))).not.toContain("abc123secret");
  });

  it("falls back rather than showing a stack trace or an error class", () => {
    expect(plainErrorWords(new TypeError("Cannot read properties of undefined"))).toBe(
      "Something went wrong inside the app.",
    );
    expect(plainErrorWords("at Object.<anonymous> (/app/index.js:1:1)")).toBe(
      "Something went wrong inside the app.",
    );
    expect(plainErrorWords({ weird: true })).toBe(
      "Something went wrong inside the app.",
    );
  });

  it("does not pass through a URL even inside a tidy sentence", () => {
    expect(plainErrorWords(new Error("Failed to load https://example.test/x."))).toBe(
      "Something went wrong inside the app.",
    );
  });
});
