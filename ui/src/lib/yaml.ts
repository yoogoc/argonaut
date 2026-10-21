import { parse, stringify } from "yaml";

/** Renders an object as YAML for the read-only manifest views. */
export function toYaml(value: unknown): string {
  try {
    return stringify(value, { lineWidth: 0 });
  } catch (error) {
    return `# could not render as YAML: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Parses editor content, returning the error message instead of throwing so forms can show it. */
export function parseYaml<T>(text: string): { value?: T; error?: string } {
  try {
    return { value: parse(text) as T };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
