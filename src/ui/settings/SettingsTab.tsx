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

import * as repo from "../../core/db/repo.ts";
import { db, validateAnthropicKey, validateUsaJobsKey } from "../app/services.ts";
import { isThemePreference } from "../app/theme.ts";
import { useAppDispatch, useAppState } from "../app/state.tsx";
import { Icon } from "../components/Icon.tsx";
import {
  Banner,
  PrimaryButton,
  QuietButton,
  SelectField,
  SettingsRow,
  TextField,
} from "../components/ui.tsx";

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
    <div className="screen">
      <h2 className="screen__title">Settings</h2>

      <section className="set">
        <h3>AI access key</h3>
        <AiKeySection
          connected={state.keys.anthropic}
          onChanged={(connected) =>
            dispatch({ type: "keys", keys: { ...state.keys, anthropic: connected } })
          }
        />
        {spend !== "" && (
          <p className="set__spend">
            <Icon name="payments" size={22} />
            <span>
              AI used this month: <b>{spend}</b>. This is a rough count kept on your
              computer — the exact bill lives in your Claude Console account.
            </span>
          </p>
        )}
      </section>

      <section className="set">
        <h3>Federal jobs</h3>
        <UsaJobsSection
          connected={state.keys.usajobs}
          onChanged={(connected) =>
            dispatch({ type: "keys", keys: { ...state.keys, usajobs: connected } })
          }
        />
      </section>

      <section className="set">
        <h3>How often to search</h3>
        <SettingsRow
          title="Look for new jobs on a schedule"
          description="Cincinnatus checks on its own while it runs in the tray."
        >
          <SelectField
            label="Search every"
            value={String(interval)}
            onChange={(next) => {
              const hours = Number(next);
              setInterval_(hours);
              void setIntervalHours(db, hours);
            }}
            options={[
              { value: "3", label: "Every 3 hours" },
              { value: "6", label: "Every 6 hours" },
              { value: "12", label: "Every 12 hours" },
              { value: "24", label: "Once a day" },
              { value: "0", label: "Do not search on a schedule" },
            ]}
          />
        </SettingsRow>
      </section>

      <section className="set">
        <h3>How it looks</h3>
        <SettingsRow
          title="Light or dark"
          description="Follows your computer unless you pick one."
        >
          <SelectField
            label="Light or dark"
            value={state.theme}
            onChange={(next) => {
              if (!isThemePreference(next)) return;
              dispatch({ type: "theme", theme: next });
              void repo.setSetting(db, "theme", next);
            }}
            options={[
              { value: "system", label: "Match my computer" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </SettingsRow>
      </section>

      <section className="set">
        <h3>Your data</h3>
        <p className="prose">
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
    <div className="stack">
      {connected ? (
        <Banner tone="success" title="Your key works. You are all set.">
          Paste a new key below to replace it, or remove it.
        </Banner>
      ) : (
        <p className="prose">
          Not connected. The AI helper reads resumes and writes documents. Get a key at{" "}
          <strong>console.anthropic.com</strong> — the developer site, not the Claude
          chat app. A Claude Pro or Max chat plan does not include one.
        </p>
      )}
      <TextField
        label="Paste your key"
        hint="It starts with sk-ant-"
        mono
        value={key}
        onChange={(e) => setKey(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        {...(message !== null && !message.ok ? { error: message.text } : {})}
      />
      {message !== null && message.ok && <Banner tone="success">{message.text}</Banner>}
      <div className="row">
        <PrimaryButton
          icon="key"
          loading={checking}
          disabled={key.trim() === "" || checking}
          onClick={() => void saveKey()}
        >
          {checking ? "Checking" : "Save my key and continue"}
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
    </div>
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
    <div className="stack">
      {connected ? (
        <Banner tone="success" title="Federal jobs are on.">
          Jobs with veterans preference show up in your searches.
        </Banner>
      ) : (
        <p className="prose">
          Free. Unlocks federal jobs, where veterans get hiring preference. Sign up at{" "}
          <strong>developer.usajobs.gov/apirequest</strong> — they email you a key.
        </p>
      )}
      <TextField
        label="USAJobs key"
        mono
        value={key}
        onChange={(e) => setKey(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        {...(message !== null && !message.ok ? { error: message.text } : {})}
      />
      <TextField
        label="The email you signed up with"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      {message !== null && message.ok && <Banner tone="success">{message.text}</Banner>}
      <div className="row">
        <PrimaryButton
          icon="key"
          loading={checking}
          disabled={key.trim() === "" || email.trim() === "" || checking}
          onClick={() => void saveKey()}
        >
          {checking ? "Checking" : "Save my key and continue"}
        </PrimaryButton>
      </div>
    </div>
  );
}
