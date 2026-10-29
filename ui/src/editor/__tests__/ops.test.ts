import { describe, expect, it } from "vitest";

import { parseDepends } from "@/graph/spec";

import { addHook, addKindNode, deleteHook, ensureDag, hookTrigger, removeTerm, renameHook, renameTask, setHookTarget, setHookTrigger } from "../ops";

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

describe("hooks", () => {
  const flow = () => ({
    spec: {
      entrypoint: "main",
      templates: [
        { name: "main", dag: { tasks: [{ name: "fetch-data", template: "work" }, { name: "b", template: "work", depends: "fetch-data" }] } },
        { name: "work", container: { image: "busybox" } },
      ],
    },
  });
  const task = { template: "main", task: "fetch-data" };
  const hooksOf = (d: ReturnType<typeof flow>) => (d.spec.templates[0].dag!.tasks[0] as Record<string, unknown>).hooks as Record<string, Record<string, unknown>>;

  it("adds preset hooks to a task and to the workflow, each running a new template", () => {
    const d = flow();
    expect(addHook(d, task, "running")).toBe("running");
    expect(addHook(d, task, "running")).toBe("running-2");
    expect(addHook(d, task, "exit")).toBe("exit");
    expect(addHook(d, task, "exit")).toBe("");
    expect(hooksOf(d).running).toEqual({ expression: `tasks['fetch-data'].status == "Running"`, template: "fetch-data-running" });
    expect(hooksOf(d).exit).toEqual({ template: "fetch-data-exit" });
    expect(addHook(d, undefined, "failed")).toBe("failed");
    expect((d.spec as Record<string, unknown>).hooks).toEqual({ failed: { expression: `workflow.status == "Failed"`, template: "workflow-failed" } });
    expect(d.spec.templates.map((t) => t.name)).toEqual(["main", "work", "fetch-data-running", "fetch-data-running-2", "fetch-data-exit", "workflow-failed"]);
  });

  it("switches triggers, renaming to and from exit, and recognises presets", () => {
    const d = flow();
    addHook(d, task, "running");
    expect(hookTrigger(d, task, "running", hooksOf(d).running)).toBe("running");
    expect(setHookTrigger(d, task, "running", "failed")).toBe("running");
    expect(hookTrigger(d, task, "running", hooksOf(d).running)).toBe("failed");
    expect(setHookTrigger(d, task, "running", "exit")).toBe("exit");
    expect(hooksOf(d)).toEqual({ exit: { template: "fetch-data-running" } });
    expect(setHookTrigger(d, task, "exit", "succeeded")).toBe("succeeded");
    expect(hooksOf(d).succeeded.expression).toBe(`tasks['fetch-data'].status == "Succeeded"`);
    hooksOf(d).succeeded.expression = "tasks['fetch-data'].status == \"Error\"";
    expect(hookTrigger(d, task, "succeeded", hooksOf(d).succeeded)).toBe("custom");
  });

  it("renames, retargets and deletes hooks, and follows a task rename", () => {
    const d = flow();
    addHook(d, task, "running");
    addHook(d, task, "exit");
    expect(renameHook(d, task, "running", "exit")).toBe(false);
    expect(renameHook(d, task, "running", "source-begin")).toBe(true);
    expect(Object.keys(hooksOf(d))).toEqual(["source-begin", "exit"]);
    setHookTarget(d, task, "exit", { templateRef: { name: "run-record", template: "source-end" } });
    expect(hooksOf(d).exit).toEqual({ templateRef: { name: "run-record", template: "source-end" } });
    renameTask(d, "main", "fetch-data", "fetch");
    expect(hooksOf(d)["source-begin"].expression).toBe(`tasks['fetch'].status == "Running"`);
    const renamed = { template: "main", task: "fetch" };
    deleteHook(d, renamed, "source-begin");
    deleteHook(d, renamed, "exit");
    expect(hooksOf(d)).toBeUndefined();
  });
});
