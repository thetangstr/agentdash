/**
 * esbuild configuration for building the AgentDash MCP server standalone binary.
 *
 * Bundles @paperclipai/shared (workspace dep) into the output so the artifact
 * is self-contained and can be published/run via npx with no unresolved workspace
 * dependencies. Real npm deps (@modelcontextprotocol/sdk, zod) are marked external
 * and will be installed alongside the package at runtime.
 */

/** @type {import('esbuild').BuildOptions} */
export default {
  entryPoints: ["src/stdio.ts"],
  outfile: "dist/stdio.js",
  banner: { js: "#!/usr/bin/env node" },
  platform: "node",
  target: "node20",
  format: "esm",
  bundle: true,
  sourcemap: true,
  // @paperclipai/shared is a workspace dep — bundle it in so the published
  // artifact has no workspace references.
  // @modelcontextprotocol/sdk and zod are real npm deps, keep them external.
  external: ["@modelcontextprotocol/sdk", "zod"],
};
