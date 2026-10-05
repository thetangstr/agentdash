import { defineConfig } from "@playwright/test";
import { resolveE2eServerPort } from "./e2e-port";

const PORT = resolveE2eServerPort(3105);
const BASE_URL = process.env.PAPERCLIP_E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: ".",
  testMatch: "multi-user-authenticated.spec.ts",
  timeout: 180_000,
  expect: {
    // Dev-mode page boots can take ~60s on a saturated machine; render-bound
    // expects need more than the usual 5s/20s.
    timeout: 60_000,
  },
  retries: 0,
  use: {
    baseURL: BASE_URL,
    // Module scripts hold `load`; a dev-mode module graph can take >30s to
    // evaluate on a loaded runner.
    navigationTimeout: 90_000,
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  outputDir: "./test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]],
});
