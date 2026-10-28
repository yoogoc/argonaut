import { describe, expect, it } from "vitest";

import type { NodeStatus, Workflow } from "@/api/types";

import { alignRendered, expressionVariables, pendingExpressions, renderedBindings, renderTemplate } from "../expressions";

const wf = {
  metadata: { name: "demo-abc", namespace: "argo", uid: "u-1", labels: { team: "data" } },
  spec: { entrypoint: "main", serviceAccountName: "runner", arguments: { parameters: [{ name: "env", value: "uat" }] } },
  status: {
    phase: "Running",
    storedWorkflowTemplateSpec: {
      arguments: {
        parameters: [
          { name: "env", value: "dev" },
          { name: "rounds", value: "45" },
        ],
      },
    },
    nodes: {
      prep: {
        id: "prep",
        name: "demo-abc.prepare",
        displayName: "prepare",
        type: "Pod",
        boundaryID: "root",
        phase: "Succeeded",
        outputs: { result: "ready", parameters: [{ name: "count", value: "3" }] },
      },
      crunch: {
        id: "crunch",
        name: "demo-abc.crunch",
        displayName: "crunch",
        type: "Pod",
        boundaryID: "root",
        templateName: "tick",
        inputs: {
          parameters: [
            { name: "rounds", value: "45" },
            { name: "label", value: "ready" },
          ],
        },
      },
      retry: { id: "retry", name: "demo-abc.flaky", displayName: "flaky", type: "Retry", boundaryID: "root", children: ["a0", "a1"] },
      a1: { id: "a1", name: "demo-abc.flaky(1)", displayName: "flaky(1)", type: "Pod", boundaryID: "root" },
    },
  },
} as unknown as Workflow;

const resolve = (node: string, path: string) => expressionVariables(wf, wf.status!.nodes![node] as NodeStatus)[path];

describe("expressionVariables", () => {
  it("resolves inputs, workflow fields and effective parameters", () => {
    expect(resolve("crunch", "inputs.parameters.rounds")).toBe("45");
    expect(resolve("crunch", "workflow.name")).toBe("demo-abc");
    expect(resolve("crunch", "workflow.labels.team")).toBe("data");
    // Submitted values win over the template's defaults, and defaults fill the rest.
    expect(resolve("crunch", "workflow.parameters.env")).toBe("uat");
    expect(resolve("crunch", "workflow.parameters.rounds")).toBe("45");
    expect(resolve("crunch", "pod.name")).toBe("demo-abc-tick-crunch");
  });

  it("resolves sibling task outputs and the retry attempt", () => {
    expect(resolve("crunch", "tasks.prepare.outputs.result")).toBe("ready");
    expect(resolve("crunch", "tasks.prepare.outputs.parameters.count")).toBe("3");
    expect(resolve("crunch", "tasks.prepare.status")).toBe("Succeeded");
    expect(resolve("a1", "retries")).toBe("1");
    expect(resolve("crunch", "tasks.missing.outputs.result")).toBeUndefined();
  });
});

describe("renderTemplate", () => {
  it("prefers the pod's values, then recorded values, then estimates", () => {
    const text = "echo {{inputs.parameters.rounds}} {{=asInt(x) + 1}} {{workflow.name}}!";
    const scope = {
      variables: { "inputs.parameters.rounds": "45", "workflow.name": "demo" },
      rendered: new Map([[text, ["46", undefined, undefined]]]),
      estimates: new Map([["asInt(x) + 1", { value: "2" }]]),
    };
    expect(renderTemplate(text, scope)).toEqual([
      { text: "echo " },
      { raw: "{{inputs.parameters.rounds}}", path: "inputs.parameters.rounds", value: "46", source: "pod" },
      { text: " " },
      { raw: "{{=asInt(x) + 1}}", path: "=asInt(x) + 1", value: "2", source: "estimate" },
      { text: " " },
      { raw: "{{workflow.name}}", path: "workflow.name", value: "demo", source: "run" },
      { text: "!" },
    ]);
  });

  it("keeps an expression the server could not evaluate unresolved, with the reason", () => {
    const [segment] = renderTemplate("{{=nope}}", { variables: {}, estimates: new Map([["nope", { error: "unknown name nope" }]]) });
    expect(segment).toEqual({ raw: "{{=nope}}", path: "=nope", error: "unknown name nope" });
  });
});

describe("alignRendered", () => {
  it("recovers each variable's value from the rendered text", () => {
    expect(alignRendered("seq {{inputs.parameters.n}}; echo {{=sprig.upper(x)}} done", "seq 45; echo HI there done")).toEqual(["45", "HI there"]);
  });

  it("gives up where values cannot be told apart, and skips what the controller left in place", () => {
    expect(alignRendered("{{a}}{{b}}", "xy")).toBeUndefined();
    expect(alignRendered("a {{x}} b", "something else")).toBeUndefined();
    expect(alignRendered("a {{x}} b", "a {{x}} b")).toEqual([undefined]);
  });
});

describe("renderedBindings and pendingExpressions", () => {
  it("pairs strings by position and lists the expressions the pod did not resolve", () => {
    const raw = { container: { image: "{{=sprig.upper(x)}}", args: ["n={{inputs.parameters.n}}", "{{=y}}"] }, name: "t" };
    const rendered = { container: { image: "BUSYBOX", args: ["n=45", "{{=y}}"] }, name: "t", archiveLocation: {} };
    const bindings = renderedBindings(raw, rendered);
    expect(bindings.get("{{=sprig.upper(x)}}")).toEqual(["BUSYBOX"]);
    expect(bindings.get("n={{inputs.parameters.n}}")).toEqual(["45"]);
    expect([...pendingExpressions(raw, bindings)]).toEqual(["y"]);
    expect([...pendingExpressions(raw)]).toEqual(["sprig.upper(x)", "y"]);
  });
});
