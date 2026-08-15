import { defineConfig } from "vitest/config";

// Standalone: this package is published on its own and must not inherit the
// monorepo's project list, whose paths do not resolve from here.
export default defineConfig({
  test: {
    include: ["src/**/*.test.mjs"],
    environment: "node",
  },
});
