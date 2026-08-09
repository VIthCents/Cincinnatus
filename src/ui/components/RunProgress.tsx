import type { SourceProgress } from "../../core/app/progress.ts";
import type { RunPhase } from "../../core/ports.ts";
import { Icon, type IconName } from "./Icon.tsx";

/**
 * Ported from the Cincinnatus Design System (components/feedback/
 * ProgressIndicator.jsx and RunProgress.jsx). Markup, class names and copy are
 * the design system's; the types and the optional `remaining` line are ours.
 */

export interface ProgressIndicatorProps {
  readonly label: string;
  readonly note?: string | undefined;
  /** 0–100. Omit (or null) for an indeterminate bar. */
  readonly value?: number | null | undefined;
  readonly icon?: IconName | undefined;
  readonly className?: string;
}

export function ProgressIndicator({
  label,
  note,
  value,
  icon,
  className = "",
}: ProgressIndicatorProps) {
  const indeterminate = value === undefined || value === null;
  return (
    <div
      className={[
        "cn-progress",
        indeterminate && "cn-progress--indeterminate",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <p className="cn-progress__label">
        {icon ? <Icon name={icon} size={20} /> : null}
        <span>{label}</span>
      </p>
      <span
        className="cn-progress__track"
        role="progressbar"
        aria-valuenow={indeterminate ? undefined : value}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <span
          className="cn-progress__fill"
          style={indeterminate ? undefined : { width: `${value}%` }}
        />
      </span>
      {note ? <p className="cn-progress__note">{note}</p> : null}
    </div>
  );
}

const PHASES: readonly { readonly id: RunPhase; readonly label: string }[] = [
  { id: "finding", label: "Finding jobs" },
  { id: "reading", label: "Reading jobs" },
  { id: "ranking", label: "Putting them in order" },
];

const HEADLINE: Record<RunPhase, string> = {
  finding: "Cincinnatus is looking for jobs.",
  reading: "Cincinnatus is reading every job it found.",
  ranking: "Cincinnatus is putting the jobs in order.",
};

const SOURCE_STATUS: Record<SourceProgress["state"], { text: string; icon: IconName }> =
  {
    running: { text: "Looking now", icon: "search" },
    done: { text: "", icon: "check_circle" },
    unchanged: { text: "Nothing new", icon: "check_circle" },
    error: { text: "Did not answer", icon: "warning" },
  };

export interface RunProgressProps {
  readonly phase?: RunPhase | "done";
  /**
   * The first search reads every job on this machine and takes ten to twenty
   * minutes. Saying so up front is the difference between waiting and
   * assuming the app is broken.
   */
  readonly firstRun?: boolean;
  readonly done?: number | null | undefined;
  readonly total?: number | null | undefined;
  readonly sources?: readonly SourceProgress[];
  /** Measured estimate, e.g. "about 6 minutes left". "" when not trustworthy. */
  readonly remaining?: string;
  readonly variant?: "full" | "compact";
  readonly onLeave?: (() => void) | undefined;
  readonly className?: string;
}

export function RunProgress({
  phase = "finding",
  firstRun = false,
  done = null,
  total = null,
  sources = [],
  remaining = "",
  variant = "full",
  onLeave,
  className = "",
}: RunProgressProps) {
  // A finished run keeps the last headline for the beat before the caller
  // stops rendering it, and shows all three phases complete.
  const active: RunPhase = phase === "done" ? "ranking" : phase;
  const finished = phase === "done";

  const counted =
    active === "reading" &&
    typeof done === "number" &&
    typeof total === "number" &&
    total > 0;
  const percent = counted ? Math.round((done / total) * 100) : null;

  const count = counted
    ? `Read ${done.toLocaleString()} of ${total.toLocaleString()} jobs.`
    : active === "reading"
      ? "Cincinnatus does not know how many are left yet."
      : null;

  const note = firstRun
    ? "The first search takes 10 to 20 minutes, because Cincinnatus reads each job on your own computer. After today, searches take about a minute."
    : "This usually takes about a minute.";

  if (variant === "compact") {
    return (
      <div
        className={["cn-run cn-run--compact", className].filter(Boolean).join(" ")}
        role="status"
        aria-live="polite"
      >
        <ProgressIndicator
          icon="search"
          value={percent}
          label={HEADLINE[active]}
          note={
            [count, firstRun ? "You can keep using Cincinnatus while it works." : null]
              .filter(Boolean)
              .join(" ") || undefined
          }
        />
      </div>
    );
  }

  const reached = finished ? PHASES.length : PHASES.findIndex((p) => p.id === active);

  return (
    <section
      className={["cn-run", className].filter(Boolean).join(" ")}
      aria-label="Search progress"
    >
      <h3 className="cn-run__title">{HEADLINE[active]}</h3>
      <p className="cn-run__note">{note}</p>

      <ol className="cn-run__phases">
        {PHASES.map((p, i) => (
          <li
            key={p.id}
            className={[
              "cn-run__phase",
              i < reached && "is-done",
              i === reached && "is-now",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <Icon name={i < reached ? "check_circle" : "schedule"} size={20} />
            <span>{p.label}</span>
            {i < reached ? <span className="cn-run__phase-state">Done</span> : null}
          </li>
        ))}
      </ol>

      <div className="cn-run__bar" role="status" aria-live="polite">
        <ProgressIndicator
          label={count ?? "Working."}
          value={percent}
          note={remaining === "" ? undefined : remaining}
        />
      </div>

      {sources.length > 0 ? (
        <ul className="cn-run__sources">
          {sources.map((s) => {
            const st = SOURCE_STATUS[s.state];
            return (
              <li key={s.id} className={`cn-run__source is-${s.state}`}>
                <Icon name={st.icon} size={18} />
                <span className="cn-run__source-name">{s.label}</span>
                <span className="cn-run__source-state">
                  {s.state === "done" && typeof s.count === "number"
                    ? `${s.count.toLocaleString()} ${s.count === 1 ? "job" : "jobs"}`
                    : st.text}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}

      {onLeave ? (
        <p className="cn-run__leave">
          You can leave this screen. Cincinnatus keeps working.{" "}
          <button type="button" className="cn-run__leave-btn" onClick={onLeave}>
            Go to Chat
          </button>
        </p>
      ) : null}
    </section>
  );
}
