import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // AgentDash: fail the run if a test leaves a runtime-service or SSH-fixture
    // process alive. It only kills processes proven to be this run's (recorded
    // descendants, or carrying the run id in their environment), never other
    // runs' or anything that merely names the run's short /tmp directory.
    globalSetup: ["./scripts/lib/vitest-process-leak-check.mjs"],
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
      // AgentDash: the self-serve cloud control plane (GH #762).
      "cloud",
    ],
  },
});
