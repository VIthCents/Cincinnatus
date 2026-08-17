import { useEffect, useRef, useState } from "react";
import type { Profile } from "../../core/types.ts";
import type { ProgressEvent } from "../../core/ports.ts";
import type { ResumeData } from "../../core/documents/types.ts";
import { parseResume } from "../../core/documents/parseResume.ts";
import {
  locationFromResumeText,
  profileFromResume,
} from "../../core/profile/fromResume.ts";
import * as repo from "../../core/db/repo.ts";

import { extractResumeFile } from "../../tauri/extractText.ts";
import {
  setSecret,
  SECRET_ANTHROPIC_KEY,
  SECRET_USAJOBS_EMAIL,
  SECRET_USAJOBS_KEY,
} from "../../tauri/secrets.ts";
import { tauriClock } from "../../tauri/clock.ts";

import {
  db,
  getLlm,
  hasAdzunaKeys,
  hasUsaJobsKey,
  runSearch,
  validateAnthropicKey,
  validateUsaJobsKey,
} from "../app/services.ts";
import { useAppDispatch, useAppState } from "../app/state.tsx";
import { sourceTroubleWords } from "../app/searchRunner.ts";
import { adoptBaseResume } from "../documents/actions.ts";
import { RunProgress } from "../components/RunProgress.tsx";
import { Mark } from "../components/Mark.tsx";
import { AnthropicKeyGuide, UsaJobsKeyGuide } from "../components/KeyGuides.tsx";
import {
  Banner,
  Busy,
  Notice,
  PrimaryButton,
  QuietButton,
  TextField,
  Toggle,
} from "../components/ui.tsx";
import {
  INITIAL_PROGRESS,
  SearchProgressTracker,
  type SearchProgress,
} from "../../core/app/progress.ts";

/**
 * First-run wizard (SPEC §8): conversational, one thing per screen, every step
 * skippable without shame. All copy at a 6th-grade reading level or below.
 *
 * Slow work never blocks a step change. Reading the resume with the AI takes
 * a minute, so it runs in the background while the person answers the
 * remaining questions — the preferences step waits on it only if they get
 * there first.
 */

type Step = "welcome" | "resume" | "ai_key" | "usajobs" | "preferences" | "search";
type Parsing = "idle" | "working" | "done" | "failed";

