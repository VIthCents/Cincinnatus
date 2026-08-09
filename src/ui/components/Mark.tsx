/**
 * The Cincinnatus mark: a chevron over a rule — the rank insignia, and the
 * same chevron the match badge stacks. Ported from the design system's
 * assets/mark.svg. Inline rather than an <img> so it inherits `currentColor`
 * and works in both themes without a second file.
 */
export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 48 48"
      width={size}
      height={size}
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M7 30 L24 13 L41 30"
        stroke="currentColor"
        strokeWidth="7"
        strokeLinejoin="miter"
        strokeLinecap="butt"
      />
      <path
        d="M7 40.5 H41"
        stroke="currentColor"
        strokeWidth="6"
        strokeLinecap="butt"
      />
    </svg>
  );
}
