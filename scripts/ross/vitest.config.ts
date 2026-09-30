import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Offline probes only. No global setup/build of shared live-service dependencies.
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  // Keep any Vite cache outside the checkout and away from the reused install.
  cacheDir: process.env.ROSS_VITEST_CACHE_DIR || join(tmpdir(), 'ross-vitest-cache'),
  // Root tsconfig references an absent inherited droid-local package. This probe
  // uses its own transformation settings rather than changing repository config.
  esbuild: { tsconfigRaw: '{"compilerOptions":{"target":"ES2023"}}' },
  test: { cache: false, include: ['scripts/ross/*.test.ts'], environment: 'node', maxWorkers: 1, minWorkers: 1, fileParallelism: false, testTimeout: 30_000 },
});
