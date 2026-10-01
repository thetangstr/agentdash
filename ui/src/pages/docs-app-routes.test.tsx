// @vitest-environment node
//
// Which route wins a /docs URL, decided by App's real route tree.
//
// React Router ranks routes by their segments, not by where they are written,
// so a docs route can lose to a board route that sits far below it in App.tsx:
// `/docs/dashboard` to `:companyPrefix/dashboard`, `/docs/guides/x/y` to
// `:companyPrefix/guides/:group/:slug` — a company called DOCS, behind the
// sign-in gate. This builds the route objects from App's own JSX (App() calls
// no hooks; it only returns the tree) and runs matchRoutes over them, so a
// board route added later is covered without editing this file.

import { isValidElement, type ReactElement, type ReactNode } from "react";
import { createRoutesFromChildren, matchRoutes, Routes, type RouteObject } from "react-router-dom";
import { describe, expect, it } from "vitest";

const { App } = await import("@/App");
const { listDocPages } = await import("@/lib/docs");

function findRoutesChildren(node: ReactNode): ReactNode | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findRoutesChildren(child);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (element.type === Routes) return element.props.children ?? null;
  return findRoutesChildren(element.props.children);
}

const routesChildren = findRoutesChildren(App());
const appRoutes: RouteObject[] = createRoutesFromChildren(routesChildren);

/** The matched chain's paths, root to leaf, and the leaf's rendered component. */
function resolve(url: string) {
  const matches = matchRoutes(appRoutes, url) ?? [];
  const leaf = matches.at(-1)?.route;
  const element = leaf?.element as ReactElement<{ children?: ReactElement }> | undefined;
  return {
    chain: matches.map((match) => match.route.path ?? "(layout)"),
    leafPath: leaf?.path ?? null,
    // App renders docs as <Suspense><Docs /></Suspense> with Docs = lazy(...).
    rendered: element?.props?.children?.type ?? element?.type ?? null,
  };
}

const LAZY = Symbol.for("react.lazy");

describe("App routes: /docs is never claimed by the board", () => {
  const docsComponent = resolve("/docs").rendered as { $$typeof?: symbol } | null;

  it("finds App's route tree", () => {
    expect(appRoutes.length).toBeGreaterThan(20);
    expect(docsComponent?.$$typeof).toBe(LAZY);
  });

  // The URLs that used to fall to the board, the edges of /docs itself, and a
  // few deeper board shapes for good measure.
  const urls = [
    "/docs",
    "/docs/",
    "/docs/x",
    "/docs/no/such-page",
    "/docs/dashboard",
    "/docs/issues",
    "/docs/costs",
    "/docs/agents",
    "/docs/guides/x/y",
    "/docs/agents/new",
    "/docs/approvals/abc",
    "/docs/company/settings/access",
    "/docs/skills/a/b/c",
  ];
  for (const url of urls) {
    it(`${url} renders the docs page, outside the board shell`, () => {
      const result = resolve(url);
      expect(result.rendered, `${url} → ${result.chain.join(" > ")}`).toBe(docsComponent);
      expect(result.chain, url).not.toContain(":companyPrefix");
      expect(result.leafPath?.startsWith("docs"), `${url} → ${result.leafPath}`).toBe(true);
    });
  }

  it("renders every bundled page's URL through the docs page", () => {
    for (const page of listDocPages()) {
      const url = `/docs/${page.slug}`;
      const result = resolve(url);
      expect(result.rendered, `${url} → ${result.chain.join(" > ")}`).toBe(docsComponent);
      expect(result.chain, url).not.toContain(":companyPrefix");
    }
  });

  it("still gives board URLs to the board", () => {
    for (const url of ["/ACME/dashboard", "/ACME/guides/steward/your-inbox", "/ACME/agents/new"]) {
      const result = resolve(url);
      expect(result.chain, url).toContain(":companyPrefix");
      expect(result.rendered, url).not.toBe(docsComponent);
    }
  });
});
