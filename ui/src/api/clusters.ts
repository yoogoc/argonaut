import { queryOptions } from "@tanstack/react-query";

import { http } from "@/lib/http";

import type { ClusterInfo, ClusterStatus, ListClustersReply } from "./gen/api.gen";

export type { ClusterInfo, ClusterStatus };

export async function listClusters(): Promise<ListClustersReply> {
  return http.get("clusters").json<ListClustersReply>();
}

/** Connects the instance to another cluster; resolves once that cluster has loaded. */
export async function switchCluster(id: string): Promise<ClusterInfo | undefined> {
  // Loading a cluster can take as long as its informers take to list everything.
  return (await http.put("clusters/current", { json: { id }, timeout: 60_000 }).json<{ cluster?: ClusterInfo }>()).cluster;
}

export const clusterQueries = {
  list: () => queryOptions({ queryKey: ["clusters"], queryFn: listClusters, refetchInterval: (q) => (q.state.data?.clusters?.some((c) => c.switching) ? 1000 : false) }),
};
