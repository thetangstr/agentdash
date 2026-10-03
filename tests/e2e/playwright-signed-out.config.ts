// AgentDash (scan 4, lane O2): pages a signed-out visitor sees, against a
// throwaway authenticated instance (the default e2e config runs local_trusted,
// where nobody is ever signed out).
//
//   PAPERCLIP_E2E_PORT=3848 pnpm exec playwright test --config tests/e2e/playwright-signed-out.config.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { defineConfig } from "@playwright/test";
import { resolveE2eEmbeddedPostgresPort } from "./e2e-db-port";

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3298);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DB_PORT = resolveE2eEmbeddedPostgresPort(PORT);
const CHROMIUM_CHANNEL = process.env.PLAYWRIGHT_CHROMIUM_CHANNEL?.trim();

export default defineConfig({
  testDir: ".",
  testMatch: "signed-out-noise.spec.ts",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  retries: 0,
  use: { baseURL: BASE_URL, headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium", ...(CHROMIUM_CHANNEL ? { channel: CHROMIUM_CHANNEL } : {}) },
    },
  ],
  outputDir: "./test-results",
  reporter: [["list"]],
  webServer: {
    command: "pnpm paperclipai onboard --yes --run",
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PORT: String(PORT),
      PAPERCLIP_EMBEDDED_POSTGRES_PORT: String(DB_PORT),
      PAPERCLIP_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-signed-out-e2e-")),
      PAPERCLIP_INSTANCE_ID: "playwright-signed-out",
      PAPERCLIP_BIND: "loopback",
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
      PAPERCLIP_PUBLIC_URL: BASE_URL,
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      AGENTDASH_RATE_LIMIT_DISABLED: "true",
    },
  },
});
