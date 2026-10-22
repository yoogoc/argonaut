import { type ReactNode, useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

const STORAGE_KEY = "argonaut.sidePanelWidth";
const MIN = 360;
const DEFAULT = 480;
// Leave the graph at least this much room.
const GRAPH_MIN = 320;

function stored(): number {
  try {
    const n = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(n) && n >= MIN ? n : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

const clamp = (w: number) => Math.round(Math.min(Math.max(w, MIN), Math.max(MIN, window.innerWidth - GRAPH_MIN)));

/**
 * The right-hand panel of the run views (node and artifact details). On wide screens its left edge
 * drags to resize it, or takes arrow keys when focused; double-click restores the default. The width
 * is remembered per browser. On narrow screens it stacks full-width under the graph.
 */
export function SidePanel({ label, children }: { label: string; children: ReactNode }) {
  const { t } = useTranslation();
  const [width, setWidth] = useState(() => clamp(stored()));
  const dragging = useRef<{ startX: number; startWidth: number } | undefined>(undefined);

  const commit = useCallback((w: number) => {
    const next = clamp(w);
    setWidth(next);
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // Not remembering the width is harmless.
    }
  }, []);

  return (
    <aside aria-label={label} style={{ "--panel-w": `${width}px` } as React.CSSProperties} className="relative flex h-full min-h-0 w-full flex-col border-l bg-card lg:w-(--panel-w) lg:shrink-0">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("Resize panel")}
        aria-valuenow={width}
        aria-valuemin={MIN}
        tabIndex={0}
        title={t("Drag to resize · double-click to reset")}
        className="absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-[3px] after:w-0.5 after:bg-transparent after:transition-colors hover:after:bg-primary/60 focus-visible:after:bg-primary lg:block"
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          dragging.current = { startX: e.clientX, startWidth: width };
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
        onPointerMove={(e) => {
          const d = dragging.current;
          // The panel sits on the right, so dragging its edge left widens it.
          if (d) setWidth(clamp(d.startWidth + d.startX - e.clientX));
        }}
        onPointerUp={(e) => {
          if (!dragging.current) return;
          dragging.current = undefined;
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
          e.currentTarget.releasePointerCapture(e.pointerId);
          commit(width);
        }}
        onDoubleClick={() => commit(DEFAULT)}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 80 : 20;
          if (e.key === "ArrowLeft") commit(width + step);
          else if (e.key === "ArrowRight") commit(width - step);
          else return;
          e.preventDefault();
        }}
      />
      <div className={cn("flex min-h-0 flex-1 flex-col")}>{children}</div>
    </aside>
  );
}
