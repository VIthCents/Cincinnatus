import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

import { isScheduledSearchDue } from "../core/app/schedule.ts";
import { tauriClock } from "../tauri/clock.ts";

import { db } from "./app/services.ts";
import { runSearchNow } from "./app/searchRunner.ts";
import { AppProvider, useAppDispatch, useAppState, type Tab } from "./app/state.tsx";
import { PrintProvider } from "./documents/print.tsx";
import { Wizard } from "./wizard/Wizard.tsx";
import { ChatTab } from "./chat/ChatTab.tsx";
import { OpportunitiesTab } from "./jobs/OpportunitiesTab.tsx";
import { SettingsTab } from "./settings/SettingsTab.tsx";
import { Busy } from "./components/ui.tsx";

export default function App() {
  return (
    <AppProvider>
      <PrintProvider>
        <Shell />
      </PrintProvider>
    </AppProvider>
  );
}

async function notifyNewJobs(count: number): Promise<void> {
  if (count <= 0) return;
  let granted = await isPermissionGranted();
  if (!granted) {
    granted = (await requestPermission()) === "granted";
  }
  if (granted) {
    sendNotification({
      title: "Cincinnatus",
      body:
        count === 1
          ? "Found 1 new job that fits you."
          : `Found ${count} new jobs that fit you.`,
    });
  }
}

function Shell() {
  const state = useAppState();
  const dispatch = useAppDispatch();

  // Tray "Search for jobs now" + the Rust scheduler metronome.
  useEffect(() => {
    if (!state.booted || state.needsWizard) return;

    const unlistenSearch = listen("search-now", () => {
      dispatch({ type: "tab", tab: "jobs" });
      void runSearchNow(dispatch, { notify: (n) => void notifyNewJobs(n) });
    });

    const unlistenTick = listen("scheduler-tick", () => {
      void isScheduledSearchDue(db, tauriClock.now()).then((due) => {
        if (due) {
          void runSearchNow(dispatch, { notify: (n) => void notifyNewJobs(n) });
        }
      });
    });

    // On-launch search, if one is due (SPEC §5: every 6 hours + on launch).
    void isScheduledSearchDue(db, tauriClock.now()).then((due) => {
      if (due) void runSearchNow(dispatch);
    });

    return () => {
      void unlistenSearch.then((fn) => fn());
      void unlistenTick.then((fn) => fn());
    };
  }, [state.booted, state.needsWizard, dispatch]);

  if (!state.booted) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <Busy label="Starting up..." />
      </main>
    );
  }

  if (state.needsWizard) {
    return <Wizard />;
  }

  return (
    <div className="flex h-screen flex-col">
      <TabBar />
      <div className="min-h-0 grow overflow-y-auto">
        {state.tab === "chat" && <ChatTab />}
        {state.tab === "jobs" && <OpportunitiesTab />}
        {state.tab === "settings" && <SettingsTab />}
      </div>
    </div>
  );
}

const TABS: { id: Tab; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "jobs", label: "Jobs" },
  { id: "settings", label: "Settings" },
];

function TabBar() {
  const state = useAppState();
  const dispatch = useAppDispatch();

  return (
    <nav
      aria-label="Main sections"
      className="flex items-center gap-1 border-b border-slate-200 px-4 pt-3"
    >
      <span className="mr-4 text-xl font-bold">Cincinnatus</span>
      {TABS.map((tab) => {
        const active = state.tab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            aria-current={active ? "page" : undefined}
            onClick={() => dispatch({ type: "tab", tab: tab.id })}
            className={
              active
                ? "rounded-t-lg border-b-4 border-blue-700 px-5 py-3 text-lg font-semibold text-blue-800"
                : "rounded-t-lg border-b-4 border-transparent px-5 py-3 text-lg text-slate-700 hover:bg-slate-100"
            }
          >
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
