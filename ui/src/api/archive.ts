import { keepPreviousData, queryOptions } from "@tanstack/react-query";

import { http, query } from "@/lib/http";
import { streamEvents } from "@/lib/sse";

import type { List, LogEntry, Workflow } from "./types";

// The workflow archive (DESIGN §2.4): runs the controller moved to its database after removing them
// from the cluster. They are addressed by UID, since a later run may reuse the name.

export interface ArchiveListParams {
  namespace: string;
  namePrefix?: string;
  labelSelector?: string;
  phases?: string[];
  limit?: number;
  continueToken?: string;
}

export async function listArchived(params: ArchiveListParams): Promise<List<Workflow>> {
  return (await http.get(`archived-workflows${query({ ...params })}`).json<{ list: List<Workflow> }>()).list;
}

export async function getArchived(uid: string): Promise<Workflow> {
  return (await http.get(`archived-workflows/${uid}`).json<{ workflow: Workflow }>()).workflow;
}

export async function deleteArchived(uid: string) {
  await http.delete(`archived-workflows/${uid}`).json();
}

export async function resubmitArchived(uid: string, options: { memoized?: boolean; parameters?: string[] } = {}): Promise<Workflow> {
  return (await http.put(`archived-workflows/${uid}/resubmit`, { json: options }).json<{ workflow: Workflow }>()).workflow;
}

export async function retryArchived(uid: string, options: { restartSuccessful?: boolean; nodeFieldSelector?: string; parameters?: string[] } = {}): Promise<Workflow> {
  return (await http.put(`archived-workflows/${uid}/retry`, { json: options }).json<{ workflow: Workflow }>()).workflow;
}

export function streamArchivedLogs(uid: string, params: { nodeId?: string; grep?: string }, options: { onEntry: (entry: LogEntry) => void; onError?: (e: unknown) => void }) {
  // An archived log is a finished file: read it once, never reconnect.
  return streamEvents<LogEntry>(`archived-workflows/${uid}/log${query({ ...params })}`, { onMessage: options.onEntry, onError: options.onError, retry: false });
}

export function archivedArtifactUrl(uid: string, nodeId: string, artifactName: string, isInput = false) {
  return `/api/v1/archived-artifacts/${uid}/${nodeId}/${encodeURIComponent(artifactName)}${isInput ? "?input=true" : ""}`;
}

export const archiveQueries = {
  list: (params: ArchiveListParams) => queryOptions({ queryKey: ["archived", "list", params], queryFn: () => listArchived(params), placeholderData: keepPreviousData }),
  detail: (uid: string) => queryOptions({ queryKey: ["archived", "detail", uid], queryFn: () => getArchived(uid), staleTime: Infinity }),
};
