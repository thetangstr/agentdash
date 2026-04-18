// Phase-1 CUJ runner config: reuses the e2e config but writes JSON to
// PLAYWRIGHT_JSON_OUTPUT_NAME so our orchestrator can render a markdown report.
import { defineConfig } from "@playwright/test";
import baseConfig from "../../tests/e2e/playwright.config";

export default defineConfig({
  ...baseConfig,
  testDir: "../../tests/e2e",
  reporter: [
    ["list"],
    ["json", { outputFile: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME ?? "./cuj-phase1.json" }],
  ],
});
