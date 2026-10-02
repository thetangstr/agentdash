import { describe, expect, it } from "vitest";
import { RESERVED_COMPANY_PREFIXES, isReservedCompanyPrefix } from "@paperclipai/shared";
import {
  applyCompanyPrefix,
  extractCompanyPrefixFromPath,
  isBoardPathWithoutPrefix,
  listRouteRoots,
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

  // AgentDash: UX-2 (#783) — the Shipped page is a board route.
  it("treats /shipped as a board route, not a company code", () => {
    expect(extractCompanyPrefixFromPath("/shipped")).toBeNull();
    expect(applyCompanyPrefix("/shipped", "KESA")).toBe("/KESA/shipped");
    expect(isBoardPathWithoutPrefix("/shipped")).toBe(true);
  });

  // AgentDash: UX-6 (#787) — Decisions is a board route, not a company code.
  it("treats /decisions as a board route, not a company code", () => {
    expect(extractCompanyPrefixFromPath("/decisions")).toBeNull();
    expect(applyCompanyPrefix("/decisions", "KESA")).toBe("/KESA/decisions");
    expect(isBoardPathWithoutPrefix("/decisions")).toBe(true);
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

    // `instance` is deliberately global (it is not company-scoped) and
    // `tests` is a dev-only perf page that also has a top-level route.
    const globallyRouted = new Set(["instance", "tests"]);

    const misread = [...roots]
      .filter((root) => !globallyRouted.has(root))
      .filter((root) => extractCompanyPrefixFromPath(`/${root}`) !== null);

    expect(misread, "these roots would be mistaken for company codes").toEqual([]);
  });
});

 it('treats cos (Ask) as a company route so links reach the sidebar Layout', () => {
 expect(applyCompanyPrefix('/cos', 'ACME')).toBe('/ACME/cos');
 expect(applyCompanyPrefix('/cos?x=1#y', 'ACME')).toBe('/ACME/cos?x=1#y');
 expect(extractCompanyPrefixFromPath('/cos')).toBeNull();
 expect(extractCompanyPrefixFromPath('/ACME/cos')).toBe('ACME');
 });

 it('treats workforce as a company route and preserves its query and brief anchor', () => {
 expect(applyCompanyPrefix('/workforce?agent=a#company-brief', 'ACME')).toBe('/ACME/workforce?agent=a#company-brief');
 });

 it('strips the company prefix from /:prefix/onboarding so a remembered path never doubles it', () => {
 expect(toCompanyRelativePath('/WAN/onboarding')).toBe('/onboarding');
 expect(extractCompanyPrefixFromPath('/onboarding')).toBeNull();
 expect(extractCompanyPrefixFromPath('/WAN/onboarding')).toBe('WAN');
 });

/**
 * Every top-level route in App.tsx is either company-agnostic (a global root)
 * or a board root. A root in neither set is read as a company prefix by the
 * company-aware navigate(), which is how "Continue to your Chief of Staff" on
 * /setup landed on /SETUP/cos ("Company not found").
 */
