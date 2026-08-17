import { openUrl } from "@tauri-apps/plugin-opener";
import type { ReactNode } from "react";

/**
 * A link out to the web, rendered as a button.
 *
 * The webview has no navigation target, so `<a href>` goes nowhere: every
 * outside address has to leave through the opener plugin and land in the
 * person's own browser. That pattern was copied into five screens before it
 * became this, and the class name is the design system's link styling.
 */
export function LinkButton({ url, children }: { url: string; children: ReactNode }) {
  return (
    <button
      type="button"
      className="cn-jobcard__vialink"
      onClick={() => void openUrl(url)}
    >
      {children}
    </button>
  );
}
