import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { extractResumeText } from "../src/node/extractText.ts";
import { loadDotEnv } from "../src/node/env.ts";
import { resumeToDocxBase64 } from "../src/core/documents/exportDocx.ts";
import type { ResumeData } from "../src/core/documents/types.ts";
import { buildMinimalPdf } from "../scripts/lib/minimalPdf.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "cinc-extract-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("extractResumeText", () => {
  it("reads the committed infantry PDF fixture, jargon intact", async () => {
    const result = await extractResumeText(
      join(repoRoot, "fixtures", "resumes", "infantry.pdf"),
    );
    expect(result.kind).toBe("pdf");
    expect(result.text).toContain("MARCUS T. WEBB");
    expect(result.text).toContain("0311");
    expect(result.text).toContain("Squad Leader");
    // Multi-page: content from the tail of the resume must survive.
    expect(result.text).toContain("PRC-152");
  });

  it("reads plain text as-is", async () => {
    const result = await extractResumeText(
      join(repoRoot, "fixtures", "resumes", "logistics.txt"),
    );
    expect(result.kind).toBe("text");
    expect(result.text).toContain("DANIELLE R. OKAFOR");
    expect(result.text).toContain("88M");
  });

  it("reads a .docx produced by our own exporter (full write→read loop)", async () => {
    const resume: ResumeData = {
      name: "Round Trip",
      email: null,
      phone: null,
      location: null,
      summary: "Testing the whole loop.",
      experience: [],
      education: [],
      certifications: [],
      skills: ["docx"],
      clearance: null,
      militaryCodes: [],
    };
    const path = join(scratch, "roundtrip.docx");
    writeFileSync(path, Buffer.from(await resumeToDocxBase64(resume), "base64"));

    const result = await extractResumeText(path);
    expect(result.kind).toBe("docx");
    expect(result.text).toContain("Round Trip");
    expect(result.text).toContain("Testing the whole loop.");
  });

  it("explains a scanned PDF in plain words", async () => {
    const path = join(scratch, "scanned.pdf");
    writeFileSync(path, buildMinimalPdf([""]));
    await expect(extractResumeText(path)).rejects.toThrow(/scanned or photographed/);
  });

  it("explains unsupported formats and missing files in plain words", async () => {
    const odt = join(scratch, "resume.odt");
    writeFileSync(odt, "not really");
    await expect(extractResumeText(odt)).rejects.toThrow(/PDF .* Word .* plain text/s);

    const doc = join(scratch, "resume.doc");
    writeFileSync(doc, "ancient");
    await expect(extractResumeText(doc)).rejects.toThrow(/old-style Word/);

    await expect(extractResumeText(join(scratch, "nope.txt"))).rejects.toThrow(
      /Could not open/,
    );
  });
});

describe("loadDotEnv", () => {
  it("loads KEY=VALUE, strips quotes, skips comments, never overrides real env", () => {
    const path = join(scratch, ".env");
    writeFileSync(
      path,
      [
        "# a comment",
        "CINC_TEST_PLAIN=hello",
        'CINC_TEST_QUOTED="with spaces"',
        "CINC_TEST_EXISTING=from-file",
        "not-a-valid-line",
      ].join("\n"),
    );

    process.env["CINC_TEST_EXISTING"] = "from-env";
    try {
      loadDotEnv(path);
      expect(process.env["CINC_TEST_PLAIN"]).toBe("hello");
      expect(process.env["CINC_TEST_QUOTED"]).toBe("with spaces");
      expect(process.env["CINC_TEST_EXISTING"]).toBe("from-env");
    } finally {
      delete process.env["CINC_TEST_PLAIN"];
      delete process.env["CINC_TEST_QUOTED"];
      delete process.env["CINC_TEST_EXISTING"];
    }
  });

  it("does nothing when the file does not exist", () => {
    expect(() => loadDotEnv(join(scratch, "no-such-env"))).not.toThrow();
  });
});
