import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { getMonthSpend, spendInWords } from "../../core/app/spend.ts";
import { quotaStatus, quotaWords } from "../../core/app/quota.ts";
import { ADZUNA_QUOTA } from "../../core/config.ts";
import {
  DEFAULT_INTERVAL_HOURS,
  getIntervalHours,
  setIntervalHours,
} from "../../core/app/schedule.ts";

import {
  SECRET_ANTHROPIC_KEY,
  SECRET_USAJOBS_EMAIL,
  SECRET_USAJOBS_KEY,
  SECRET_ADZUNA_APP_ID,
  SECRET_ADZUNA_APP_KEY,
  setSecret,
} from "../../tauri/secrets.ts";
import { tauriClock } from "../../tauri/clock.ts";

import * as repo from "../../core/db/repo.ts";
import {
  db,
  validateAdzunaKeys,
  validateAnthropicKey,
  validateUsaJobsKey,
} from "../app/services.ts";
import { consumeSectionJump } from "../app/jump.ts";
import { isThemePreference } from "../app/theme.ts";
import { useAppDispatch, useAppState } from "../app/state.tsx";
import { Icon } from "../components/Icon.tsx";
import {
  Banner,
  Button,
  Disclosure,
  PrimaryButton,
  SelectField,
  SettingsRow,
  TextField,
} from "../components/ui.tsx";

/**
 * Settings (SPEC §8): one simple page. Key boxes with live checks, the search
 * schedule, and the plain-language AI spend estimate.
 *
 * Optional sources are here (USAJobs, Adzuna). Watchlist editing is not built:
 * SPEC §8 puts it under an Advanced fold, and adding or removing a board needs
 * paste-time validation to be usable at all — a wrong slug has to fail in front
 * of the person, the way every key box here does, not silently return nothing
 * on the next search. Recorded in DECISIONS.md rather than left as a promise.
 */

/**
 * What went wrong when saving or removing a key, in plain words.
 *
 * Every one of these paths used to fail silently: an unguarded `await` inside a
 * `void`-ed handler, or a `.then()` with no rejection branch. A keychain that
 * refused to write produced no banner, no error, no spinner — the key stayed in
 * the box and nothing at all happened, which is indistinguishable from not
 * having pressed the button.
 */
const SAVE_FAILED =
  "The key checks out, but Cincinnatus could not save it on this computer. Try again in a moment.";
const REMOVE_FAILED = "Cincinnatus could not remove the key. Try again in a moment.";
const REMOVE_NUMBERS_FAILED =
  "Cincinnatus could not remove the numbers. Try again in a moment.";

function Trouble({ text }: { text: string | null }) {
  if (text === null) return null;
  return (
    <Banner tone="caution" title="That did not work.">
      {text}
    </Banner>
  );
}

