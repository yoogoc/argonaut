import { createTemplate, deleteTemplate, expect, NAMESPACE, test, uniqueName } from "./fixtures";

test.describe("template editor", () => {
  const created: string[] = [];
  test.afterAll(async ({ request }) => {
    for (const name of created) await deleteTemplate(request, name);
  });

  test("creates a template from the palette and saves it", async ({ page }) => {
    const name = uniqueName("new");
    created.push(name);
    await page.goto("/templates/new");
    await page.getByRole("textbox", { name: "Template name" }).fill(name);
    const palette = page.getByRole("complementary", { name: "Node palette" });
    await palette.getByRole("button", { name: "Container Image and command" }).click();
    await palette.getByRole("button", { name: "Script Image and inline source" }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    await expect(page.getByText("No problems")).toBeVisible();

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/templates/${NAMESPACE}/${name}/edit`));
    await expect(page.getByText("Unsaved changes")).toHaveCount(0);
  });

  test("edits a field, lints against the cluster and saves", async ({ page, request }) => {
    const name = uniqueName("edit");
    created.push(name);
    await createTemplate(request, name);
    await page.goto(`/templates/${NAMESPACE}/${name}/edit`);
    await page.locator('.react-flow__node[data-id="a"]').click();
    const image = page.getByRole("textbox", { name: "Image", exact: true });
    await image.fill("busybox:1.37");
    await expect(page.getByText("Unsaved changes")).toBeVisible();

    await page.getByRole("button", { name: "Lint", exact: true }).click();
    await expect(page.getByText("Argo lint passed")).toBeVisible();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Unsaved changes")).toHaveCount(0);

    const saved = await (await request.get(`/api/v1/workflow-templates/${NAMESPACE}/${name}`)).json();
    expect(saved.template.spec.templates.find((t: { name: string }) => t.name === "echo").container.image).toBe("busybox:1.37");
  });

  test("merges a concurrent save through the three-way merge view", async ({ page, request }) => {
    const name = uniqueName("merge");
    created.push(name);
    await createTemplate(request, name);
    await page.goto(`/templates/${NAMESPACE}/${name}/edit`);
    await page.locator('.react-flow__node[data-id="a"]').click();
    await page.getByRole("textbox", { name: "Image", exact: true }).fill("busybox:mine");

    // Someone else saves meanwhile: a conflicting image and a non-conflicting working directory.
    const current = (await (await request.get(`/api/v1/workflow-templates/${NAMESPACE}/${name}`)).json()).template;
    const echo = current.spec.templates.find((t: { name: string }) => t.name === "echo");
    echo.container.image = "busybox:theirs";
    echo.container.workingDir = "/tmp";
    const res = await request.put(`/api/v1/workflow-templates/${NAMESPACE}/${name}`, { data: { manifest: JSON.stringify(current) } });
    expect(res.ok()).toBeTruthy();

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Someone saved this template while you were editing.")).toBeVisible();
    await expect(page.getByText("template echo · container.workingDir")).toBeVisible();
    await page.getByRole("button", { name: "Use mine" }).click();
    await page.getByRole("button", { name: "Lint and save merged" }).click();
    await expect(page.getByText("Someone saved this template while you were editing.")).toHaveCount(0);

    const saved = (await (await request.get(`/api/v1/workflow-templates/${NAMESPACE}/${name}`)).json()).template;
    const merged = saved.spec.templates.find((t: { name: string }) => t.name === "echo").container;
    expect(merged.image).toBe("busybox:mine");
    expect(merged.workingDir).toBe("/tmp");
  });
});
