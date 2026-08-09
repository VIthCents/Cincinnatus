import type { ResumeData } from "../../core/documents/types.ts";
import { formatResumeDate } from "../../core/documents/exportDocx.ts";

/**
 * On-screen (and print) rendering of a structured resume. Mirrors the DOCX
 * template's order so what the user sees is what the file will say.
 */
export function ResumeView({ resume }: { resume: ResumeData }) {
  const contact = [resume.email, resume.phone, resume.location]
    .filter((p): p is string => p !== null && p !== "")
    .join(" · ");

  return (
    <article className="paper">
      <header>
        <h3 className="paper__name">{resume.name}</h3>
        {contact !== "" && <p className="paper__contact">{contact}</p>}
      </header>

      {resume.summary !== null && resume.summary.trim() !== "" && (
        <section>
          <h4>Summary</h4>
          <p>{resume.summary}</p>
        </section>
      )}

      {resume.clearance !== null && (
        <p className="paper__role">Security clearance: {resume.clearance}</p>
      )}

      {resume.experience.length > 0 && (
        <section>
          <h4>Experience</h4>
          <div className="paper__roles">
            {resume.experience.map((exp, i) => {
              const dates = [formatResumeDate(exp.start), formatResumeDate(exp.end)]
                .filter((d) => d !== "")
                .join(" – ");
              const meta = [dates, exp.location ?? ""]
                .filter((m) => m !== "")
                .join(" · ");
              return (
                <div key={`${exp.org}-${exp.title}-${i}`}>
                  <p className="paper__role">
                    {exp.title} — {exp.org}
                  </p>
                  {meta !== "" && <p className="paper__meta">{meta}</p>}
                  <ul>
                    {exp.bullets.map((bullet, j) => (
                      <li key={j}>{bullet}</li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {resume.education.length > 0 && (
        <section>
          <h4>Education</h4>
          <ul>
            {resume.education.map((edu, i) => (
              <li key={i}>
                {edu.credential}, {edu.institution}
                {edu.year !== null && edu.year !== "" ? ` (${edu.year})` : ""}
              </li>
            ))}
          </ul>
        </section>
      )}

      {resume.certifications.length > 0 && (
        <section>
          <h4>Certifications</h4>
          <ul>
            {resume.certifications.map((cert, i) => (
              <li key={i}>{cert}</li>
            ))}
          </ul>
        </section>
      )}

      {resume.skills.length > 0 && (
        <section>
          <h4>Skills</h4>
          <p>{resume.skills.join(", ")}</p>
        </section>
      )}
    </article>
  );
}
