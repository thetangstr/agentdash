import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    isolate: true,
    maxConcurrency: 1,
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
    poolOptions: {
      forks: {
        isolate: true,
        maxForks: 1,
        minForks: 1,
      },
    },
    sequence: {
      concurrent: false,
      hooks: "list",
    },
    // AgentDash: bound every phase so a wedged embedded-Postgres start/teardown
    // fails fast (and the fork is killed) instead of hanging the whole job to the
    // 35-min CI timeout. Generous enough for migration replay on slow CI runners.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    teardownTimeout: 30_000,
    setupFiles: ["./src/__tests__/setup-supertest.ts"],
  },
});
