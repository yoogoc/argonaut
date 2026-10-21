import "@/lib/monaco";

import { DiffEditor, Editor } from "@monaco-editor/react";

import { cn } from "@/lib/utils";
import { useTheme } from "@/stores/theme";

export interface YamlEditorProps {
  value: string;
  /** Defaults to yaml; script sources and bodies use their own language. */
  language?: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  className?: string;
  /** A stable path gives each editor its own model, so undo history and markers do not leak. */
  path?: string;
  height?: string | number;
  onMount?: (editor: unknown) => void;
}

export interface YamlDiffProps {
  original: string;
  modified: string;
  className?: string;
  sideBySide?: boolean;
  height?: string | number;
}

const options = {
  minimap: { enabled: false },
  fontSize: 12,
  fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace',
  scrollBeyondLastLine: false,
  tabSize: 2,
  automaticLayout: true,
  renderLineHighlight: "line" as const,
  wordWrap: "off" as const,
};

export function YamlEditorImpl({
  value,
  onChange,
  readOnly,
  className,
  path,
  height = "100%",
  onMount,
  language = "yaml",
}: YamlEditorProps) {
  const theme = useTheme((s) => s.resolved);
  return (
    // Monaco sizes itself to its container; an absolutely positioned box gives it a definite height even
    // when the wrapper only has a min-height (a percentage of that would resolve to zero).
    <div
      className={cn(
        "relative h-full min-h-40 overflow-hidden rounded-md border",
        className,
      )}
    >
      <div className="absolute inset-0">
        <Editor
          height={height}
          language={language}
          path={path}
          value={value}
          theme={theme === "dark" ? "vs-dark" : "vs"}
          onChange={(next) => onChange?.(next ?? "")}
          onMount={(editor) => onMount?.(editor)}
          options={{ ...options, readOnly, domReadOnly: readOnly }}
        />
      </div>
    </div>
  );
}

export function YamlDiffImpl({
  original,
  modified,
  className,
  sideBySide = false,
  height = "100%",
}: YamlDiffProps) {
  const theme = useTheme((s) => s.resolved);
  return (
    <div
      className={cn(
        "relative h-full min-h-40 overflow-hidden rounded-md border",
        className,
      )}
    >
      <div className="absolute inset-0">
        <DiffEditor
          height={height}
          language="yaml"
          original={original}
          modified={modified}
          theme={theme === "dark" ? "vs-dark" : "vs"}
          options={{
            ...options,
            readOnly: true,
            renderSideBySide: sideBySide,
            originalEditable: false,
          }}
        />
      </div>
    </div>
  );
}
