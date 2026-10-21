import { createFileRoute } from "@tanstack/react-router";

import { EditorPage } from "@/editor/editor-page";

export const Route = createFileRoute("/_app/cluster-templates/new")({
  component: () => <EditorPage scope={{ cluster: true }} />,
});
