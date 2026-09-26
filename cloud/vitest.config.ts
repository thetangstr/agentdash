import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Embedded Postgres boots per suite; keep suites in separate forks.
    pool: "forks",
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
