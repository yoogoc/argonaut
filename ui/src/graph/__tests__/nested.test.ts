import { describe, expect, it } from "vitest";

import { nestedGraph as build, openUnless } from "../nested";
import type { SpecLike } from "../spec";

// The shape of deploy/examples/nested-dag: main → region (×2) → publish.
const spec: SpecLike = {
  entrypoint: "main",
  templates: [
    {
      name: "main",
      dag: {
        tasks: [
          { name: "prepare", template: "say" },
          { name: "region-us", template: "region", depends: "prepare" },
          { name: "region-eu", template: "region", depends: "prepare" },
          { name: "summary", template: "say", depends: "region-us && region-eu" },
        ],
      },
    },
    {
      name: "region",
      dag: {
        tasks: [
          { name: "fetch", template: "say" },
          { name: "clean", template: "say", depends: "fetch" },
          { name: "validate", template: "say", depends: "fetch" },
          { name: "load", template: "say", depends: "clean && validate" },
          { name: "publish", template: "publish", depends: "load" },
        ],
      },
    },
    { name: "publish", dag: { tasks: [{ name: "upload", template: "say" }, { name: "notify", template: "say", depends: "upload" }, { name: "archive", template: "say", depends: "upload" }] } },
    { name: "loop", dag: { tasks: [{ name: "again", template: "loop" }] } },
    { name: "say", container: {} },
  ],
};

// The tests name what is open; the views default to everything open (openUnless).
const nestedGraph = (spec: SpecLike, template: string, open: Set<string>) => build(spec, template, (id) => open.has(id));
const edges = (g: ReturnType<typeof nestedGraph>) => g.edges.map((e) => `${e.source}->${e.target}`).sort();

describe("nestedGraph", () => {
  it("is the plain graph when nothing is expanded, with child counts on DAG tasks", () => {
    const g = nestedGraph(spec, "main", new Set());
    expect(g.nodes.map((n) => [n.id, n.group, n.childCount])).toEqual([
      ["prepare", false, undefined],
      ["region-us", false, 5],
      ["region-eu", false, 5],
      ["summary", false, undefined],
    ]);
    expect(edges(g)).toEqual(["prepare->region-eu", "prepare->region-us", "region-eu->summary", "region-us->summary"]);
  });

  it("opens a group in place, rewiring edges to its first and last tasks", () => {
    const g = nestedGraph(spec, "main", new Set(["region-eu"]));
    const eu = g.nodes.filter((n) => n.parent === "region-eu").map((n) => n.id);
    expect(eu).toEqual(["region-eu/fetch", "region-eu/clean", "region-eu/validate", "region-eu/load", "region-eu/publish"]);
    expect(g.nodes.find((n) => n.id === "region-eu")?.group).toBe(true);
    expect(edges(g)).toContain("prepare->region-eu/fetch");
    expect(edges(g)).toContain("region-eu/publish->summary");
    expect(edges(g)).toContain("prepare->region-us");
    // Layout edges stay between siblings: the group stands for its contents.
    expect(g.layoutEdges.map((e) => `${e.source}->${e.target}`)).toContain("prepare->region-eu");
  });

  it("opens several levels, and the same template separately in each place", () => {
    const g = nestedGraph(spec, "main", new Set(["region-eu", "region-eu/publish", "region-us"]));
    expect(edges(g)).toContain("region-eu/load->region-eu/publish/upload");
    expect(edges(g)).toContain("region-eu/publish/notify->summary");
    expect(edges(g)).toContain("region-eu/publish/archive->summary");
    expect(g.nodes.find((n) => n.id === "region-us/publish")?.group).toBe(false);
    expect(edges(g)).toContain("region-us/publish->summary");
  });

  it("opens everything by default except what was closed, and records each task's template", () => {
    const g = build(spec, "main", openUnless(new Set(["region-us"])));
    expect(g.nodes.filter((n) => n.group).map((n) => n.id)).toEqual(["region-eu", "region-eu/publish"]);
    expect(g.nodes.find((n) => n.id === "region-eu/publish/upload")?.in).toBe("publish");
    expect(g.nodes.find((n) => n.id === "prepare")?.in).toBe("main");
  });

  it("does not open a template inside itself", () => {
    const g = nestedGraph({ ...spec, entrypoint: "loop" }, "loop", new Set(["again"]));
    expect(g.nodes.map((n) => [n.id, n.group])).toEqual([["again", false]]);
  });
});
