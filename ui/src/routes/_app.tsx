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

// The layout is exactly the viewport tall and pages scroll inside it, so full-height views (run
// details, the editor) get a bounded area: their panels and log views scroll rather than stretching
// the page.
function AppLayout() {
  return (
    <div className="flex h-dvh flex-col">
      <AppHeader />
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}
