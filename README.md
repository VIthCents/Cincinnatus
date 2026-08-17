# Cincinnatus

A free app that helps veterans get hired. It runs on your own computer.

There is no Cincinnatus account and nothing to sign up for to use it. Your resume,
your chats, and every document you make stay on your machine. Nothing about you goes
to any cloud unless you turn on a helper, and this page lists every one of those.

- **Chat** — talk through your resume. You get an honest read on it, not
  flattery, and a stronger version you can use.
- **Jobs** — one list, best fit first. Each job has one button that writes a
  resume and cover letter for that job. **You** click Apply. The app never
  applies for anything on your behalf.

Looking for jobs is free and works the minute you install it. The AI helper is the
one part that costs money, and you pay Anthropic for it, never us. The section
[What it costs](#what-it-costs) says exactly what is free and what is not.

---

## Get it on your computer

1. Click this link: **[Download Cincinnatus for Windows](https://github.com/VIthCents/Cincinnatus/releases/latest/download/Cincinnatus_0.1.0_x64-setup.exe)** (about 13 MB).
2. When it finishes, open your **Downloads** folder.
3. Double-click the file named **Cincinnatus_0.1.0_x64-setup.exe**.
4. Windows may show a blue box that says **"Windows protected your PC."** That is
   normal for a new app. Click **More info**.
5. Check that the publisher line says **Hawkseye Corp.** That is us. (The dot at the
   end is part of the name.)
6. Click **Run anyway**.
7. Follow the prompts to install. It installs for you only, so it never asks for an
   administrator password.
8. Cincinnatus opens on a screen that says **"Welcome. I'm Cincinnatus."** You are in.

That blue box shows up because the app is new, not because anything is wrong with it.
It stops showing up as more people install it.

**Mac is not ready yet.** The Mac version needs a separate signature from Apple that
is not finished. If you install an unsigned Mac app, macOS blocks it in a way that is
genuinely hard to undo, so we would rather wait than hand you that.

<details>
<summary>Checking the download yourself (optional)</summary>

The installer is signed by **Hawkseye Corp.** Right-click it → Properties →
Digital Signatures to see for yourself.

To check nothing changed on the way to you, open PowerShell in your Downloads
folder and run:

```powershell
Get-FileHash .\Cincinnatus_0.1.0_x64-setup.exe -Algorithm SHA256
```

It should print:

```
39A9DBE897BE883216A463FB01DC9EF7ED9AD018C8550B7683B25627D688BC03
```

</details>

---

## What it costs

| Part                       | Cost                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------ |
| The app itself             | **Free.** Open source. There is nothing to buy from us, ever.                        |
| Looking for jobs           | **Free.** Works the minute you install it, with no keys and no sign-ups.             |
| Federal jobs (USAJobs)     | **Free**, but you have to sign up with USAJobs to get a key.                         |
| More job listings (Adzuna) | **Free**, but you have to sign up with Adzuna to get two numbers.                    |
| The AI helper              | **Costs money.** You buy about **$5** of credit from Anthropic and use it up slowly. |

The AI helper is the only part you pay for. You pay Anthropic, the company that makes
the AI — not us. There is no monthly plan. You put a small amount of money in and it
draws from that as you go. To give you an idea: reading and scoring a batch of 30 jobs
costs about **2 cents**, and writing a resume and cover letter for one job costs about
**10 to 15 cents**. Five dollars lasts a long while.

**You do not have to set any of this up to find jobs.** Install the app, tell it what
kind of work you want, and it goes and looks. The three helpers below are extras. Each
one has step-by-step directions here and inside the app under Settings.

---

## Your first search

**The first search is slow.** It takes 10 to 20 minutes, because your computer reads
every job it finds rather than sending them off somewhere. After the first time,
searches take about a minute. You can close the window; it keeps working.

---

## The three extras, and how to turn them on

You do not need any of these. Add them when you want to.

### Turn on the AI helper (this is the part that costs money)

The AI helper reads your resume, fixes it with you, and writes a resume and cover
letter for each job you pick.

> **Read this first.** You need an account on **Claude Console**. That is Anthropic's
> site for developers — **not** the Claude chat app. A Claude Pro or Max chat plan does
> **not** come with an access key, so please do not buy one for this.

1. Go to [console.anthropic.com](https://console.anthropic.com/).
2. Click **Sign up**. Type your email and make a password.
3. Anthropic emails you a code. Type that code on the web page. Look in your spam
   folder if it does not come.
4. Now you are on the Console. Find **Billing** in the menu and click it.
5. Add **$5** with a card. You only pay for what you use.
6. Find **API keys** in the same menu and click it.
7. Click **Create Key**. Give it any name you like — Cincinnatus is fine.
8. The key shows one time only. Copy it now. It starts with `sk-ant-`.
9. Open Cincinnatus. Click the gear in the top corner to open **Settings**.
10. Under **AI access key**, paste your key in the box and click
    **Save my key and continue**.
11. You will see **"Your key works. You are all set."**

### Turn on federal jobs (free)

Federal jobs give hiring preference to veterans, so these are worth having.

1. Go to [developer.usajobs.gov/apirequest](https://developer.usajobs.gov/apirequest/).
2. Fill in every box on the form. Use an email you can open right now.
3. Send the form.
4. USAJobs emails you a key. It is a long line of letters and numbers. Look in your
   spam folder if it does not come.
5. Copy the key out of that email.
6. Open Cincinnatus and go to **Settings**.
7. Under **Federal jobs**, paste the key in the first box.
8. Type that **same email** in the second box. USAJobs checks that the two match.
9. Click **Save my key and continue**. You will see **"Federal jobs are on."**

### Turn on more job listings (free)

Company job boards carry a lot of office and engineering work. This adds driving,
warehouse, maintenance, and trades jobs near you, which is most of what those boards
miss.

1. Go to [developer.adzuna.com/signup](https://developer.adzuna.com/signup).
2. Make a user name and a password, and type your email.
3. Where it asks what you are building, choose **Publishing Adzuna ad listings**. This
   matters — the other choices stop working after two weeks.
4. If it asks for a website and you do not have one, use this address:
   `https://github.com/VIthCents/Cincinnatus`
5. Check your email and click the link they send you.
6. You land on a page called **Dashboard**. It shows you two things.
7. Open Cincinnatus and go to **Settings**.
8. Under **More job listings**, copy the **Application ID** into the first box. That is
   the short one, about 8 characters.
9. Copy the **Application Key** into the second box. That is the long one, about 32
   characters.
10. Click **Save and turn on more jobs**.

---

## What leaves your computer

Your resume, your chats, and every document stay on your machine. Four things can go
out, and nothing else:

1. **The words you are searching for**, to the job sites. That is the same thing you
   would type into a search box. This happens every time the app looks for jobs.
2. **Your resume and the one job you picked**, to Anthropic. This happens **only** if
   you turned the AI helper on, and **only** when you press the button.
3. **The email you signed up to USAJobs with**, to USAJobs. This happens **only** if
   you turned on federal jobs. USAJobs requires it on every request. That is their
   rule, not ours.
4. **Search words**, to Adzuna. This happens **only** if you turned on more job
   listings. One more thing worth knowing: tapping Apply on one of those jobs opens it
   on Adzuna's website first, and Adzuna counts that visit. That is how they pay for
   letting apps show their jobs.

No tracking. No analytics. No crash reports. There is no Cincinnatus account — the
sign-ups above are with those services, never with us.

[PRIVACY.md](./PRIVACY.md) says all of this again, in detail.

---

## Want to work on the code?

See [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Licence

MIT. See [LICENSE](./LICENSE).

Military-to-civilian job code translation is derived from the
[O\*NET Military Crosswalk](https://www.onetcenter.org/crosswalks.html) by the
U.S. Department of Labor, Employment and Training Administration, used under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Titles were
simplified and military-specific codes removed.
