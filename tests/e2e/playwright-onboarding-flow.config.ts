/**
 * Playwright configuration for the onboarding-flow e2e spec.
 *
 * Boots a dedicated server in `authenticated` deployment mode so the sign-up
 * form is live. Uses port 3198 to avoid colliding with local_trusted e2e
 * (3199) or multi-user authenticated (3105).
 *
 * Config isolation: PAPERCLIP_CONFIG is set to a non-existent path so the
 * ancestor-search in resolvePaperclipConfigPath() is bypassed. The server
 * falls back to all-env-var defaults; PAPERCLIP_DEPLOYMENT_MODE=authenticated
 * overrides the --yes quickstart default at runtime (the config file the
 * CLI writes is separate from the env override the server reads on startup).
 *
 * The spec's beforeAll runs the bootstrap-ceo invite script (same pattern as
 * multi-user-authenticated.spec.ts). The config path written by onboard --yes
 * lives at <PAPERCLIP_HOME>/instances/<INSTANCE_ID>/config.json and is passed
 * to test workers via the webServer.env PAPERCLIP_E2E_* vars, which Playwright
 * workers inherit as process.env.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3198);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const INSTANCE_ID = "playwright-onboarding-e2e";

// Use a stable temp dir keyed on the main process PID so all evaluations of
// this config file within the same Playwright run share the same directory.
// Workers inherit the parent's process.env, so if PAPERCLIP_E2E_HOME was
// set by the main process they get the same value.
const PAPERCLIP_HOME =
  process.env.PAPERCLIP_E2E_HOME ??
  (() => {
    const dir = path.join(os.tmpdir(), `paperclip-e2e-onboarding-${process.pid}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  })();

// Set in main process env so it propagates to forked workers
process.env.PAPERCLIP_E2E_HOME = PAPERCLIP_HOME;

process.env.PAPERCLIP_E2E_BASE_URL = BASE_URL;

// The config file path we pass to PAPERCLIP_CONFIG:
//  - Before server starts: file doesn't exist → ancestor-config-search is bypassed
//    and readConfigFile() returns null (server uses env-var defaults).
//  - After `onboard --yes` runs: it writes the config TO this exact path
//    (the CLI always writes to PAPERCLIP_CONFIG when set).
//  - The spec's beforeAll bootstrap script also reads from this path.
const E2E_CONFIG_PATH = path.join(PAPERCLIP_HOME, "e2e-config.json");
process.env.PAPERCLIP_E2E_CONFIG_PATH = E2E_CONFIG_PATH;

export default defineConfig({
  testDir: ".",
  testMatch: "onboarding-flow.spec.ts",
  timeout: 120_000,
  expect: {
    timeout: 30_000,
  },
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
  webServer: {
    command: `pnpm paperclipai onboard --yes --run`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PORT: String(PORT),
      PAPERCLIP_HOME,
      PAPERCLIP_INSTANCE_ID: INSTANCE_ID,
      PAPERCLIP_CONFIG: E2E_CONFIG_PATH,
      PAPERCLIP_BIND: "loopback",
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
      PAPERCLIP_AUTH_PUBLIC_BASE_URL: BASE_URL,
      BETTER_AUTH_SECRET: "test-secret-e2e-onboarding-flow-insecure",
      // Propagate to test workers that read these in beforeAll / sessionFetch
      PAPERCLIP_E2E_HOME: PAPERCLIP_HOME,
      PAPERCLIP_E2E_CONFIG_PATH: E2E_CONFIG_PATH,
      PAPERCLIP_E2E_BASE_URL: BASE_URL,
      PAPERCLIP_E2E_PORT: String(PORT),
    },
  },
  outputDir: "./test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]],
});
