import type { CoverLetter, ResumeData } from "../../core/documents/types.ts";
import {
  coverLetterToDocxBase64,
  resumeToDocxBase64,
} from "../../core/documents/exportDocx.ts";
import * as repo from "../../core/db/repo.ts";
import { db } from "../app/services.ts";
import { tauriClock, tauriHasher } from "../../tauri/clock.ts";
import { saveFileAs } from "../../tauri/secrets.ts";

/** Document plumbing shared by chat cards, the prepare flow, and the wizard. */

function fileSafe(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "document"
  );
}

/** Returns the saved path, or null if the user cancelled the dialog. */
export async function saveResumeDocx(
  resume: ResumeData,
  options: { federal?: boolean; suggestedName?: string } = {},
): Promise<string | null> {
  const base64 = await resumeToDocxBase64(resume, {
    federal: options.federal ?? false,
  });
  const name = options.suggestedName ?? `resume-${fileSafe(resume.name)}.docx`;
  return saveFileAs(name, base64);
}

export async function saveLetterDocx(
  letter: CoverLetter,
  resume: ResumeData,
  company: string,
): Promise<string | null> {
  const base64 = await coverLetterToDocxBase64(letter, resume);
  return saveFileAs(`cover-letter-${fileSafe(company)}.docx`, base64);
}

/** Make this the veteran's base resume — the source of truth for everything. */
export async function adoptBaseResume(resume: ResumeData): Promise<void> {
  const now = tauriClock.now();
  await repo.saveDocument(
    db,
    {
      id: tauriHasher.sha256Hex(`base_resume:${now}:${resume.name}`),
      kind: "base_resume",
      jobId: null,
      content: JSON.stringify(resume),
    },
    now,
  );
}

export async function saveTailoredDocuments(
  jobId: string,
  resume: ResumeData,
  letter: CoverLetter | null,
): Promise<void> {
  const now = tauriClock.now();
  await repo.saveDocument(
    db,
    {
      id: tauriHasher.sha256Hex(`tailored:${jobId}:${now}`),
      kind: "tailored_resume",
      jobId,
      content: JSON.stringify(resume),
    },
    now,
  );
  if (letter !== null) {
    await repo.saveDocument(
      db,
      {
        id: tauriHasher.sha256Hex(`letter:${jobId}:${now}`),
        kind: "cover_letter",
        jobId,
        content: JSON.stringify(letter),
      },
      now,
    );
  }
}
