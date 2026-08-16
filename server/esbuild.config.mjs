/**
 * esbuild configuration for building the server as a single file.
 *
 * The point is Gate 4's "the client's machine holds no source". Today launchd
 * runs `pnpm exec tsx src/index.ts` — production executes the TypeScript source
 * tree, which is why 2,329 source files and 192 MB of git history sit on the
 * client's machine. A bundle removes the reason for them to be there.
 *
 * Proven by running, not by reasoning: a bundle built with this config, given
 * the layout in `scripts/package-server.mjs`, started against a scratch
 * database, applied all 117 migrations, and produced a public schema with
 * exactly the same 167 tables as the live `uat` instance. It served
 * `GET /api/health` and the UI. The install contained zero `.ts` files and no
 * `.git`.
 *
 * No source changes were needed. `app.ts` already resolves the UI and MCP
 * assets through a two-candidate list — a packaged path first, a repo path
 * second — so it was written anticipating this layout.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

/**
 * Scopes whose packages are OURS and belong inside the bundle.
 *
 * `@agentdash/` is not decoration. `@agentdash/mcp-server` is a workspace
 * package declared with `workspace:*`, and a rule that only recognised
 * `@paperclipai/` externalised it — leaving the bundle importing a package
 * that is never published and would not be in node_modules on the client's
 * machine.
 */
export const WORKSPACE_SCOPES = ["@paperclipai/", "@agentdash/"];

/**
 * Decide whether a bare import is ours (bundle it) or npm's (leave it out).
 *
 * Exported so it can be tested directly. The alternative — a hand-maintained
 * list of externals, as the CLI config uses — only ever covers DIRECT
 * dependencies. The first transitive one esbuild follows breaks the build:
 * here `vite` dragged in `lightningcss` and a native `fsevents.node`, neither
 * of which the server ever meant to bundle.
 */
export function isWorkspaceImport(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return true;
  return WORKSPACE_SCOPES.some((scope) => specifier.startsWith(scope));
}

const externalizeNpm = {
  name: "externalize-npm",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === "entry-point") return null;
      if (isWorkspaceImport(args.path)) return null;
      return { path: args.path, external: true };
    });
  },
};

/** Every workspace package whose source ends up inside the bundle. */
export function bundledWorkspacePackages() {
  const paths = [
    "server",
    "packages/db",
    "packages/shared",
    "packages/adapter-utils",
    "packages/plugins/sdk",
    "packages/mcp-server",
  ];
  for (const dir of readdirSync(resolve(repoRoot, "packages/adapters"))) {
    paths.push(`packages/adapters/${dir}`);
  }
  return paths;
}

/**
 * The dependencies a packaged install must actually have on disk.
 *
 * The UNION across every bundled package, not just the server's own. Found the
 * hard way: an install carrying only `server`'s 45 dependencies died on
 * `Cannot find package 'drizzle-orm'`, and once that was fixed, on
 * `Cannot find package 'postgres'` — both dependencies of `packages/db`, whose
 * code is inside the bundle but whose dependencies are not.
 */
export function externalDependencyUnion() {
  const deps = {};
  const conflicts = [];
  const unresolved = [];
  for (const pkgPath of bundledWorkspacePackages()) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(resolve(repoRoot, pkgPath, "package.json"), "utf8"));
    } catch {
      continue;
    }
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      if (WORKSPACE_SCOPES.some((scope) => name.startsWith(scope))) continue;
      const pinned = installedVersion(name, pkgPath);
      if (!pinned) unresolved.push({ name, pkgPath, range });
      const value = pinned ?? range;
      if (deps[name] && deps[name] !== value) {
        conflicts.push({ name, existing: deps[name], incoming: value, pkgPath });
      }
      deps[name] = value;
    }
  }
  return { deps, conflicts, unresolved };
}

/**
 * The version actually installed in this workspace, not the range asked for.
 *
 * A shipped artefact should carry what was TESTED. Emitting `^1.2.3` lets the
 * install on the target resolve 1.9.0 — a version nobody ran the suite against,
 * chosen by whenever the install happened to run. Pinning removes that.
 *
 * It also matters because `pnpm deploy` cannot be used here: it copies the
 * package's `.ts` sources into the output, which is precisely what a
 * source-free install exists to avoid.
 */
function installedVersion(name, pkgPath) {
  const candidates = [resolve(repoRoot, pkgPath, "node_modules", name), resolve(repoRoot, "node_modules", name)];
  for (const dir of candidates) {
    try {
      const version = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")).version;
      if (typeof version === "string" && version.length > 0) return version;
    } catch {
      // Not installed here; try the next location.
    }
  }
  return null;
}

/** @type {import('esbuild').BuildOptions} */
export default {
  absWorkingDir: resolve(repoRoot, "server"),
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: "dist-bundle/index.js",
  plugins: [externalizeNpm],
  treeShaking: true,
  sourcemap: true,
  logLevel: "warning",
};
