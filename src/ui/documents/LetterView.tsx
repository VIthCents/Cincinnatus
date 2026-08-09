import type { CoverLetter, ResumeData } from "../../core/documents/types.ts";

export function LetterView({
  letter,
  resume,
}: {
  letter: CoverLetter;
  resume: ResumeData;
}) {
  return (
    <article className="space-y-4 text-base leading-relaxed">
      <header>
        <h3 className="text-2xl font-bold">{resume.name}</h3>
      </header>
      <p>{letter.salutation}</p>
      {letter.bodyParagraphs.map((paragraph, i) => (
        <p key={i}>{paragraph}</p>
      ))}
      <p>
        {letter.closing}
        <br />
        {resume.name}
      </p>
    </article>
  );
}