export function Wizard() {
  const dispatch = useAppDispatch();
  const appState = useAppState();
  const appKeys = appState.keys;
  const [step, setStep] = useState<Step>("welcome");

  // Carried between steps. A re-run of the wizard (e.g. after a failed first
  // search) starts from whatever is already saved — nobody uploads twice.
  const [resumeText, setResumeText] = useState<string | null>(null);
  const [resumeData, setResumeData] = useState<ResumeData | null>(appState.resume);
  const [parsing, setParsing] = useState<Parsing>(
    appState.resume === null ? "idle" : "done",
  );
  const [haveAiKey, setHaveAiKey] = useState(appKeys.anthropic);

  async function parseInBackground(text: string): Promise<void> {
    try {
      // Via getLlm so the parse counts toward the monthly spend estimate.
      const llm = await getLlm();
      if (llm === null) throw new Error("no key");
      const parsed = await parseResume(llm, text);
      await adoptBaseResume(parsed);
      await repo.setSetting(db, "base_resume_raw_text", text);
      setResumeData(parsed);
      dispatch({ type: "resume", resume: parsed });
      setParsing("done");
    } catch {
      // Not the end of anything: the chat's "Look over my resume" tries again.
      await repo.setSetting(db, "pending_resume_text", text);
      setParsing("failed");
    }
  }

  // Each step change moves keyboard focus to the step container, so a screen
  // reader announces the new screen instead of leaving focus on a button that
  // just disappeared.
  const stepRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    stepRef.current?.focus();
  }, [step]);

  const stepNumber = STEP_ORDER.indexOf(step) + 1;

  return (
    <main className="cn-wizard">
      <header className="cn-wizard__bar">
        <span className="app__mark">
          <Mark />
          <span>CINCINNATUS</span>
        </span>
        <StepProgress step={stepNumber} total={STEP_ORDER.length} />
      </header>

      <div key={step} ref={stepRef} tabIndex={-1} className="cn-wizard__body stack">
        {step === "welcome" && <WelcomeStep onNext={() => setStep("resume")} />}
        {step === "resume" && (
          <ResumeStep
            alreadyHave={resumeData !== null}
            onDone={(text) => {
              setResumeText(text);
              setResumeData(null);
              setStep("ai_key");
            }}
            onSkip={() => setStep("ai_key")}
          />
        )}
        {step === "ai_key" && (
          <AiKeyStep
            alreadyConnected={appKeys.anthropic}
            onDone={async (connected) => {
              setHaveAiKey(connected);
              if (connected && resumeText !== null && resumeData === null) {
                // Move on RIGHT AWAY — the slow part is the parse, and it
                // happens in the background.
                setStep("usajobs");
                setParsing("working");
                void parseInBackground(resumeText);
                return;
              }
              if (!connected && resumeText !== null) {
                // This one is a local SQLite write of a few milliseconds, and
                // the chat tab reads it back. Awaited so the value is there
                // before anything can look, but inside try/finally: a failed
                // write must not strand somebody on this step with no message
                // and no way forward, which is the whole shape of the bug this
                // step used to have on its other path.
                try {
                  await repo.setSetting(db, "pending_resume_text", resumeText);
                } catch (err) {
                  console.error(err);
                }
              }
              setStep("usajobs");
            }}
          />
        )}
        {step === "usajobs" && <UsaJobsStep onDone={() => setStep("preferences")} />}
        {step === "preferences" && (
          <PreferencesStep
            resume={resumeData}
            parsing={parsing}
            onStopWaiting={() => setParsing("failed")}
            onDone={async (profile) => {
              await repo.saveProfile(db, profile, tauriClock.now(), null, null);
              dispatch({ type: "profile", profile });
              dispatch({
                type: "keys",
                keys: {
                  anthropic: haveAiKey || appKeys.anthropic,
                  // Derived from the stored secret, not from a settings flag
                  // that only this wizard ever wrote. The flag was a second
                  // source of truth for the same fact, and Settings never
                  // updated it — connect a key there and the wizard's view of
                  // it was simply wrong.
                  usajobs: await hasUsaJobsKey(),
                  // The wizard never asks for Adzuna; read reality so this
                  // dispatch does not clobber what boot() found.
                  adzuna: await hasAdzunaKeys(),
                },
              });
              setStep("search");
            }}
          />
        )}
        {step === "search" && (
          <FirstSearchStep onAllDone={() => void finish(dispatch)} />
        )}
      </div>
    </main>
  );
}

/**
 * A key that works but will not save. Rare, and worth its own words: the
 * person has done everything right, so the message must not sound like their
 * key was rejected, and it has to point at the way out — Skip is on this same
 * screen and Settings will take the key later.
 */
const KEY_SAVE_FAILED =
  "The key works, but Cincinnatus could not save it on this computer. Try again. If it keeps failing, skip for now — you can add the key later in Settings.";

const USAJOBS_SAVE_FAILED =
  "The key works, but Cincinnatus could not save it on this computer. Try again, or skip for now and add it later in Settings.";

const STEP_ORDER: readonly Step[] = [
  "welcome",
  "resume",
  "ai_key",
  "usajobs",
  "preferences",
  "search",
];

/** Ported from the design system (components/wizard/StepProgress.jsx). */
function StepProgress({ step, total }: { step: number; total: number }) {
  return (
    <div className="cn-steps">
      <span className="cn-steps__label">
        Step {step} of {total}
      </span>
      <span
        className="cn-steps__track"
        role="progressbar"
        aria-valuenow={step}
        aria-valuemin={1}
        aria-valuemax={total}
        aria-label={`Step ${step} of ${total}`}
      >
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={[
              "cn-steps__seg",
              i + 1 < step && "is-done",
              i + 1 === step && "is-current",
            ]
              .filter(Boolean)
              .join(" ")}
          />
        ))}
      </span>
    </div>
  );
}

async function finish(dispatch: ReturnType<typeof useAppDispatch>): Promise<void> {
  await repo.setSetting(db, "wizard_done", "1");
  const profile = await repo.getStoredProfile(db);
  if (profile !== null) dispatch({ type: "wizard_done", profile });
  dispatch({ type: "tab", tab: "jobs" });
}

