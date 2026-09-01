import { describe, expect, it } from "vitest";
import {
  applyCompanyPrefix,
  extractCompanyPrefixFromPath,
  isBoardPathWithoutPrefix,
  toCompanyRelativePath,
} from "./company-routes";

describe("company routes", () => {
  it("treats execution workspace paths as board routes that need a company prefix", () => {
    expect(isBoardPathWithoutPrefix("/execution-workspaces/workspace-123")).toBe(true);
    expect(isBoardPathWithoutPrefix("/execution-workspaces/workspace-123/routines")).toBe(true);
    expect(extractCompanyPrefixFromPath("/execution-workspaces/workspace-123")).toBeNull();
    expect(applyCompanyPrefix("/execution-workspaces/workspace-123", "PAP")).toBe(
      "/PAP/execution-workspaces/workspace-123",
    );
    expect(applyCompanyPrefix("/execution-workspaces/workspace-123/routines", "PAP")).toBe(
      "/PAP/execution-workspaces/workspace-123/routines",
    );
  });

  it("normalizes prefixed execution workspace paths back to company-relative paths", () => {
    expect(toCompanyRelativePath("/PAP/execution-workspaces/workspace-123")).toBe(
      "/execution-workspaces/workspace-123",
    );
    expect(toCompanyRelativePath("/PAP/execution-workspaces/workspace-123/routines")).toBe(
      "/execution-workspaces/workspace-123/routines",
    );
  });
});

describe("board route roots stay in step with the router", () => {
  /**
   * The sidebar's own "My Agent" link was broken by an omission here.
   *
   * A root that is not in BOARD_ROUTE_ROOTS is assumed to BE a company prefix,
   * so `/my-agent` was read as a company called MY-AGENT, returned unprefixed,
   * and fell through to the :companyPrefix route — which reported "No company
   * matches prefix MY-AGENT" for a page that has nothing to do with a company.
   */
  it("treats /my-agent as a board route, not a company code", () => {
    expect(extractCompanyPrefixFromPath("/my-agent")).toBeNull();
    expect(applyCompanyPrefix("/my-agent", "KESA")).toBe("/KESA/my-agent");
    expect(isBoardPathWithoutPrefix("/my-agent")).toBe(true);
  });

  /**
   * The guard that matters more than the case above: every path registered
   * under `boardRoutes()` must be recognised as a board root. Reading App.tsx
   * as source is crude, but it is the only way to catch the *next* route
   * somebody adds without touching this file — which is exactly how this bug
   * arrived.
   */
  it("recognises every root registered under boardRoutes()", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const appSource = fs.readFileSync(
      path.resolve(import.meta.dirname, "../App.tsx"),
      "utf8",
    );

    const board = appSource.match(/function boardRoutes\(\)[\s\S]*?\n\}/);
    expect(board, "boardRoutes() should still exist in App.tsx").toBeTruthy();

    const roots = new Set(
      [...board![0].matchAll(/path="([^"]+)"/g)]
        .map((m) => m[1]!.split("/")[0]!.toLowerCase())
        .filter((root) => root && root !== "*" && !root.startsWith(":")),
    );
    expect(roots.size, "should have found some board routes to check").toBeGreaterThan(5);

    // `instance` is deliberately global (it is not company-scoped), and
    // `onboarding`/`settings` have their own top-level routes ahead of the
    // :companyPrefix block, so they never reach prefix extraction.
    const globallyRouted = new Set(["instance", "onboarding", "settings", "tests", "plugins"]);

    const misread = [...roots]
      .filter((root) => !globallyRouted.has(root))
      .filter((root) => extractCompanyPrefixFromPath(`/${root}`) !== null);

    expect(misread, "these roots would be mistaken for company codes").toEqual([]);
  });
});
