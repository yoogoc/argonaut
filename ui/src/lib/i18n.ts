import i18n from "i18next";
import { initReactI18next } from "react-i18next";

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
  resources: { "zh-CN": { translation: zhCN } },
  lng: initialLanguage(),
  fallbackLng: false,
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  returnEmptyString: false,
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
