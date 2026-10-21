import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";

import { http, query } from "@/lib/http";
import { getRevision } from "@/lib/revision";

import type { AuditEvent, AuthzStatus, Grant, MyPermissions, Policy, ResourceRef, Role, RoleInfo } from "./types";

export type { Policy };

export async function listGrants(params: { subject?: string; namespace?: string; name?: string } = {}): Promise<Grant[]> {
  const reply = await http.get(`authz/grants${query({ ...params })}`).json<{ grants: Grant[] | null }>();
  return reply.grants ?? [];
}

export interface CreateGrantParams {
  subject: string;
  role: Role;
  resourceType: Grant["resourceType"];
  namespace?: string;
  /** A template name, or "*" for every template in the namespace. */
  name?: string;
}

export async function createGrant(params: CreateGrantParams): Promise<Grant> {
  const reply = await http.post("authz/grants", { json: { subjectType: "user", ...params } }).json<{ grant: Grant }>();
  return reply.grant;
}

export async function deleteGrant(id: string) {
  await http.delete(`authz/grants/${id}`).json();
}

export async function listRoles(): Promise<RoleInfo[]> {
  const reply = await http.get("authz/roles").json<{ roles: RoleInfo[] | null }>();
  return reply.roles ?? [];
}

export async function listOrphanGrants(): Promise<Grant[]> {
  const reply = await http.get("authz/orphan-grants").json<{ grants: Grant[] | null }>();
  return reply.grants ?? [];
}

export async function getAuthzStatus(): Promise<AuthzStatus> {
  return http.get("authz/status").json<AuthzStatus>();
}


export async function listPolicies(): Promise<Policy[]> {
  return (await http.get("authz/policies").json<{ policies: Policy[] | null }>()).policies ?? [];
}

export async function createPolicy(p: { name: string; description: string; body: string }) {
  return (await http.post("authz/policies", { json: p }).json<{ policy: Policy }>()).policy;
}

export async function setPolicyEnabled(p: Policy, enabled: boolean) {
  await http.put(`authz/policies/${p.id}`, { json: { id: p.id, name: p.name, enabled } }).json();
}

export async function deletePolicy(p: Policy) {
  await http.delete(`authz/policies/${p.id}${query({ name: p.name })}`).json();
}

export async function listAudit(params: { actor?: string; action?: string; result?: string; limit?: number; offset?: number }) {
  const reply = await http.get(`authz/audit${query({ ...params })}`).json<{ events: AuditEvent[] | null; total: number }>();
  return { events: reply.events ?? [], total: reply.total ?? 0 };
}

// Every permission query is keyed under "authz" so a newer revision invalidates them all (lib/query).
export const authzQueries = {
  mine: () =>
    queryOptions({
      queryKey: ["authz", "mine", getRevision()],
      queryFn: () => http.get("authz/my-permissions").json<MyPermissions>(),
      staleTime: 60_000,
    }),
  actions: (ref: ResourceRef) =>
    queryOptions({
      queryKey: ["authz", "actions", ref.namespace ?? "", ref.template ?? "", ref.clusterTemplate ?? ""],
      queryFn: async () => {
        const reply = await http.get(`authz/actions${query({ ...ref })}`).json<{ actions: string[] | null }>();
        return new Set(reply.actions ?? []);
      },
      staleTime: 60_000,
      placeholderData: keepPreviousData,
    }),
};

export function useMyPermissions() {
  return useQuery(authzQueries.mine());
}

/**
 * The actions the server would allow on a resource. The UI never evaluates the policy itself; it asks
 * the same engine that enforces it, so a button is shown exactly when the request would succeed.
 */
export function useActions(ref: ResourceRef | undefined) {
  const result = useQuery({ ...authzQueries.actions(ref ?? {}), enabled: !!ref });
  return {
    can: (action: string) => !!result.data?.has(action),
    loading: result.isPending,
  };
}
