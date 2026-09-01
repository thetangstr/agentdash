import { describe, expect, it } from "vitest";
import {
  WORKSPACE_SCOPES,
  bundledWorkspacePackages,
  externalDependencyUnion,
  isWorkspaceImport,
} from "./esbuild.config.mjs";

/**
 * The two rules that decide what a source-free install contains.
 *
 * Both were got wrong on the first attempt, and both failed at RUNTIME rather
 * than at build time — the bundle compiled happily and then the server died on
 * startup. That is the expensive kind of wrong, so it is pinned here.
 */

describe("isWorkspaceImport", () => {
  it("bundles relative and absolute imports", () => {
    expect(isWorkspaceImport("./app.js")).toBe(true);
    expect(isWorkspaceImport("../packages/db/src/index.js")).toBe(true);
    expect(isWorkspaceImport("/abs/path.js")).toBe(true);
  });

  it("bundles every workspace scope, not just @paperclipai", () => {
    // The bug: a rule that only knew `@paperclipai/` externalised
    // `@agentdash/mcp-server`, which is declared `workspace:*` and is never
    // published — so the install would import a package that cannot exist in
    // its node_modules.
    expect(isWorkspaceImport("@paperclipai/db")).toBe(true);
    expect(isWorkspaceImport("@agentdash/mcp-server")).toBe(true);
  });

  it("leaves npm packages external", () => {
    for (const npm of ["express", "drizzle-orm", "postgres", "sharp", "embedded-postgres"]) {
      expect(isWorkspaceImport(npm), `${npm} must stay external`).toBe(false);
    }
  });

  it("leaves transitively-reached npm packages external too", () => {
    // `vite` pulls in `lightningcss` and a native `fsevents.node`. A
    // hand-maintained externals list covers direct dependencies only, so the
    // build failed on both. The rule does not care how they were reached.
    for (const npm of ["vite", "lightningcss", "fsevents"]) {
      expect(isWorkspaceImport(npm)).toBe(false);
    }
  });

  it("does not treat a lookalike scope as ours", () => {
    // `@paperclipai-community/x` is somebody else's package.
    expect(isWorkspaceImport("@paperclipai-community/plugin")).toBe(false);
    expect(WORKSPACE_SCOPES.every((s) => s.endsWith("/"))).toBe(true);
  });
});

describe("externalDependencyUnion", () => {
  it("covers more than the server's own dependencies", () => {
    // The failure this prevents: an install built from `server/package.json`
    // alone died on `Cannot find package 'drizzle-orm'`, then on
    // `Cannot find package 'postgres'` — dependencies of `packages/db`, whose
    // CODE is in the bundle but whose DEPENDENCIES are not.
    const { deps } = externalDependencyUnion();
    expect(deps.postgres, "postgres comes from packages/db, not server").toBeDefined();
    expect(deps["drizzle-orm"]).toBeDefined();
  });

  it("excludes workspace packages, which are inside the bundle", () => {
    const { deps } = externalDependencyUnion();
    for (const name of Object.keys(deps)) {
      expect(
        WORKSPACE_SCOPES.some((scope) => name.startsWith(scope)),
        `${name} is a workspace package and must not be a runtime dependency`,
      ).toBe(false);
    }
  });

  it("never emits a workspace: protocol range", () => {
    // `workspace:*` is meaningless to `npm install` on the target machine.
    const { deps } = externalDependencyUnion();
    for (const [name, range] of Object.entries(deps)) {
      expect(String(range).startsWith("workspace:"), `${name} -> ${range}`).toBe(false);
    }
  });

  it("scans the packages that are actually bundled", () => {
    const paths = bundledWorkspacePackages();
    expect(paths).toContain("server");
    expect(paths).toContain("packages/db");
    expect(paths.some((p) => p.startsWith("packages/adapters/"))).toBe(true);
  });
});
