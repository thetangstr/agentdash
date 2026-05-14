import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// Use a dedicated port so e2e tests always start their own server in local_trusted mode,
// even when the dev server is running on :3100 in authenticated mode.
const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PAPERCLIP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-e2e-home-"));

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  // These suites target dedicated multi-user configurations/ports and are
  // intentionally not part of the default local_trusted e2e run.
  testIgnore: ["multi-user.spec.ts", "multi-user-authenticated.spec.ts"],
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: BASE_URL,
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
  // The webServer directive bootstraps a throwaway instance and then starts it.
  // `onboard --yes --run` works in a non-interactive temp PAPERCLIP_HOME.
  webServer: {
    command: `pnpm paperclipai onboard --yes --run`,
    url: `${BASE_URL}/api/health`,
    // Always boot a dedicated throwaway instance for e2e so browser tests
    // never attach to the developer's active Paperclip home/server.
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PORT: String(PORT),
      PAPERCLIP_HOME,
      PAPERCLIP_INSTANCE_ID: "playwright-e2e",
      PAPERCLIP_BIND: "loopback",
      PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
      // Successor of #295: the onboarding-deep-interview spec requires
      // /assess to route through the deep-interview engine; without
      // this flag the route returns 503 on every turn. Default to true
      // so local `pnpm test:e2e` runs match CI behavior; callers that
      // need the legacy path can set it to "false" in their shell.
      AGENTDASH_DEEP_INTERVIEW_ASSESS:
        process.env.AGENTDASH_DEEP_INTERVIEW_ASSESS ?? "true",
      // Successor of #311: onboarding-deep-interview's ensure-company
      // helper creates the first workspace, then signoff-policy tries
      // to POST a second one and hits the #102 single-company guard.
      // Bypass the guard for the duration of the e2e run so all specs
      // can stand up their own isolated company state.
      AGENTDASH_ALLOW_MULTI_COMPANY:
        process.env.AGENTDASH_ALLOW_MULTI_COMPANY ?? "true",
    },
  },
  outputDir: "./test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]],
});
