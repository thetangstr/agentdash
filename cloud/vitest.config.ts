import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The workspace MCP package resolves to its built dist/ at runtime; tests
    // run its source, so they need no build (src/types/agentdash-mcp-server.d.ts).
    alias: { "@agentdash/mcp-server": fileURLToPath(new URL("../packages/mcp-server/src/index.ts", import.meta.url)) },
  },
  test: {
    environment: "node",
    // Embedded Postgres boots per suite; keep suites in separate forks.
    pool: "forks",
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
