import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ROUTES_REL,
  SEARCH_INDEX_REL,
  buildDocsRoutes,
  buildDocsSearchIndex,
} from "../../../scripts/docs/build-search-index.mjs";
import { listDocPages } from "./docs";

// vitest's cwd is ui/ locally but the repo root in CI's sharded run.
const REPO_ROOT = [process.cwd(), path.join(process.cwd(), "..")].find((candidate) =>
  existsSync(path.join(candidate, "docs", "docs.json")),
)!;

/**
 * The drift check. The search index and the public slug list are generated
 * from docs/ and committed; this rebuilds both in memory and fails when a
 * committed file is stale, so a docs edit cannot ship with a search that
 * points at headings that are gone, or a page list the nav no longer has.
 */
describe("docs search index", () => {
  const committed = readFileSync(path.join(REPO_ROOT, SEARCH_INDEX_REL), "utf8");

  it("is current — run `pnpm docs:search-index` after editing docs/", () => {
    expect(committed).toBe(buildDocsSearchIndex(REPO_ROOT));
  });

  it("indexes exactly the bundled pages, in nav order", () => {
    const index = JSON.parse(committed) as { pages: Array<{ slug: string; title: string }> };
    expect(index.pages.map((page) => page.slug)).toEqual(listDocPages().map((page) => page.slug));
    for (const page of index.pages) expect(page.title, page.slug).not.toBe(page.slug);
  });

  it("has a current public slug list — run `pnpm docs:search-index` after editing docs/docs.json", () => {
    const routes = readFileSync(path.join(REPO_ROOT, ROUTES_REL), "utf8");
    expect(routes).toBe(buildDocsRoutes(REPO_ROOT));
  });
});
