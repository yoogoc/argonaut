import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { templateQueries } from "@/api/templates";
import { ErrorState, Spinner } from "@/components/common/states";
import { TemplateDetail } from "@/templates/template-detail";

export const Route = createFileRoute("/_app/templates/$namespace/$name")({
  validateSearch: z.object({ tab: z.enum(["overview", "runs", "yaml", "revisions"]).optional() }),
  loader: ({ context, params }) => context.queryClient.ensureQueryData(templateQueries.detail({ cluster: false, namespace: params.namespace, name: params.name })),
  pendingComponent: () => <Spinner className="mt-20" />,
  errorComponent: ({ error }) => <ErrorState error={error} className="m-6" />,
  component: function TemplatePage() {
    const { namespace, name } = Route.useParams();
    const { tab } = Route.useSearch();
    const navigate = Route.useNavigate();
    return <TemplateDetail templateRef={{ cluster: false, namespace, name }} tab={tab ?? "overview"} onTab={(next) => void navigate({ search: { tab: next }, replace: true })} />;
  },
});
