/**
 * esbuild configuration for building the AgentDash MCP server standalone bundle.
 *
 * Both published entry points are bundled so each is self-contained:
 *   - dist/stdio.js  — the `agentdash-mcp-server` bin (npx target)
 *   - dist/index.js  — the library entry (publishConfig main/exports)
 *
 * @paperclipai/shared is a workspace dep (a devDependency here, never published),
 * so it MUST be inlined into both outputs — otherwise the library entry would
 * carry an unresolved `@paperclipai/shared` import for consumers who `import`
 * the package. Real npm deps (@modelcontextprotocol/sdk, zod) stay external and
 * are installed alongside the package at runtime.
 */

/** @type {import('esbuild').BuildOptions} */
export default {
  entryPoints: ["src/stdio.ts", "src/index.ts"],
  outdir: "dist",
  // Shebang lands on both files; Node strips it from the imported library entry,
  // and it makes dist/stdio.js directly executable as the bin.
  banner: { js: "#!/usr/bin/env node" },
  platform: "node",
  target: "node20",
  format: "esm",
  bundle: true,
  sourcemap: true,
  // @paperclipai/shared is a workspace dep — bundle it in so the published
  // artifacts have no workspace references.
  // @modelcontextprotocol/sdk and zod are real npm deps, keep them external.
  external: ["@modelcontextprotocol/sdk", "zod"],
};
