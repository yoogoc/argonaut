import { type APIRequestContext, test as base } from "@playwright/test";

export const NAMESPACE = process.env.E2E_NAMESPACE ?? "argo";

/** A two-task DAG template; tests create their own so they never touch anyone's templates. */
export function templateManifest(name: string, image = "busybox:1.36") {
  return `metadata:
  name: ${name}
  namespace: ${NAMESPACE}
spec:
  entrypoint: main
  templates:
    - name: main
      dag:
        tasks:
          - name: a
            template: echo
          - name: b
            template: echo
            depends: a
    - name: echo
      container:
        image: ${image}
        command: [sh, -c]
        args: ["echo hello"]
`;
}

export async function createTemplate(request: APIRequestContext, name: string) {
  const res = await request.post(`/api/v1/workflow-templates/${NAMESPACE}`, { data: { manifest: templateManifest(name) } });
  if (!res.ok()) throw new Error(`creating ${name}: ${res.status()} ${await res.text()}`);
  return (await res.json()).template;
}

export async function deleteTemplate(request: APIRequestContext, name: string) {
  await request.delete(`/api/v1/workflow-templates/${NAMESPACE}/${name}`);
}

export const uniqueName = (prefix: string) => `e2e-${prefix}-${Date.now().toString(36)}`;

/** Every test runs in English, so selectors do not depend on the browser's language. */
export const test = base.extend({
  page: async ({ page }, provide) => {
    await page.addInitScript("localStorage.setItem('argonaut.language', 'en')");
    await provide(page);
  },
});

export { expect } from "@playwright/test";
