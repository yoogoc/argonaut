import { create } from "zustand";

/**
 * Which cluster this page believes the instance is connected to, and whether a response came back
 * from a different one: someone switched the instance (docs/multi-cluster.md). Fed from the
 * X-Argonaut-Cluster header of every API response; kept apart from the session store so the HTTP
 * client can update it without an import cycle.
 */
interface ClusterState {
  expected?: string;
  changedTo?: string;
  expect: (id?: string) => void;
  observe: (id: string | null) => void;
}

export const useClusterState = create<ClusterState>((set, get) => ({
  expect: (id) => set({ expected: id, changedTo: undefined }),
  observe: (id) => {
    const { expected, changedTo } = get();
    if (!id || !expected || id === expected || id === changedTo) return;
    set({ changedTo: id });
  },
}));
