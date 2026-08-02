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

/** Translation hook: `const t = useT(); t("ai.exitWithCode", { code: 1 })` */
export function useT() {
  const locale = useI18n((s) => s.locale);
  return (key: TranslationKey, params?: Record<string, string | number>): string => {
    let text = DICTIONARIES[locale][key];
    if (params) {
      for (const [name, value] of Object.entries(params)) {
        text = text.replaceAll(`{${name}}`, String(value));
      }
    }
    return text;
  };
}

/** For use outside React components (stores, services). */
export function translate(key: TranslationKey, params?: Record<string, string | number>): string {
  let text = DICTIONARIES[useI18n.getState().locale][key];
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}
