// Monaco runs from the bundled package, never a CDN: the console must work on air-gapped clusters,
// and @monaco-editor/react would otherwise fetch the editor from jsdelivr at runtime.
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import { configureMonacoYaml } from "monaco-yaml";

import argoSchema from "@/api/gen/argo-schema.json";

import YamlWorker from "./yaml.worker?worker";

self.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    if (label === "yaml") return new YamlWorker();
    if (label === "json") return new JsonWorker();
    return new EditorWorker();
  },
};

loader.config({ monaco });

// Every YAML editor validates and completes against Argo's own schema (the one the server is built
// with, see scripts/gen-argo-types.mjs), so typos are underlined before the server's lint runs.
configureMonacoYaml(monaco, {
  enableSchemaRequest: false,
  hover: true,
  completion: true,
  validate: true,
  format: {},
  schemas: [{ uri: "argonaut://argo-schema.json", fileMatch: ["*"], schema: argoSchema as object }],
});

export { monaco };
