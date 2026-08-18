#!/usr/bin/env node
/**
 * Assemble a source-free server install.
 *
 * Produces the layout that was proven to serve:
 *
 *   <out>/package.json      version + type + the external dependency union
 *   <out>/dist/index.js     the bundled server, no .ts anywhere
 *   <out>/dist/migrations/  drizzle SQL, resolved relative to the bundle
 *   <out>/ui-dist/          built UI
 *   <out>/mcp-dist/         the MCP server tarball, if built
 *
 * `node_modules` is NOT produced here. Run `npm install --omit=dev` inside the
 * output, or `pnpm deploy`, to materialise it. That is deliberate: this script
 * decides WHAT the install contains, and leaves HOW dependencies arrive to the
 * installer that will run on the target machine.
 *
 * Why each path matters, all learned by watching it fail:
 *   - `dist/migrations` because `packages/db/src/client.ts` resolves them with
 *     `new URL("./migrations", import.meta.url)`, which after bundling means
 *     "next to the bundle".
 *   - `package.json` because `server/src/version.ts` does
 *     `createRequire(import.meta.url)` then `require("../package.json")`.
 *   - `ui-dist` and `mcp-dist` because `app.ts` looks for `../ui-dist` and
 *     `../mcp-dist` before falling back to repo paths.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

import buildConfig, { externalDependencyUnion } from "../server/esbuild.config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const outDir = resolve(process.argv[2] ?? resolve(repoRoot, "dist-install"));

function copyIfPresent(from, to, label) {
  if (!existsSync(from)) {
    console.warn(`  ${label}: not built at ${from} — skipped`);
    return false;
  }
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  console.log(`  ${label}: copied`);
  return true;
}

console.log(`Packaging a source-free server install into ${outDir}`);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(resolve(outDir, "dist"), { recursive: true });

const result = await esbuild.build({
  ...buildConfig,
  outfile: resolve(outDir, "dist/index.js"),
  metafile: true,
});
const bundleBytes = Object.values(result.metafile.outputs).find((o) => o.entryPoint)?.bytes ?? 0;
console.log(
  `  bundle: ${Object.keys(result.metafile.inputs).length} source files -> ` +
    `${(bundleBytes / 1_000_000).toFixed(1)} MB, ${result.warnings.length} warnings`,
);

copyIfPresent(resolve(repoRoot, "packages/db/src/migrations"), resolve(outDir, "dist/migrations"), "migrations");
copyIfPresent(resolve(repoRoot, "server/src/onboarding-assets"), resolve(outDir, "dist/onboarding-assets"), "onboarding assets");
copyIfPresent(resolve(repoRoot, "ui/dist"), resolve(outDir, "ui-dist"), "ui");
copyIfPresent(resolve(repoRoot, "packages/mcp-server/agentdash-mcp-server.tgz"), resolve(outDir, "mcp-dist/agentdash-mcp-server.tgz"), "mcp tarball");

const serverManifest = JSON.parse(readFileSync(resolve(repoRoot, "server/package.json"), "utf8"));
const { deps, conflicts, unresolved } = externalDependencyUnion();
for (const u of unresolved) {
  // A dependency we could not pin falls back to its range, which means the
  // target may install a version nobody tested. Say so rather than let it pass.
  console.warn(`  NOT PINNED: ${u.name} (${u.range}) — not installed under ${u.pkgPath}`);
}
for (const c of conflicts) {
  // Surfaced rather than silently resolved: two workspace packages asking for
  // different ranges of the same dependency is a decision, not a detail.
  console.warn(`  version conflict: ${c.name} ${c.existing} vs ${c.incoming} (from ${c.pkgPath})`);
}
writeFileSync(
  resolve(outDir, "package.json"),
  `${JSON.stringify(
    { name: "agentdash", version: serverManifest.version, private: true, type: "module", dependencies: deps },
    null,
    2,
  )}\n`,
);
console.log(`  package.json: ${Object.keys(deps).length} external dependencies`);

console.log("\nNext: run `npm install --omit=dev` inside the output to materialise node_modules,");
console.log("then start it with `node dist/index.js`.");
