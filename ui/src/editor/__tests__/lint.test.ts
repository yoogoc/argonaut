import { describe, expect, it } from "vitest";

import { lintLocal } from "../lint";

const tpl = (tasks: unknown[], extra: Record<string, unknown> = {}) => ({
  metadata: { name: "t", namespace: "argo" },
  spec: { entrypoint: "main", templates: [{ name: "main", dag: { tasks } }, { name: "echo", retryStrategy: { limit: 3 }, container: { image: "busybox", resources: { limits: { cpu: 1 } } } }], ...extra },
});

describe("lintLocal", () => {
  it("accepts a valid template", () => {
    expect(lintLocal(tpl([{ name: "a", template: "echo" }, { name: "b", template: "echo", depends: "a" }]), false, [])).toEqual([]);
  });

  it("finds unknown fields, missing templates, bad depends and cycles", () => {
    const problems = lintLocal(tpl([{ name: "a", template: "nope", bogus: 1 }, { name: "b", template: "echo", depends: "c && a" }, { name: "c", template: "echo", depends: "b" }]), false, []);
    const messages = problems.map((p) => `${p.node}: ${p.message}`);
    expect(messages.some((m) => m.startsWith("a:") && m.includes("bogus"))).toBe(true);
    expect(messages).toContain("a: runs template nope, which is not defined");
    expect(messages.some((m) => m.includes("dependency cycle"))).toBe(true);
  });
});
