import { createTemplate, deleteTemplate, expect, NAMESPACE, test, uniqueName } from "./fixtures";

test("template detail shows the DAG and its revisions", async ({ page, request }) => {
  const name = uniqueName("detail");
  await createTemplate(request, name);
  try {
    await page.goto(`/templates/${NAMESPACE}/${name}`);
    await expect(page.getByRole("heading", { name })).toBeVisible();
    await expect(page.locator('.react-flow__node[data-id="b"]')).toBeVisible();
    await page.getByRole("tab", { name: "Revisions" }).click();
    await expect(page.getByText("#1").first()).toBeVisible();
  } finally {
    await deleteTemplate(request, name);
  }
});

test("archive lists archived runs and opens one", async ({ page, request }) => {
  const info = await (await request.get("/api/v1/info")).json();
  test.skip(!info.archiveEnabled, "the controller config has no workflow archive");
  const list = await (await request.get(`/api/v1/archived-workflows?namespace=${NAMESPACE}&limit=1`)).json();
  const run = list.list.items?.[0];
  test.skip(!run, "the archive is empty");

  await page.goto("/archived");
  await expect(page.getByRole("heading", { name: "Archive" })).toBeVisible();
  await page.getByRole("link", { name: run.metadata.name, exact: true }).first().click();
  await expect(page.getByText("Archived", { exact: true })).toBeVisible();
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
});

test("permissions pages render for an administrator", async ({ page }) => {
  await page.goto("/admin/authz");
  await expect(page.getByRole("heading", { name: "Permissions" })).toBeVisible();
  await expect(page.getByText("Authorization revision")).toBeVisible();
  await page.goto("/admin/audit");
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeVisible();
});

test("the interface switches to Chinese", async ({ context }) => {
  // A page of its own: the shared fixture pins English on every load.
  const page = await context.newPage();
  await page.addInitScript("localStorage.setItem('argonaut.language', 'zh-CN')");
  await page.goto("/workflows");
  await expect(page.getByRole("link", { name: "工作流" }).first()).toBeVisible();
  await page.close();
});