export function SettingsTab() {
  const state = useAppState();
  const dispatch = useAppDispatch();

  const [spend, setSpend] = useState<string>("");
  const [interval, setInterval_] = useState<number>(DEFAULT_INTERVAL_HOURS);

  useEffect(() => {
    void getMonthSpend(db, tauriClock.now()).then((usd) => setSpend(spendInWords(usd)));
    void getIntervalHours(db).then(setInterval_);
  }, []);

  useEffect(() => {
    // Another screen may have asked for a specific section — the "Show me
    // how" button on the Jobs tab does. Runs after mount because switching
    // tabs remounts this whole panel. Focus, not just scroll, so a screen
    // reader announces where the jump landed (same reasoning as the wizard's
    // step focus).
    const id = consumeSectionJump();
    if (id === null) return;
    const el = document.getElementById(id);
    if (el === null) return;
    el.scrollIntoView({ block: "start" });
    el.focus();
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
              computer — the exact bill is in the account where you made your key, at
              console.anthropic.com.
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

      <section className="set" id="more-jobs" tabIndex={-1}>
        <h3>More job listings</h3>
        <AdzunaSection
          connected={state.keys.adzuna}
          onChanged={(connected) =>
            dispatch({ type: "keys", keys: { ...state.keys, adzuna: connected } })
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
          Anthropic to write your documents.
        </p>
        <p className="prose">
          Cincinnatus does not track you and never sends anyone your details. One thing
          worth knowing: if you turned on more job listings, tapping Apply on one of
          those opens it on Adzuna first, and Adzuna counts that tap. That is how they
          pay for letting us list their jobs.
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
  const [trouble, setTrouble] = useState<string | null>(null);

  async function saveKey() {
    setChecking(true);
    setMessage(null);
    setTrouble(null);
    const outcome = await validateAnthropicKey(key.trim());
    setChecking(false);
    if (!outcome.ok) {
      setMessage({ ok: false, text: outcome.message });
      return;
    }
    try {
      await setSecret(SECRET_ANTHROPIC_KEY, key.trim());
    } catch (err) {
      console.error(err);
      setTrouble(SAVE_FAILED);
      return;
    }
    setMessage({ ok: true, text: "✓ The key works and is saved." });
    setKey("");
    onChanged(true);
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
          <button
            type="button"
            className="cn-jobcard__vialink"
            onClick={() => void openUrl("https://console.anthropic.com/")}
          >
            console.anthropic.com
          </button>{" "}
          — the developer site, not the Claude chat app. A Claude Pro or Max chat plan
          does not include one.
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
      <Trouble text={trouble} />
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
          <Button
            variant="destructive"
            size="md"
            onClick={() => {
              setTrouble(null);
              void setSecret(SECRET_ANTHROPIC_KEY, "").then(
                () => {
                  setMessage({ ok: true, text: "The key was removed." });
                  onChanged(false);
                },
                (err: unknown) => {
                  console.error(err);
                  setTrouble(REMOVE_FAILED);
                },
              );
            }}
          >
            Remove the key
          </Button>
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
  const [trouble, setTrouble] = useState<string | null>(null);

  async function saveKey() {
    setChecking(true);
    setMessage(null);
    setTrouble(null);
    const outcome = await validateUsaJobsKey(key.trim(), email.trim());
    setChecking(false);
    if (!outcome.ok) {
      setMessage({ ok: false, text: outcome.message });
      return;
    }
    try {
      await setSecret(SECRET_USAJOBS_KEY, key.trim());
      await setSecret(SECRET_USAJOBS_EMAIL, email.trim());
    } catch (err) {
      console.error(err);
      setTrouble(SAVE_FAILED);
      return;
    }
    setMessage({ ok: true, text: "✓ Federal jobs are on." });
    setKey("");
    setEmail("");
    onChanged(true);
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
          <button
            type="button"
            className="cn-jobcard__vialink"
            onClick={() => void openUrl("https://developer.usajobs.gov/apirequest/")}
          >
            developer.usajobs.gov/apirequest
          </button>{" "}
          — they email you a key.
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
      <Trouble text={trouble} />
      <div className="row">
        <PrimaryButton
          icon="key"
          loading={checking}
          disabled={key.trim() === "" || email.trim() === "" || checking}
          onClick={() => void saveKey()}
        >
          {checking ? "Checking" : "Save my key and continue"}
        </PrimaryButton>
        {/* The AI key and Adzuna both offered removal and this did not, so a
            wrong key here could not be undone from the interface at all. */}
        {connected && (
          <Button
            variant="destructive"
            size="md"
            onClick={() => {
              setTrouble(null);
              void Promise.all([
                setSecret(SECRET_USAJOBS_KEY, ""),
                setSecret(SECRET_USAJOBS_EMAIL, ""),
              ]).then(
                () => {
                  setMessage({
                    ok: true,
                    text: "The key was removed. Federal jobs are off.",
                  });
                  onChanged(false);
                },
                (err: unknown) => {
                  console.error(err);
                  setTrouble(REMOVE_FAILED);
                },
              );
            }}
          >
            Remove the key
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Adzuna is the source that reaches the trades — driving, warehouse,
 * maintenance — that employer job boards almost never carry. Measured on a real
 * corpus: a CDL driver near Fayetteville had almost nothing to apply to from
 * the employer boards alone, and one Adzuna search found nearly two thousand
 * driving jobs within an hour of her.
 *
 * It is deliberately NOT in the first-run wizard. That already sends people to
 * one developer website for the AI key; sending them to a second before they
 * have seen a single job is where people give up. This lives here, and the
 * numbered steps name the exact dropdown option, because picking the wrong one
 * puts the account on a 14-day trial that expires without telling anyone.
 */
function AdzunaSection({
  connected,
  onChanged,
}: {
  connected: boolean;
  onChanged: (connected: boolean) => void;
}) {
  const [appId, setAppId] = useState("");
  const [appKey, setAppKey] = useState("");
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [quotaNote, setQuotaNote] = useState<string | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);

  useEffect(() => {
    // Adzuna has a daily and monthly ceiling. On a day the ledger is spent,
    // "More job listings are on" would be a lie — say what the harness says
    // instead: which limit was hit and when it comes back.
    //
    // Nothing is cleared here when disconnected: the note is rendered behind
    // `connected` anyway, and clearing it synchronously inside the effect makes
    // React re-render twice for a value nobody can see.
    if (!connected) return;

    let cancelled = false;
    void quotaStatus(db, "adzuna", ADZUNA_QUOTA, tauriClock.now()).then((quota) => {
      if (cancelled) return;
      setQuotaNote(quota.exhausted === null ? null : quotaWords(quota.exhausted));
    });
    return () => {
      cancelled = true;
    };
  }, [connected]);

  async function save() {
    setChecking(true);
    setMessage(null);
    setTrouble(null);
    const outcome = await validateAdzunaKeys(appId.trim(), appKey.trim());
    setChecking(false);
    if (!outcome.ok) {
      setMessage({ ok: false, text: outcome.message });
      return;
    }
    try {
      await setSecret(SECRET_ADZUNA_APP_ID, appId.trim());
      await setSecret(SECRET_ADZUNA_APP_KEY, appKey.trim());
    } catch (err) {
      console.error(err);
      setTrouble(SAVE_FAILED);
      return;
    }
    setMessage({
      ok: true,
      text: "That worked. You will see more jobs from now on.",
    });
    setAppId("");
    setAppKey("");
    onChanged(true);
  }

  return (
    <div className="stack">
      {connected && quotaNote !== null ? (
        <Banner tone="info" title="Taking a short break.">
          {quotaNote}
        </Banner>
      ) : connected ? (
        <Banner tone="success" title="More job listings are on.">
          You are seeing driving, warehouse and trades jobs as well as the ones from
          company job boards.
        </Banner>
      ) : (
        <p className="prose">
          Free, and worth doing. Company job boards carry a lot of office and
          engineering work. This adds driving, warehouse, maintenance and trades jobs
          near you.
        </p>
      )}

      <Disclosure
        summary="How to get these numbers (about 5 minutes)"
        defaultOpen={!connected}
      >
        <ol className="cn-guide">
          <li>
            Go to{" "}
            <button
              type="button"
              className="cn-jobcard__vialink"
              onClick={() => void openUrl("https://developer.adzuna.com/signup")}
            >
              developer.adzuna.com/signup
            </button>{" "}
            and fill in your name and email.
          </li>
          <li>
            Where it asks what you are building, choose{" "}
            <strong>Publishing Adzuna ad listings</strong>. This matters — the other
            choices stop working after two weeks.
          </li>
          <li>
            If it asks for a website and you do not have one, put{" "}
            <strong>https://github.com/VIthCents/Cincinnatus</strong>.
          </li>
          <li>Check your email and click the link they send you.</li>
          <li>
            You land on a page called <strong>Dashboard</strong>. Copy the two things it
            shows you into the boxes below. The Application ID is short. The Application
            Key is long.
          </li>
        </ol>
      </Disclosure>

      <TextField
        label="Application ID"
        hint="The short one, about 8 characters"
        mono
        value={appId}
        onChange={(e) => setAppId(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <TextField
        label="Application Key"
        hint="The long one, about 32 characters"
        mono
        value={appKey}
        onChange={(e) => setAppKey(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        {...(message !== null && !message.ok ? { error: message.text } : {})}
      />
      {message !== null && message.ok && <Banner tone="success">{message.text}</Banner>}
      <Trouble text={trouble} />
      <div className="row">
        <PrimaryButton
          icon="key"
          loading={checking}
          disabled={appId.trim() === "" || appKey.trim() === "" || checking}
          onClick={() => void save()}
        >
          {checking ? "Checking" : "Save and turn on more jobs"}
        </PrimaryButton>
        {connected && (
          <Button
            variant="destructive"
            size="md"
            onClick={() => {
              setTrouble(null);
              void Promise.all([
                setSecret(SECRET_ADZUNA_APP_ID, ""),
                setSecret(SECRET_ADZUNA_APP_KEY, ""),
              ]).then(
                () => {
                  setMessage({ ok: true, text: "The numbers were removed." });
                  onChanged(false);
                },
                (err: unknown) => {
                  console.error(err);
                  setTrouble(REMOVE_NUMBERS_FAILED);
                },
              );
            }}
          >
            Remove these numbers
          </Button>
        )}
      </div>
      <p className="prose--muted">
        These jobs are gathered by Adzuna from around the web, so a few may be older or
        listed twice. Tapping Apply opens the listing on Adzuna first, and Adzuna counts
        that tap.
      </p>
    </div>
  );
}
