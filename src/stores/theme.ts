import { create } from "zustand";

export type Theme = "dark" | "light";

const STORAGE_KEY = "aime.theme";

function initialTheme(): Theme {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyToDom(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

interface ThemeState {
  theme: Theme;
  toggle: () => void;
}

export const useTheme = create<ThemeState>((set, get) => {
  const theme = initialTheme();
  applyToDom(theme);
  return {
    theme,
    toggle: () => {
      const next: Theme = get().theme === "dark" ? "light" : "dark";
      localStorage.setItem(STORAGE_KEY, next);
      applyToDom(next);
      set({ theme: next });
    },
  };
});

/** Monaco theme name matching the app theme. */
export function monacoThemeOf(theme: Theme): string {
  return theme === "dark" ? "aime-dark" : "aime-light";
}
