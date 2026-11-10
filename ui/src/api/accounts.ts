import { queryOptions } from "@tanstack/react-query";

import { http } from "@/lib/http";

import type { CreateUserRequest, SetupStatusReply } from "./gen/api.gen";
import type { DirectoryUser } from "./types";

export type NewAccount = Required<CreateUserRequest>;

export const setupStatus = queryOptions({
  queryKey: ["setup", "status"],
  queryFn: ({ signal }) => http.get("setup", { signal }).json<SetupStatusReply>(),
  retry: false,
});

export async function setupAdmin(token: string, user: NewAccount): Promise<DirectoryUser> {
  return http.post("setup", { json: { token, user } }).json<DirectoryUser>();
}

export async function createUser(user: NewAccount): Promise<DirectoryUser> {
  return http.post("authz/users", { json: user }).json<DirectoryUser>();
}
