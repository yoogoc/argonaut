import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";

import { AccountForm } from "@/admin/account-form";
import { type NewAccount, setupAdmin, setupStatus } from "@/api/accounts";
import { Logo } from "@/components/common/logo";
import { ErrorState, Spinner } from "@/components/common/states";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError } from "@/lib/http";

export const Route = createFileRoute("/setup")({
  validateSearch: z.object({ redirect: z.string().optional() }),
  component: SetupPage,
});

function SetupPage() {
  const { t } = useTranslation();
  const { redirect } = Route.useSearch();
  const status = useQuery(setupStatus);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const setup = useMutation({
    gcTime: 0,
    mutationFn: ({ token, user }: { token: string; user: NewAccount }) => setupAdmin(token, user),
    onSuccess: () => {
      toast.success(t("Administrator added. Sign in with the matching verified Logto email."));
      queryClient.setQueryData(setupStatus.queryKey, { required: false, available: false });
      void navigate({ to: "/login", search: { redirect }, replace: true });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.reason === "setup_complete") {
        queryClient.setQueryData(setupStatus.queryKey, { required: false, available: false });
      }
    },
  });

  if (status.data && !status.data.required) return <Navigate to="/login" search={{ redirect }} replace />;
  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="gap-4">
          <Logo />
          <div className="space-y-1">
            <CardTitle><h1>{t("Set up Argonaut")}</h1></CardTitle>
            <CardDescription>{t("Add the first local administrator. The global admin role takes effect after sign-in with the matching verified Logto email.")}</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {status.isPending ? <Spinner /> : status.error ? <ErrorState error={status.error} /> : status.data?.available ? (
            <AccountForm setup pending={setup.isPending} error={setup.error} onSubmit={(user, token) => setup.mutate({ user, token })} />
          ) : (
            <p className="text-sm text-muted-foreground">{t("Configure OIDC sign-in and a setup token on the server to continue.")}</p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
