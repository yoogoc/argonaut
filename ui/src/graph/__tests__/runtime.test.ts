import { describe, expect, it } from "vitest";

import type { Workflow } from "@/api/types";

import { buildRuntimeGraph } from "../runtime";

// prepare → region (a nested DAG: fetch → load) → summary, as Argo records it: the DAG node's children
// are its first tasks, its last tasks' children are what comes after it, and boundaryID says which DAG
// each node ran in.
const node = (id: string, type: string, boundaryID: string | undefined, children: string[] = []) => ({ id, name: id, displayName: id, type, phase: "Succeeded", boundaryID, children });
const wf = {
  metadata: { name: "run" },
  spec: {},
  status: {
    phase: "Succeeded",
    nodes: {
      run: node("run", "DAG", undefined, ["prepare"]),
      prepare: node("prepare", "Pod", "run", ["region"]),
      region: node("region", "DAG", "run", ["fetch"]),
      fetch: node("fetch", "Pod", "region", ["load"]),
      load: node("load", "Pod", "region", ["summary"]),
      summary: node("summary", "Pod", "run"),
    },
  },
} as unknown as Workflow;

const build = (closedDags?: Set<string>) => buildRuntimeGraph(wf, { expandRetries: false, showArtifacts: false, closedDags });
const shape = (g: ReturnType<typeof build>) => ({
  nodes: g.nodes.map((n) => `${n.id}:${n.data.kind}${n.parent ? `@${n.parent}` : ""}`).sort(),
  edges: g.edges.map((e) => `${e.source}->${e.target}`).sort(),
});

describe("buildRuntimeGraph with nested DAGs", () => {
  it("draws a nested DAG open, as a frame around what it ran, with edges at their own level", () => {
    expect(shape(build())).toEqual({
      nodes: ["fetch:step@region", "load:step@region", "prepare:step", "region:dag", "run:step", "summary:step"],
      edges: ["fetch->load", "prepare->region", "region->summary", "run->prepare"],
    });
  });

  it("draws a closed one as a card, its contents hidden and its edges kept", () => {
    const g = build(new Set(["region"]));
    expect(shape(g)).toEqual({
      nodes: ["prepare:step", "region:step", "run:step", "summary:step"],
      edges: ["prepare->region", "region->summary", "run->prepare"],
    });
    const card = g.nodes.find((n) => n.id === "region")!.data;
    expect(card.kind === "step" && card.dag).toEqual({ count: 2, open: false });
  });
});

describe("buildRuntimeGraph with a workflow exit handler", () => {
  it("draws a steps exit handler after the flow, joined from where the flow ends", () => {
    const withExit = {
      ...wf,
      status: {
        ...wf.status,
        nodes: {
          ...wf.status!.nodes,
          exit: { ...node("exit", "Steps", undefined, ["notify"]), name: "run.onExit", templateName: "exit-handler" },
          notify: node("notify", "Pod", "exit"),
        },
      },
    } as unknown as Workflow;
    const g = buildRuntimeGraph(withExit, { expandRetries: false, showArtifacts: false });
    const exit = g.nodes.find((n) => n.id === "exit")!;
    expect(exit.data.kind === "dag" && exit.data.exit).toBe(true);
    expect(g.nodes.find((n) => n.id === "notify")?.parent).toBe("exit");
    expect(g.edges.filter((e) => e.exit).map((e) => `${e.source}->${e.target}`)).toEqual(["summary->exit"]);
  });
});

describe("buildRuntimeGraph shows every hook", () => {
  // prepare declares two hooks: "running" fired; "failed" never did. summary's exit hook ran a DAG.
  const nodes = {
    ...wf.status!.nodes,
    run: { ...node("run", "DAG", undefined, ["prepare"]), templateName: "main" },
    prepare: node("prepare", "Pod", "run", ["region", "hooked"]),
    hooked: { ...node("hooked", "Pod", "run"), name: "run.prepare.hooks.running" },
    exit: { ...node("exit", "DAG", "run", ["exit-step"]), name: "summary.onExit" },
    "exit-step": node("exit-step", "Pod", "exit"),
  };
  const run = {
    ...wf,
    spec: {
      templates: [
        { name: "main", dag: { tasks: [{ name: "prepare", template: "say", hooks: { running: { template: "say" }, failed: { template: "say" } } }, { name: "region", template: "region" }, { name: "summary", template: "say", onExit: "notify" }] } },
      ],
    },
    status: { ...wf.status, nodes },
  } as unknown as Workflow;
  const g = buildRuntimeGraph(run, { expandRetries: false, showArtifacts: false });
  const hooks = g.nodes.filter((n) => n.data.kind === "hook").map((n) => n.data.kind === "hook" && `${n.data.owner}:${n.data.event}${n.data.planned ? "?" : ""}`);

  it("draws fired hooks, and declared ones that never fired as planned", () => {
    expect(hooks.sort()).toEqual(["prepare:failed?", "prepare:running", "summary:exit"]);
  });

  it("folds a hook that ran a DAG into one pill", () => {
    expect(g.nodes.some((n) => n.id === "exit-step")).toBe(false);
    expect(g.edges.filter((e) => !e.hook).some((e) => e.source === "exit" || e.target === "exit")).toBe(false);
  });
});
