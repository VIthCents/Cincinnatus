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
import { watchSystemTheme } from "./app/theme.ts";
import {
  AppProvider,
  useAppDispatch,
  useAppState,
  useRetryBoot,
  type Tab,
} from "./app/state.tsx";
import { PrintProvider } from "./documents/print.tsx";
import { Wizard } from "./wizard/Wizard.tsx";
import { ChatTab } from "./chat/ChatTab.tsx";
import { OpportunitiesTab } from "./jobs/OpportunitiesTab.tsx";
import { ApplicationsTab } from "./applications/ApplicationsTab.tsx";
import { SettingsTab } from "./settings/SettingsTab.tsx";
import { Mark } from "./components/Mark.tsx";
import {
  Banner,
  Busy,
  IconButton,
  PrimaryButton,
  QuietButton,
  TabBar,
} from "./components/ui.tsx";

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

  // The design system's dark palette lives behind a `.dark` class on the root
  // element, so something has to put it there — and keep following the
  // computer's own setting while the preference is "system".
  useEffect(() => watchSystemTheme(state.theme), [state.theme]);

  // Tray "Search for jobs now" + the Rust scheduler metronome.
  useEffect(() => {
    // No listener during the wizard or a boot failure, and that is deliberate
    // rather than an oversight: the Rust side raises the window before it emits
    // (see show_main_window in lib.rs), so a tray click during setup puts the
    // wizard in front of the person — which is the screen that explains what to
    // do next. A notice saying "finish setup first" would be telling them what
    // they are already looking at.
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
      <main className="app">
        <div className="screen">
          {state.bootError === "" ? (
            <Busy label="Starting up..." />
          ) : (
            <div className="stack">
              <Banner tone="error" title="Cincinnatus could not open its saved data.">
                {state.bootError}
              </Banner>
              <div className="row">
                <BootRetryButton />
              </div>
            </div>
          )}
        </div>
      </main>
    );
  }

  if (state.needsWizard) {
    return <Wizard />;
  }

  const visibleJobs =
    state.ranked === null
      ? null
      : state.ranked.filter((r) => !state.hidden.has(r.job.id)).length;

  return (
    <div className="app">
      <header className="app__head">
        <span className="app__mark">
          <Mark />
          <span>CINCINNATUS</span>
        </span>
        <MainTabs jobCount={visibleJobs} />
        <IconButton
          icon="settings"
          label="Settings"
          bordered={state.tab === "settings"}
          pressed={state.tab === "settings"}
          onClick={() =>
            dispatch({
              type: "tab",
              tab: state.tab === "settings" ? state.returnTab : "settings",
            })
          }
        />
      </header>

      <main
        className="app__body"
        id={`panel-${state.tab}`}
        role={state.tab === "settings" ? undefined : "tabpanel"}
        aria-labelledby={state.tab === "settings" ? undefined : `tab-${state.tab}`}
        tabIndex={-1}
      >
        {/* The key store was unreadable at startup. The database opened fine
            and the job search works, so this is a notice and not a dead end. */}
        {state.keyStoreTrouble && (
          <Banner
            tone="caution"
            title="Cincinnatus could not check your saved keys."
            actions={
              <QuietButton
                size="md"
                onClick={() => dispatch({ type: "key_trouble_dismissed" })}
              >
                OK
              </QuietButton>
            }
          >
            The job search still works. AI help and federal jobs are off for now. Close
            Cincinnatus and open it again to try once more.
          </Banner>
        )}
        {state.tab === "chat" && <ChatTab />}
        {state.tab === "jobs" && <OpportunitiesTab />}
        {state.tab === "applications" && <ApplicationsTab />}
        {state.tab === "settings" && <SettingsTab />}
      </main>
    </div>
  );
}

function BootRetryButton() {
  const retry = useRetryBoot();
  return (
    <PrimaryButton onClick={retry} autoFocus>
      Try again
    </PrimaryButton>
  );
}

/**
 * Three tabs. SPEC §0 says two, and this is a deliberate departure recorded in
 * DECISIONS.md: what the veteran already sent is not the same list as what
 * they might send next, and folding the two together muddies the one ranked
 * list the Opportunities tab is built around.
 *
 * Settings stays the icon button beside them, not a tab — it is a place you
 * visit, not a place you work.
 */
type MainTab = Extract<Tab, "chat" | "jobs" | "applications">;

function MainTabs({ jobCount }: { jobCount: number | null }) {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const active: MainTab | null = state.tab === "settings" ? null : state.tab;

  return (
    <TabBar<MainTab>
      active={active}
      onChange={(tab) => dispatch({ type: "tab", tab })}
      tabs={[
        { id: "chat", label: "Chat", icon: "forum" },
        { id: "jobs", label: "Opportunities", icon: "work", count: jobCount },
        // No count. How many jobs you applied to is not news you need
        // announced in a badge every time you open the app.
        { id: "applications", label: "My applications", icon: "check_circle" },
      ]}
    />
  );
}
