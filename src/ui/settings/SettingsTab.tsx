import { useEffect, useState } from "react";
import { getMonthSpend, spendInWords } from "../../core/app/spend.ts";
import {
  DEFAULT_INTERVAL_HOURS,
  getIntervalHours,
  setIntervalHours,
} from "../../core/app/schedule.ts";

import {
  SECRET_ANTHROPIC_KEY,
  SECRET_USAJOBS_EMAIL,
  SECRET_USAJOBS_KEY,
  setSecret,
} from "../../tauri/secrets.ts";
import { tauriClock } from "../../tauri/clock.ts";

import { db, validateAnthropicKey, validateUsaJobsKey } from "../app/services.ts";
import { useAppDispatch, useAppState } from "../app/state.tsx";
import { Notice, PrimaryButton, QuietButton, TextField } from "../components/ui.tsx";

/**
 * Settings (SPEC §8): one simple page. Key boxes with live checks, the search
 * schedule, and the plain-language AI spend estimate. Watchlist editing and
 * optional sources arrive with Phase 4 under an Advanced fold.
 */

export function SettingsTab() {
  const state = useAppState();
  const dispatch = useAppDispatch();

  const [spend, setSpend] = useState<string>("");
  const [interval, setInterval_] = useState<number>(DEFAULT_INTERVAL_HOURS);

  useEffect(() => {
    void getMonthSpend(db, tauriClock.now()).then((usd) => setSpend(spendInWords(usd)));
    void getIntervalHours(db).then(setInterval_);
  }, []);

  return (
    <div className="mx-auto max-w-2xl space-y-8 p-6">
      <h2 className="text-2xl font-bold">Settings</h2>

      <AiKeySection
        connected={state.keys.anthropic}
        onChanged={(connected) =>
          dispatch({ type: "keys", keys: { ...state.keys, anthropic: connected } })
        }
      />

      {spend !== "" && (
        <Notice>
          AI used this month: {spend}. This is a rough count kept on your computer — the
          exact bill lives in your Claude Console account.
        </Notice>
      )}

      <UsaJobsSection
        connected={state.keys.usajobs}
        onChanged={(connected) =>
          dispatch({ type: "keys", keys: { ...state.keys, usajobs: connected } })
        }
      />

      <section className="space-y-3">
        <h3 className="text-xl font-bold">How often to search</h3>
        <p className="text-lg text-slate-700">
          Cincinnatus looks for new jobs on its own while it runs in the tray.
        </p>
        <label className="block text-lg">
          <span className="mb-1 block font-medium">Search every</span>
          <select
            className="rounded-lg border border-slate-300 px-4 py-3 text-lg"
            value={interval}
            onChange={(e) => {
              const hours = Number(e.target.value);
              setInterval_(hours);
              void setIntervalHours(db, hours);
            }}
          >
            <option value={3}>3 hours</option>
            <option value={6}>6 hours</option>
            <option value={12}>12 hours</option>
            <option value={24}>day</option>
            <option value={0}>— don't search on a schedule</option>
          </select>
        </label>
      </section>

      <section className="space-y-2">
        <h3 className="text-xl font-bold">Your data</h3>
        <p className="text-lg text-slate-700">
          Your resume, your chats, and every document live only on this computer.
          Nothing is sent anywhere except: job searches go to the job sites, and — only
          if you connected the AI helper — your resume and the one job you pick go to
          Anthropic to write your documents. No tracking, ever.
        </p>
      </section>
    </div>
  );
}

// -----------------------------------------------------------------------------

function AiKeySection({
  connected,
  onChanged,
}: {
  connected: boolean;
  onChanged: (connected: boolean) => void;
}) {
  const [key, setKey] = useState("");
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function saveKey() {
    setChecking(true);
    setMessage(null);
    const outcome = await validateAnthropicKey(key.trim());
    setChecking(false);
    if (outcome.ok) {
      await setSecret(SECRET_ANTHROPIC_KEY, key.trim());
      setMessage({ ok: true, text: "✓ The key works and is saved." });
      setKey("");
      onChanged(true);
    } else {
      setMessage({ ok: false, text: outcome.message });
    }
  }

  return (
    <section className="space-y-3">
      <h3 className="text-xl font-bold">AI access key</h3>
      {connected ? (
        <p className="text-lg text-slate-700">
          ✓ Connected. Paste a new key below to replace it, or remove it.
        </p>
      ) : (
        <p className="text-lg text-slate-700">
          Not connected. The AI helper reads resumes and writes documents. Get a key at{" "}
          <strong>console.anthropic.com</strong> — the developer site, not the Claude
          chat app. A Claude Pro or Max chat plan does not include one.
        </p>
      )}
      <TextField
        label="Paste your key"
        hint="It starts with sk-ant-"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      {message !== null && (
        <Notice tone={message.ok ? "info" : "warn"}>{message.text}</Notice>
      )}
      <div className="flex gap-3">
        <PrimaryButton
          disabled={key.trim() === "" || checking}
          onClick={() => void saveKey()}
        >
          {checking ? "Checking..." : "Check and save"}
        </PrimaryButton>
        {connected && (
          <QuietButton
            onClick={() => {
              void setSecret(SECRET_ANTHROPIC_KEY, "").then(() => {
                setMessage({ ok: true, text: "The key was removed." });
                onChanged(false);
              });
            }}
          >
            Remove the key
          </QuietButton>
        )}
      </div>
    </section>
  );
}

function UsaJobsSection({
  connected,
  onChanged,
}: {
  connected: boolean;
  onChanged: (connected: boolean) => void;
}) {
  const [key, setKey] = useState("");
  const [email, setEmail] = useState("");
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function saveKey() {
    setChecking(true);
    setMessage(null);
    const outcome = await validateUsaJobsKey(key.trim(), email.trim());
    setChecking(false);
    if (outcome.ok) {
      await setSecret(SECRET_USAJOBS_KEY, key.trim());
      await setSecret(SECRET_USAJOBS_EMAIL, email.trim());
      setMessage({ ok: true, text: "✓ Federal jobs are on." });
      setKey("");
      setEmail("");
      onChanged(true);
    } else {
      setMessage({ ok: false, text: outcome.message });
    }
  }

  return (
    <section className="space-y-3">
      <h3 className="text-xl font-bold">Federal jobs (USAJobs key)</h3>
      <p className="text-lg text-slate-700">
        {connected
          ? "✓ Connected. Federal jobs with veterans preference show up in your searches."
          : "Free. Unlocks federal jobs, where veterans get hiring preference. Sign up at developer.usajobs.gov/apirequest — they email you a key."}
      </p>
      <TextField
        label="USAJobs key"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <TextField
        label="The email you signed up with"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      {message !== null && (
        <Notice tone={message.ok ? "info" : "warn"}>{message.text}</Notice>
      )}
      <PrimaryButton
        disabled={key.trim() === "" || email.trim() === "" || checking}
        onClick={() => void saveKey()}
      >
        {checking ? "Checking..." : "Check and save"}
      </PrimaryButton>
    </section>
  );
}
