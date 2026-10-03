// AgentDash (#767, SC-6): the claim link, end to end in a browser.
//
// Against a real hosted box (the release acceptance run):
//   CLAIM_E2E_BASE_URL=https://<slug>.agentdash.cloud CLAIM_E2E_EMAIL=<claim email> \
//   CLAIM_E2E_CODE=<claim code, from the control plane; never commit or paste it> \
//   pnpm exec playwright test --config tests/e2e/playwright-claim-link.config.ts
// Without CLAIM_E2E_BASE_URL it boots a throwaway authenticated instance on a
// loopback port with a claim binding and a random code made for this run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { defineConfig } from "@playwright/test";
import { resolveE2eEmbeddedPostgresPort } from "./e2e-db-port";

const external = process.env.CLAIM_E2E_BASE_URL?.trim();
const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3299);
const DB_PORT = external ? null : resolveE2eEmbeddedPostgresPort(PORT);
const BASE_URL = external || `http://127.0.0.1:${PORT}`;
if (!external) {
  process.env.CLAIM_E2E_EMAIL ??= `claim-${Date.now()}@example.test`;
  process.env.CLAIM_E2E_CODE ??= `AGD-${randomBytes(13).toString("hex").toUpperCase()}`;
}
process.env.CLAIM_E2E_BASE_URL_RESOLVED = BASE_URL;

export default defineConfig({
  testDir: ".",
  testMatch: "claim-link.spec.ts",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: 0,
  use: { baseURL: BASE_URL, headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  outputDir: "./test-results",
  reporter: [["list"]],
  ...(external
    ? {}
    : {
        webServer: {
          command: "pnpm paperclipai onboard --yes --run",
          url: `${BASE_URL}/api/health`,
          reuseExistingServer: false,
          timeout: 180_000,
          stdout: "pipe" as const,
          stderr: "pipe" as const,
          env: {
            ...process.env,
            PORT: String(PORT),
            PAPERCLIP_EMBEDDED_POSTGRES_PORT: String(DB_PORT),
            PAPERCLIP_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-claim-e2e-")),
            PAPERCLIP_INSTANCE_ID: "playwright-claim-link",
            PAPERCLIP_BIND: "loopback",
            PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
            PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
            PAPERCLIP_PUBLIC_URL: BASE_URL,
            BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
            AGENTDASH_REQUIRE_SIGNUP_INVITE_CODE: "true",
            AGENTDASH_INVITE_CODES: process.env.CLAIM_E2E_CODE!,
            AGENTDASH_CLAIM_EMAIL: process.env.CLAIM_E2E_EMAIL!,
            AGENTDASH_SELF_SERVE_BOOTSTRAP: "true",
            AGENTDASH_RATE_LIMIT_DISABLED: "true",
          },
        },
      }),
});
