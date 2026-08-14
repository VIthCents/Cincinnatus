import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useState,
  type Dispatch,
  type ReactNode,
} from "react";
import { INITIAL_PROGRESS, type SearchProgress } from "../../core/app/progress.ts";
import { isThemePreference, type ThemePreference } from "./theme.ts";
import type {
  ApplicationStatus,
  Profile,
  RankedJob,
  RunReport,
  TrackedApplication,
} from "../../core/types.ts";
import type { ResumeData } from "../../core/documents/types.ts";
import { verifyResume } from "../../core/documents/verify.ts";
import * as repo from "../../core/db/repo.ts";
import { isAdzunaNudgeDismissed } from "../../core/app/nudge.ts";
import {
  db,
  ensureDbReady,
  hasAdzunaKeys,
  hasAnthropicKey,
  hasUsaJobsKey,
  loadLastRanking,
} from "./services.ts";

/**
 * One reducer, one context. No state library (constraint 7) — the app has a
 * handful of screens and the data flow is: services mutate the database, then
 * dispatch what changed.
 */

export type Tab = "chat" | "jobs" | "applications" | "settings";

export interface ChatEntry {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  /** A structured card rendered under the text, when a flow produced one. */
  readonly card?:
    | { kind: "critique"; critiqueJson: string }
    | { kind: "resume"; resumeJson: string; note: string; findingsJson: string }
    | null;
}

/**
 * What the Opportunities tab needs in order to explain the list it is showing:
 * whether the search had to look beyond the person's area, how many jobs were
 * genuinely nearby, and any plain-words notes about the run.
 *
 * A `RunReport` is assignable to this, which is what lets a finished search
 * hand its whole report over unchanged while a cold start supplies the two
 * facts it can recompute and an empty note list.
 */
export interface WidenSummary {
  readonly widenedBeyondRadius: boolean;
  readonly reachable: number;
  readonly notes: readonly string[];
}

export interface AppState {
  readonly booted: boolean;
  /** Plain-words message when startup failed; "" while fine. */
  readonly bootError: string;
  readonly needsWizard: boolean;
  readonly tab: Tab;
  readonly resume: ResumeData | null;
  readonly profile: Profile | null;
  readonly keys: { anthropic: boolean; usajobs: boolean; adzuna: boolean };
  readonly ranked: readonly RankedJob[] | null;
  /**
   * What the list on screen needs explaining about itself.
   *
   * Narrower than a RunReport on purpose, because it must also be answerable
   * after a restart, when there is no run to report — `loadRankedFromDb`
   * recomputes widening against the current profile, which is a truer answer
   * than replaying a stale run anyway. A full RunReport satisfies this shape,
   * so `search_done` can keep handing one over.
   */
  readonly lastReport: WidenSummary | null;
  readonly searching: boolean;
  /** What the run is doing right now. Only meaningful while `searching`. */
  readonly progress: SearchProgress;
  /** Plain-words message left over from the last run: a warning or an error. */
  readonly searchStatus: string;
  /**
   * False until a search has finished once on this machine. Drives the "the
   * first search takes 10 to 20 minutes" advisory — after that it would be a
   * lie, so it stops being shown.
   */
  readonly hasSearched: boolean;
  /** True once the person has said "no thanks" to the Adzuna offer. Permanent. */
  readonly adzunaNudgeDismissed: boolean;
  readonly hidden: ReadonlySet<string>;
  /** The veteran's saved 👍/👎 per job, restored across launches. */
  readonly feedback: ReadonlyMap<string, "up" | "down">;
  /** The jobs they told us they applied to, newest first. */
  readonly applications: readonly TrackedApplication[];
  readonly chat: readonly ChatEntry[];
  readonly chatBusy: boolean;
  readonly theme: ThemePreference;
}

const initialState: AppState = {
  booted: false,
  bootError: "",
  needsWizard: false,
  tab: "chat",
  resume: null,
  profile: null,
  keys: { anthropic: false, usajobs: false, adzuna: false },
  ranked: null,
  lastReport: null,
  searching: false,
  progress: INITIAL_PROGRESS,
  searchStatus: "",
  hasSearched: false,
  adzunaNudgeDismissed: false,
  hidden: new Set(),
  feedback: new Map(),
  applications: [],
  chat: [],
  chatBusy: false,
  theme: "system",
};

