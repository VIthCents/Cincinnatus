import { CopyButton } from "./CopyButton.tsx";
import { LinkButton } from "./LinkButton.tsx";
import { Notice } from "./ui.tsx";

/**
 * The sign-up guides for the three keys, in one place.
 *
 * The wizard and Settings both show these. They used to be written twice —
 * the wizard had steps and Settings had a single sentence — so somebody who
 * skipped a step on the first run could never find the instructions again,
 * and the two copies were free to drift apart. One source now.
 *
 * The audience may never have made an account on a developer website before,
 * so every step is one action with the button named exactly as it appears,
 * and the screens that look alarming are described before they show up.
 */

/** Offered as the website on Adzuna's form, for people who do not have one. */
const PROJECT_URL = "https://github.com/VIthCents/Cincinnatus";

export function AnthropicKeyGuide() {
  return (
    <>
      <Notice tone="warn">
        You need a <strong>Claude Console</strong> account. That is Anthropic's
        developer site — <strong>not</strong> the Claude chat app. A Claude Pro or Max
        chat plan does <strong>not</strong> come with an access key, so please don't buy
        one for this.
      </Notice>
      <ol className="cn-guide">
        <li>
          Go to{" "}
          <LinkButton url="https://console.anthropic.com/">
            console.anthropic.com
          </LinkButton>
          . It opens in your web browser.
        </li>
        <li>
          Click <strong>Sign up</strong>. Type your email and make a password.
        </li>
        <li>
          Anthropic emails you a code. Type that code on the web page. Look in your spam
          folder if it does not come.
        </li>
        <li>
          Now you are on the Console. Find <strong>Billing</strong> in the menu and
          click it.
        </li>
        <li>
          Add <strong>$5</strong> with a card. This is money you pay Anthropic, not us.
          You only pay for what you use, and $5 lasts a long while.
        </li>
        <li>
          Find <strong>API keys</strong> in the same menu and click it.
        </li>
        <li>
          Click <strong>Create Key</strong>. Give it any name you like — Cincinnatus is
          fine.
        </li>
        <li>
          The key shows one time only. Copy it now. It starts with{" "}
          <strong>sk-ant-</strong>.
        </li>
        <li>
          Come back here. Click the box below and paste the key in. To paste, hold{" "}
          <strong>Ctrl</strong> and press <strong>V</strong>.
        </li>
      </ol>
    </>
  );
}

export function UsaJobsKeyGuide() {
  return (
    <ol className="cn-guide">
      <li>
        Go to{" "}
        <LinkButton url="https://developer.usajobs.gov/apirequest/">
          developer.usajobs.gov/apirequest
        </LinkButton>
        . It opens in your web browser.
      </li>
      <li>Fill in every box on the form. Use an email you can open right now.</li>
      <li>Send the form.</li>
      <li>
        USAJobs emails you a key. It is a long line of letters and numbers. Look in your
        spam folder if it does not come.
      </li>
      <li>Copy the key out of that email.</li>
      <li>Come back here. Paste the key in the first box below.</li>
      <li>
        Type that <strong>same email</strong> in the second box. USAJobs checks that the
        two match, so it has to be the one you signed up with.
      </li>
    </ol>
  );
}

export function AdzunaKeyGuide() {
  return (
    <ol className="cn-guide">
      <li>
        Go to{" "}
        <LinkButton url="https://developer.adzuna.com/signup">
          developer.adzuna.com/signup
        </LinkButton>
        . It opens in your web browser.
      </li>
      <li>Make a user name and a password, and type your email.</li>
      <li>
        Where it asks what you are building, choose{" "}
        <strong>Publishing Adzuna ad listings</strong>. This matters — the other choices
        stop working after two weeks.
      </li>
      <li>
        If it asks for a website and you do not have one, use this address:
        <br />
        <code>{PROJECT_URL}</code>
        <br />
        <CopyButton text={PROJECT_URL} label="Copy this address" />
      </li>
      <li>Check your email and click the link they send you.</li>
      <li>
        You land on a page called <strong>Dashboard</strong>. It shows you two things.
      </li>
      <li>
        Copy the <strong>Application ID</strong> into the first box below. That is the
        short one, about 8 characters.
      </li>
      <li>
        Copy the <strong>Application Key</strong> into the second box below. That is the
        long one, about 32 characters.
      </li>
    </ol>
  );
}
