/**
 * The small, eager half of the public docs: which pages exist and what is
 * never published. App.tsx imports this to register one route per page, so it
 * must stay free of page bodies and the search index — those live behind the
 * lazy `docs.ts`.
 *
 * Why a route per page rather than one `docs/*` splat: React Router ranks a
 * splat below any route with more matched segments, so `/docs/guides/x/y` was
 * taken by the board's `:companyPrefix/guides/:group/:slug` (a company called
 * DOCS) and sent a visitor to the sign-in gate. A fully static path outranks
 * every board route. `docs-routes.test.tsx` checks each URL against App's own
 * route paths.
 */

import docsConfig from "../../../docs/docs.json";

/**
 * Docs-relative paths (no extension) that are never bundled, even when the nav
 * lists them. An entry ending in `/` is a directory prefix. Mirrored in
 * `scripts/docs/build-search-index.mjs` and in the glob negations in
 * `docs.ts`; `docs.test.ts` keeps all three equal.
 */
export const DOCS_PATH_DENYLIST: readonly string[] = [
  "api/agentdash-mk",
  "deploy/ross-private-host",
  "superpowers/",
  "agents/",
  "design/",
  "specs/",
  "plans/",
];

/** A docs.json page entry: a path string, or (Mintlify) a nested group. */
type RawNavEntry = string | { group?: string; pages?: RawNavEntry[] };

export interface DocsConfig {
  navigation?: {
    tabs?: Array<{ tab?: string; groups?: Array<{ group?: string; pages?: RawNavEntry[] }> }>;
  };
}

export function isDeniedDocPath(page: string): boolean {
  return DOCS_PATH_DENYLIST.some((entry) =>
    entry.endsWith("/") ? page.startsWith(entry) : page === entry,
  );
}

/** Every page entry the nav lists, in reading order, duplicates kept. Nested groups are flattened. */
export function navPageEntries(config: DocsConfig): string[] {
  const out: string[] = [];
  const walk = (pages: RawNavEntry[] | undefined) => {
    for (const entry of pages ?? []) {
      if (typeof entry === "string") out.push(entry);
      else if (entry && Array.isArray(entry.pages)) walk(entry.pages);
    }
  };
  for (const tab of config.navigation?.tabs ?? []) {
    for (const group of tab.groups ?? []) walk(group.pages);
  }
  return out;
}

/** `docs/<slug>` for every public page, in nav order — App.tsx's route paths. */
export function docsRoutePaths(config: DocsConfig = docsConfig as DocsConfig): string[] {
  const paths: string[] = [];
  for (const slug of navPageEntries(config)) {
    if (isDeniedDocPath(slug)) continue;
    const path = `docs/${slug}`;
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

/** The page slug for a pathname under /docs: `/docs/start/quickstart/` → `start/quickstart`. */
export function docSlugFromPathname(pathname: string): string {
  return pathname.replace(/^\/docs(?:\/|$)/, "").replace(/^\/+|\/+$/g, "");
}
