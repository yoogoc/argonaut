import { http, query } from "@/lib/http";

import type { Info, UserInfo } from "./types";

/** Asks the server where to send the browser to log in, remembering the page to return to. */
export async function getLoginUrl(redirect: string): Promise<string> {
  const reply = await http.get(`oauth2/redirect${query({ redirect })}`).json<{ redirectUri: string }>();
  return reply.redirectUri;
}

/** Completes the login, exchanging the provider's code for an argonaut session token. */
export async function completeLogin(state: string, code: string): Promise<{ authorization: string; redirectUri: string }> {
  return http.get(`oauth2/callback${query({ state, code })}`).json();
}

export async function getUserInfo(): Promise<UserInfo> {
  return http.get("oauth2/userinfo").json<UserInfo>();
}

export async function getInfo(): Promise<Info> {
  return http.get("info").json<Info>();
}
