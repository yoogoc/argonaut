import { Link } from "@tanstack/react-router";
import { Copy } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { TemplateRef } from "@/api/templates";
import { Button } from "@/components/ui/button";

export function CopyTemplateButton({ templateRef, component = false, compact = false }: { templateRef: TemplateRef; component?: boolean; compact?: boolean }) {
  const { t } = useTranslation();
  const label = t(component ? "Copy component" : "Copy template");
  const content = <><Copy aria-hidden />{!compact && label}</>;

  return (
    <Button asChild variant={compact ? "ghost" : "outline"} size={compact ? "icon-sm" : "default"}>
      {templateRef.cluster ? (
        <Link to="/cluster-templates/new" search={{ copy: templateRef.name }} aria-label={label} title={label}>
          {content}
        </Link>
      ) : (
        <Link to="/templates/new" search={{ copy: templateRef.name, namespace: templateRef.namespace }} aria-label={label} title={label}>
          {content}
        </Link>
      )}
    </Button>
  );
}
