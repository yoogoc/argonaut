import { Minus, Plus } from "lucide-react";

import { cn } from "@/lib/utils";

/** "+" / "−" on a DAG task or group: opens or closes it in place. */
export function ToggleButton({ label, onClick, open, className }: { label: string; onClick: () => void; open?: boolean; className?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={!!open}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn("nodrag nopan flex size-5 shrink-0 items-center justify-center rounded-md border border-node-dag/40 text-node-dag hover:bg-node-dag-bg", className)}
    >
      {open ? <Minus className="size-3" aria-hidden /> : <Plus className="size-3" aria-hidden />}
    </button>
  );
}
