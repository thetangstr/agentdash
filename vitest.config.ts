import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/shared",
      "packages/db",
      "packages/adapter-utils",
      // AgentDash: mcp-server carries 96 tests that no runner was executing.
      "packages/mcp-server",
      "packages/adapters/acpx-local",
      "packages/adapters/claude-local",
      "packages/adapters/codex-local",
      "packages/adapters/cursor-local",
      "packages/adapters/gemini-local",
      // AgentDash: openclaw-gateway's suite was listed in no project, so the
      // weakest harness-directive path in the system had a test file nobody ran.
      "packages/adapters/openclaw-gateway",
      "packages/adapters/opencode-local",
      "packages/adapters/pi-local",
      // AgentDash: paperclip-plugin-fake-sandbox is a workspace member with a
      // test script, but packages/plugins/* was in neither this list nor
      // run-vitest-stable.mjs — so pnpm test:run executed its suite in no runner.
      "packages/plugins/paperclip-plugin-fake-sandbox",
      // packages/plugins/sandbox-providers/e2b is deliberately outside the
      // workspace (pnpm-workspace.yaml excludes it so its third-party deps stay
      // out of the lockfile) — intentionally not registered here.
      "server",
      "ui",
      "cli",
    ],
  },
});
