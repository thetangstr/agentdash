/**
 * The eager half of the public docs: only what App.tsx needs to route /docs.
 * App imports this at startup, so it is in the initial chunk every visitor to
 * www.agentdash.cloud downloads — it must carry no page list, no nav and no
 * denylist. Those live behind the lazy `docs.ts`; the denylist lives only in
 * `scripts/docs/build-search-index.mjs` and the tests.
 *
 * Why /docs needs more than `docs` and `docs/*`: React Router ranks routes by
 * their segments, not by where they are written, and a splat ranks low. So
 * `/docs/dashboard` went to the board's `:companyPrefix/dashboard`, and
 * `/docs/guides/x/y` to `:companyPrefix/guides/:group/:slug` — a company
 * called DOCS, behind the sign-in gate. For every board path `P` this
 * registers `docs/P` as a docs route. It matches exactly the URLs
 * `:companyPrefix/P` would match there, and always ranks above it: a static
 * `docs` segment outranks a dynamic `:companyPrefix`, and the rest is the same.
 * So the board can never claim a /docs URL, whatever board routes are added
 * later, and the docs page decides from the pathname whether it is a page or
 * not found. `docs-routes.test.tsx` checks this against App's real routes.
 */

import type { ReactNode } from "react";
import { createRoutesFromChildren, type RouteObject } from "react-router-dom";

function routePaths(routes: RouteObject[], parent = ""): string[] {
  const paths: string[] = [];
  for (const route of routes) {
    const full = route.path ? (parent ? `${parent}/${route.path}` : route.path) : parent;
    if (route.path) paths.push(full);
    if (route.children) paths.push(...routePaths(route.children, full));
  }
  return paths;
}

/**
 * `docs/<P>` for every path `P` in the board's route elements (the children of
 * `:companyPrefix`). The board's own `*` is skipped: App declares `docs/*`.
 */
export function docsShadowRoutePaths(boardRouteElements: ReactNode): string[] {
  const out: string[] = [];
  for (const path of routePaths(createRoutesFromChildren(boardRouteElements))) {
    if (path === "*") continue;
    const shadow = `docs/${path.replace(/^\/+/, "")}`;
    if (!out.includes(shadow)) out.push(shadow);
  }
  return out;
}

/** The page slug for a pathname under /docs: `/docs/start/quickstart/` → `start/quickstart`. */
export function docSlugFromPathname(pathname: string): string {
  return pathname.replace(/^\/docs(?:\/|$)/, "").replace(/^\/+|\/+$/g, "");
}
