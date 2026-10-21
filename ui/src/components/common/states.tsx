import { AlertTriangle, FileQuestion, Inbox, Loader2, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ApiError } from "@/lib/http";
import { cn } from "@/lib/utils";

export function Spinner({ label, className }: { label?: string; className?: string }) {
  const { t } = useTranslation();
  return (
    <div role="status" className={cn("flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground", className)}>
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label ?? t("Loading…")}
    </div>
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

export function ErrorState({ error, className, title }: { error: unknown; className?: string; title?: string }) {
  const { t } = useTranslation();
  const forbidden = error instanceof ApiError && error.code === 403;
  const Icon = forbidden ? ShieldAlert : AlertTriangle;
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-3 rounded-lg border border-phase-fail-solid/30 bg-phase-fail-bg p-4 text-sm text-phase-fail",
        className,
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-1">
        <p className="font-semibold">{title ?? (forbidden ? t("You do not have permission to do this") : t("Something went wrong"))}</p>
        <p className="break-words">{errorMessage(error)}</p>
      </div>
    </div>
  );
}

export function EmptyState({ title, description, action, className }: { title: string; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-6 py-14 text-center", className)}>
      <Inbox className="size-8 text-muted-foreground/60" aria-hidden />
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function NotFoundState({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <div className={cn("flex flex-col items-center gap-2 py-20 text-center", className)}>
      <FileQuestion className="size-8 text-muted-foreground" aria-hidden />
      <p className="font-medium">{t("Page not found")}</p>
      <a href="/workflows" className="text-sm text-primary hover:underline">
        {t("Back to workflows")}
      </a>
    </div>
  );
}
