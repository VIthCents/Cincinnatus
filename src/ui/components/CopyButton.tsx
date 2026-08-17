import { useEffect, useRef, useState } from "react";
import { Button } from "./ui.tsx";

/** How long the button reads "Copied" before going back to its normal label. */
const COPIED_MS = 2000;

/**
 * Copies a short piece of text — an address to paste into a sign-up form.
 *
 * Uses the webview's own clipboard rather than a Tauri plugin: this is a
 * two-line need and the complexity budget does not stretch to a new
 * dependency for it. If the clipboard refuses, the person is told to select
 * the text by hand instead of being left with a button that did nothing.
 */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.error(err);
      setState("failed");
      return;
    }
    setState("copied");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), COPIED_MS);
  }

  return (
    <span className="row" role="status" aria-live="polite">
      <Button
        variant="secondary"
        size="md"
        icon={state === "copied" ? "check" : "content_paste"}
        onClick={() => void copy()}
      >
        {state === "copied" ? "Copied" : label}
      </Button>
      {state === "failed" && (
        <span className="prose--muted">
          Copy did not work. You can select the address above and copy it by hand.
        </span>
      )}
    </span>
  );
}
