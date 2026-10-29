import { describe, expect, it } from "vitest";

import { parseDepends } from "@/graph/spec";

import { addKindNode, ensureDag, removeTerm } from "../ops";

describe("removeTerm", () => {
  it.each([
    ["a", "a", ""],
    ["a && b", "a", "b"],
    ["a && b", "b", "a"],
    ["a.Succeeded && (b || c.Failed)", "c", "a.Succeeded && (b)"],
    ["(a || b) && c", "a", "(b) && c"],
    ["build-a && build", "build", "build-a"],
  ])("removes %s from %s", (expr, task, want) => {
    expect(removeTerm(expr, task)).toBe(want);
  });
});

describe("parseDepends", () => {
  it("reads tasks and conditions", () => {
    expect(parseDepends("a.Succeeded && (b || !c.Failed)")).toEqual([
      { task: "a", condition: "Succeeded" },
      { task: "b", condition: undefined },
      { task: "c", condition: "Failed" },
    ]);
  });
});

describe("pruneZero", () => {
  it("drops Go zero values but keeps meaningful empty objects", async () => {
    const { pruneZero } = await import("../doc");
    expect(pruneZero({ templates: [{ name: "a", inputs: {}, metadata: {}, suspend: {}, container: { name: "", image: "x", resources: {} } }] })).toEqual({
      templates: [{ name: "a", suspend: {}, container: { image: "x" } }],
    });
  });
});

describe("ensureDag", () => {
  it("wraps a single-step entry in a DAG before the first node is added", () => {
    const draft = { spec: { entrypoint: "notify", templates: [{ name: "notify", container: { image: "busybox" } }, { name: "main-x" }] } };
    const target = ensureDag(draft, "notify");
    expect(target).toBe("main");
    const added = addKindNode(draft, target, "script");
    expect(draft.spec.entrypoint).toBe("main");
    expect(draft.spec.templates.find((t) => t.name === "main")).toMatchObject({ dag: { tasks: [{ name: "notify", template: "notify" }, { name: added }] } });
    expect(draft.spec.templates[0]).toEqual({ name: "notify", container: { image: "busybox" } });
  });

  it("leaves DAG templates and templates other than the entry alone", () => {
    const draft = { spec: { entrypoint: "flow", templates: [{ name: "flow", dag: { tasks: [] } }, { name: "leaf", container: {} }] } };
    expect(ensureDag(draft, "flow")).toBe("flow");
    expect(ensureDag(draft, "leaf")).toBe("leaf");
    expect(draft.spec.templates).toHaveLength(2);
  });
});