describe("every top-level route in App.tsx is a global root or a board root", () => {
  type ParsedRoute = { path: string | null; children: ParsedRoute[] };

  // Walks the <Route> tags of a JSX fragment and returns the tree. Tag ends
  // are found by tracking {} depth, so `element={<Layout />}` does not end
  // the tag early.
  function parseRoutes(source: string): ParsedRoute[] {
    const root: ParsedRoute = { path: null, children: [] };
    const stack: ParsedRoute[] = [root];
    let i = 0;
    while (i < source.length) {
      if (source.startsWith("</Route>", i)) {
        stack.pop();
        i += "</Route>".length;
        continue;
      }
      if (source.startsWith("<Route", i) && /[\s>]/.test(source[i + "<Route".length] ?? "")) {
        let depth = 0;
        let j = i + "<Route".length;
        for (; j < source.length; j += 1) {
          const ch = source[j];
          if (ch === "{") depth += 1;
          else if (ch === "}") depth -= 1;
          else if (ch === ">" && depth === 0) break;
        }
        const tag = source.slice(i, j + 1);
        const selfClosing = source[j - 1] === "/";
        const pathMatch = tag.match(/\bpath="([^"]*)"/);
        // A computed path (path={...}) cannot be checked by reading source.
        const computed = tag.match(/\bpath=\{([^}]*)\}/);
        const node: ParsedRoute = {
          path: pathMatch ? pathMatch[1]! : computed ? `{${computed[1]!.trim()}}` : null,
          children: [],
        };
        stack[stack.length - 1]!.children.push(node);
        if (!selfClosing) stack.push(node);
        i = j + 1;
        continue;
      }
      i += 1;
    }
    return root.children;
  }

  // A route is top-level when every ancestor is a pathless layout route
  // (e.g. <Route element={<CloudAccessGate />}>).
  function topLevelPaths(routes: ParsedRoute[]): string[] {
    return routes.flatMap((route) => (route.path === null ? topLevelPaths(route.children) : [route.path]));
  }

  async function readApp() {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const appSource = fs.readFileSync(path.resolve(import.meta.dirname, "../App.tsx"), "utf8");
    const app = appSource.match(/export function App\(\)[\s\S]*?\n\}/);
    const board = appSource.match(/function boardRoutes\(\)[\s\S]*?\n\}/);
    expect(app, "App() should still exist in App.tsx").toBeTruthy();
    expect(board, "boardRoutes() should still exist in App.tsx").toBeTruthy();
    return { app: app![0], board: board![0] };
  }

  function rootsOf(paths: string[]): string[] {
    return [
      ...new Set(
        paths
          .filter((p) => !p.startsWith("{"))
          .map((p) => p.replace(/^\//, "").split("/")[0]!.toLowerCase())
          // "/" is the landing page, ":companyPrefix" is the company itself,
          // "*" is the not-found page.
          .filter((root) => root && root !== "*" && !root.startsWith(":")),
      ),
    ];
  }

  // The one computed top-level path: the docs shadow routes, all under /docs
  // (DOCS_SHADOW_ROUTE_PATHS, ui/src/lib/docs-nav.ts).
  const ALLOWED_COMPUTED_TOP_LEVEL_PATHS = ["{path}"];

  it("leaves no top-level root to be misread as a company code", async () => {
    const { app } = await readApp();
    const paths = topLevelPaths(parseRoutes(app));

    // A computed path hides its root from this check; only the docs map may.
    const computed = paths.filter((p) => p.startsWith("{"));
    expect(computed, "a top-level <Route path={...}> this test cannot check").toEqual(ALLOWED_COMPUTED_TOP_LEVEL_PATHS);
    expect(app).toContain("DOCS_SHADOW_ROUTE_PATHS.map((path) => <Route key={path} path={path}");

    const roots = rootsOf(paths);
    expect(roots.length, "should have found the top-level routes").toBeGreaterThan(20);
    expect(roots).toEqual(expect.arrayContaining(["setup", "company-create", "trial", "oauth", "invite", "auth", "claim"]));

    const misread = roots.filter((root) => extractCompanyPrefixFromPath(`/${root}`) !== null);
    expect(misread, "these top-level routes would be read as company codes").toEqual([]);
  });

  it("answers every board root unprefixed too", async () => {
    const { app, board } = await readApp();
    const topLevel = new Set(rootsOf(topLevelPaths(parseRoutes(app))));
    const boardRoots = rootsOf(topLevelPaths(parseRoutes(board)));
    expect(boardRoots.length).toBeGreaterThan(20);
    const missing = boardRoots.filter((root) => !topLevel.has(root));
    expect(missing, "board roots with no top-level route (add an UnprefixedBoardRedirect)").toEqual([]);
  });

  it("keeps both route sets inside the shared reserved company prefixes", () => {
    const { global, board } = listRouteRoots();
    const reserved = new Set<string>(RESERVED_COMPANY_PREFIXES);
    expect([...global, ...board].filter((root) => !reserved.has(root))).toEqual([]);
    expect(isReservedCompanyPrefix("MCP")).toBe(true);
    expect(isReservedCompanyPrefix("ORG")).toBe(true);
    expect(isReservedCompanyPrefix("ACME")).toBe(false);
  });

  it("navigates from /setup to the selected company's CoS, not /SETUP/cos", () => {
    // useNavigate() takes the prefix from the current path first; /setup has none.
    expect(extractCompanyPrefixFromPath("/setup")).toBeNull();
    expect(applyCompanyPrefix("/cos", "ACME")).toBe("/ACME/cos");
    expect(applyCompanyPrefix("/setup", "ACME")).toBe("/setup");
    expect(extractCompanyPrefixFromPath("/company-create")).toBeNull();
    expect(extractCompanyPrefixFromPath("/oauth/consent")).toBeNull();
    expect(extractCompanyPrefixFromPath("/trial/claim")).toBeNull();
    expect(extractCompanyPrefixFromPath("/member-onboarding")).toBeNull();
  });

  it("prefixes /settings and /plugins/:id with the company instead of reading them as one", () => {
    expect(applyCompanyPrefix("/settings", "ACME")).toBe("/ACME/settings");
    expect(applyCompanyPrefix("/plugins/p-1", "ACME")).toBe("/ACME/plugins/p-1");
  });
});
