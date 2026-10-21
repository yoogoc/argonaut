import { EventStreamContentType, fetchEventSource } from "@microsoft/fetch-event-source";

import { ApiError, authHeaders } from "./http";
import { observeRevision } from "./revision";

class FatalStreamError extends Error {}

/**
 * Consumes a Server-Sent Events endpoint of the API.
 *
 * The browser's EventSource cannot send an Authorization header, and every stream here is
 * authenticated, so streams go through fetch. A non-2xx response is reported as an error rather than
 * retried forever; a dropped connection is retried with backoff, unless `retry` is false (log
 * streams, where a reconnect would replay the log from the start).
 */
export function streamEvents<T>(
  path: string,
  options: {
    onMessage: (data: T) => void;
    onError?: (error: unknown) => void;
    onOpen?: () => void;
    onClose?: () => void;
    retry?: boolean;
  },
): () => void {
  const controller = new AbortController();
  const retry = options.retry ?? true;

  void fetchEventSource(`/api/v1/${path.replace(/^\//, "")}`, {
    headers: authHeaders(),
    signal: controller.signal,
    openWhenHidden: true,
    async onopen(response) {
      observeRevision(response.headers.get("X-Authz-Revision"));
      if (response.ok && response.headers.get("content-type")?.startsWith(EventStreamContentType)) {
        options.onOpen?.();
        return;
      }
      let message = `stream failed with status ${response.status}`;
      let reason = "";
      try {
        const body = (await response.json()) as { message?: string; reason?: string };
        if (body.message) message = body.message;
        reason = body.reason ?? "";
      } catch {
        // Keep the status-based message.
      }
      throw new FatalStreamError(JSON.stringify({ code: response.status, reason, message }));
    },
    onmessage(event) {
      if (!event.data) return;
      try {
        options.onMessage(JSON.parse(event.data) as T);
      } catch {
        // A frame we cannot parse is dropped rather than killing the stream.
      }
    },
    onclose() {
      options.onClose?.();
      if (retry) throw new Error("stream closed; reconnecting");
      controller.abort();
    },
    onerror(error) {
      if (error instanceof FatalStreamError) {
        const parsed = JSON.parse(error.message) as { code: number; reason: string; message: string };
        options.onError?.(new ApiError(parsed.code, parsed.reason, parsed.message));
        throw error;
      }
      if (!retry) {
        options.onError?.(error);
        throw error;
      }
      // Returning undefined lets the library retry with its default interval.
      return 2000;
    },
  }).catch(() => {
    // Fatal errors were already reported through onError; an abort is how callers stop the stream.
  });

  return () => controller.abort();
}
