import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "@/locales/en";
import zhCN from "@/locales/zh-CN";

// English source strings are the keys, so English needs no catalogue and a missing translation
// degrades to readable English instead of a dotted key path.
export const LANGUAGES = [
  { code: "zh-CN", label: "简体中文" },
  { code: "en", label: "English" },
] as const;

const STORAGE_KEY = "argonaut.language";

function initialLanguage(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && LANGUAGES.some((l) => l.code === stored)) return stored;
  } catch {
    // Storage can be unavailable; fall through to the browser language.
  }
  return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

void i18n.use(initReactI18next).init({
  resources: { "zh-CN": { translation: zhCN }, en: { translation: en } },
  lng: initialLanguage(),
  fallbackLng: false,
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  returnEmptyString: false,
  // In development, untranslated strings are collected on window.__missingI18n for checking a page.
  saveMissing: import.meta.env.DEV,
  saveMissingTo: "current",
  missingKeyHandler: (lngs, _ns, key) => {
    if (!lngs.includes("zh-CN")) return;
    const w = window as unknown as { __missingI18n?: Set<string> };
    (w.__missingI18n ??= new Set()).add(key);
  },
});

i18n.on("languageChanged", (lng) => {
  document.documentElement.lang = lng;
  try {
    localStorage.setItem(STORAGE_KEY, lng);
  } catch {
    // Not persisting the choice is harmless.
  }
});
document.documentElement.lang = i18n.language;

export default i18n;
