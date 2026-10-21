import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/components")({
  component: () => <main className="p-6 text-sm text-muted-foreground">Components</main>,
});
