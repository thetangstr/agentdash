import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3106);
const BASE_URL = process.env.PAPERCLIP_E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

/**
 * AgentDash-MK workforce acceptance.
 *
 * Separate config because the multi-user configs pin `testMatch` to their own
 * spec. Expects a server already listening on PORT in `local_trusted` mode.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "agentdash-mk-workforce.spec.ts",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  retries: 0,
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  outputDir: "./test-results",
  reporter: [["list"]],
});
