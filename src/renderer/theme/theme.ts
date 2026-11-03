import { useSyncExternalStore } from "react";
import type { ThemePreference } from "../../shared/types";

export type ResolvedTheme = "light" | "dark";

const cacheKey = "json-craft-theme";
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function cachedPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(cacheKey);
    if (value === "light" || value === "dark") return value;
  } catch {}
  return "system";
}

let preference = cachedPreference();
let resolved: ResolvedTheme = "light";

function applyTheme() {
  const next =
    preference === "system"
      ? systemTheme.matches
        ? "dark"
        : "light"
      : preference;
  document.documentElement.dataset.theme = next;
  document.documentElement.style.colorScheme = next;
  if (next !== resolved) {
    resolved = next;
    for (const listener of listeners) listener();
  }
}

export function getThemePreference() {
  return preference;
}

export function setThemePreference(value: ThemePreference) {
  preference = value;
  try {
    localStorage.setItem(cacheKey, value);
  } catch {}
  applyTheme();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useResolvedTheme() {
  return useSyncExternalStore(subscribe, () => resolved);
}

systemTheme.addEventListener("change", applyTheme);
if (import.meta.hot)
  import.meta.hot.dispose(() =>
    systemTheme.removeEventListener("change", applyTheme),
  );
applyTheme();
