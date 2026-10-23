import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, FileStack, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { templateQueries } from "@/api/templates";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** "cluster/<name>" selects a ClusterWorkflowTemplate; a bare name a WorkflowTemplate. */
const CLUSTER = "cluster/";

/**
 * Filters runs by the template they were started from. Several may be picked; a run matches any of
 * them. The list offers this namespace's templates and the cluster templates.
 */
export function TemplateFilter({ namespace, value, onChange }: { namespace: string; value: string[]; onChange: (keys: string[]) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const local = useQuery({ ...templateQueries.list({ cluster: false, namespace }), enabled: open || value.length > 0 });
  const cluster = useQuery({ ...templateQueries.list({ cluster: true }), enabled: open || value.length > 0 });
  const names = (list: typeof local.data) => (list?.items ?? []).map((tpl) => tpl.metadata.name).sort();

  const toggle = (key: string) => onChange(value.includes(key) ? value.filter((v) => v !== key) : [...value, key]);
  const label = (key: string) => (key.startsWith(CLUSTER) ? `${key.slice(CLUSTER.length)} (${t("cluster")})` : key);

  const item = (key: string) => (
    <CommandItem key={key} value={key} onSelect={() => toggle(key)} className="font-mono text-xs">
      <Check className={cn("size-3.5", value.includes(key) ? "opacity-100" : "opacity-0")} aria-hidden />
      <span className="truncate">{key.startsWith(CLUSTER) ? key.slice(CLUSTER.length) : key}</span>
    </CommandItem>
  );

  return (
    <div className="flex items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className={cn("h-8 max-w-72 gap-1.5 font-normal", value.length > 0 && "border-primary/50 text-primary")} aria-label={t("Filter by template")}>
            <FileStack aria-hidden />
            <span className="truncate">
              {value.length === 0 ? t("Template") : value.length === 1 ? label(value[0]) : t("{{count}} templates", { count: value.length })}
            </span>
            <ChevronDown className="opacity-50" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-0">
          <Command>
            <CommandInput placeholder={t("Search templates")} />
            <CommandList className="max-h-80">
              <CommandEmpty>{local.isPending || cluster.isPending ? t("Loading…") : t("No templates")}</CommandEmpty>
              {names(local.data).length > 0 && <CommandGroup heading={namespace}>{names(local.data).map((n) => item(n))}</CommandGroup>}
              {names(cluster.data).length > 0 && <CommandGroup heading={t("Cluster templates")}>{names(cluster.data).map((n) => item(CLUSTER + n))}</CommandGroup>}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value.length > 0 && (
        <Button variant="ghost" size="icon" className="size-8" aria-label={t("Clear template filter")} onClick={() => onChange([])}>
          <X aria-hidden />
        </Button>
      )}
    </div>
  );
}
