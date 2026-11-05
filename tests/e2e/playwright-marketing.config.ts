import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.AGENTDASH_MARKETING_PREVIEW_PORT || 3398);
const channel = process.env.PLAYWRIGHT_CHROMIUM_CHANNEL?.trim();
export default defineConfig({
  testDir: here,
  testMatch: "marketing.spec.ts",
  timeout: 30_000,
  retries: 0,
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true, screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { browserName: "chromium", ...(channel ? { channel } : {}) } }],
  webServer: {
    command: "node tests/e2e/fixtures/marketing-preview.mjs",
    cwd: path.resolve(here, "../.."),
    env: { PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}` },
    url: `http://127.0.0.1:${port}/agent-performance`,
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
