import { useVirtualizer } from "@tanstack/react-virtual";
import Anser from "anser";
import { Download, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { streamArchivedLogs } from "@/api/archive";
import type { LogEntry, Workflow } from "@/api/types";
import { streamLogs } from "@/api/workflows";
import { ErrorState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import { useRunSource } from "./run-source";

const MAX_LINES = 200_000;

/** One rendered line; ANSI colour runs become styled spans. */
function LogLine({ text }: { text: string }) {
  const parts = useMemo(() => Anser.ansiToJson(text, { use_classes: false, remove_empty: true }), [text]);
  return (
    <>
      {parts.map((part, i) => (
        <span key={i} style={{ color: part.fg ? `rgb(${part.fg})` : undefined, fontWeight: part.decorations?.includes("bold") ? 600 : undefined }}>
          {part.content}
        </span>
      ))}
    </>
  );
}

/**
 * Live container logs (DESIGN §5.3 LogViewer): virtualized so a pod's whole log fits, ANSI colours,
 * a client-side filter on top of the server-side one, and follow mode while the step runs.
 */
export function LogViewer({
  workflow,
  podName,
  nodeId,
  containers,
  running,
}: {
  workflow: Workflow;
  podName?: string;
  nodeId?: string;
  containers: string[];
  running: boolean;
}) {
  const { t } = useTranslation();
  const { archivedUid } = useRunSource();
  const [container, setContainer] = useState(containers[0] ?? "main");
  const [grep, setGrep] = useState("");
  const [timestamps, setTimestamps] = useState(false);
  const [follow, setFollow] = useState(true);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<unknown>();
  const [ended, setEnded] = useState(false);
  const buffer = useRef<string[]>([]);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containers.includes(container) && containers[0]) setContainer(containers[0]);
  }, [containers, container]);

  useEffect(() => {
    buffer.current = [];
    setLines([]);
    setError(undefined);
    setEnded(false);
    // Lines arrive in bursts; batching them into one render per frame keeps a fast log smooth.
    let frame = 0;
    const flush = () => {
      frame = 0;
      setLines(buffer.current.length > MAX_LINES ? buffer.current.slice(-MAX_LINES) : buffer.current.slice());
    };
    const handlers = {
      onEntry: (entry: LogEntry) => {
        // An empty line arrives without content: the server omits empty fields.
        buffer.current.push(entry.content ?? "");
        if (!frame) frame = requestAnimationFrame(flush);
      },
      onError: setError,
    };
    // An archived run's pods are gone; its logs come from the artifact repository by node.
    const stop = archivedUid
      ? streamArchivedLogs(archivedUid, { nodeId }, handlers)
      : streamLogs(workflow.metadata.namespace, workflow.metadata.name, { podName, nodeId, container, follow: running, timestamps, tailLines: running ? 5000 : undefined }, handlers);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      stop();
      setEnded(true);
    };
  }, [workflow.metadata.namespace, workflow.metadata.name, podName, nodeId, container, timestamps, running, archivedUid]);

  const filtered = useMemo(() => {
    if (!grep) return lines;
    const needle = grep.toLowerCase();
    return lines.filter((l) => l.toLowerCase().includes(needle));
  }, [lines, grep]);

  const virtualizer = useVirtualizer({ count: filtered.length, getScrollElement: () => scroller.current, estimateSize: () => 20, overscan: 30 });

  useEffect(() => {
    if (follow && filtered.length) virtualizer.scrollToIndex(filtered.length - 1, { align: "end" });
  }, [filtered.length, follow, virtualizer]);

  const download = () => {
    const blob = new Blob([lines.map((l) => Anser.ansiToText(l)).join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${podName ?? workflow.metadata.name}-${container}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {containers.length > 1 ? (
          <Select value={container} onValueChange={setContainer}>
            <SelectTrigger size="sm" className="w-32 font-mono" aria-label={t("Container")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {containers.map((c) => (
                <SelectItem key={c} value={c} className="font-mono">
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="rounded-md border px-2 py-1 font-mono text-xs">{container}</span>
        )}
        <label className="relative min-w-32 flex-1">
          <span className="sr-only">{t("Filter logs")}</span>
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={grep} onChange={(e) => setGrep(e.target.value)} placeholder="grep" className="h-8 pl-7 font-mono text-xs" />
        </label>
        <div className="flex items-center gap-1.5">
          <Switch id="log-ts" checked={timestamps} onCheckedChange={setTimestamps} />
          <Label htmlFor="log-ts" className="text-xs font-normal">
            {t("Timestamps")}
          </Label>
        </div>
        <div className="flex items-center gap-1.5">
          <Switch id="log-follow" checked={follow} onCheckedChange={setFollow} />
          <Label htmlFor="log-follow" className="text-xs font-normal">
            {t("Follow")}
          </Label>
        </div>
        <Button variant="ghost" size="icon" className="size-8" onClick={download} aria-label={t("Download logs")} disabled={!lines.length}>
          <Download aria-hidden />
        </Button>
      </div>
      {error !== undefined && <ErrorState error={error} />}
      <div ref={scroller} className="relative min-h-48 flex-1 overflow-auto rounded-lg bg-zinc-950 font-mono text-xs leading-5 text-zinc-200">
        {filtered.length === 0 ? (
          <p className="p-3 text-zinc-400">{grep && lines.length ? t("No lines match the filter.") : running && !ended ? t("Waiting for output…") : t("No log output.")}</p>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((item) => (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className={cn("absolute left-0 w-full px-3 break-all whitespace-pre-wrap")}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <LogLine text={filtered[item.index]} />
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        {t("{{count}} lines", { count: filtered.length })}
        {running && follow ? ` · ${t("following")}` : ""}
      </p>
    </div>
  );
}
