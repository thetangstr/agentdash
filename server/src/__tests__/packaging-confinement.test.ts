import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs build config, no types
import { isWorkspaceImport, externalDependencyUnion, PATCHED_BUNDLED_PACKAGES } from "../../esbuild.config.mjs";

/**
 * Packaging must not silently un-confine the agents.
 *
 * This is the third appearance of one bug. `hermes-paperclip-adapter` is
 * patched in this repo and its `@paperclipai/adapter-utils` is overridden to
 * our sandboxed build. Neither a patch nor a pnpm override survives `npm
 * install` on a client machine — so while the adapter was listed as an
 * external dependency, a packaged deployment fetched the pristine published
 * 0.3.0, which depends on the published adapter-utils containing NO sandbox
 * code. The operator would read "agent subprocess sandbox: on" in their logs
 * and the agents would be running unconfined.
 *
 * It was invisible because every check was done in the DEV tree, where the
 * patch and the override are both in force. These cases pin the packaging
 * rules themselves, which is the only place the difference shows up.
 */
describe("packaged install keeps agent confinement", () => {
  it("bundles every locally patched package instead of depending on it", () => {
    expect(PATCHED_BUNDLED_PACKAGES).toContain("hermes-paperclip-adapter");
    for (const name of PATCHED_BUNDLED_PACKAGES) {
      expect(isWorkspaceImport(name), `${name} must be bundled`).toBe(true);
      // Deep imports too — the adapter is reached as `<pkg>/server`.
      expect(isWorkspaceImport(`${name}/server`), `${name}/server must be bundled`).toBe(true);
    }
  });

  it("does NOT also list a bundled package as an npm dependency", () => {
    // Listing it as well means npm installs the published copy alongside the
    // bundled one, and resolution order decides which sandbox you get.
    const { deps } = externalDependencyUnion();
    for (const name of PATCHED_BUNDLED_PACKAGES) {
      expect(Object.keys(deps), `${name} must not be an external dependency`).not.toContain(name);
    }
  });

  it("still externalises ordinary npm packages", () => {
    // The guard above must not turn into "bundle everything", which would
    // drag native modules into the bundle and break the build.
    expect(isWorkspaceImport("express")).toBe(false);
    expect(isWorkspaceImport("postgres")).toBe(false);
    const { deps } = externalDependencyUnion();
    expect(Object.keys(deps).length).toBeGreaterThan(20);
    expect(deps).toHaveProperty("express");
  });

  it("keeps our own workspace packages inside the bundle", () => {
    expect(isWorkspaceImport("@paperclipai/adapter-utils")).toBe(true);
    expect(isWorkspaceImport("@paperclipai/adapter-utils/server-utils")).toBe(true);
    expect(isWorkspaceImport("@agentdash/mcp-server")).toBe(true);
  });
});
