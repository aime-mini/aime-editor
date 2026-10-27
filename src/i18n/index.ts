import { useCallback } from "react";
import { create } from "zustand";
import { en, type TranslationKey } from "./en";
import { vi } from "./vi";

export type Locale = "en" | "vi";

const DICTIONARIES: Record<Locale, Record<TranslationKey, string>> = { en, vi };
const STORAGE_KEY = "aime.locale";

function initialLocale(): Locale {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === "vi" || saved === "en" ? saved : "en";
}

interface I18nState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

export const useI18n = create<I18nState>((set) => ({
  locale: initialLocale(),
  setLocale: (locale) => {
    localStorage.setItem(STORAGE_KEY, locale);
    set({ locale });
  },
}));

/** Looks the key up and fills its `{name}` placeholders. */
function format(locale: Locale, key: TranslationKey, params?: Record<string, string | number>): string {
  let text = DICTIONARIES[locale][key];
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

/**
 * Translation hook: `const t = useT(); t("ai.exitWithCode", { code: 1 })`
 *
 * The function keeps its identity until the locale changes, so components may
 * put `t` in a dependency array - a fresh closure per render would quietly
 * defeat every `memo` below it.
 */
export function useT() {
  const locale = useI18n((s) => s.locale);
  return useCallback(
    (key: TranslationKey, params?: Record<string, string | number>) => format(locale, key, params),
    [locale],
  );
}

/** For use outside React components (stores, services). */
export function translate(key: TranslationKey, params?: Record<string, string | number>): string {
  return format(useI18n.getState().locale, key, params);
}
