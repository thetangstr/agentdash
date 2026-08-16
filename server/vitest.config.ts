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
    /**
     * Rebuild `@paperclipai/shared` and `@paperclipai/plugin-sdk` before the
     * suite runs, if their sources have moved on.
     *
     * Both are imported through their `exports` maps, which point at `dist` —
     * so without this the tests exercise whatever was built last, not what is
     * on disk. That is not hypothetical: deleting the plugin capability gate
     * from SDK source broke no test, because the suite was running against a
     * dist compiled before the deletion. Green over a stale artifact.
     *
     * `typecheck` already ran this script; tests did not.
     */
    globalSetup: ["./src/__tests__/global-setup-build-deps.ts"],
  },
});
