import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { EditorPage } from "@/editor/editor-page";

export const Route = createFileRoute("/_app/cluster-templates/new")({
  validateSearch: z.object({ copy: z.string().min(1).optional() }),
  component: NewClusterTemplate,
});

function NewClusterTemplate() {
  const { copy } = Route.useSearch();
  return <EditorPage scope={{ cluster: true }} copy={copy} />;
}
