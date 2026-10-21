import { describe, expect, it } from "vitest";

import { merge3, resolveAt } from "../merge";

const tpl = (tasks: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  metadata: { name: "t", resourceVersion: "1" },
  spec: { entrypoint: "main", templates: [{ name: "main", dag: { tasks } }, { name: "x", container: { image: "a" }, ...extra }] },
});

describe("merge3", () => {
  it("merges edits to different tasks without conflict", () => {
    const base = tpl([{ name: "a", template: "x" }, { name: "b", template: "x" }]);
    const theirs = tpl([{ name: "a", template: "x", when: "1 == 1" }, { name: "b", template: "x" }]);
    const mine = tpl([{ name: "a", template: "x" }, { name: "b", template: "x", depends: "a" }, { name: "c", template: "x" }]);
    const r = merge3(base, theirs, mine);
    expect(r.conflicts).toHaveLength(0);
    const tasks = (r.merged as typeof base).spec.templates[0].dag!.tasks;
    expect(tasks.map((t) => t.name)).toEqual(["a", "b", "c"]);
    expect(tasks[0].when).toBe("1 == 1");
    expect(tasks[1].depends).toBe("a");
    expect(r.changes.map((c) => c.who).sort()).toEqual(["mine", "mine", "theirs"]);
  });

  it("reports both sides changing one field, and resolves it by path", () => {
    const base = tpl([], { retryStrategy: { limit: 2 } });
    const theirs = tpl([], { retryStrategy: { limit: 3 } });
    const mine = tpl([], { retryStrategy: { limit: 4 } });
    const r = merge3(base, theirs, mine);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].label).toBe("template x · retryStrategy.limit");
    const resolved = resolveAt(r.merged, r.conflicts[0].path, 3) as typeof base;
    expect((resolved.spec.templates[1] as unknown as { retryStrategy: { limit: number } }).retryStrategy.limit).toBe(3);
  });

  it("ignores server-managed fields", () => {
    const r = merge3({ metadata: { resourceVersion: "1" } }, { metadata: { resourceVersion: "2" } }, { metadata: { resourceVersion: "1" } });
    expect(r.conflicts).toHaveLength(0);
    expect(r.changes).toHaveLength(0);
    expect((r.merged as { metadata: { resourceVersion: string } }).metadata.resourceVersion).toBe("2");
  });

  it("reports an untouched subtree's change at the field that changed", () => {
    const tpl = (dir?: string) => ({ spec: { templates: [{ name: "echo", container: { image: "busybox", ...(dir ? { workingDir: dir } : {}) } }] } });
    const r = merge3(tpl(), tpl("/tmp"), tpl());
    expect(r.changes.map((c) => c.label)).toEqual(["template echo · container.workingDir"]);
  });
});
