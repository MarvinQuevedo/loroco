// Theme toggle — mirrors docs/theme.js. The initial theme is resolved
// before first paint by the inline script in index.html; this module only
// handles runtime toggling and notifies subscribers (the TopBar button).

export type Theme = "light" | "dark";

const KEY = "loroco-theme";
const root = document.documentElement;
const subscribers = new Set<(t: Theme) => void>();

export function getTheme(): Theme {
  const v = root.dataset.theme;
  return v === "dark" ? "dark" : "light";
}

export function applyTheme(theme: Theme): void {
  root.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* private mode — choice just won't persist */
  }
  for (const fn of subscribers) fn(theme);
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  return next;
}

export function onThemeChange(fn: (t: Theme) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
