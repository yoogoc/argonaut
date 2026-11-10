import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { EditorPage } from "@/editor/editor-page";
import { useNamespace } from "@/hooks/use-namespace";

export const Route = createFileRoute("/_app/templates/new")({
  validateSearch: z.object({ component: z.boolean().optional(), from: z.string().optional(), copy: z.string().min(1).optional(), namespace: z.string().min(1).optional() }),
  component: NewTemplate,
});

function NewTemplate() {
  const { component, from, copy, namespace: copyNamespace } = Route.useSearch();
  const { namespace } = useNamespace();
  return <EditorPage scope={{ cluster: false, namespace: copy ? (copyNamespace ?? namespace) : namespace }} component={component} from={from} copy={copy} />;
}
