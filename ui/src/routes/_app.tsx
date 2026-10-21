import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { AppHeader } from "@/components/common/app-header";
import { useSession } from "@/stores/session";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ location }) => {
    const session = useSession.getState();
    if (session.status === "loading") await session.load();
    if (useSession.getState().status !== "authenticated") {
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }
  },
  component: AppLayout,
});

function AppLayout() {
  return (
    <div className="flex min-h-full flex-col">
      <AppHeader />
      <Outlet />
    </div>
  );
}