export type Action =
  | {
      type: "booted";
      needsWizard: boolean;
      resume: ResumeData | null;
      profile: Profile | null;
      keys: { anthropic: boolean; usajobs: boolean; adzuna: boolean };
      ranked: readonly RankedJob[] | null;
      lastReport: WidenSummary | null;
      hasSearched: boolean;
      adzunaNudgeDismissed: boolean;
      hidden: ReadonlySet<string>;
      feedback: ReadonlyMap<string, "up" | "down">;
      applications: readonly TrackedApplication[];
      chat: readonly ChatEntry[];
      theme: ThemePreference;
    }
  | { type: "boot_failed"; message: string }
  | { type: "tab"; tab: Tab }
  | { type: "wizard_done"; profile: Profile }
  | { type: "resume"; resume: ResumeData }
  | { type: "profile"; profile: Profile }
  | { type: "keys"; keys: { anthropic: boolean; usajobs: boolean; adzuna: boolean } }
  | { type: "adzuna_nudge_dismissed" }
  | { type: "search_start" }
  | { type: "search_progress"; progress: SearchProgress }
  | { type: "feedback"; jobId: string; verdict: "up" | "down" | null }
  | {
      type: "search_done";
      ranked: readonly RankedJob[];
      report: RunReport;
      warning: string;
    }
  | { type: "search_failed"; message: string }
  | { type: "hide_job"; jobId: string }
  | { type: "applied"; application: TrackedApplication }
  | {
      type: "application_status";
      jobId: string;
      status: ApplicationStatus;
      now: number;
    }
  | { type: "application_removed"; jobId: string }
  | { type: "chat_add"; entry: ChatEntry }
  | { type: "chat_busy"; busy: boolean }
  | { type: "theme"; theme: ThemePreference };

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "booted":
      return {
        ...state,
        booted: true,
        bootError: "",
        needsWizard: action.needsWizard,
        resume: action.resume,
        profile: action.profile,
        keys: action.keys,
        ranked: action.ranked,
        lastReport: action.lastReport,
        hasSearched: action.hasSearched,
        adzunaNudgeDismissed: action.adzunaNudgeDismissed,
        hidden: action.hidden,
        feedback: action.feedback,
        applications: action.applications,
        chat: action.chat,
        theme: action.theme,
      };
    case "boot_failed":
      return { ...state, booted: false, bootError: action.message };
    case "tab":
      return { ...state, tab: action.tab };
    case "wizard_done":
      return { ...state, needsWizard: false, profile: action.profile };
    case "resume":
      return { ...state, resume: action.resume };
    case "profile":
      return { ...state, profile: action.profile };
    case "keys":
      return { ...state, keys: action.keys };
    case "adzuna_nudge_dismissed":
      return { ...state, adzunaNudgeDismissed: true };
    case "search_start":
      return {
        ...state,
        searching: true,
        progress: INITIAL_PROGRESS,
        searchStatus: "",
      };
    case "search_progress":
      return { ...state, progress: action.progress };
    case "search_done":
      return {
        ...state,
        searching: false,
        // A partial or total source failure stays visible after the run.
        searchStatus: action.warning,
        ranked: action.ranked,
        lastReport: action.report,
        hasSearched: true,
      };
    case "search_failed":
      return { ...state, searching: false, searchStatus: action.message };
    case "hide_job": {
      const hidden = new Set(state.hidden);
      hidden.add(action.jobId);
      return { ...state, hidden };
    }
    case "feedback": {
      const feedback = new Map(state.feedback);
      if (action.verdict === null) feedback.delete(action.jobId);
      else feedback.set(action.jobId, action.verdict);
      return { ...state, feedback };
    }
    case "applied": {
      // Mirrors the ON CONFLICT DO NOTHING in repo.saveApplication: confirming
      // again must not reset a job that has since reached "interview".
      const id = action.application.job.id;
      if (state.applications.some((a) => a.job.id === id)) return state;
      return { ...state, applications: [action.application, ...state.applications] };
    }
    case "application_status": {
      const applications = state.applications.map((a) =>
        a.job.id === action.jobId
          ? { ...a, status: action.status, updatedAt: action.now }
          : a,
      );
      return { ...state, applications };
    }
    case "application_removed":
      return {
        ...state,
        applications: state.applications.filter((a) => a.job.id !== action.jobId),
      };
    case "chat_add":
      return { ...state, chat: [...state.chat, action.entry] };
    case "chat_busy":
      return { ...state, chatBusy: action.busy };
    case "theme":
      return { ...state, theme: action.theme };
  }
}

const StateContext = createContext<AppState>(initialState);
const DispatchContext = createContext<Dispatch<Action>>(() => {});

