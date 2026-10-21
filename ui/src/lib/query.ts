import { QueryClient } from "@tanstack/react-query";

import { ApiError } from "./http";
import { onRevisionChange } from "./revision";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Workflow state changes on the cluster's schedule, not the browser's; screens that need live
      // data subscribe to a watch stream instead of polling.
      staleTime: 5_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        // Retrying a permission or not-found error just repeats it.
        if (error instanceof ApiError && [400, 401, 403, 404, 409].includes(error.code)) return false;
        return failureCount < 2;
      },
    },
  },
});

// Every permission answer is only as good as the revision it was computed at. When the server reports
// a newer revision, drop the cached answers so buttons re-check against the new grants.
onRevisionChange(() => {
  void queryClient.invalidateQueries({ queryKey: ["authz"] });
});
