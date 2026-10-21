import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { EditorPage } from "@/editor/editor-page";
import { useNamespace } from "@/hooks/use-namespace";

export const Route = createFileRoute("/_app/templates/new")({
  validateSearch: z.object({ component: z.boolean().optional(), from: z.string().optional() }),
  component: NewTemplate,
});

function NewTemplate() {
  const { component, from } = Route.useSearch();
  const { namespace } = useNamespace();
  return <EditorPage scope={{ cluster: false, namespace }} component={component} from={from} />;
}
