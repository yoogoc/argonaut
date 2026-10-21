import { useTranslation } from "react-i18next";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useNamespace } from "@/hooks/use-namespace";

export function NamespaceSwitcher() {
  const { t } = useTranslation();
  const { namespace, setNamespace, namespaces } = useNamespace();
  return (
    <Select value={namespace} onValueChange={setNamespace}>
      <SelectTrigger size="sm" aria-label={t("Namespace")} className="min-w-36 gap-2">
        <span className="text-muted-foreground">{t("Namespace")}</span>
        <SelectValue className="font-mono" />
      </SelectTrigger>
      <SelectContent align="end">
        {namespaces.map((ns) => (
          <SelectItem key={ns} value={ns} className="font-mono">
            {ns}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
