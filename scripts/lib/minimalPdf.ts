/**
 * Build a minimal, valid, multi-page PDF from lines of text — no library.
 *
 * Exists so the repo can carry a real PDF fixture for the extraction path
 * without committing an opaque binary nobody can regenerate, and so tests can
 * build PDFs on the fly. Hand-rolled because every PDF *writing* library is a
 * heavyweight dependency, and fifty careful lines cover our one need
 * (constraint 7). Validated against pdfjs-dist before being relied on.
 *
 * ASCII/Latin-1 text only, Helvetica, one text column — which is exactly what
 * a resume fixture is.
 */

function pdfEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function buildMinimalPdf(lines: readonly string[], linesPerPage = 48): Buffer {
  const pages: string[][] = [];
  for (let i = 0; i < Math.max(lines.length, 1); i += linesPerPage) {
    pages.push(lines.slice(i, i + linesPerPage) as string[]);
  }

  // Object numbering: 1 Catalog, 2 Pages, 3 Font, then Page+Contents per page.
  interface PdfObject {
    num: number;
    body: string;
  }
  const objects: PdfObject[] = [];
  let next = 4;
  const pageEntries: { pageNum: number; contentNum: number; pageLines: string[] }[] =
    [];
  for (const pageLines of pages) {
    pageEntries.push({ pageNum: next, contentNum: next + 1, pageLines });
    next += 2;
  }

  objects.push({ num: 1, body: `<< /Type /Catalog /Pages 2 0 R >>` });
  objects.push({
    num: 2,
    body: `<< /Type /Pages /Kids [${pageEntries.map((p) => `${p.pageNum} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  });
  objects.push({
    num: 3,
    body: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
  });

  for (const { pageNum, contentNum, pageLines } of pageEntries) {
    const ops = ["BT", "/F1 11 Tf", "14 TL", "50 760 Td"];
    pageLines.forEach((line, i) => {
      if (i > 0) ops.push("T*");
      ops.push(`(${pdfEscape(line)}) Tj`);
    });
    ops.push("ET");
    const stream = ops.join("\n");

    objects.push({
      num: pageNum,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`,
    });
    objects.push({
      num: contentNum,
      body: `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    });
  }

  objects.sort((a, b) => a.num - b.num);

  let out = "%PDF-1.4\n";
  const offsets = new Map<number, number>();
  for (const obj of objects) {
    offsets.set(obj.num, Buffer.byteLength(out, "latin1"));
    out += `${obj.num} 0 obj\n${obj.body}\nendobj\n`;
  }

  const xrefStart = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const obj of objects) {
    out += `${String(offsets.get(obj.num) ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(out, "latin1");
}
