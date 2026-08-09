import { useEffect, useId, useRef } from "react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";
import { Icon, type IconName } from "./Icon.tsx";

/**
 * The primitives every screen shares, ported from the Cincinnatus Design
 * System (components/actions, components/forms, components/feedback,
 * components/navigation). Markup, class names and behaviour are the design
 * system's; the types are ours.
 *
 * Nothing here carries visual styling of its own. Every colour, size, radius
 * and duration comes from src/ui/tokens/*.css, and the Tailwind theme is
 * closed — an off-system utility like `bg-blue-700` generates no CSS at all,
 * which is the point: drift fails visibly rather than shipping.
 */

// ── Buttons ─────────────────────────────────────────────────────────────────

export type ButtonVariant = "primary" | "secondary" | "quiet" | "destructive";

export interface ButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label"
> {
  readonly variant?: ButtonVariant;
  readonly size?: "lg" | "md";
  readonly icon?: IconName;
  readonly iconEnd?: IconName;
  readonly loading?: boolean;
  readonly block?: boolean;
  readonly ariaLabel?: string;
  readonly children: ReactNode;
}

export function Button({
  variant = "primary",
  size = "lg",
  icon,
  iconEnd,
  loading = false,
  disabled = false,
  block = false,
  type = "button",
  ariaLabel,
  children,
  className = "",
  ...rest
}: ButtonProps) {
  const cls = [
    "cn-btn",
    `cn-btn--${variant}`,
    size === "md" && "cn-btn--md",
    block && "cn-btn--block",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  const glyph = size === "md" ? 20 : 22;

  return (
    <button
      type={type}
      className={cls}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-label={ariaLabel}
      {...rest}
    >
      {loading ? (
        <span className="cn-spinner" aria-hidden="true" />
      ) : icon ? (
        <Icon name={icon} size={glyph} />
      ) : null}
      <span>{children}</span>
      {iconEnd !== undefined && !loading ? <Icon name={iconEnd} size={glyph} /> : null}
    </button>
  );
}

/**
 * The two names the screens already use. Kept as the design system's primary
 * and secondary so every existing call site lands on system styling.
 */
export function PrimaryButton(props: Omit<ButtonProps, "variant">) {
  return <Button variant="primary" {...props} />;
}

export function QuietButton(props: Omit<ButtonProps, "variant">) {
  return <Button variant="secondary" {...props} />;
}

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label" | "title"
> {
  readonly icon: IconName;
  /** Required: it becomes both the accessible name and the tooltip. */
  readonly label: string;
  readonly pressed?: boolean;
  readonly bordered?: boolean;
  readonly showLabel?: boolean;
}

export function IconButton({
  icon,
  label,
  pressed,
  bordered = false,
  showLabel = false,
  disabled = false,
  className = "",
  ...rest
}: IconButtonProps) {
  const cls = [
    "cn-iconbtn",
    showLabel && "cn-iconbtn--labelled",
    bordered && "cn-iconbtn--bordered",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      className={cls}
      disabled={disabled}
      aria-label={showLabel ? undefined : label}
      title={showLabel ? undefined : label}
      aria-pressed={pressed}
      {...rest}
    >
      <Icon name={icon} size={22} />
      {showLabel ? <span>{label}</span> : null}
    </button>
  );
}

// ── Fields ──────────────────────────────────────────────────────────────────

interface FieldChrome {
  /** Omit and one is generated; supply when something else must label it. */
  readonly id?: string;
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly mono?: boolean;
  readonly className?: string;
}

export type TextFieldProps = FieldChrome &
  Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "className">;

export function TextField({
  id: givenId,
  label,
  hint,
  error,
  mono = false,
  className = "",
  ...rest
}: TextFieldProps) {
  const generated = useId();
  const id = givenId ?? generated;
  const describedBy =
    [hint !== undefined && `${id}-hint`, error !== undefined && `${id}-error`]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <div className={["cn-field", className].filter(Boolean).join(" ")}>
      <label className="cn-field__label" htmlFor={id}>
        {label}
      </label>
      {hint !== undefined ? (
        <p className="cn-field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      <input
        id={id}
        className={["cn-input", mono && "cn-input--mono"].filter(Boolean).join(" ")}
        aria-invalid={error !== undefined ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
      {error !== undefined ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </div>
  );
}

export type TextAreaFieldProps = FieldChrome &
  Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id" | "className">;

export function TextAreaField({
  id: givenId,
  label,
  hint,
  error,
  mono = false,
  className = "",
  rows = 3,
  ...rest
}: TextAreaFieldProps) {
  const generated = useId();
  const id = givenId ?? generated;
  const describedBy =
    [hint !== undefined && `${id}-hint`, error !== undefined && `${id}-error`]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <div className={["cn-field", className].filter(Boolean).join(" ")}>
      <label className="cn-field__label" htmlFor={id}>
        {label}
      </label>
      {hint !== undefined ? (
        <p className="cn-field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      <textarea
        id={id}
        rows={rows}
        className={["cn-input", mono && "cn-input--mono"].filter(Boolean).join(" ")}
        aria-invalid={error !== undefined ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
      {error !== undefined ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </div>
  );
}

function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p className="cn-field__error" id={id} role="alert">
      <Icon name="cancel" size={20} />
      <span>{children}</span>
    </p>
  );
}

export interface SelectFieldProps {
  readonly id?: string;
  readonly label: string;
  readonly hint?: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly disabled?: boolean;
  readonly className?: string;
}

export function SelectField({
  id: givenId,
  label,
  hint,
  value,
  onChange,
  options,
  disabled = false,
  className = "",
}: SelectFieldProps) {
  const generated = useId();
  const id = givenId ?? generated;
  return (
    <div className={["cn-field", className].filter(Boolean).join(" ")}>
      <label className="cn-field__label" htmlFor={id}>
        {label}
      </label>
      {hint !== undefined ? (
        <p className="cn-field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      <span className="cn-select-wrap">
        <select
          id={id}
          className="cn-select"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-describedby={hint !== undefined ? `${id}-hint` : undefined}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Icon name="keyboard_arrow_down" size={24} />
      </span>
    </div>
  );
}

export interface ToggleProps {
  readonly id?: string;
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly label: string;
  readonly disabled?: boolean;
  readonly className?: string;
}

export function Toggle({
  id,
  checked,
  onChange,
  label,
  disabled = false,
  className = "",
}: ToggleProps) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={["cn-toggle", className].filter(Boolean).join(" ")}
      onClick={() => onChange(!checked)}
    >
      <span className="cn-toggle__track" aria-hidden="true">
        <span className="cn-toggle__knob" />
      </span>
      <span>{label}</span>
    </button>
  );
}

export function SettingsRow({
  title,
  description,
  children,
  className = "",
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={["cn-row", className].filter(Boolean).join(" ")}>
      <span className="cn-row__text">
        <span className="cn-row__title">{title}</span>
        {description !== undefined ? (
          <span className="cn-row__desc">{description}</span>
        ) : null}
      </span>
      <span className="cn-row__control">{children}</span>
    </div>
  );
}

export function Disclosure({
  summary = "Advanced",
  children,
  defaultOpen = false,
  className = "",
}: {
  summary?: string;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  return (
    <details
      className={["cn-disclosure", className].filter(Boolean).join(" ")}
      open={defaultOpen}
    >
      <summary className="cn-disclosure__summary">
        <Icon name="keyboard_arrow_down" size={22} />
        <span>{summary}</span>
      </summary>
      <div className="cn-disclosure__body">{children}</div>
    </details>
  );
}

// ── Feedback ────────────────────────────────────────────────────────────────

export type BannerTone = "error" | "caution" | "info" | "success";

const BANNER_GLYPH: Record<BannerTone, IconName> = {
  error: "cancel",
  caution: "warning",
  info: "info",
  success: "check_circle",
};

export function Banner({
  tone = "info",
  title,
  children,
  actions,
  className = "",
}: {
  tone?: BannerTone;
  title?: string;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={["cn-banner", `cn-banner--${tone}`, className]
        .filter(Boolean)
        .join(" ")}
      role={tone === "error" ? "alert" : undefined}
    >
      <span className="cn-banner__icon">
        <Icon name={BANNER_GLYPH[tone]} size={24} />
      </span>
      <span className="cn-banner__body">
        {title !== undefined ? <span className="cn-banner__title">{title}</span> : null}
        {children ? <span className="cn-banner__desc">{children}</span> : null}
        {actions ? <span className="cn-banner__actions">{actions}</span> : null}
      </span>
    </div>
  );
}

/**
 * The name the screens already use. "warn" is the design system's caution
 * tone; anything a person must act on gets `Banner` with a title instead.
 */
export function Notice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "warn";
}) {
  return <Banner tone={tone === "warn" ? "caution" : "info"}>{children}</Banner>;
}

export function EmptyState({
  icon = "work",
  title,
  children,
  actions,
  className = "",
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={["cn-empty", className].filter(Boolean).join(" ")}>
      <span className="cn-empty__mark" aria-hidden="true">
        <Icon name={icon} size={32} />
      </span>
      <h2 className="cn-empty__title">{title}</h2>
      {children ? <p className="cn-empty__desc">{children}</p> : null}
      {actions ? <div className="cn-empty__actions">{actions}</div> : null}
    </div>
  );
}

export type ToastTone = "success" | "error" | "info";

const TOAST_GLYPH: Record<ToastTone, IconName> = {
  success: "check_circle",
  error: "cancel",
  info: "info",
};

export function Toast({
  tone = "success",
  title,
  description,
  onDismiss,
  className = "",
}: {
  tone?: ToastTone;
  title: string;
  description?: string;
  onDismiss?: () => void;
  className?: string;
}) {
  return (
    <div
      className={["cn-toast", `cn-toast--${tone}`, className].filter(Boolean).join(" ")}
      role={tone === "error" ? "alert" : "status"}
      aria-live={tone === "error" ? "assertive" : "polite"}
    >
      <span className="cn-toast__icon">
        <Icon name={TOAST_GLYPH[tone]} size={24} />
      </span>
      <span className="cn-toast__body">
        <span className="cn-toast__title">{title}</span>
        {description !== undefined ? (
          <span className="cn-toast__desc">{description}</span>
        ) : null}
      </span>
      {onDismiss ? (
        <IconButton icon="close" label="Close this message" onClick={onDismiss} />
      ) : null}
    </div>
  );
}

/** A short wait with no measurable end. Long waits use RunProgress instead. */
export function Busy({ label }: { label: string }) {
  return (
    <p className="cn-progress__label" role="status" aria-live="polite">
      <span className="cn-spinner" aria-hidden="true" />
      <span>{label}</span>
    </p>
  );
}

// ── Navigation ──────────────────────────────────────────────────────────────

export interface TabDescriptor<Id extends string> {
  readonly id: Id;
  readonly label: string;
  readonly icon?: IconName;
  readonly count?: number | null;
}

export function TabBar<Id extends string>({
  tabs,
  active,
  onChange,
  onKeyDown,
  className = "",
}: {
  tabs: readonly TabDescriptor<Id>[];
  active: Id | null;
  onChange: (id: Id) => void;
  /** Arrow keys, so the caller can move selection (accessibility.md). */
  onKeyDown?: (key: string) => void;
  className?: string;
}) {
  return (
    <div
      className={["cn-tabs", className].filter(Boolean).join(" ")}
      role="tablist"
      aria-label="Main sections"
      onKeyDown={(e) => {
        if (onKeyDown === undefined) return;
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        // The newly selected tab is the only one in the tab order, so moving
        // focus to it is what makes the arrow keys feel like a selection.
        e.preventDefault();
        onKeyDown(e.key);
      }}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          className="cn-tab"
          id={`tab-${t.id}`}
          aria-selected={active === t.id}
          aria-controls={`panel-${t.id}`}
          tabIndex={active === t.id ? 0 : -1}
          ref={
            active === t.id
              ? (el) => {
                  // Only steal focus if focus is already inside the tab list —
                  // otherwise clicking a job card would yank it back up here.
                  if (el !== null && el.parentElement?.contains(document.activeElement))
                    el.focus();
                }
              : undefined
          }
          onClick={() => onChange(t.id)}
        >
          {t.icon !== undefined ? <Icon name={t.icon} size={22} /> : null}
          <span>{t.label}</span>
          {t.count != null ? <span className="cn-tab__count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

// ── Modal ───────────────────────────────────────────────────────────────────

/**
 * Modal scaffolding both dialogs share: labelled, Escape closes, focus lands
 * inside on open and is trapped there, so a keyboard or screen-reader user is
 * never stranded behind an invisible wall.
 *
 * The design system has no modal — the app needs one for Prepare and the
 * resume review. Layout only, every value from the same tokens (.cn-modal in
 * src/ui/tokens/app.css).
 */
export function ModalShell({
  label,
  onClose,
  children,
  wide = false,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="cn-modal"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          onClose();
          return;
        }
        if (e.key !== "Tab") return;

        // Trap: without this, Tab walks out of the dialog into the page
        // underneath, which is invisible and unreachable with the mouse.
        const panel = panelRef.current;
        if (panel === null) return;
        const focusable = panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        const activeEl = document.activeElement;

        if (e.shiftKey && (activeEl === first || activeEl === panel)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && activeEl === last) {
          e.preventDefault();
          first.focus();
        }
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={["cn-modal__panel", wide && "cn-modal__panel--wide"]
          .filter(Boolean)
          .join(" ")}
      >
        {children}
      </div>
    </div>
  );
}
