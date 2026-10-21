import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { completeLogin } from "@/api/auth";
import { ErrorState, Spinner } from "@/components/common/states";
import { setToken } from "@/lib/http";
import { useSession } from "@/stores/session";

export const Route = createFileRoute("/oauth2/callback")({
  validateSearch: z.object({ code: z.string().optional(), state: z.string().optional() }),
  component: Callback,
});

/** Where the identity provider returns to; exchanges the code for a session and resumes the journey. */
function Callback() {
  const { t } = useTranslation();
  const { code, state } = Route.useSearch();
  const navigate = useNavigate();
  const load = useSession((s) => s.load);
  const [error, setError] = useState<unknown>();
  // The code and the login state are single-use, so the exchange must run exactly once; StrictMode
  // re-runs effects on mount in development, and a ref survives that remount.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!code || !state) {
      setError(new Error(t("The identity provider did not return a code.")));
      return;
    }
    void completeLogin(state, code)
      .then(async (reply) => {
        setToken(reply.authorization);
        await load();
        await navigate({ to: reply.redirectUri || "/workflows", replace: true });
      })
      .catch(setError);
  }, [code, state, navigate, load, t]);

  if (error) {
    return (
      <main className="mx-auto mt-24 max-w-md space-y-3 px-4">
        <h1 className="text-lg font-semibold">{t("Sign-in failed")}</h1>
        <ErrorState error={error} />
        <a className="text-sm text-primary hover:underline" href="/login">
          {t("Try again")}
        </a>
      </main>
    );
  }
  return <Spinner label={t("Completing sign-in…")} className="mt-24" />;
}
