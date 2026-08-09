import { useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { RankedJob } from "../../core/types.ts";
import * as repo from "../../core/db/repo.ts";

import { tauriClock } from "../../tauri/clock.ts";
import { db } from "../app/services.ts";
import { runSearchNow } from "../app/searchRunner.ts";
import {
  ageWords,
  matchLabel,
  matchTone,
  salaryWords,
  whyWords,
} from "../app/format.ts";
import { useAppDispatch, useAppState } from "../app/state.tsx";
import { PrepareDialog } from "./PrepareDialog.tsx";
import { Busy, Notice, PrimaryButton, QuietButton } from "../components/ui.tsx";

/**
 * The Opportunities tab (SPEC §8): one ranked list, one score, one big button
 * per job. Filters are deliberately minimal: Remote only · Federal only ·
 * Hide low matches.
 */

export function OpportunitiesTab() {
  const state = useAppState();
  const dispatch = useAppDispatch();

  const [remoteOnly, setRemoteOnly] = useState(false);
  const [federalOnly, setFederalOnly] = useState(false);
  const [hideWeak, setHideWeak] = useState(false);
  const [preparing, setPreparing] = useState<RankedJob | null>(null);
  const [shown, setShown] = useState(25);

  const visible = useMemo(() => {
    if (state.ranked === null) return [];
    return state.ranked.filter((r) => {
      if (state.hidden.has(r.job.id)) return false;
      if (remoteOnly && r.job.remote !== true) return false;
      if (federalOnly && r.job.source !== "usajobs") return false;
      if (hideWeak && r.fitScore < 25) return false;
      return true;
    });
  }, [state.ranked, state.hidden, remoteOnly, federalOnly, hideWeak]);

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-bold">Jobs for you</h2>
        <PrimaryButton
          disabled={state.searching}
          onClick={() => void runSearchNow(dispatch)}
        >
          {state.searching ? "Searching..." : "Search now"}
        </PrimaryButton>
      </div>

      {state.searching && <Busy label={state.searchStatus || "Searching..."} />}
      {!state.searching && state.searchStatus !== "" && (
        <Notice tone="warn">{state.searchStatus}</Notice>
      )}

      <div className="flex flex-wrap gap-4 text-lg">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className="h-5 w-5"
            checked={remoteOnly}
            onChange={(e) => setRemoteOnly(e.target.checked)}
          />
          Work-from-home only
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className="h-5 w-5"
            checked={federalOnly}
            onChange={(e) => setFederalOnly(e.target.checked)}
          />
          Federal jobs only
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className="h-5 w-5"
            checked={hideWeak}
            onChange={(e) => setHideWeak(e.target.checked)}
          />
          Hide weak matches
        </label>
      </div>

      {state.ranked === null && !state.searching && (
        <Notice>
          No search yet. Hit "Search now" and I'll go look. The first search is the slow
          one — after that they're quick.
        </Notice>
      )}

      {state.ranked !== null && visible.length === 0 && !state.searching && (
        <Notice>
          Nothing matches those filters right now. Try turning a filter off, or search
          again later — new jobs show up all the time.
        </Notice>
      )}

      <ul className="space-y-4">
        {visible.slice(0, shown).map((ranked) => (
          <JobCard
            key={ranked.job.id}
            ranked={ranked}
            onPrepare={() => setPreparing(ranked)}
          />
        ))}
      </ul>

      {visible.length > shown && (
        <QuietButton onClick={() => setShown(shown + 25)}>
          Show more jobs ({visible.length - shown} left)
        </QuietButton>
      )}

      {preparing !== null && (
        <PrepareGate ranked={preparing} onClose={() => setPreparing(null)} />
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------

const TONE_STYLES: Record<ReturnType<typeof matchTone>, string> = {
  strong: "bg-green-100 text-green-900",
  good: "bg-blue-100 text-blue-900",
  weak: "bg-slate-200 text-slate-700",
};

function JobCard({ ranked, onPrepare }: { ranked: RankedJob; onPrepare: () => void }) {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const { job } = ranked;
  const salary = salaryWords(job);
  const why = state.profile === null ? null : whyWords(job, state.profile);
  const [voted, setVoted] = useState<"up" | "down" | null>(null);

  function vote(verdict: "up" | "down") {
    setVoted(verdict);
    void repo.saveFeedback(db, job.id, verdict, tauriClock.now());
  }

  function hide() {
    dispatch({ type: "hide_job", jobId: job.id });
    void repo.saveFeedback(db, job.id, "hidden", tauriClock.now());
  }

  return (
    <li className="rounded-xl border border-slate-200 p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-xl font-semibold">{job.title}</h3>
          <p className="text-lg text-slate-700">
            {job.company}
            {job.location !== null && ` — ${job.location}`}
          </p>
        </div>
        <span
          className={`whitespace-nowrap rounded-full px-3 py-1 text-base font-medium ${TONE_STYLES[matchTone(ranked.fitScore)]}`}
        >
          {matchLabel(ranked.fitScore)}
        </span>
      </div>

      <p className="mt-1 text-base text-slate-600">
        Posted {ageWords(ranked.ageDays)}
        {job.postedAtIsEstimated && " (best guess)"}
        {salary !== null && ` · ${salary}`}
        {job.source === "usajobs" && " · Federal — veterans preference"}
      </p>
      {why !== null && <p className="text-base text-slate-600">{why}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <PrimaryButton onClick={onPrepare}>Prepare my application</PrimaryButton>
        <QuietButton onClick={() => void openUrl(job.url)}>Apply</QuietButton>
        <QuietButton
          aria-label="This job fits me"
          aria-pressed={voted === "up"}
          onClick={() => vote("up")}
        >
          👍
        </QuietButton>
        <QuietButton
          aria-label="This job does not fit me"
          aria-pressed={voted === "down"}
          onClick={() => vote("down")}
        >
          👎
        </QuietButton>
        <QuietButton aria-label="Hide this job" onClick={hide}>
          Hide
        </QuietButton>
      </div>
    </li>
  );
}

/** The prepare button needs a base resume; explain kindly when there is none. */
function PrepareGate({ ranked, onClose }: { ranked: RankedJob; onClose: () => void }) {
  const state = useAppState();
  const dispatch = useAppDispatch();

  if (state.resume === null) {
    return (
      <div
        role="dialog"
        aria-modal="true"
        className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/60 p-4"
      >
        <div className="w-full max-w-lg space-y-4 rounded-xl bg-white p-6 shadow-xl">
          <h2 className="text-2xl font-bold">One thing first</h2>
          <p className="text-lg">
            To write your application, I need your resume. Go to the Chat tab and use
            "Look over my resume" — once I've read it, come back and this button will
            work.
          </p>
          <div className="flex gap-3">
            <PrimaryButton
              onClick={() => {
                onClose();
                dispatch({ type: "tab", tab: "chat" });
              }}
            >
              Go to the chat
            </PrimaryButton>
            <QuietButton onClick={onClose}>Not now</QuietButton>
          </div>
        </div>
      </div>
    );
  }

  return <PrepareDialog job={ranked.job} baseResume={state.resume} onClose={onClose} />;
}
