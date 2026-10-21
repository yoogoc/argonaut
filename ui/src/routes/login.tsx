import { createFileRoute } from "@tanstack/react-router";
import { LogIn } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { getLoginUrl } from "@/api/auth";
import { Logo } from "@/components/common/logo";
import { ErrorState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/login")({
  validateSearch: z.object({ redirect: z.string().optional() }),
  component: LoginPage,
});

function LoginPage() {
  const { t } = useTranslation();
  const { redirect } = Route.useSearch();
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);

  const signIn = async () => {
    setPending(true);
    setError(undefined);
    try {
      window.location.href = await getLoginUrl(redirect || "/workflows");
    } catch (err) {
      setError(err);
      setPending(false);
    }
  };

  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="gap-4">
          <Logo />
          <div className="space-y-1">
            <CardTitle>{t("Sign in")}</CardTitle>
            <CardDescription>{t("Use your organization account to continue.")}</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {error !== undefined && <ErrorState error={error} />}
          <Button className="w-full" onClick={signIn} disabled={pending}>
            <LogIn aria-hidden />
            {pending ? t("Redirecting…") : t("Sign in with SSO")}
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
