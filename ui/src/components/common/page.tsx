import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

/** The standard content column of a page. */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <main className={cn("mx-auto flex w-full max-w-[1440px] flex-1 flex-col gap-5 px-4 py-6 sm:px-6", className)}>{children}</main>;
}

/**
 * A page's header line: where the page sits, its title and badges, then its facts or description,
 * which wrap under the title when the line is narrow.
 *
 * The facts carry their own divider, pulled left by its padding: after the title the title's right
 * margin makes up for it, and at the start of a line it falls outside the clipped row, so a wrapped
 * line lines up with the title and never starts with a stray rule.
 */
export function TitleRow({ breadcrumb, title, facts, className }: { breadcrumb?: ReactNode; title: ReactNode; facts?: ReactNode; className?: string }) {
  const { t } = useTranslation();
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2.5 gap-y-1 overflow-hidden", className)}>
      {breadcrumb && (
        <nav aria-label={t("Breadcrumb")} className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          {breadcrumb}
          <span aria-hidden>/</span>
        </nav>
      )}
      <div className={cn("flex flex-wrap items-center gap-x-2.5 gap-y-1", facts && "mr-[15px]")}>{title}</div>
      {facts && <div className="-ml-[13px] flex flex-wrap items-center gap-x-4 gap-y-1 border-l pl-3 text-[13px] text-muted-foreground">{facts}</div>}
    </div>
  );
}

/** The header of a page: its title line (TitleRow) with the page's actions on the right. */
export function PageHeader({ title, description, actions, breadcrumb }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; breadcrumb?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
      <TitleRow
        className="min-w-0 flex-[1_1_20rem]"
        breadcrumb={breadcrumb}
        title={<h1 className="flex flex-wrap items-center gap-2.5 text-2xl font-bold tracking-tight">{title}</h1>}
        facts={description}
      />
      {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
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
