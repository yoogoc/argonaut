import { createRouter } from "@tanstack/react-router";

import { queryClient } from "@/lib/query";

import { routeTree } from "./routeTree.gen";

export const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
  // Query owns caching; the router should always ask it rather than keep its own stale copy.
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
