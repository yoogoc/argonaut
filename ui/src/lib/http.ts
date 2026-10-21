import ky, { HTTPError } from "ky";

import { getRevision, observeRevision } from "./revision";

export const AUTH_KEY = "argonaut.authorization";

export function getToken(): string | null {
  return localStorage.getItem(AUTH_KEY);
}

export function setToken(token: string) {
  localStorage.setItem(AUTH_KEY, token);
  // Artifact downloads are plain links, and a browser cannot attach an Authorization header to one.
  // Mirroring the token into a cookie is what makes those links work; the server accepts either.
  document.cookie = `authorization=${encodeURIComponent(token)}; path=/; SameSite=Lax`;
}

export function clearToken() {
  localStorage.removeItem(AUTH_KEY);
  document.cookie = "authorization=; path=/; Max-Age=0; SameSite=Lax";
}

export interface ApiErrorBody {
  code: number;
  reason: string;
  message: string;
}

/** A failure reported by the argonaut API, carrying the HTTP status and Kratos reason. */
export class ApiError extends Error {
  code: number;
  reason: string;

  constructor(code: number, reason: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.reason = reason;
  }
}

export const isForbidden = (error: unknown) => error instanceof ApiError && error.code === 403;
export const isNotFound = (error: unknown) => error instanceof ApiError && error.code === 404;
export const isConflict = (error: unknown) => error instanceof ApiError && error.code === 409;

/** Headers every API call carries; shared with the SSE client, which does not go through ky. */
export function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = token;
  const revision = getRevision();
  if (revision > 0) headers["X-Authz-Revision"] = String(revision);
  return headers;
}

export const http = ky.create({
  prefixUrl: "/api/v1",
  timeout: 60_000,
  retry: 0,
  hooks: {
    beforeRequest: [
      (request) => {
        for (const [name, value] of Object.entries(authHeaders())) request.headers.set(name, value);
      },
    ],
    beforeError: [
      async (error: HTTPError) => {
        // Kratos reports failures as {code, reason, message}; surfacing that message is the
        // difference between "Request failed with status code 400" and Argo telling the user
        // exactly which field of their manifest is wrong.
        try {
          const body = (await error.response.clone().json()) as ApiErrorBody;
          if (body?.message) {
            return new ApiError(body.code || error.response.status, body.reason ?? "", body.message) as unknown as HTTPError;
          }
        } catch {
          // Not a JSON error body; fall through to ky's own error.
        }
        return new ApiError(error.response.status, "", error.message) as unknown as HTTPError;
      },
    ],
    afterResponse: [
      (_request, _options, response) => {
        observeRevision(response.headers.get("X-Authz-Revision"));
        if (response.status === 401) {
          // The session is gone; drop it so the router sends the user back through login.
          clearToken();
        }
        return response;
      },
    ],
  },
});

/** Builds a query string, dropping empty values so the server sees absent rather than blank filters. */
export function query(params: Record<string, string | number | boolean | string[] | undefined | null>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== "") search.append(key, item);
      }
      continue;
    }
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}
