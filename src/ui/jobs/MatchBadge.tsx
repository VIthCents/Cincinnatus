import { MATCH_WORDS, type MatchLevel } from "../app/format.ts";

/**
 * Ported from the Cincinnatus Design System
 * (components/opportunities/MatchBadge.jsx).
 *
 * Chevrons AND the word, never one without the other: the chevrons are
 * aria-hidden, so what a screen reader announces is "Strong match", not
 * "graphic". Colour is the third signal, never the only one.
 */

const CHEVRONS: Record<MatchLevel, number> = { fair: 1, good: 2, strong: 3 };

function Chevron({ on }: { on: boolean }) {
  return (
    <svg
      width="26"
      height="9"
      viewBox="0 0 28 10"
      fill="none"
      className={on ? "" : "is-off"}
      aria-hidden="true"
    >
      <path
        d="M2 8 L14 2 L26 8"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinejoin="miter"
        strokeLinecap="butt"
      />
    </svg>
  );
}

export function MatchBadge({
  level,
  className = "",
}: {
  level: MatchLevel;
  className?: string;
}) {
  const filled = CHEVRONS[level];
  return (
    <span
      className={["cn-match", `cn-match--${level}`, className]
        .filter(Boolean)
        .join(" ")}
    >
      <span className="cn-match__stack" aria-hidden="true">
        <Chevron on={filled >= 3} />
        <Chevron on={filled >= 2} />
        <Chevron on={filled >= 1} />
      </span>
      <span className="cn-match__word">{MATCH_WORDS[level]}</span>
    </span>
  );
}
