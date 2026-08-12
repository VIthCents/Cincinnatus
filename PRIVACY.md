# Your privacy

Short version: **your resume stays on your computer.**

Cincinnatus has no accounts. You never sign up. There is no company server that holds your
information, because there is no server at all.

## What we never do

- We never track you. (If you turn on more job listings, the company behind them counts one
  thing — see number 4 below.)
- We never collect analytics.
- We never send crash reports.
- We never send your resume anywhere unless you turn on AI help. See below.
- We never apply to a job for you. You always click Apply yourself.

## Where your things are kept

Everything is in one file on your own computer:

- **Windows:** `%APPDATA%\io.github.cincinnatus\cincinnatus.db`
- **Mac:** `~/Library/Application Support/io.github.cincinnatus/cincinnatus.db`

Your resume, your chat history, and any documents the app makes for you all live in that file.
Nobody else can read it. To delete everything, delete that file.

Your access keys are the one thing kept somewhere else. Windows and Mac each have a locked
place for passwords, and that is where they go. You can remove them in Settings at any time.

## What leaves your computer, and when

Four things can leave. Each one is listed here.

### 1. Job searches

To find jobs, the app asks job websites for openings. It sends **search words** — things like
"truck driver" and the name of your city.

It does **not** send your name, your resume, or your work history.

This happens every time the app looks for jobs.

### 2. AI help — only if you turn it on

The app can look over your resume, help you make it better, and write cover letters. To do that,
it sends your resume and the job posting to Anthropic, the company that makes the AI.

**This only happens if you add an AI access key.** If you skip that step, nothing is ever sent.
The app still finds and ranks jobs for you without it.

You can remove your key at any time in Settings. After that, nothing is sent again.

### 3. Federal jobs — only if you turn it on

USAJobs is the government's job website. To use it, they require the app to send **the email
address you signed up with** on each request. That is their rule, not ours.

**This only happens if you add a USAJobs key.** If you skip it, the app never contacts USAJobs.

### 4. More job listings — only if you turn it on

Adzuna is a website that gathers job ads from around the web. If you turn on more job listings
in Settings, the app sends Adzuna the same kind of **search words** — things like "truck driver"
and the name of your city. It does **not** send your name or your resume.

**This only happens if you add Adzuna's two numbers in Settings.** If you skip it, the app never
contacts Adzuna. You can remove the numbers at any time in Settings.

One more thing worth knowing: tapping Apply on one of these jobs opens the ad on Adzuna's
website first, and Adzuna counts that visit. That is how they pay for letting apps show their
jobs.

## Why we are careful about this

A veteran's resume can say things about their health and their service that they may not want
shared. That is why the app keeps everything on your machine by default, and why every case where
something leaves is listed above in plain words.

## Questions

This app is free and open source. Anyone can read the code and check that this page is true.
