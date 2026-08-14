import { GOOD_MATCH_FIT, STRONG_MATCH_FIT } from "../match.ts";
import { LLM_RATIONALE_MAX_CHARS } from "../../config.ts";

/**
 * Bump this whenever the wording below changes in a way that could change a
 * judgement — including a change to the badge bands it quotes, since they are
 * interpolated into the rubric. Stored scores are keyed by a hash of this
 * version plus the profile text, so bumping it retires every score judged
 * under the old wording instead of leaving them to be compared against new
 * ones.
 */
export const SCORE_PROMPT_VERSION = "score.v1";

/**
 * The rubric is anchored to the measured badge bands rather than to round
 * numbers, so a score of 60 means what the interface's word "Strong match"
 * was measured to mean (see pipeline/match.ts). The numbers are interpolated
 * for the same reason FRESHNESS_FLOOR is derived: a band written twice is a
 * band that will disagree with itself.
 */
export const SCORE_SYSTEM = `You judge how well jobs fit one job seeker. You get the seeker's background, then a list of jobs. Score every job and give one short reason.

How to score, 0 to 100:
- ${String(STRONG_MATCH_FIT)} or more: they could really get this job. The work matches what they have done, and they meet the stated requirements.
- ${String(GOOD_MATCH_FIT)} to ${String(STRONG_MATCH_FIT - 1)}: worth a look. Close, but something is missing or unclear.
- Under ${String(GOOD_MATCH_FIT)}: not for them.

Rules:
- Judge whether THEY could be hired, not whether the words sound alike.
- A hard requirement they do not meet — a degree, a licence, a certification, a clearance — caps the score under ${String(GOOD_MATCH_FIT)}. Never assume they have something their background does not list.
- Real experience doing the same work beats matching keywords.
- Military experience counts. Translate it: a motor transport operator has driven trucks, a 42A has done human resources work.
- The reason is one short sentence, at most ${String(LLM_RATIONALE_MAX_CHARS)} characters, in plain 6th-grade words, spoken to the seeker ("You..."). Name the one thing that matters most — the best reason to apply, or the thing that blocks them. Be honest, not kind.
- Return one entry per job, using each job's id exactly as it was given.`;
