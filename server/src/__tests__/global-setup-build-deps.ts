import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Bring `@paperclipai/shared` and `@paperclipai/plugin-sdk` up to date before
 * the suite runs.
 *
 * Both are consumed through their package `exports` maps, which point at
 * `dist`. Without this, the tests exercise whatever was compiled last rather
 * than what is on disk — and the script this delegates to used to check only
 * that `dist/index.js` EXISTED, so a stale build was never noticed at all.
 *
 * The cost of getting this wrong is a suite that is green about code it never
 * ran. It was found the way such things are found: a deliberate sabotage of
 * the plugin capability gate failed to break a single test.
 *
 * `ensure-plugin-build-deps.mjs` is a no-op when the outputs are current, so
 * the usual case adds a directory walk and nothing more.
 */
export default function setup(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(here, "../../..");
  const script = path.join(rootDir, "scripts/ensure-plugin-build-deps.mjs");

  const result = spawnSync(process.execPath, [script], {
    cwd: rootDir,
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    // Fail loudly. Continuing would run the suite against a build we know is
    // stale, which is the exact condition this exists to prevent.
    throw new Error(
      `ensure-plugin-build-deps failed with status ${result.status}; `
      + "the test suite would otherwise run against a stale dist.",
    );
  }
}
