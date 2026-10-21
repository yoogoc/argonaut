import { describe, expect, it } from "vitest";

import { parseDepends } from "@/graph/spec";

import { removeTerm } from "../ops";

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
