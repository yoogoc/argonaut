import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Check, ChevronDown, Loader2, Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { clusterQueries, type ClusterStatus, switchCluster } from "@/api/clusters";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useClusterState } from "@/stores/cluster";
import { useSession } from "@/stores/session";

import { errorMessage } from "./states";

/** Colour of a cluster's environment: production stands out everywhere it is shown. */
export const envTone = (env?: string) => (env === "prod" ? "bg-phase-fail-solid" : env === "uat" ? "bg-amber-500" : "bg-muted-foreground/50");

/**
 * Switches the instance between the clusters listed in cluster_switch (docs/multi-cluster.md). Only
 * shown when the server reports a switchable cluster; only super admins may switch, since it moves
 * every user of the instance.
 */
export function ClusterSwitcher() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const info = useSession((s) => s.info);
  const superAdmin = useSession((s) => !!s.user?.superAdmin);
  const load = useSession((s) => s.load);
  const list = useQuery({ ...clusterQueries.list(), enabled: !!info?.cluster });

  const change = useMutation({
    mutationFn: (c: ClusterStatus) => switchCluster(c.id!),
    onSuccess: async (cluster) => {
      useClusterState.getState().expect(cluster?.id);
      // Everything cached belongs to the previous cluster.
      queryClient.clear();
      await load();
      void navigate({ to: "/workflows" });
      toast.success(t("Connected to {{name}}", { name: cluster?.name ?? cluster?.id }));
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: ["clusters"] });
      toast.error(t("Could not switch cluster"), {
        description: errorMessage(error),
        duration: 10000,
      });
    },
  });

  if (!info?.cluster) return null;
  const current = info.cluster;
  const clusters = list.data?.clusters ?? [];
  const target = change.isPending ? change.variables : undefined;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2" aria-label={t("Cluster")}>
            <span aria-hidden className={cn("size-2 rounded-full", envTone(current.env))} />
            <span className="text-muted-foreground">{t("Cluster")}</span>
            <span className="max-w-40 truncate font-medium">{current.name || current.id}</span>
            <ChevronDown className="opacity-50" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            {superAdmin ? t("Switching moves everyone using this instance to the chosen cluster.") : t("Only a super admin can switch clusters.")}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {clusters.map((c) => (
            <DropdownMenuItem key={c.id} disabled={!superAdmin || c.current || change.isPending} onSelect={() => change.mutate(c)} className="flex-col items-start gap-0.5">
              <span className="flex w-full items-center gap-2">
                <span aria-hidden className={cn("size-2 shrink-0 rounded-full", envTone(c.env))} />
                <span className="truncate font-medium">{c.name || c.id}</span>
                {c.env && <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground uppercase">{c.env}</span>}
                {c.current && <Check className="ml-auto size-3.5" aria-label={t("Current")} />}
              </span>
              {c.context && <span className="w-full truncate pl-4 font-mono text-[11px] text-muted-foreground">{c.context}</span>}
              {c.lastError && (
                <span className="flex w-full items-start gap-1 pl-4 text-[11px] text-destructive">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
                  <span className="line-clamp-2">{c.lastError}</span>
                </span>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {target && (
        <div role="status" className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex items-center gap-3 rounded-xl border bg-card px-5 py-4 shadow-lg">
            <Loader2 className="size-5 animate-spin text-primary" aria-hidden />
            <div className="flex flex-col">
              <span className="font-medium">
                {t("Connecting to {{name}}…", {
                  name: target.name || target.id,
                })}
              </span>
              <span className="text-xs text-muted-foreground">{t("Loading its workflows and templates; this can take a few seconds.")}</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** A thin red strip and a label while the instance is connected to a production cluster. */
export function ProductionMarker() {
  const { t } = useTranslation();
  const cluster = useSession((s) => s.info?.cluster);
  if (cluster?.env !== "prod") return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-phase-fail-solid px-2 py-0.5 text-xs font-semibold text-white">
      <Server className="size-3" aria-hidden />
      {t("Production")}
    </span>
  );
}

/** Shown when a response came from a different cluster than this page expects: someone switched. */
export function ClusterChangedNotice() {
  const { t } = useTranslation();
  const changedTo = useClusterState((s) => s.changedTo);
  if (!changedTo) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 border-b bg-amber-100 px-4 py-2 text-sm text-amber-950 sm:px-6 dark:bg-amber-950 dark:text-amber-100">
      <AlertTriangle className="size-4 shrink-0" aria-hidden />
      <span className="flex-1">{t("This instance was switched to cluster {{id}}. What you see may belong to the previous cluster.", { id: changedTo })}</span>
      <Button size="sm" variant="outline" onClick={() => window.location.assign("/workflows")}>
        {t("Reload")}
      </Button>
    </div>
  );
}
