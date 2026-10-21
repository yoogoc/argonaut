import { createFileRoute } from "@tanstack/react-router";

import { EditorPage } from "@/editor/editor-page";

export const Route = createFileRoute("/_app/templates/$namespace/$name_/edit")({
  component: EditTemplate,
});

function EditTemplate() {
  const { namespace, name } = Route.useParams();
  return <EditorPage key={`${namespace}/${name}`} scope={{ cluster: false, namespace }} name={name} />;
}
