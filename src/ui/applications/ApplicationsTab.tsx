import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ApplicationStatus, Job, TrackedApplication } from "../../core/types.ts";
import * as repo from "../../core/db/repo.ts";

import { tauriClock } from "../../tauri/clock.ts";
import { db } from "../app/services.ts";
import { ageWords } from "../app/format.ts";
import { useAppDispatch, useAppState } from "../app/state.tsx";
import { SavedDocuments } from "../documents/SavedDocuments.tsx";
import { STATUS_STEPS, statusWords } from "./status.ts";
import { Icon } from "../components/Icon.tsx";
import {
  Banner,
  Button,
  EmptyState,
  IconButton,
  PrimaryButton,
  QuietButton,
} from "../components/ui.tsx";

/**
 * "My applications": the jobs the veteran said they applied to.
 *
 * A record, not a workflow. It does not chase anyone, does not remind, and
 * makes no AI calls — everything here works with no key connected. Its whole
 * job is to answer "what did I send, and where did it get to?", which is the
 * question the app previously dropped the moment Apply opened a browser.
 *
 * Nothing on this screen is inferred. Every status is one the person set.
 */

const DAY_MS = 86_400_000;

export function ApplicationsTab() {
  const state = useAppState();
  const dispatch = useAppDispatch();

  // Which jobs have a prepared resume or letter on disk. Fetched once per
  // visit — the tab unmounts on a tab switch, so coming back re-reads it and
  // documents prepared in the meantime show up.
  const [withDocuments, setWithDocuments] = useState<ReadonlySet<string>>(new Set());
  const [showing, setShowing] = useState<Job | null>(null);
  const [docsTrouble, setDocsTrouble] = useState(false);

  useEffect(() => {
    // A failure here used to be swallowed, so "See the papers you made" simply
    // never appeared and the person was left believing the app had lost them.
    void repo.listJobIdsWithDocuments(db).then(setWithDocuments, (err: unknown) => {
      console.error(err);
      setDocsTrouble(true);
    });
  }, []);

  const now = tauriClock.now();

  return (
    <div className="screen">
      <div className="screen__head">
        <h2 className="screen__title">Jobs you applied to</h2>
      </div>

      {docsTrouble && state.applications.length > 0 && (
        <Banner tone="caution" title="Cincinnatus could not check for saved papers.">
          Your applications are all here. Leave this tab and come back to try again.
        </Banner>
      )}

      {state.applications.length === 0 ? (
        <EmptyState
          icon="work"
          title="Nothing here yet."
          actions={
            <PrimaryButton
              icon="work"
              onClick={() => dispatch({ type: "tab", tab: "jobs" })}
            >
              Go to your job list
            </PrimaryButton>
          }
        >
          When you apply to a job, Cincinnatus asks if you did. Say yes, and the job
          shows up here so you can keep track of how it is going.
        </EmptyState>
      ) : (
        <ul className="cn-applist" aria-label="Jobs you applied to, newest first">
          {state.applications.map((application) => (
            <ApplicationCard
              key={application.job.id}
              application={application}
              now={now}
              hasDocuments={withDocuments.has(application.job.id)}
              onShowDocuments={() => setShowing(application.job)}
            />
          ))}
        </ul>
      )}

      {showing !== null && (
        <SavedDocuments
          job={showing}
          baseResume={state.resume}
          onClose={() => setShowing(null)}
        />
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------

function ApplicationCard({
  application,
  now,
  hasDocuments,
  onShowDocuments,
}: {
  application: TrackedApplication;
  now: number;
  hasDocuments: boolean;
  onShowDocuments: () => void;
}) {
  const dispatch = useAppDispatch();
  const { job, status } = application;
  const where = `${job.title} at ${job.company}`;

  function setStatus(next: ApplicationStatus) {
    const at = tauriClock.now();
    dispatch({ type: "application_status", jobId: job.id, status: next, now: at });
    // Dispatch first so the tap feels instant, but if the row turned out not to
    // be there, take it off the screen rather than leaving a card that answers
    // to nothing.
    void repo.updateApplicationStatus(db, job.id, next, at).then(
      (moved) => {
        if (!moved) dispatch({ type: "application_removed", jobId: job.id });
      },
      () => dispatch({ type: "application_removed", jobId: job.id }),
    );
  }

  function remove() {
    dispatch({ type: "application_removed", jobId: job.id });
    void repo.deleteApplication(db, job.id);
  }

  return (
    <li className="cn-appcard">
      <div className="cn-appcard__head">
        <div>
          <h3 className="cn-appcard__title">{job.title}</h3>
          <p className="cn-appcard__org">{job.company}</p>
        </div>
        <span className="cn-appcard__status">{statusWords(status)}</span>
      </div>

      <p className="cn-appcard__when">
        <Icon name="schedule" size={18} />
        You applied {ageWords((now - application.appliedAt) / DAY_MS)}.
      </p>

      {/* The same pressed-pill pattern as the job filters, because it is the
          same gesture: one tap, and you can see which one is on. */}
      <div
        className="cn-filters"
        role="group"
        aria-label={`How it is going with ${where}`}
      >
        {STATUS_STEPS.map((step) => (
          <button
            key={step.id}
            type="button"
            className="cn-filter"
            aria-pressed={step.id === status}
            onClick={() => setStatus(step.id)}
          >
            <span className="cn-filter__check" aria-hidden="true">
              <Icon name="check" size={16} />
            </span>
            <span>{step.label}</span>
          </button>
        ))}
      </div>

      <div className="cn-appcard__foot">
        <Button
          variant="secondary"
          size="md"
          iconEnd="open_in_new"
          onClick={() => void openUrl(job.url)}
          // The words on the button have to survive into the accessible name,
          // or someone driving the app by voice can say what they can see and
          // hit nothing (WCAG 2.5.3). The job is named after them because
          // every card has one of these buttons.
          ariaLabel={`See the job — ${where}`}
        >
          See the job
        </Button>
        {hasDocuments && (
          <QuietButton size="md" icon="description" onClick={onShowDocuments}>
            See the papers you made
          </QuietButton>
        )}
        <span className="cn-appcard__spacer" />
        <IconButton
          icon="cancel"
          label={`Take ${where} off this list`}
          showLabel
          onClick={remove}
        />
      </div>
    </li>
  );
}
