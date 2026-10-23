import { create } from "zustand";

const NAMESPACE_KEY = "argonaut.namespace";
const TIME_DISPLAY_KEY = "argonaut.timeDisplay";

/** Whether run lists show start times as "3 minutes ago" or as a date and time. */
export type TimeDisplay = "relative" | "absolute";

function read(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

interface PreferencesState {
  /** The namespace list pages show; pages that carry ?namespace= override and update it. */
  namespace?: string;
  setNamespace: (namespace: string) => void;
  timeDisplay: TimeDisplay;
  setTimeDisplay: (display: TimeDisplay) => void;
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembering the choice is harmless.
  }
}

export const usePreferences = create<PreferencesState>((set) => ({
  namespace: read(NAMESPACE_KEY),
  setNamespace: (namespace) => {
    write(NAMESPACE_KEY, namespace);
    set({ namespace });
  },
  timeDisplay: read(TIME_DISPLAY_KEY) === "absolute" ? "absolute" : "relative",
  setTimeDisplay: (timeDisplay) => {
    write(TIME_DISPLAY_KEY, timeDisplay);
    set({ timeDisplay });
  },
}));
