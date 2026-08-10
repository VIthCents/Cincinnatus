/**
 * The three words a veteran actually sees, and what they are measured to mean.
 *
 * One source of truth. These bands used to exist twice — in the harness and in
 * the UI — with the same numbers copied by hand, which is how two things that
 * must agree stop agreeing.
 *
 * ## What the numbers are, and what they are not
 *
 * Measured over 88 real jobs labelled for two profiles (see
 * `fixtures/rank-eval/`, `docs/DECISIONS.md`), `fitScore` distributes like this:
 *
 * | label            |  n | median |  range      |
 * |------------------|----|--------|-------------|
 * | 2 strong match   |  7 |  64.0  | 52.0 – 70.6 |
 * | 1 worth a look   | 26 |  54.9  | 14.7 – 72.7 |
 * | 0 not for them   | 55 |  37.5  |  5.3 – 70.4 |
 *
 * Those ranges overlap badly: one job the judges unanimously said was out of
 * reach scores 70.4, above most of the genuinely strong ones. So the honest
 * finding is that **fit cannot tell a 2 from a 1**. No threshold produces a
 * "Strong match" bucket that is mostly label 2 — the best any cut achieves is
 * 26% against an 8% base rate.
 *
 * What fit *can* do is tell "worth your time" from "not for you". At 60 and
 * above, 94% of jobs are label 1 or 2. At 48 and above, 57%. Below that it is
 * mostly noise. The bands below are those measurements, not round numbers
 * chosen because they look decisive:
 *
 *   STRONG (>= 60) — 94% of jobs here are ones a judge said she could get.
 *   GOOD   (>= 48) — 57%. Worth reading, not worth clearing an evening for.
 *   FAIR   (<  48) — everything else.
 *
 * ## Why these are absolute and not relative
 *
 * They are not quartiles of today's results. On a corpus with no driving jobs
 * in it, a CDL driver should see no strong matches, because there are none —
 * and that is exactly what these bands do: nothing in the CDL golden set
 * reaches 60. A system that promotes the best of a bad list to "Strong match"
 * to avoid an empty-looking screen is lying to someone who is about to spend an
 * evening on an application. See `guidelines/matching.md`.
 *
 * ## The badge reads fitScore, never finalScore
 *
 * `finalScore` decays with age, so a badge on it would show a strong match on
 * Monday and a fair match a week later for a job whose text never changed. Age
 * is on the card in words, where a person can weigh it themselves.
 */

export type MatchLevel = "fair" | "good" | "strong";

/** 94% of jobs at or above this were judged gettable. */
export const STRONG_MATCH_FIT = 60;

/** 57% were. Below it, mostly noise. */
export const GOOD_MATCH_FIT = 48;

export function matchLevel(fitScore: number): MatchLevel {
  if (fitScore >= STRONG_MATCH_FIT) return "strong";
  if (fitScore >= GOOD_MATCH_FIT) return "good";
  return "fair";
}

/**
 * The words themselves. A person never sees the number — it carries more
 * precision than the method deserves and there is nothing to do with it.
 */
export const MATCH_WORDS: Record<MatchLevel, string> = {
  fair: "Fair match",
  good: "Good match",
  strong: "Strong match",
};
