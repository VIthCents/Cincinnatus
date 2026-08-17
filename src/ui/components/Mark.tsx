/**
 * The Cincinnatus mark: a laurel wreath opening around an arrow pointing up.
 *
 * This is the same mark as the installed app icon (src-tauri/icons), so the
 * window header, the taskbar, the Start menu and the installer all show one
 * thing. They used to disagree — the header drew a rank chevron while the
 * icon drew the wreath — which reads as two different programs.
 *
 * Inline SVG rather than an <img> so the arrow can take `currentColor` and
 * stay legible in both themes. The laurel keeps its own green, because that
 * colour is most of what makes the icon recognisable at taskbar size.
 */

const LAUREL = "#9cba6b";

/** Where the wreath sits inside the 48x48 box. */
const CENTRE_X = 24;
const CENTRE_Y = 25.4;
const RADIUS = 14.6;

/** Leaves per arm, swept from above the horizontal down to the base. */
const PER_ARM = 7;

/**
 * How far each leaf turns off the arc, in degrees. Lying flat along the arc
 * the leaves overlap into one smooth band; angled outward, each tip clears
 * its neighbour and the wreath reads as leaves, the way the icon does.
 */
const LEAF_TILT = 38;

interface Leaf {
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly deg: number;
}

/**
 * Both arms, mirrored about the vertical. Angles are measured the way SVG
 * draws them — y grows downward — so 90° is the base of the wreath and 180°
 * is its left edge.
 */
function leaves(): Leaf[] {
  const out: Leaf[] = [];
  for (let i = 0; i < PER_ARM; i++) {
    const t = i / (PER_ARM - 1);
    const angle = 202 - t * 111;
    const rx = 3.3 + t * 1.2; // leaves grow toward the base, as in the icon
    for (const mirrored of [false, true]) {
      const deg = mirrored ? 180 - angle : angle;
      const rad = (deg * Math.PI) / 180;
      out.push({
        cx: CENTRE_X + RADIUS * Math.cos(rad),
        cy: CENTRE_Y + RADIUS * Math.sin(rad),
        rx,
        // Tangent to the arc, then tilted outward — mirrored on the far arm.
        deg: deg + 90 + (mirrored ? LEAF_TILT : -LEAF_TILT),
      });
    }
  }
  return out;
}

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
      {leaves().map((leaf, i) => (
        <ellipse
          key={i}
          cx={leaf.cx}
          cy={leaf.cy}
          rx={leaf.rx}
          ry="2.1"
          fill={LAUREL}
          transform={`rotate(${leaf.deg} ${leaf.cx} ${leaf.cy})`}
        />
      ))}
      <path d="M24 14.5 L30 22.5 H26.6 V31 H21.4 V22.5 H18 Z" fill="currentColor" />
    </svg>
  );
}
