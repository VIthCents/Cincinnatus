import type { CoverLetter, ResumeData } from "../../core/documents/types.ts";

export function LetterView({
  letter,
  resume,
}: {
  letter: CoverLetter;
  resume: ResumeData;
}) {
  return (
    <article className="paper">
      <header>
        <h3 className="paper__name">{resume.name}</h3>
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
