import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";

import { ErrorState, NotFoundState } from "@/components/common/states";

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
  errorComponent: ({ error }) => <ErrorState error={error} className="m-8" />,
  notFoundComponent: () => <NotFoundState className="m-8" />,
});
