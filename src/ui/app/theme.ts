/**
 * Light or dark, or whatever the computer is set to.
 *
 * The design system ships a full dark palette behind a `.dark` class on the
 * root element — no `prefers-color-scheme` of its own — so something has to
 * put the class there. That is all this does.
 */

export type ThemePreference = "system" | "light" | "dark";

export function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyTheme(preference: ThemePreference): void {
  const dark =
    preference === "dark" || (preference === "system" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", dark);
}

/**
 * Follows the computer's setting while the preference is "system". Returns an
 * unsubscribe function.
 */
export function watchSystemTheme(preference: ThemePreference): () => void {
  applyTheme(preference);
  if (preference !== "system") return () => {};

  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => applyTheme("system");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
