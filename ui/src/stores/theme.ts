import { create } from "zustand";

export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "argonaut.theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");

function stored(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark" || value === "system") return value;
  } catch {
    // Fall back to following the system.
  }
  return "system";
}

function resolve(pref: ThemePreference): "light" | "dark" {
  if (pref === "system") return media.matches ? "dark" : "light";
  return pref;
}

function apply(pref: ThemePreference) {
  const resolved = resolve(pref);
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.style.colorScheme = resolved;
}

interface ThemeState {
  preference: ThemePreference;
  resolved: "light" | "dark";
  setPreference: (pref: ThemePreference) => void;
}

export const useTheme = create<ThemeState>((set) => ({
  preference: stored(),
  resolved: resolve(stored()),
  setPreference: (preference) => {
    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // Not persisting the choice is harmless.
    }
    apply(preference);
    set({ preference, resolved: resolve(preference) });
  },
}));

apply(useTheme.getState().preference);
media.addEventListener("change", () => {
  const { preference } = useTheme.getState();
  if (preference !== "system") return;
  apply(preference);
  useTheme.setState({ resolved: resolve(preference) });
});
