import { createFileRoute } from "@tanstack/react-router";

import { useNamespace } from "@/hooks/use-namespace";
import { TemplateList } from "@/templates/template-list";

export const Route = createFileRoute("/_app/templates/")({
  component: function TemplatesPage() {
    const { namespace } = useNamespace();
    return <TemplateList scope={{ cluster: false, namespace }} />;
  },
});
