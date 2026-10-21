import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/admin/authz")({
  component: () => <main className="p-6 text-sm text-muted-foreground">Permissions</main>,
});
