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
import {
  Busy,
  ModalShell,
  Notice,
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
  onClose,
}: {
  job: Job;
  baseResume: ResumeData;
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
      <div>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold">
              {job.title} — {job.company}
            </h2>
            {federal && (
              <p className="text-lg text-slate-600">
                This is a federal job, so the resume uses the federal format: longer and
                more detailed on purpose.
              </p>
            )}
          </div>
          <QuietButton onClick={onClose} aria-label="Close">
            Close
          </QuietButton>
        </div>

        {phase === "working" && (
          <div className="space-y-3 py-10">
            <Busy label="Writing your resume and cover letter for this job..." />
            <p className="text-lg text-slate-600">
              This takes a minute or two, and uses a few cents of your AI credits.
            </p>
          </div>
        )}

        {phase === "failed" && (
          <div className="space-y-4 py-6">
            <Notice tone="warn">{error}</Notice>
            <QuietButton onClick={onClose}>Close</QuietButton>
          </div>
        )}

        {phase === "review" && tailored !== null && letter !== null && (
          <div className="space-y-5">
            {anyHigh ? (
              <Notice tone="warn">
                Look at the flagged items below before you use these documents.
              </Notice>
            ) : (
              <Notice>
                Both documents checked out: nothing was added that your resume does not
                back up. Look them over, save them, then hit Apply.
              </Notice>
            )}

            {tailored.note !== "" && <p className="text-lg">{tailored.note}</p>}

            <div className="grid gap-6 lg:grid-cols-2">
              <section className="space-y-3 rounded-lg border border-slate-200 p-4">
                <h3 className="text-xl font-bold">Your resume for this job</h3>
                <FindingsList findings={tailored.findings} context="derived" />
                <div className="max-h-96 overflow-y-auto">
                  <ResumeView resume={tailored.document} />
                </div>
                <div className="flex flex-wrap gap-2">
                  <PrimaryButton
                    onClick={() => {
                      void saveResumeDocx(tailored.document, {
                        federal,
                        suggestedName: `resume-${job.company.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.docx`,
                      }).then((path) => {
                        if (path !== null) setSavedNote(`Resume saved to ${path}`);
                      });
                    }}
                  >
                    Save the resume
                  </PrimaryButton>
                  <QuietButton
                    onClick={() => print(<ResumeView resume={tailored.document} />)}
                  >
                    Print
                  </QuietButton>
                </div>
              </section>

              <section className="space-y-3 rounded-lg border border-slate-200 p-4">
                <h3 className="text-xl font-bold">Your cover letter</h3>
                <FindingsList findings={letter.findings} context="derived" />
                <div className="max-h-96 overflow-y-auto">
                  <LetterView letter={letter.document} resume={baseResume} />
                </div>
                <div className="flex flex-wrap gap-2">
                  <PrimaryButton
                    onClick={() => {
                      void saveLetterDocx(
                        letter.document,
                        baseResume,
                        job.company,
                      ).then((path) => {
                        if (path !== null)
                          setSavedNote(`Cover letter saved to ${path}`);
                      });
                    }}
                  >
                    Save the letter
                  </PrimaryButton>
                  <QuietButton
                    onClick={() =>
                      print(<LetterView letter={letter.document} resume={baseResume} />)
                    }
                  >
                    Print
                  </QuietButton>
                </div>
              </section>
            </div>

            {savedNote !== null && <Notice>{savedNote}</Notice>}

            <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-4">
              <PrimaryButton onClick={() => void openUrl(job.url)}>
                Apply — opens the job in your browser
              </PrimaryButton>
              <p className="text-base text-slate-600">
                You do the applying. Cincinnatus never sends anything for you.
              </p>
            </div>
          </div>
        )}
      </div>
    </ModalShell>
  );
}
