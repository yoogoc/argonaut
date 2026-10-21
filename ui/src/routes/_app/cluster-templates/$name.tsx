import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { templateQueries } from "@/api/templates";
import { ErrorState, Spinner } from "@/components/common/states";
import { TemplateDetail } from "@/templates/template-detail";

export const Route = createFileRoute("/_app/cluster-templates/$name")({
  validateSearch: z.object({ tab: z.enum(["overview", "runs", "yaml", "revisions"]).optional() }),
  loader: ({ context, params }) => context.queryClient.ensureQueryData(templateQueries.detail({ cluster: true, name: params.name })),
  pendingComponent: () => <Spinner className="mt-20" />,
  errorComponent: ({ error }) => <ErrorState error={error} className="m-6" />,
  component: function ClusterTemplatePage() {
    const { name } = Route.useParams();
    const { tab } = Route.useSearch();
    const navigate = Route.useNavigate();
    return <TemplateDetail templateRef={{ cluster: true, name }} tab={tab ?? "overview"} onTab={(next) => void navigate({ search: { tab: next }, replace: true })} />;
  },
});
