import { useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { RankedJob } from "../../core/types.ts";
import * as repo from "../../core/db/repo.ts";

import { tauriClock } from "../../tauri/clock.ts";
import { db } from "../app/services.ts";
import { runSearchNow } from "../app/searchRunner.ts";
import { ageWords, matchLevel, salaryWords, whyWords } from "../app/format.ts";
import { useAppDispatch, useAppState } from "../app/state.tsx";
import { PrepareDialog } from "./PrepareDialog.tsx";
import { MatchBadge } from "./MatchBadge.tsx";
import { Icon } from "../components/Icon.tsx";
import { RunProgress } from "../components/RunProgress.tsx";
import {
  Banner,
  Button,
  Disclosure,
  EmptyState,
  IconButton,
  ModalShell,
  PrimaryButton,
  QuietButton,
} from "../components/ui.tsx";

/**
 * The Opportunities tab (SPEC §8): one ranked list, one badge, one big button
 * per job. Filters are deliberately minimal: Work-from-home · Federal · Hide
 * fair matches.
 *
 * Built on the design system's opportunities components — JobList, JobCard,
 * MatchBadge, FilterRow — and its copy rulings: every fact is shown even when
 * the posting did not give it, and an absent fact says so in words.
 */

const FILTERS = [
  { id: "remote", label: "Work-from-home only" },
  { id: "federal", label: "Federal jobs only" },
  { id: "strongish", label: "Hide fair matches" },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

export function OpportunitiesTab() {
  const state = useAppState();
  const dispatch = useAppDispatch();

  const [on, setOn] = useState<Record<FilterId, boolean>>({
    remote: false,
    federal: false,
    strongish: false,
  });
  const [preparing, setPreparing] = useState<RankedJob | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [shown, setShown] = useState(25);

  const visible = useMemo(() => {
    if (state.ranked === null) return [];
    return state.ranked.filter((r) => {
      if (state.hidden.has(r.job.id)) return false;
      if (on.remote && r.job.remote !== true) return false;
      if (on.federal && r.job.source !== "usajobs") return false;
      if (on.strongish && matchLevel(r.fitScore) === "fair") return false;
      return true;
    });
  }, [state.ranked, state.hidden, on]);

  const anyFilterOn = on.remote || on.federal || on.strongish;
  const widened = state.lastReport?.widenedBeyondRadius === true;

  return (
    <div className="screen">
      <div className="screen__head">
        <h2 className="screen__title">Jobs for you</h2>
        <PrimaryButton
          icon="refresh"
          disabled={state.searching}
          loading={state.searching}
          onClick={() => void runSearchNow(dispatch)}
        >
          {state.searching ? "Looking now" : "Search now"}
        </PrimaryButton>
      </div>

      {state.searching && (
        <RunProgress
          phase={state.progress.phase}
          firstRun={!state.hasSearched}
          done={state.progress.done}
          total={state.progress.total}
          sources={state.progress.sources}
          remaining={state.progress.remaining}
          onLeave={() => dispatch({ type: "tab", tab: "chat" })}
        />
      )}

      {!state.searching && state.searchStatus !== "" && (
        <Banner tone="caution" title="The job search hit a snag.">
          {state.searchStatus}
        </Banner>
      )}

      {!state.searching && !state.keys.anthropic && state.ranked !== null && (
        <Banner
          tone="info"
          title="Cincinnatus is matching these jobs by reading your resume."
          actions={
            <Button
              size="md"
              icon="key"
              onClick={() => dispatch({ type: "tab", tab: "settings" })}
            >
              Connect the AI brain
            </Button>
          }
        >
          Connect the AI brain and it will also tell you why each job fits you, and
          write your resume and cover letter for the ones you pick.
        </Banner>
      )}

      {widened && !state.searching && (
        <Banner tone="info" title="Cincinnatus looked further out.">
          Only {state.lastReport?.reachable ?? 0} jobs matched close to you, so
          Cincinnatus also looked across the country. Jobs outside your area say so on
          the card.
        </Banner>
      )}

      {state.ranked !== null && (
        <>
          <div className="cn-filters" role="group" aria-label="Narrow the list">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className="cn-filter"
                aria-pressed={on[f.id]}
                onClick={() => setOn({ ...on, [f.id]: !on[f.id] })}
              >
                <span className="cn-filter__check" aria-hidden="true">
                  <Icon name="check" size={16} />
                </span>
                <span>{f.label}</span>
              </button>
            ))}
            <span className="cn-filters__count">
              {visible.length === 1 ? "1 job" : `${visible.length} jobs`}
            </span>
          </div>

          <CoverageNote onGoToChat={() => dispatch({ type: "tab", tab: "chat" })} />
        </>
      )}

      {state.ranked === null && !state.searching && (
        <EmptyState
          icon="work"
          title="No jobs yet."
          actions={
            <PrimaryButton icon="search" onClick={() => void runSearchNow(dispatch)}>
              Look for jobs now
            </PrimaryButton>
          }
        >
          Cincinnatus has not looked yet. The first search takes 10 to 20 minutes,
          because it reads each job on your own computer. After today, searches take
          about a minute.
        </EmptyState>
      )}

      {state.ranked !== null && visible.length === 0 && !state.searching && (
        <EmptyState
          icon="work"
          title={anyFilterOn ? "Nothing matches those filters." : "Nothing here yet."}
          actions={
            anyFilterOn ? (
              <QuietButton
                onClick={() =>
                  setOn({ remote: false, federal: false, strongish: false })
                }
              >
                Turn the filters off
              </QuietButton>
            ) : (
              <PrimaryButton icon="search" onClick={() => void runSearchNow(dispatch)}>
                Look for jobs now
              </PrimaryButton>
            )
          }
        >
          {anyFilterOn
            ? "Try turning a filter off, or search again later — new jobs show up all the time."
            : "New jobs show up all the time. Try looking again later today."}
        </EmptyState>
      )}

      {visible.length > 0 && (
        <ul className="cn-joblist" aria-label="Jobs for you, best fit first">
          {visible.slice(0, shown).map((ranked) => (
            <JobCard
              key={ranked.job.id}
              ranked={ranked}
              expanded={expanded === ranked.job.id}
              onToggle={() =>
                setExpanded(expanded === ranked.job.id ? null : ranked.job.id)
              }
              onPrepare={() => setPreparing(ranked)}
            />
          ))}
        </ul>
      )}

      {visible.length > shown && (
        <div className="row">
          <QuietButton icon="keyboard_arrow_down" onClick={() => setShown(shown + 25)}>
            Show more jobs ({visible.length - shown} left)
          </QuietButton>
        </div>
      )}

      {preparing !== null && (
        <PrepareGate ranked={preparing} onClose={() => setPreparing(null)} />
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------

/**
 * The honest account of what Cincinnatus can and cannot see. A quiet link
 * under the filter row that opens in place — never a banner, never uninvited
 * (guidelines/copy-voice.md).
 */
function CoverageNote({ onGoToChat }: { onGoToChat: () => void }) {
  return (
    <Disclosure summary="Where these jobs come from" className="cn-coverage">
      <div className="cn-coverage__body">
        <p>
          Cincinnatus reads job boards that are open to everyone: USAJobs, and the
          public boards many private employers use. It finds a lot of defense,
          aerospace, public safety and government work, and more of it on the coasts
          than in the middle of the country.
        </p>
        <p>
          Some big employers of veterans — Lockheed Martin, Northrop Grumman, RTX,
          Leidos, Booz Allen, GDIT, USAA, Peraton, CACI and V2X — post through systems
          Cincinnatus is not allowed to read. Their jobs will not show up here.
        </p>
        <p>
          Go to those employers' own career pages yourself, and use Cincinnatus for the
          rest. Paste any job you find anywhere into Chat and Cincinnatus will still
          write your resume and cover letter for it.
        </p>
        <div className="cn-coverage__act">
          <QuietButton size="md" icon="forum" onClick={onGoToChat}>
            Paste a job into Chat
          </QuietButton>
        </div>
      </div>
    </Disclosure>
  );
}

/** A fact the posting did not give is still written out, and says so. */
function Fact({
  icon,
  known,
  value,
  missing,
}: {
  icon: "location_on" | "payments" | "work" | "schedule";
  known: boolean;
  value: string;
  missing: string;
}) {
  return (
    <span className={known ? undefined : "is-unknown"}>
      <Icon name={icon} size={18} />
      {known ? value : missing}
    </span>
  );
}

function JobCard({
  ranked,
  expanded,
  onToggle,
  onPrepare,
}: {
  ranked: RankedJob;
  expanded: boolean;
  onToggle: () => void;
  onPrepare: () => void;
}) {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const { job } = ranked;

  const salary = salaryWords(job);
  const aiConnected = state.keys.anthropic;
  const why =
    !aiConnected || state.profile === null ? null : whyWords(job, state.profile);
  // Restored across launches; one verdict per job; tapping again un-votes.
  const voted = state.feedback.get(job.id) ?? null;

  function vote(verdict: "up" | "down") {
    const now = tauriClock.now();
    if (voted === verdict) {
      dispatch({ type: "feedback", jobId: job.id, verdict: null });
      void repo.removeFeedback(db, job.id, verdict);
      return;
    }
    dispatch({ type: "feedback", jobId: job.id, verdict });
    void (async () => {
      if (voted !== null) await repo.removeFeedback(db, job.id, voted);
      await repo.saveFeedback(db, job.id, verdict, now);
    })();
  }

  function hide() {
    dispatch({ type: "hide_job", jobId: job.id });
    void repo.saveFeedback(db, job.id, "hidden", tauriClock.now());
  }

  const where = `${job.title} at ${job.company}`;

  return (
    <li
      className={["cn-jobcard", expanded && "cn-jobcard--expanded"]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="cn-jobcard__head">
        <div>
          <h3 className="cn-jobcard__title">{job.title}</h3>
          <p className="cn-jobcard__org">{job.company}</p>
        </div>
        <MatchBadge level={matchLevel(ranked.fitScore)} />
      </div>

      <div className="cn-jobcard__meta">
        <Fact
          icon="location_on"
          known={job.location !== null}
          value={`${job.location ?? ""}${ranked.withinReach ? "" : " · outside your area"}`}
          missing="Location not listed"
        />
        <Fact
          icon="payments"
          known={salary !== null}
          value={salary ?? ""}
          missing="Pay not listed"
        />
        {/* Three facts, not two: "Remote", "On site", and the posting saying
            nothing at all. Collapsing the third into either of the others
            would assert something the employer never said. */}
        <Fact
          icon="work"
          known={job.remote !== null}
          value={job.remote === true ? "Remote" : "On site"}
          missing="Remote not listed"
        />
        {/* An estimated date says whose fact it is: with no date on the
            posting, what Cincinnatus knows is when IT first saw the job. */}
        <Fact
          icon="schedule"
          known
          value={
            job.postedAtIsEstimated
              ? `Cincinnatus first saw this ${ageWords(ranked.ageDays)}`
              : `Posted ${ageWords(ranked.ageDays)}`
          }
          missing="Posted date not listed"
        />
        {job.source === "usajobs" && (
          <span>
            <Icon name="check_circle" size={18} />
            Federal — veterans preference
          </span>
        )}
      </div>

      {why !== null && (
        <p className="cn-jobcard__why">
          <Icon name="info" size={20} />
          <span>{why}</span>
        </p>
      )}

      {expanded && (
        <div className="cn-jobcard__detail">
          <h4>What the posting says</h4>
          <p>
            {job.descriptionText.slice(0, 1200)}
            {job.descriptionText.length > 1200 ? "…" : ""}
          </p>
        </div>
      )}

      <div className="cn-jobcard__foot">
        {/* With no AI key there is no Prepare — a disabled primary button is a
            nag drawn permanently. Apply is promoted instead
            (guidelines/matching.md). */}
        {aiConnected ? (
          <>
            <Button
              variant="primary"
              size="md"
              icon="description"
              onClick={onPrepare}
              ariaLabel={`Prepare my application for ${where}`}
            >
              Prepare my application
            </Button>
            <Button
              variant="secondary"
              size="md"
              iconEnd="open_in_new"
              onClick={() => void openUrl(job.url)}
              ariaLabel={`Apply for ${where} on the employer's website`}
            >
              Apply
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            size="md"
            iconEnd="open_in_new"
            onClick={() => void openUrl(job.url)}
            ariaLabel={`Apply for ${where} on the employer's website`}
          >
            Apply
          </Button>
        )}
        <span className="cn-jobcard__spacer" />
        <IconButton
          icon="thumb_up"
          label={`More jobs like ${where}`}
          pressed={voted === "up"}
          onClick={() => vote("up")}
        />
        <IconButton
          icon="thumb_down"
          label={`Fewer jobs like ${where}`}
          pressed={voted === "down"}
          onClick={() => vote("down")}
        />
        <IconButton
          icon="visibility_off"
          label="Hide this job"
          showLabel
          onClick={hide}
        />
        <IconButton
          icon={expanded ? "keyboard_arrow_up" : "keyboard_arrow_down"}
          label={expanded ? `Show less about ${where}` : `Show more about ${where}`}
          onClick={onToggle}
        />
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
      <ModalShell label="One thing first" onClose={onClose}>
        <div className="cn-modal__body">
          <h2 className="cn-modal__title">One thing first</h2>
          <p className="prose">
            To write your application, Cincinnatus needs your resume. Go to the Chat tab
            and use "Look over my resume" — once it has read it, come back and this
            button will work.
          </p>
          <div className="cn-modal__actions">
            <PrimaryButton
              icon="forum"
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
      </ModalShell>
    );
  }

  return <PrepareDialog job={ranked.job} baseResume={state.resume} onClose={onClose} />;
}
