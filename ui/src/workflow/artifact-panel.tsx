import { Download, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { Artifact, NodeStatus, Workflow } from "@/api/types";
import { Fields, Mono } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import { artifactArchive, artifactLocation } from "@/lib/workflow";
import { toYaml } from "@/lib/yaml";

import { Code } from "./node-spec";
import { useArtifactHref } from "./run-source";

/** One artifact's details, with the download as a deliberate action (an archive can be large). */
export function ArtifactPanel({ workflow, node, artifact, isInput, onClose, onSelectNode }: { workflow: Workflow; node: NodeStatus; artifact: Artifact; isInput: boolean; onClose: () => void; onSelectNode: (node: NodeStatus) => void }) {
  const { t } = useTranslation();
  const location = artifactLocation(artifact);
  const artifactHref = useArtifactHref();
  const href = artifactHref(workflow, node.id, artifact.name, isInput);
  return (
    <aside aria-label={t("Artifact details")} className="flex h-full min-h-0 w-full flex-col border-l bg-card lg:w-[440px] lg:shrink-0">
      <div className="flex items-start gap-2 border-b px-5 py-4">
        <div className="min-w-0">
          <h2 className="truncate font-mono text-base font-semibold">{artifact.name}</h2>
          <p className="text-xs text-muted-foreground">
            {isInput ? t("Input artifact, read by") : t("Output artifact, produced by")}{" "}
            <button type="button" className="font-mono text-primary hover:underline" onClick={() => onSelectNode(node)}>
              {node.displayName || node.name}
            </button>
          </p>
        </div>
        <div className="ml-auto flex gap-1">
          <Button asChild size="sm">
            <a href={href} download>
              <Download aria-hidden />
              {t("Download")}
            </a>
          </Button>
          <Button variant="ghost" size="icon" className="size-8" onClick={onClose} aria-label={t("Close")}>
            <X aria-hidden />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-auto p-5">
        <Fields
          items={[
            [t("Storage"), location?.store ?? "—"],
            [t("Location"), location ? <Mono className="break-all text-xs">{location.path}</Mono> : "—"],
            [t("Packaging"), artifactArchive(artifact)],
            [t("Container path"), artifact.path ? <Mono>{artifact.path}</Mono> : "—"],
            [t("Optional"), artifact.optional ? t("Yes") : t("No")],
          ]}
        />
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-muted-foreground">{t("Definition")}</h3>
          <Code text={toYaml(artifact)} />
        </section>
      </div>
    </aside>
  );
}
