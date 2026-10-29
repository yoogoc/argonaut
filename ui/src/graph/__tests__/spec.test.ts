import { describe, expect, it } from "vitest";

import { standaloneTemplates } from "../spec";

describe("standaloneTemplates", () => {
  it("lists every step of a library, the entry first, without DAGs or the exit handler", () => {
    const spec = {
      entrypoint: "raw",
      onExit: "cleanup",
      templates: [{ name: "regular", container: {} }, { name: "raw", container: {} }, { name: "flow", dag: { tasks: [] } }, { name: "cleanup", script: {} }, { name: "wait", suspend: {} }],
    };
    expect(standaloneTemplates(spec).map((n) => [n.id, n.kind, !!n.entry])).toEqual([
      ["raw", "container", true],
      ["regular", "container", false],
      ["wait", "suspend", false],
    ]);
  });

  it("is empty when the entry is a DAG or missing", () => {
    expect(standaloneTemplates({ entrypoint: "flow", templates: [{ name: "flow", dag: {} }, { name: "a", container: {} }] })).toEqual([]);
    expect(standaloneTemplates({ entrypoint: "nope", templates: [{ name: "a", container: {} }] })).toEqual([]);
  });
});
