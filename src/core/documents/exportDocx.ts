import { Document, Packer, Paragraph, TextRun } from "docx";
import type { CoverLetter, ResumeData, ResumeExperience } from "./types.ts";

/**
 * ResumeData → .docx, as a base64 string.
 *
 * Base64 because core cannot touch Buffer (Node) or Blob (DOM); the caller —
 * harness today, the app in Phase 3 — decodes and writes the file. The `docx`
 * package itself is a pure in-memory transform (it builds a zip), which is why
 * it is permitted inside core; see docs/DECISIONS.md.
 *
 * ATS-SAFE means boring on purpose: one column, ordinary paragraphs, a
 * standard font, headings that are just bold text, standard Word bullets. No
 * tables, no text boxes, no columns, no images, no headers/footers — each of
 * those is something a resume-parsing system somewhere mangles. A veteran
 * cannot see the parser reject their resume; boring is the only safe layout.
 */

const BODY_SIZE = 22; // half-points → 11pt
const NAME_SIZE = 32; // 16pt

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** "2015-06" → "Jun 2015" · "2015" → "2015" · "present" → "Present". */
export function formatResumeDate(value: string | null): string {
  if (value === null || value.trim() === "") return "";
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === "present") return "Present";
  const match = /^(\d{4})-(\d{2})$/.exec(trimmed);
  if (match !== null) {
    const month = MONTHS[Number(match[2]) - 1];
    return month === undefined ? trimmed : `${month} ${match[1]}`;
  }
  return trimmed;
}

function heading(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 240, after: 60 },
    children: [new TextRun({ text: text.toUpperCase(), bold: true, size: BODY_SIZE })],
  });
}

function body(
  text: string,
  opts: { bold?: boolean; bullet?: boolean } = {},
): Paragraph {
  return new Paragraph({
    ...(opts.bullet === true ? { bullet: { level: 0 } } : {}),
    spacing: { after: 40 },
    children: [new TextRun({ text, bold: opts.bold ?? false, size: BODY_SIZE })],
  });
}

function experienceParagraphs(exp: ResumeExperience, federal: boolean): Paragraph[] {
  const out: Paragraph[] = [body(`${exp.title} — ${exp.org}`, { bold: true })];

  const dates = [formatResumeDate(exp.start), formatResumeDate(exp.end)]
    .filter((d) => d !== "")
    .join(" – ");
  const meta = [
    dates,
    exp.location ?? "",
    // Hours per week is meaningful on federal resumes, where reviewers use it
    // to compute equivalent experience. Rendered only when the resume states
    // it — never assumed.
    federal && exp.hoursPerWeek !== null ? `${exp.hoursPerWeek} hours per week` : "",
  ].filter((m) => m !== "");
  if (meta.length > 0) out.push(body(meta.join(" · ")));

  for (const bullet of exp.bullets) {
    out.push(body(bullet, { bullet: true }));
  }
  return out;
}

function contactLine(resume: ResumeData): string {
  return [resume.email, resume.phone, resume.location]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ");
}

export async function resumeToDocxBase64(
  resume: ResumeData,
  options: { federal?: boolean } = {},
): Promise<string> {
  const federal = options.federal ?? false;
  const children: Paragraph[] = [];

  children.push(
    new Paragraph({
      children: [new TextRun({ text: resume.name, bold: true, size: NAME_SIZE })],
    }),
  );
  const contact = contactLine(resume);
  if (contact !== "") children.push(body(contact));

  if (resume.summary !== null && resume.summary.trim() !== "") {
    children.push(heading("Summary"));
    children.push(body(resume.summary.trim()));
  }

  if (resume.clearance !== null && resume.clearance.trim() !== "") {
    children.push(body(`Security clearance: ${resume.clearance.trim()}`));
  }

  if (resume.experience.length > 0) {
    children.push(heading("Experience"));
    for (const exp of resume.experience) {
      children.push(...experienceParagraphs(exp, federal));
    }
  }

  if (resume.education.length > 0) {
    children.push(heading("Education"));
    for (const edu of resume.education) {
      const year = edu.year === null || edu.year === "" ? "" : ` (${edu.year})`;
      children.push(body(`${edu.credential}, ${edu.institution}${year}`));
    }
  }

  if (resume.certifications.length > 0) {
    children.push(heading("Certifications"));
    for (const cert of resume.certifications) {
      children.push(body(cert, { bullet: true }));
    }
  }

  if (resume.skills.length > 0) {
    children.push(heading("Skills"));
    children.push(body(resume.skills.join(", ")));
  }

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: "Calibri", size: BODY_SIZE } },
      },
    },
    sections: [{ children }],
  });

  return Packer.toBase64String(doc);
}

export async function coverLetterToDocxBase64(
  letter: CoverLetter,
  resume: ResumeData,
): Promise<string> {
  const children: Paragraph[] = [
    new Paragraph({
      children: [new TextRun({ text: resume.name, bold: true, size: NAME_SIZE })],
    }),
  ];
  const contact = contactLine(resume);
  if (contact !== "") children.push(body(contact));

  children.push(new Paragraph({ spacing: { after: 200 }, children: [] }));
  children.push(body(letter.salutation));
  children.push(new Paragraph({ spacing: { after: 120 }, children: [] }));

  for (const paragraph of letter.bodyParagraphs) {
    children.push(
      new Paragraph({
        spacing: { after: 160 },
        children: [new TextRun({ text: paragraph, size: BODY_SIZE })],
      }),
    );
  }

  children.push(body(letter.closing));
  children.push(body(resume.name));

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: "Calibri", size: BODY_SIZE } },
      },
    },
    sections: [{ children }],
  });

  return Packer.toBase64String(doc);
}
