// Types for build-search-index.mjs, so the UI's tests can import it under tsc.
export declare const DOCS_PATH_DENYLIST: string[];
export declare const SEARCH_INDEX_REL: string;
export declare const ROUTES_REL: string;
export declare function isDeniedDocPath(page: string): boolean;
export declare function navPageEntries(config: unknown): string[];
export declare function collectBundledPages(
  repoRoot: string,
): Array<{ slug: string; file: string; markdown: string }>;
export declare function buildDocsSearchIndex(repoRoot: string): string;
export declare function buildDocsRoutes(repoRoot: string): string;
