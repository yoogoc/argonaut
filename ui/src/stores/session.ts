import { create } from "zustand";

import { getInfo, getUserInfo } from "@/api/auth";
import type { Info, UserInfo } from "@/api/types";
import { clearToken } from "@/lib/http";

type Status = "loading" | "authenticated" | "anonymous";

interface SessionState {
  status: Status;
  user?: UserInfo;
  info?: Info;
  error?: string;
  load: () => Promise<void>;
  logout: () => void;
}

/**
 * The session holds the user and the server's capabilities. Permissions are not cached here: the UI
 * asks the server which actions it may take on each resource (api/authz), so the browser never
 * re-implements the policy and can never disagree with it.
 */
export const useSession = create<SessionState>((set) => ({
  status: "loading",

  load: async () => {
    // The identity is always confirmed with the server rather than inferred from a stored token, so a
    // stale token resolves to anonymous, and a server running without SSO (which authenticates every
    // request as its development subject) works without the browser holding a token at all.
    try {
      const [user, info] = await Promise.all([getUserInfo(), getInfo()]);
      set({ status: "authenticated", user, info, error: undefined });
    } catch (error) {
      clearToken();
      set({ status: "anonymous", error: error instanceof Error ? error.message : String(error) });
    }
  },

  logout: () => {
    clearToken();
    set({ status: "anonymous", user: undefined });
  },
}));
