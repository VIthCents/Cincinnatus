import { useEffect, useState } from "react";
import type { Job } from "../../core/types.ts";
import type { CoverLetter, Finding, ResumeData } from "../../core/documents/types.ts";
import { verifyCoverLetter, verifyResume } from "../../core/documents/verify.ts";
import * as repo from "../../core/db/repo.ts";

import { db } from "../app/services.ts";
import { saveLetterDocx, saveResumeDocx } from "./actions.ts";
import { FindingsList } from "./FindingsList.tsx";
import { LetterView } from "./LetterView.tsx";
import { ResumeView } from "./ResumeView.tsx";
import { usePrint } from "./print.tsx";
import { Icon } from "../components/Icon.tsx";
import {
  Banner,
  Busy,
  IconButton,
  ModalShell,
  PrimaryButton,
  QuietButton,
} from "../components/ui.tsx";

/**
 * The resume and letter that were prepared for this job, read back from the
 * database exactly as they were saved.
 *
 * Nothing is re-generated: reopening what you already made must never cost the
 * veteran a cent of their own credits (SPEC §7).
 */
export function SavedDocuments({
  job,
  baseResume,
  onClose,
}: {
  job: Job;
  baseResume: ResumeData | null;
  onClose: () => void;
}) {
  const print = usePrint();
  const [loading, setLoading] = useState(true);
  const [resume, setResume] = useState<ResumeData | null>(null);
  const [letter, setLetter] = useState<CoverLetter | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [findings, setFindings] = useState<readonly Finding[]>([]);

  const federal = job.source === "usajobs";

  useEffect(() => {
    void (async () => {
      try {
        const [storedResume, storedLetter] = await Promise.all([
          repo.getLatestDocument(db, "tailored_resume", job.id),
          repo.getLatestDocument(db, "cover_letter", job.id),
        ]);
        const parsedResume =
          storedResume === null
            ? null
            : (JSON.parse(storedResume.content) as ResumeData);
        const parsedLetter =
          storedLetter === null
            ? null
            : (JSON.parse(storedLetter.content) as CoverLetter);
        if (parsedResume !== null) setResume(parsedResume);
        if (parsedLetter !== null) setLetter(parsedLetter);

        // The no-fabrication check, recomputed at the moment a person can
        // actually act on it (constraint 4). Both functions are pure and cheap,
        // and running them here rather than storing findings means papers
        // written ahead of time — by auto-prep, possibly overnight — are
        // checked against the base resume as it stands NOW.
        if (baseResume !== null) {
          const all: Finding[] = [];
          if (parsedResume !== null)
            all.push(...verifyResume(baseResume, parsedResume));
          if (parsedLetter !== null) {
            all.push(...verifyCoverLetter(baseResume, parsedLetter));
          }
          setFindings(all);
        }
      } catch {
        // A document that will not load reads as no document. Nothing is
        // rewritten and nothing is spent to paper over it.
      }
      setLoading(false);
    })();
  }, [job.id, baseResume]);

  return (
    <ModalShell
      label={`What you made for ${job.title} at ${job.company}`}
      onClose={onClose}
      wide
    >
      <div className="review">
        <div className="review__head">
          <div>
            <h2>
              {job.title} — {job.company}
            </h2>
            <p className="sub">These are the papers Cincinnatus made for this job.</p>
          </div>
          <span className="cn-wizard__spacer" />
          <IconButton icon="close" label="Close" onClick={onClose} />
        </div>

        {loading && <Busy label="Getting your papers…" />}

        {!loading && findings.length > 0 && (
          <FindingsList findings={findings} context="derived" />
        )}

        {!loading && resume === null && letter === null && (
          <Banner tone="info" title="Nothing saved for this job.">
            Cincinnatus does not have a resume or letter for this one. You can make them
            from the job list.
          </Banner>
        )}

        {!loading && (resume !== null || letter !== null) && (
          <div className="review__grid">
            {resume !== null && (
              <section className="doc">
                <div className="doc__head">
                  <Icon name="description" size={20} />
                  Your resume for this job
                </div>
                <div className="doc__body">
                  <ResumeView resume={resume} />
                  <div className="row">
                    <PrimaryButton
                      size="md"
                      icon="download"
                      onClick={() => {
                        void saveResumeDocx(resume, {
                          federal,
                          suggestedName: `resume-${job.company.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.docx`,
                        }).then((path) => {
                          if (path !== null)
                            setSavedNote(`Your resume is saved. Look in ${path}.`);
                        });
                      }}
                    >
                      Save the resume
                    </PrimaryButton>
                    <QuietButton
                      size="md"
                      icon="print"
                      onClick={() => print(<ResumeView resume={resume} />)}
                    >
                      Print
                    </QuietButton>
                  </div>
                </div>
              </section>
            )}

            {/* The letter is drawn from the base resume's name and contact
                details, so with no base resume on file there is nothing to
                head it with — better to show only the resume than a letter
                signed by nobody. */}
            {letter !== null && baseResume !== null && (
              <section className="doc">
                <div className="doc__head">
                  <Icon name="description" size={20} />
                  Your cover letter
                </div>
                <div className="doc__body">
                  <LetterView letter={letter} resume={baseResume} />
                  <div className="row">
                    <PrimaryButton
                      size="md"
                      icon="download"
                      onClick={() => {
                        void saveLetterDocx(letter, baseResume, job.company).then(
                          (path) => {
                            if (path !== null)
                              setSavedNote(
                                `Your cover letter is saved. Look in ${path}.`,
                              );
                          },
                        );
                      }}
                    >
                      Save the letter
                    </PrimaryButton>
                    <QuietButton
                      size="md"
                      icon="print"
                      onClick={() =>
                        print(<LetterView letter={letter} resume={baseResume} />)
                      }
                    >
                      Print
                    </QuietButton>
                  </div>
                </div>
              </section>
            )}
          </div>
        )}

        {savedNote !== null && <Banner tone="success">{savedNote}</Banner>}
      </div>
    </ModalShell>
  );
}
