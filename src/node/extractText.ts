import { readFileSync } from "node:fs";
import { extname } from "node:path";
import mammoth from "mammoth";

/**
 * Resume file → plain text. PDF via pdfjs-dist (legacy build — the one that
 * runs under Node), DOCX via mammoth, and .txt/.md read directly.
 *
 * Errors are plain sentences: the person hitting them may have exported their
 * resume from a phone app and has no idea what a "parse error" is.
 */

export type ResumeFileKind = "pdf" | "docx" | "text";

export interface ExtractedResume {
  readonly text: string;
  readonly kind: ResumeFileKind;
}

async function extractPdf(buffer: Buffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
  });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .map((item) => ("str" in item ? item.str : ""))
          .filter((s) => s !== "")
          .join("\n"),
      );
    }
    return pages.join("\n\n");
  } finally {
    // In pdfjs 6 the destroy lives on the loading task, not the document.
    await task.destroy();
  }
}

export async function extractResumeText(path: string): Promise<ExtractedResume> {
  const ext = extname(path).toLowerCase();

  let buffer: Buffer;
  try {
    buffer = readFileSync(path);
  } catch {
    throw new Error(`Could not open ${path}. Check the file name and try again.`);
  }

  if (ext === ".pdf") {
    try {
      const text = await extractPdf(buffer);
      if (text.trim() === "") {
        throw new Error("scanned");
      }
      return { text, kind: "pdf" };
    } catch (err) {
      if (err instanceof Error && err.message === "scanned") {
        throw new Error(
          `${path} looks like a scanned or photographed PDF — there is no text inside it to read. ` +
            `If you have the resume as a Word file or can copy the text out, use that instead.`,
          { cause: err },
        );
      }
      throw new Error(
        `Could not read ${path} as a PDF. If it opens fine on your screen, try saving it again ` +
          `from the program that made it, or save it as a Word or text file.`,
        { cause: err },
      );
    }
  }

  if (ext === ".docx" || ext === ".doc") {
    if (ext === ".doc") {
      throw new Error(
        `${path} is an old-style Word file (.doc). Open it in Word and save it as .docx, then try again.`,
      );
    }
    try {
      const result = await mammoth.extractRawText({ buffer });
      return { text: result.value, kind: "docx" };
    } catch (err) {
      throw new Error(
        `Could not read ${path} as a Word file. Try opening it in Word and saving it again as .docx.`,
        { cause: err },
      );
    }
  }

  if (ext === ".txt" || ext === ".md" || ext === "") {
    return { text: buffer.toString("utf8"), kind: "text" };
  }

  throw new Error(
    `Cincinnatus can read PDF (.pdf), Word (.docx), and plain text (.txt) resumes. ` +
      `${path} is a ${ext} file — save it in one of those formats and try again.`,
  );
}