// -----------------------------------------------------------------------------

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <>
      <h1 className="cn-wizard__title">Welcome. I'm Cincinnatus.</h1>
      <p className="cn-wizard__lede">
        I help veterans find work. Looking for jobs is free.
      </p>
      <p className="cn-wizard__lede">
        Everything you tell me stays on this computer. There is no account for this app
        and nothing to sign up for to use it. I only go online to look for jobs.
      </p>
      <PrimaryButton onClick={onNext} autoFocus>
        Let's get started
      </PrimaryButton>
    </>
  );
}

function ResumeStep({
  alreadyHave,
  onDone,
  onSkip,
}: {
  alreadyHave: boolean;
  onDone: (text: string) => void;
  onSkip: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  if (alreadyHave && !replacing) {
    return (
      <>
        <h1 className="cn-wizard__title">I have your resume</h1>
        <p className="cn-wizard__lede">
          ✓ Your resume is already saved on this computer.
        </p>
        <PrimaryButton onClick={onSkip} autoFocus>
          Keep it and continue
        </PrimaryButton>
        <QuietButton onClick={() => setReplacing(true)}>
          Use a different resume
        </QuietButton>
      </>
    );
  }

  async function handleFile(file: File | undefined) {
    if (file === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const extracted = await extractResumeFile(file);
      onDone(extracted.text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="cn-wizard__title">Do you have a resume?</h1>
      <p className="cn-wizard__lede">
        Any shape is fine — PDF, Word, or plain text. It never leaves this computer
        unless you connect the AI helper later.
      </p>
      <div
        className="cn-drop"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void handleFile(e.dataTransfer.files[0]);
        }}
      >
        {busy ? (
          <Busy label="Reading your resume..." />
        ) : (
          <>
            <p className="prose">Drop your resume here, or</p>
            <PrimaryButton icon="upload_file" onClick={() => inputRef.current?.click()}>
              Choose the file
            </PrimaryButton>
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.docx,.txt,.md"
              hidden
              onChange={(e) => void handleFile(e.target.files?.[0])}
            />
          </>
        )}
      </div>
      {error !== null && (
        <Banner tone="caution" title="Cincinnatus could not read that file.">
          {error}
        </Banner>
      )}
      <QuietButton onClick={onSkip}>I don't have one yet — skip this</QuietButton>
    </>
  );
}

function AiKeyStep({
  alreadyConnected,
  onDone,
}: {
  alreadyConnected: boolean;
  onDone: (connected: boolean) => void;
}) {
  const [key, setKey] = useState("");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function checkAndSave() {
    setChecking(true);
    setResult(null);
    const outcome = await validateAnthropicKey(key.trim());
    if (!outcome.ok) {
      setChecking(false);
      setResult({ ok: false, message: outcome.message });
      return;
    }
    // setChecking(false) used to live after this await and inside the success
    // branch, so a keychain that refused to write left `checking` true forever:
    // the button stayed disabled reading "Checking the key...", nothing was
    // said, and the first-run wizard became a dead end on the person's very
    // first attempt to use the app.
    try {
      await setSecret(SECRET_ANTHROPIC_KEY, key.trim());
    } catch (err) {
      console.error(err);
      setChecking(false);
      setResult({ ok: false, message: KEY_SAVE_FAILED });
      return;
    }
    setChecking(false);
    onDone(true);
  }

  if (alreadyConnected) {
    return (
      <>
        <h1 className="cn-wizard__title">The AI helper is connected</h1>
        <p className="cn-wizard__lede">
          ✓ Your AI access key is already saved. You can change it any time in Settings.
        </p>
        <PrimaryButton onClick={() => onDone(true)} autoFocus>
          Keep it and continue
        </PrimaryButton>
      </>
    );
  }

  return (
    <>
      <h1 className="cn-wizard__title">Connect the AI helper</h1>
      <p className="cn-wizard__lede">
        The AI helper looks over your resume, fixes it with you, and writes documents
        for each job. It costs a little money — you pay Anthropic (the AI company)
        directly, only for what you use. About $5 lasts a long while.
      </p>
      <AnthropicKeyGuide />
      <TextField
        label="Your AI access key"
        hint="It starts with sk-ant-"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      {result !== null && <Notice tone="warn">{result.message}</Notice>}
      <PrimaryButton
        onClick={() => void checkAndSave()}
        disabled={key.trim() === "" || checking}
      >
        {checking ? "Checking the key..." : "Check and save the key"}
      </PrimaryButton>
      <QuietButton onClick={() => onDone(false)}>
        Skip for now — job search works without it
      </QuietButton>
    </>
  );
}

function UsaJobsStep({ onDone }: { onDone: () => void }) {
  const [key, setKey] = useState("");
  const [email, setEmail] = useState("");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function checkAndSave() {
    setChecking(true);
    setResult(null);
    const outcome = await validateUsaJobsKey(key.trim(), email.trim());
    setChecking(false);
    if (!outcome.ok) {
      setResult({ ok: false, message: outcome.message });
      return;
    }
    // No hang here, because setChecking(false) is already above — but the
    // writes were still uncaught inside a void-ed handler, so a keychain
    // failure moved the person on as if their key had been saved. The
    // `usajobs_connected` setting is gone: the stored secret is the one source
    // of truth for whether federal jobs are on.
    try {
      await setSecret(SECRET_USAJOBS_KEY, key.trim());
      await setSecret(SECRET_USAJOBS_EMAIL, email.trim());
    } catch (err) {
      console.error(err);
      setResult({ ok: false, message: USAJOBS_SAVE_FAILED });
      return;
    }
    onDone();
  }

  return (
    <>
      <h1 className="cn-wizard__title">Want federal jobs too?</h1>
      <p className="cn-wizard__lede">
        Federal jobs give hiring preference to veterans. To include them, you need a
        free key from USAJobs — the government's job site. It takes a few minutes and
        costs nothing.
      </p>
      <UsaJobsKeyGuide />
      <TextField
        label="Your USAJobs key"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <TextField
        label="The email you signed up with"
        hint="USAJobs checks that these two match."
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      {result !== null && <Notice tone="warn">{result.message}</Notice>}
      <PrimaryButton
        onClick={() => void checkAndSave()}
        disabled={key.trim() === "" || email.trim() === "" || checking}
      >
        {checking ? "Checking..." : "Check and save"}
      </PrimaryButton>
      <QuietButton onClick={onDone}>Skip for now</QuietButton>
    </>
  );
}

function PreferencesStep({
  resume,
  parsing,
  onStopWaiting,
  onDone,
}: {
  resume: ResumeData | null;
  parsing: Parsing;
  onStopWaiting: () => void;
  onDone: (profile: Profile) => void;
}) {
  const [work, setWork] = useState("");
  const [typedCity, setTypedCity] = useState<string | null>(null);
  const [typedState, setTypedState] = useState<string | null>(null);
  const [remoteOk, setRemoteOk] = useState(true);

  // The address off the resume shows in the boxes, so the person confirms what
  // was found instead of typing it again — and so a resume that states where
  // they live is actually used, with the boxes as the correction.
  //
  // Derived rather than copied into state: the resume arrives while this step
  // is already on screen, and writing it into state on arrival would either
  // fight whatever they had begun typing or need an effect that reaches back
  // and sets state. `null` means "not typed yet", which is what lets an empty
  // box stay empty after they clear one.
  const fromResume = locationFromResumeText(resume?.location ?? null);
  const city = typedCity ?? fromResume?.city ?? "";
  const state = typedState ?? fromResume?.state ?? "";

  const stillReading = parsing === "working" && resume === null;
  const needWorkWords = resume === null && !stillReading;

  function buildProfile(): Profile {
    if (resume !== null) {
      const fromResume = profileFromResume(
        resume,
        new Date(tauriClock.now()).getUTCFullYear(),
      );
      return {
        ...fromResume,
        location:
          city.trim() !== "" && state.trim().length === 2
            ? { city: city.trim(), state: state.trim().toUpperCase() }
            : fromResume.location,
        remotePreference: remoteOk ? "any" : "prefer_onsite",
      };
    }
    return {
      titles: work
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t !== "")
        .slice(0, 5),
      skills: [],
      mocCodes: [],
      branch: null,
      clearance: null,
      education: [],
      yearsExperience: null,
      location:
        city.trim() !== "" && state.trim().length === 2
          ? { city: city.trim(), state: state.trim().toUpperCase() }
          : null,
      radiusMiles: 50,
      remotePreference: remoteOk ? "any" : "prefer_onsite",
      salaryFloor: null,
      excludedKeywords: [],
    };
  }

  const canContinue = !stillReading && (resume !== null || work.trim() !== "");

  return (
    <>
      <h1 className="cn-wizard__title">A few quick questions</h1>
      {resume !== null && (
        <p className="cn-wizard__lede">
          ✓ I read your resume — I'll use it to find work like what you've done. You can
          change anything later in the chat.
        </p>
      )}
      {stillReading && (
        <>
          <Busy label="Still reading your resume — about a minute. You can fill these in meanwhile." />
          <QuietButton onClick={onStopWaiting}>
            Stop waiting — I'll type what I'm looking for instead
          </QuietButton>
        </>
      )}
      {parsing === "failed" && (
        <Notice tone="warn">
          I couldn't finish reading your resume just now. No problem — tell me in a few
          words instead, and I'll try the resume again later in the chat.
        </Notice>
      )}
      {needWorkWords && (
        <TextField
          label="What kind of work are you looking for?"
          hint='A few words is plenty. For example: "truck driver, dispatcher"'
          value={work}
          onChange={(e) => setWork(e.target.value)}
        />
      )}
      <div className="cn-pair">
        <TextField
          label="What city are you near?"
          value={city}
          onChange={(e) => setTypedCity(e.target.value)}
        />
        <TextField
          label="State"
          hint="Like NC"
          value={state}
          maxLength={2}
          onChange={(e) => setTypedState(e.target.value)}
          className="cn-pair__narrow"
        />
      </div>
      <Toggle
        checked={remoteOk}
        onChange={setRemoteOk}
        label="Work-from-home jobs are fine too"
      />
      <div className="row">
        <PrimaryButton
          icon="search"
          onClick={() => onDone(buildProfile())}
          disabled={!canContinue}
        >
          Find my first jobs
        </PrimaryButton>
      </div>
    </>
  );
}

