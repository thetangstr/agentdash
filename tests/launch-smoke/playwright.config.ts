import { defineConfig } from "@playwright/test";

const BASE_URL = process.env.AGENTDASH_LAUNCH_SMOKE_BASE_URL?.trim().replace(/\/+$/, "");

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  timeout: 120_000,
  expect: {
    timeout: 20_000,
  },
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: BASE_URL || "http://127.0.0.1:1",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
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
