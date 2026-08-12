import type { ApplicationStatus } from "../../core/types.ts";

/**
 * The words for each step of an application, and the order they usually
 * happen in.
 *
 * Plain and short on purpose. "Heard back" is jargon-free but vague, so the
 * button says what actually happened: they wrote to you. "Not this one" is
 * how the last step is put — "rejected" is a word that lands hard on someone
 * who has had a run of them, and the app has no business being the one to say
 * it. Nothing here is a judgement; it is a place to put a fact.
 */
export const STATUS_STEPS: readonly {
  readonly id: ApplicationStatus;
  readonly label: string;
}[] = [
  { id: "applied", label: "Applied" },
  { id: "heard_back", label: "They wrote back" },
  { id: "interview", label: "Interview" },
  { id: "offer", label: "Job offer" },
  { id: "closed", label: "Not this one" },
];

const WORDS: Record<ApplicationStatus, string> = {
  applied: "Applied",
  heard_back: "They wrote back",
  interview: "Interview",
  offer: "Job offer",
  closed: "Not this one",
};

export function statusWords(status: ApplicationStatus): string {
  return WORDS[status];
}
