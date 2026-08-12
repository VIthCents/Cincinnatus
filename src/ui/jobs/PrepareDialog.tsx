import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Job } from "../../core/types.ts";
import type {
  CoverLetter,
  ResumeData,
  VerifiedDocument,
} from "../../core/documents/types.ts";
import { tailorResume } from "../../core/documents/tailor.ts";
import { writeCoverLetter } from "../../core/documents/coverletter.ts";

import { llmErrorMessage } from "../../tauri/llm.ts";

import { getLlm } from "../app/services.ts";
import {
  saveLetterDocx,
  saveResumeDocx,
  saveTailoredDocuments,
} from "../documents/actions.ts";
import { FindingsList } from "../documents/FindingsList.tsx";
import { LetterView } from "../documents/LetterView.tsx";
import { ResumeView } from "../documents/ResumeView.tsx";
import { usePrint } from "../documents/print.tsx";
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
 * "Prepare my application" (SPEC §8): tailored resume + cover letter,
 * side-by-side review, entity-check findings as plain confirmations, then
 * Save / Print / Apply. Documents are generated on demand only — never
 * speculatively (SPEC §7: that burns the user's money).
 */

export function PrepareDialog({
  job,
  baseResume,
  onApplyOpened,
  onClose,
}: {
  job: Job;
  baseResume: ResumeData;
  /** Applying from here asks the same "did you apply?" question the card does. */
  onApplyOpened: () => void;
  onClose: () => void;
}) {
  const print = usePrint();
  const federal = job.source === "usajobs";

  const [phase, setPhase] = useState<"working" | "review" | "failed">("working");
  const [error, setError] = useState("");
  const [tailored, setTailored] = useState<VerifiedDocument<ResumeData> | null>(null);
  const [letter, setLetter] = useState<VerifiedDocument<CoverLetter> | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    void (async () => {
      // getLlm() already counts usage toward the monthly spend estimate.
      const llm = await getLlm();
      if (llm === null) {
        setError(
          "Making documents needs the AI helper. Add your AI access key in Settings first.",
        );
        setPhase("failed");
        return;
      }
      try {
        const tailorResult = await tailorResume(llm, baseResume, job);
        setTailored(tailorResult);
        const letterResult = await writeCoverLetter(llm, baseResume, job);
        setLetter(letterResult);
        await saveTailoredDocuments(
          job.id,
          tailorResult.document,
          letterResult.document,
        );
        setPhase("review");
      } catch (err) {
        setError(llmErrorMessage(err));
        setPhase("failed");
      }
    })();
  }, [baseResume, job]);

  const anyHigh =
    (tailored?.findings.some((f) => f.severity === "high") ?? false) ||
    (letter?.findings.some((f) => f.severity === "high") ?? false);

  return (
    <ModalShell
      label={`Prepare application for ${job.title} at ${job.company}`}
      onClose={onClose}
      wide
    >
      <div className="review">
        <div className="review__head">
          <div>
            <h2>
              {job.title} — {job.company}
            </h2>
            {federal && (
              <p className="sub">
                This is a federal job, so the resume uses the federal format: longer and
                more detailed on purpose.
              </p>
            )}
          </div>
          <span className="cn-wizard__spacer" />
          <IconButton icon="close" label="Close" onClick={onClose} />
        </div>

        {phase === "working" && (
          <div className="stack">
            <Busy label="Writing your resume and cover letter for this job…" />
            <p className="prose--muted">
              This takes a minute or two, and uses a few cents of your AI credits.
            </p>
          </div>
        )}

        {phase === "failed" && (
          <div className="stack">
            <Banner tone="error" title="Cincinnatus could not write the documents.">
              {error}
            </Banner>
            <div className="row">
              <QuietButton onClick={onClose}>Close</QuietButton>
            </div>
          </div>
        )}

        {phase === "review" && tailored !== null && letter !== null && (
          <>
            {anyHigh ? (
              <Banner tone="caution" title="Look at the flagged items first.">
                Check them before you use these documents.
              </Banner>
            ) : (
              <Banner tone="success" title="Both documents checked out.">
                Nothing was added that your resume does not back up. Look them over,
                save them, then hit Apply.
              </Banner>
            )}

            {tailored.note !== "" && <p className="prose">{tailored.note}</p>}

            <div className="review__grid">
              <section className="doc">
                <div className="doc__head">
                  <Icon name="description" size={20} />
                  Your resume for this job
                </div>
                <div className="doc__body">
                  <FindingsList findings={tailored.findings} context="derived" />
                  <ResumeView resume={tailored.document} />
                  <div className="row">
                    <PrimaryButton
                      size="md"
                      icon="download"
                      onClick={() => {
                        void saveResumeDocx(tailored.document, {
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
                      onClick={() => print(<ResumeView resume={tailored.document} />)}
                    >
                      Print
                    </QuietButton>
                  </div>
                </div>
              </section>

              <section className="doc">
                <div className="doc__head">
                  <Icon name="description" size={20} />
                  Your cover letter
                </div>
                <div className="doc__body">
                  <FindingsList findings={letter.findings} context="derived" />
                  <LetterView letter={letter.document} resume={baseResume} />
                  <div className="row">
                    <PrimaryButton
                      size="md"
                      icon="download"
                      onClick={() => {
                        void saveLetterDocx(
                          letter.document,
                          baseResume,
                          job.company,
                        ).then((path) => {
                          if (path !== null)
                            setSavedNote(
                              `Your cover letter is saved. Look in ${path}.`,
                            );
                        });
                      }}
                    >
                      Save the letter
                    </PrimaryButton>
                    <QuietButton
                      size="md"
                      icon="print"
                      onClick={() =>
                        print(
                          <LetterView letter={letter.document} resume={baseResume} />,
                        )
                      }
                    >
                      Print
                    </QuietButton>
                  </div>
                </div>
              </section>
            </div>

            {savedNote !== null && <Banner tone="success">{savedNote}</Banner>}

            {/* The human applies. This is constraint 2, drawn. */}
            <div className="row">
              <PrimaryButton
                iconEnd="open_in_new"
                onClick={() => {
                  // The dialog closes behind them: "did you apply?" belongs on
                  // the job card, which is what they come back to.
                  void openUrl(job.url).then(
                    () => {
                      onApplyOpened();
                      onClose();
                    },
                    () => undefined,
                  );
                }}
              >
                Apply — opens the job in your browser
              </PrimaryButton>
              <p className="prose--muted">
                You do the applying. Cincinnatus never sends anything for you.
              </p>
            </div>
          </>
        )}
      </div>
    </ModalShell>
  );
}