export function useAppState(): AppState {
  return useContext(StateContext);
}

export function useAppDispatch(): Dispatch<Action> {
  return useContext(DispatchContext);
}

/** Everything the app needs before first paint, in one pass. */
async function boot(dispatch: Dispatch<Action>): Promise<void> {
  await ensureDbReady();

  const [
    wizardDone,
    baseResume,
    profile,
    anthropic,
    usajobs,
    adzuna,
    adzunaNudgeDismissed,
    hidden,
    ups,
    downs,
    applications,
    chatRows,
    themeSetting,
  ] = await Promise.all([
    repo.getSetting(db, "wizard_done"),
    repo.getLatestDocument(db, "base_resume"),
    repo.getStoredProfile(db),
    hasAnthropicKey(),
    hasUsaJobsKey(),
    hasAdzunaKeys(),
    isAdzunaNudgeDismissed(db),
    repo.listFeedback(db, "hidden"),
    repo.listFeedback(db, "up"),
    repo.listFeedback(db, "down"),
    repo.listApplications(db),
    repo.listRecentChatMessages(db, 50),
    repo.getSetting(db, "theme"),
  ]);

  const resume =
    baseResume === null ? null : (JSON.parse(baseResume.content) as ResumeData);

  let ranked: readonly RankedJob[] | null = null;
  let lastReport: WidenSummary | null = null;
  // A completed run on record means the jobs are already read and stored, so
  // the next search is the fast kind. That is the whole basis for whether the
  // "first search is slow" advisory is true.
  let hasSearched = false;
  try {
    const last = await loadLastRanking();
    if (last !== null) {
      ranked = last.ranked.ranked;
      // Keep the explanation, not just the list. Without this the "looked
      // further out" banner vanished on restart while the jobs it explains
      // stayed — leaving rows marked "Outside your area" with nothing on
      // screen saying why they were shown at all. No notes: there was no run.
      lastReport = {
        widenedBeyondRadius: last.ranked.widenedBeyondRadius,
        reachable: last.ranked.reachable,
        notes: [],
      };
      hasSearched = true;
    }
  } catch {
    // A failed re-rank must not stop the app from opening.
  }

  // 👎 wins when both were ever recorded; either way one verdict per job.
  const feedback = new Map<string, "up" | "down">();
  for (const id of ups) feedback.set(id, "up");
  for (const id of downs) feedback.set(id, "down");

  // Rebuild document cards for messages that carry one, so a revised resume
  // survives a restart with its buttons intact. Findings are re-computed
  // against the CURRENT base resume — cheap, and more honest than replaying
  // findings from before the base may have changed.
  const chat: ChatEntry[] = [];
  for (const m of chatRows) {
    let card: ChatEntry["card"] = null;
    if (m.relatedDocumentId != null) {
      try {
        const doc = await repo.getDocumentById(db, m.relatedDocumentId);
        if (doc !== null && doc.kind === "final_resume") {
          const docResume = JSON.parse(doc.content) as ResumeData;
          const findings = resume === null ? [] : verifyResume(resume, docResume);
          card = {
            kind: "resume",
            resumeJson: doc.content,
            note: m.content,
            findingsJson: JSON.stringify(findings),
          };
        }
      } catch {
        // A missing document just means no card; the text still reads fine.
      }
    }
    chat.push({ id: m.id, role: m.role, content: m.content, card });
  }

  dispatch({
    type: "booted",
    needsWizard: wizardDone === null,
    resume,
    profile,
    keys: { anthropic, usajobs, adzuna },
    ranked,
    lastReport,
    hasSearched,
    adzunaNudgeDismissed,
    hidden,
    feedback,
    applications,
    chat,
    theme: isThemePreference(themeSetting) ? themeSetting : "system",
  });
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [bootAttempt, setBootAttempt] = useState(0);

  useEffect(() => {
    boot(dispatch).catch((err: unknown) => {
      // Never strand the person on the spinner. Say what happened in plain
      // words and give them a button.
      dispatch({
        type: "boot_failed",
        message:
          "Cincinnatus could not open its saved data. " +
          (err instanceof Error ? err.message : String(err)),
      });
    });
  }, [bootAttempt]);

  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>
        <RetryBootContext.Provider value={() => setBootAttempt((n) => n + 1)}>
          {children}
        </RetryBootContext.Provider>
      </DispatchContext.Provider>
    </StateContext.Provider>
  );
}

const RetryBootContext = createContext<() => void>(() => {});

export function useRetryBoot(): () => void {
  return useContext(RetryBootContext);
}
