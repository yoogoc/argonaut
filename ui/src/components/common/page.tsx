import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** The standard content column of a page. */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <main className={cn("mx-auto flex w-full max-w-[1440px] flex-1 flex-col gap-5 px-4 py-6 sm:px-6", className)}>{children}</main>;
}

export function PageHeader({ title, description, actions, breadcrumb, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; breadcrumb?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
      <div className="flex min-w-0 flex-col gap-1">
        {breadcrumb && <div className="text-[13px] text-muted-foreground">{breadcrumb}</div>}
        <h1 className="flex flex-wrap items-center gap-2.5 text-2xl font-bold tracking-tight">{title}</h1>
        {description && <div className="text-sm text-muted-foreground">{description}</div>}
        {children}
      </div>
      {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Section({ title, description, actions, children, className, bodyClassName }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cn("overflow-hidden rounded-xl border bg-card text-card-foreground", className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
          {title && <h2 className="text-sm font-bold">{title}</h2>}
          {description && <span className="text-xs text-muted-foreground">{description}</span>}
          {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

/** A two-column definition list. */
export function Fields({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[minmax(6rem,max-content)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm", className)}>
      {items.map(([label, value], index) => (
        <div key={index} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[0.92em]", className)}>{children}</span>;
}
