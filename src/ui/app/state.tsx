import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";
import type { Profile, RankedJob, RunReport } from "../../core/types.ts";
import type { ResumeData } from "../../core/documents/types.ts";
import * as repo from "../../core/db/repo.ts";
import {
  db,
  ensureDbReady,
  hasAnthropicKey,
  hasUsaJobsKey,
  loadLastRanking,
} from "./services.ts";

/**
 * One reducer, one context. No state library (constraint 7) — the app has a
 * handful of screens and the data flow is: services mutate the database, then
 * dispatch what changed.
 */

export type Tab = "chat" | "jobs" | "settings";

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

export interface AppState {
  readonly booted: boolean;
  readonly needsWizard: boolean;
  readonly tab: Tab;
  readonly resume: ResumeData | null;
  readonly profile: Profile | null;
  readonly keys: { anthropic: boolean; usajobs: boolean };
  readonly ranked: readonly RankedJob[] | null;
  readonly lastReport: RunReport | null;
  readonly searching: boolean;
  readonly searchStatus: string;
  readonly hidden: ReadonlySet<string>;
  readonly chat: readonly ChatEntry[];
  readonly chatBusy: boolean;
}

const initialState: AppState = {
  booted: false,
  needsWizard: false,
  tab: "chat",
  resume: null,
  profile: null,
  keys: { anthropic: false, usajobs: false },
  ranked: null,
  lastReport: null,
  searching: false,
  searchStatus: "",
  hidden: new Set(),
  chat: [],
  chatBusy: false,
};

export type Action =
  | {
      type: "booted";
      needsWizard: boolean;
      resume: ResumeData | null;
      profile: Profile | null;
      keys: { anthropic: boolean; usajobs: boolean };
      ranked: readonly RankedJob[] | null;
      hidden: ReadonlySet<string>;
      chat: readonly ChatEntry[];
    }
  | { type: "tab"; tab: Tab }
  | { type: "wizard_done"; profile: Profile }
  | { type: "resume"; resume: ResumeData }
  | { type: "profile"; profile: Profile }
  | { type: "keys"; keys: { anthropic: boolean; usajobs: boolean } }
  | { type: "search_start" }
  | { type: "search_status"; message: string }
  | { type: "search_done"; ranked: readonly RankedJob[]; report: RunReport }
  | { type: "search_failed"; message: string }
  | { type: "hide_job"; jobId: string }
  | { type: "chat_add"; entry: ChatEntry }
  | { type: "chat_busy"; busy: boolean };

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "booted":
      return {
        ...state,
        booted: true,
        needsWizard: action.needsWizard,
        resume: action.resume,
        profile: action.profile,
        keys: action.keys,
        ranked: action.ranked,
        hidden: action.hidden,
        chat: action.chat,
      };
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
    case "search_start":
      return { ...state, searching: true, searchStatus: "Starting the search..." };
    case "search_status":
      return { ...state, searchStatus: action.message };
    case "search_done":
      return {
        ...state,
        searching: false,
        searchStatus: "",
        ranked: action.ranked,
        lastReport: action.report,
      };
    case "search_failed":
      return { ...state, searching: false, searchStatus: action.message };
    case "hide_job": {
      const hidden = new Set(state.hidden);
      hidden.add(action.jobId);
      return { ...state, hidden };
    }
    case "chat_add":
      return { ...state, chat: [...state.chat, action.entry] };
    case "chat_busy":
      return { ...state, chatBusy: action.busy };
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

  const [wizardDone, baseResume, profile, anthropic, usajobs, hidden, chatRows] =
    await Promise.all([
      repo.getSetting(db, "wizard_done"),
      repo.getLatestDocument(db, "base_resume"),
      repo.getStoredProfile(db),
      hasAnthropicKey(),
      hasUsaJobsKey(),
      repo.listFeedback(db, "hidden"),
      repo.listRecentChatMessages(db, 50),
    ]);

  let ranked: readonly RankedJob[] | null = null;
  try {
    const last = await loadLastRanking();
    if (last !== null) ranked = last.ranked.ranked;
  } catch {
    // A failed re-rank must not stop the app from opening.
  }

  dispatch({
    type: "booted",
    needsWizard: wizardDone === null,
    resume: baseResume === null ? null : (JSON.parse(baseResume.content) as ResumeData),
    profile,
    keys: { anthropic, usajobs },
    ranked,
    hidden,
    chat: chatRows.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      card: null,
    })),
  });
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    void boot(dispatch);
  }, []);

  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>{children}</DispatchContext.Provider>
    </StateContext.Provider>
  );
}
