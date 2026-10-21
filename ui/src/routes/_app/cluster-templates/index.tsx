import { createFileRoute } from "@tanstack/react-router";

import { TemplateList } from "@/templates/template-list";

export const Route = createFileRoute("/_app/cluster-templates/")({
  component: () => <TemplateList scope={{ cluster: true }} />,
});
