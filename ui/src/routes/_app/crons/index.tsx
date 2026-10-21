import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/crons/")({
  component: () => <main className="p-6 text-sm text-muted-foreground">CronWorkflows</main>,
});
