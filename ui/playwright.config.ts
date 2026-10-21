import { defineConfig } from "@playwright/test";

// End-to-end smoke tests against a running argonaut and a real cluster (DESIGN §7.1). They need the
// server with a development identity (configs/dev or configs/dev-archive) and the built UI:
//
//   make build && (cd server && ./bin/argonaut server -c ./configs/dev-archive)
//   pnpm e2e
//
// Tests create their own templates (prefixed e2e-) and remove them afterwards. They use the
// installed Chrome, so no browser download is needed; set E2E_BASE_URL to test another server.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // The tests share one cluster namespace; running them one at a time keeps them independent.
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:4100",
    channel: "chrome",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
});