function FirstSearchStep({ onAllDone }: { onAllDone: () => void }) {
  const dispatch = useAppDispatch();
  const [progress, setProgress] = useState<SearchProgress>(INITIAL_PROGRESS);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const startedRef = useRef(false);
  const trackerRef = useRef(new SearchProgressTracker());

  // Kept local as well as dispatched: this step renders its own progress, and
  // reading it straight from the tracker avoids depending on when the reducer
  // flushes.
  function report(event: ProgressEvent) {
    const next = trackerRef.current.apply(event, Date.now());
    setProgress(next);
    dispatch({ type: "search_progress", progress: next });
  }

  async function start() {
    if (startedRef.current) return;
    startedRef.current = true;
    setRunning(true);
    setFailed(null);
    try {
      const profile = await repo.getStoredProfile(db);
      if (profile === null) throw new Error("No profile saved yet.");
      dispatch({ type: "search_start" });
      const { report: runReport, ranked } = await runSearch(profile, report);
      dispatch({
        type: "search_done",
        ranked: [...ranked],
        report: runReport,
        warning: sourceTroubleWords(runReport),
      });
      onAllDone();
    } catch (err) {
      startedRef.current = false;
      setRunning(false);
      trackerRef.current = new SearchProgressTracker();
      setProgress(INITIAL_PROGRESS);
      const message = err instanceof Error ? err.message : String(err);
      setFailed(message);
      dispatch({ type: "search_failed", message });
    }
  }

  return (
    <>
      <h1 className="cn-wizard__title">Your first search</h1>
      <p className="cn-wizard__lede">
        The first one is the slow one: I download a small matching tool (about 23 MB)
        and read every job closely. After this, searches are much faster. You can watch
        it work:
      </p>
      {!running && failed === null && (
        <PrimaryButton onClick={() => void start()} autoFocus>
          Start the search
        </PrimaryButton>
      )}
      {running && (
        <RunProgress
          phase={progress.phase}
          firstRun
          done={progress.done}
          total={progress.total}
          sources={progress.sources}
          remaining={progress.remaining}
        />
      )}
      {failed !== null && (
        <>
          <Notice tone="warn">
            The search hit a problem: {failed}. Your setup is saved — you can try again
            now or later from the Jobs tab.
          </Notice>
          <div className="row">
            <PrimaryButton onClick={() => void start()}>Try again</PrimaryButton>
            <QuietButton onClick={onAllDone}>Go to the app</QuietButton>
          </div>
        </>
      )}
    </>
  );
}
