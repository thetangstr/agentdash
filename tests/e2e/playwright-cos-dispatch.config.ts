import path from "node:path";
import { defineConfig } from "@playwright/test";

// Neutral default port (never the 3199 ExecOS instance); set before the base
// config reads it.
process.env.PAPERCLIP_E2E_PORT ??= "3411";
const { default: base } = await import("./playwright.config");

// CoS chat dispatch failure spec: boots the usual throwaway instance but with
// real dispatch (no canned LLM) routed to a fake `hermes` that fails like
// canary1's CoS profile until the flag file beside it appears.

const baseServer = Array.isArray(base.webServer) ? base.webServer[0]! : base.webServer!;

export default defineConfig({
  ...base,
  testMatch: "cos-dispatch-failure.spec.ts",
  testIgnore: [],
  globalSetup: undefined,
  reporter: [["list"]],
  webServer: {
    ...baseServer,
    timeout: 300_000,
    env: {
      ...(baseServer.env as Record<string, string>),
      PAPERCLIP_E2E_SKIP_LLM: "false",
      AGENTDASH_DEFAULT_ADAPTER: "hermes_local",
      AGENTDASH_HERMES_COMMAND: path.resolve(process.cwd(), "tests/e2e/fixtures/fake-hermes-chat.sh"),
    },
  },
});
