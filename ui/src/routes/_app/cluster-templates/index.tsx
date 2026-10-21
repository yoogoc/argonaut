import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/cluster-templates/")({
  component: () => <main className="p-6 text-sm text-muted-foreground">Cluster templates</main>,
});
