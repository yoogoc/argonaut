import { createFileRoute } from "@tanstack/react-router";

import { EditorPage } from "@/editor/editor-page";

export const Route = createFileRoute("/_app/cluster-templates/$name_/edit")({
  component: EditClusterTemplate,
});

function EditClusterTemplate() {
  const { name } = Route.useParams();
  return <EditorPage key={name} scope={{ cluster: true }} name={name} />;
}
