import { createContext, useContext } from "react";

import { archivedArtifactUrl } from "@/api/archive";
import type { Workflow } from "@/api/types";
import { artifactUrl } from "@/api/workflows";

/**
 * Where the run on screen comes from. The node panel, log viewer and artifact links are shared by
 * live and archived runs; an archived run has no pods and is addressed by UID, so they read their
 * endpoints from here.
 */
export interface RunSource {
  archivedUid?: string;
}

const RunSourceContext = createContext<RunSource>({});

export const RunSourceProvider = RunSourceContext.Provider;

export function useRunSource(): RunSource {
  return useContext(RunSourceContext);
}

/** Builds artifact download links for the current run source. */
export function useArtifactHref() {
  const { archivedUid } = useRunSource();
  return (workflow: Workflow, nodeId: string, name: string, isInput: boolean) =>
    archivedUid ? archivedArtifactUrl(archivedUid, nodeId, name, isInput) : artifactUrl(workflow.metadata.namespace, workflow.metadata.name, nodeId, name, isInput);
}
