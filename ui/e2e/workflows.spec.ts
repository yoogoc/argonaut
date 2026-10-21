import { expect, NAMESPACE, test } from "./fixtures";

test("lists workflows and opens a run with its graph, node panel and logs", async ({ page, request }) => {
  const list = await (await request.get(`/api/v1/workflows?namespace=${NAMESPACE}&limit=50`)).json();
  const run = (list.list.items ?? []).find((w: { status?: { phase?: string } }) => w.status?.phase === "Succeeded");
  test.skip(!run, "needs at least one succeeded workflow in the namespace");

  await page.goto("/workflows");
  await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible();
  await page.getByRole("link", { name: run.metadata.name, exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/workflows/${NAMESPACE}/${run.metadata.name}`));

  const nodes = page.locator(".react-flow__node");
  await expect(nodes.first()).toBeVisible();
  // Open the first pod step and read its logs.
  const detail = await (await request.get(`/api/v1/workflows/${NAMESPACE}/${run.metadata.name}`)).json();
  const pod = Object.values(detail.workflow.status.nodes as Record<string, { id: string; type: string }>).find((n) => n.type === "Pod");
  test.skip(!pod, "the run has no pod steps");
  await page.goto(`/workflows/${NAMESPACE}/${run.metadata.name}?nodeId=${pod!.id}`);
  const panel = page.getByRole("complementary", { name: "Node details" });
  await expect(panel).toBeVisible();
  await panel.getByRole("tab", { name: "Logs" }).click();
  await expect(panel.getByText(/lines|No log output|Waiting for output/).first()).toBeVisible();

  await page.getByRole("tab", { name: "Timeline" }).click();
  await expect(page.getByText(run.metadata.name).first()).toBeVisible();
});
