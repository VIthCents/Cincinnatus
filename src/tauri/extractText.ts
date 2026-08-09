import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import mammoth from "mammoth";

/**
 * Resume file → plain text, webview edition — the twin of
 * src/node/extractText.ts with a File instead of a path. pdfjs runs its worker
 * from the bundled asset (never a CDN); mammoth resolves to its browser build
 * under Vite automatically.
 *
 * Error messages are plain sentences: the person hitting them may have
 * exported their resume from a phone app and has no idea what a parse error is.
 */

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export type ResumeFileKind = "pdf" | "docx" | "text";

export interface ExtractedResume {
  readonly text: string;
  readonly kind: ResumeFileKind;
}

async function extractPdf(buffer: ArrayBuffer): Promise<string> {
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer) });
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
    await task.destroy();
  }
}

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

export async function extractResumeFile(file: File): Promise<ExtractedResume> {
  const ext = extension(file.name);

  if (ext === ".pdf") {
    let text: string;
    try {
      text = await extractPdf(await file.arrayBuffer());
    } catch (err) {
      throw new Error(
        `Could not read ${file.name} as a PDF. If it opens fine on your screen, try saving it ` +
          `again from the program that made it, or save it as a Word or text file.`,
        { cause: err },
      );
    }
    if (text.trim() === "") {
      throw new Error(
        `${file.name} looks like a scanned or photographed PDF — there is no text inside it to ` +
          `read. If you have the resume as a Word file or can copy the text out, use that instead.`,
      );
    }
    return { text, kind: "pdf" };
  }

  if (ext === ".doc") {
    throw new Error(
      `${file.name} is an old-style Word file (.doc). Open it in Word and save it as .docx, then try again.`,
    );
  }

  if (ext === ".docx") {
    try {
      const result = await mammoth.extractRawText({
        arrayBuffer: await file.arrayBuffer(),
      });
      return { text: result.value, kind: "docx" };
    } catch (err) {
      throw new Error(
        `Could not read ${file.name} as a Word file. Try opening it in Word and saving it again as .docx.`,
        { cause: err },
      );
    }
  }

  if (ext === ".txt" || ext === ".md" || ext === "") {
    return { text: await file.text(), kind: "text" };
  }

  throw new Error(
    `Cincinnatus can read PDF (.pdf), Word (.docx), and plain text (.txt) resumes. ` +
      `${file.name} is a ${ext} file — save it in one of those formats and try again.`,
  );
}
