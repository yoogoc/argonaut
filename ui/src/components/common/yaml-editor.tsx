import { lazy, Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import type { YamlDiffProps, YamlEditorProps } from "./yaml-editor-impl";

// Monaco is several megabytes; it loads only when an editor is first shown (DESIGN §5.3).
const LazyEditor = lazy(() => import("./yaml-editor-impl").then((m) => ({ default: m.YamlEditorImpl })));
const LazyDiff = lazy(() => import("./yaml-editor-impl").then((m) => ({ default: m.YamlDiffImpl })));

function Fallback({ className }: { className?: string }) {
  return <Skeleton className={cn("h-full min-h-40 w-full rounded-md", className)} />;
}

export function YamlEditor(props: YamlEditorProps) {
  return (
    <Suspense fallback={<Fallback className={props.className} />}>
      <LazyEditor {...props} />
    </Suspense>
  );
}

export function YamlDiff(props: YamlDiffProps) {
  return (
    <Suspense fallback={<Fallback className={props.className} />}>
      <LazyDiff {...props} />
    </Suspense>
  );
}
