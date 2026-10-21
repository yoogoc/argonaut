import { create } from "zustand";

const NAMESPACE_KEY = "argonaut.namespace";

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
}

export const usePreferences = create<PreferencesState>((set) => ({
  namespace: read(NAMESPACE_KEY),
  setNamespace: (namespace) => {
    try {
      localStorage.setItem(NAMESPACE_KEY, namespace);
    } catch {
      // Not remembering the choice is harmless.
    }
    set({ namespace });
  },
}));
