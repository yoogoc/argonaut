import { cn } from "@/lib/utils";

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2 text-base font-bold tracking-tight", className)}>
      <span aria-hidden className="flex size-[26px] items-center justify-center rounded-[7px] bg-foreground text-background">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="6" cy="6" r="2.5" />
          <circle cx="18" cy="12" r="2.5" />
          <circle cx="6" cy="18" r="2.5" />
          <path d="M8.5 6.5 15.5 11M8.5 17.5l7-4.5" />
        </svg>
      </span>
      argonaut
    </span>
  );
}
