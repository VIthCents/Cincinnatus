import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

/**
 * The handful of primitives every screen shares. Big touch targets, visible
 * focus, high contrast — the audience may be on a small old laptop, using a
 * screen reader, or new to computers (SPEC constraint 5).
 */

export function PrimaryButton(
  props: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode },
) {
  const { children, className = "", ...rest } = props;
  return (
    <button
      type="button"
      {...rest}
      className={`rounded-lg bg-blue-700 px-6 py-3 text-lg font-semibold text-white hover:bg-blue-800 focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-400 disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}

export function QuietButton(
  props: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode },
) {
  const { children, className = "", ...rest } = props;
  return (
    <button
      type="button"
      {...rest}
      className={`rounded-lg border border-slate-300 px-5 py-3 text-lg text-slate-800 hover:bg-slate-100 focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-400 disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}

export function TextField(
  props: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string },
) {
  const { label, hint, id, className = "", ...rest } = props;
  const fieldId = id ?? label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return (
    <label htmlFor={fieldId} className="block">
      <span className="mb-1 block text-lg font-medium">{label}</span>
      {hint !== undefined && (
        <span className="mb-1 block text-base text-slate-600">{hint}</span>
      )}
      <input
        id={fieldId}
        {...rest}
        className={`w-full rounded-lg border border-slate-300 px-4 py-3 text-lg focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-400 ${className}`}
      />
    </label>
  );
}

export function Busy({ label }: { label: string }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className="flex items-center gap-3 text-lg text-slate-700"
    >
      <span
        aria-hidden="true"
        className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-blue-700 motion-reduce:animate-none"
      />
      {label}
    </p>
  );
}

export function Notice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "warn";
}) {
  const styles =
    tone === "warn"
      ? "border-amber-400 bg-amber-50 text-amber-900"
      : "border-blue-300 bg-blue-50 text-blue-900";
  return (
    <div className={`rounded-lg border px-4 py-3 text-lg ${styles}`}>{children}</div>
  );
}
