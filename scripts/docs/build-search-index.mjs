#!/usr/bin/env node
// Build the public docs' generated files:
//   ui/src/generated/docs-search-index.json — the search index;
//   ui/src/generated/docs-routes.json       — the ordered list of public slugs.
//
// One entry per page the public docs bundle (doc/plans/2026-10-01-public-docs-section.md):
// the pages docs/docs.json lists, minus the denylist. Each entry carries the
// slug, the title, the section headings and the first paragraph — enough for a
// client-side matcher and for the nav to show titles without loading a page.
//
// The slug list exists so the UI never needs the denylist at runtime: the UI
// keeps a page only if its slug is on this list, and the denylist itself lives
// here and in the tests — never in a shipped chunk, where anyone could read the
// private file names it exists to hide.
//
// Both outputs are committed. ui/src/lib/docs-search-index.test.ts rebuilds them
// in memory and fails when a committed file is stale, so a docs edit that is not
// followed by `pnpm docs:search-index` fails CI rather than shipping a search
// that points at headings that no longer exist.
//
// Usage: node scripts/docs/build-search-index.mjs [--check]

import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Docs-relative paths that are never bundled, even if docs.json lists them.
 * An entry ending in `/` is a directory prefix. The one copy: the UI tests
 * import it from here, and ui/src/lib/docs.ts's glob negations must cover it
 * (ui/src/lib/docs.test.ts checks that). Do not import this from UI code.
 */
export const DOCS_PATH_DENYLIST = [
  "api/agentdash-mk",
  "deploy/ross-private-host",
  "superpowers/",
  "agents/",
  "design/",
  "specs/",
  "plans/",
];

export const SEARCH_INDEX_REL = "ui/src/generated/docs-search-index.json";
export const ROUTES_REL = "ui/src/generated/docs-routes.json";

const FIRST_PARAGRAPH_MAX = 280;

export function isDeniedDocPath(page) {
  return DOCS_PATH_DENYLIST.some((entry) =>
    entry.endsWith("/") ? page.startsWith(entry) : page === entry,
  );
}

/** Every page entry in a Mintlify nav, in reading order, duplicates kept. */
export function navPageEntries(config) {
  const out = [];
  const walk = (pages) => {
    for (const entry of pages ?? []) {
      if (typeof entry === "string") out.push(entry);
      else if (entry && Array.isArray(entry.pages)) walk(entry.pages);
    }
  };
  for (const tab of config?.navigation?.tabs ?? []) {
    for (const group of tab.groups ?? []) walk(group.pages);
  }
  return out;
}

function parseFrontMatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (!match) return { fields: {}, body: markdown };
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return { fields, body: markdown.slice(match[0].length) };
}

/** Markdown inline syntax → the words a person would search for. */
function plainText(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]+/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const JSX_TAG_LINE = /^<\/?[A-Z][A-Za-z0-9]*(\s[^>]*)?\/?>\s*$/;

function extractHeadingsAndFirstParagraph(body, isMdx) {
  const headings = [];
  let firstParagraph = "";
  let paragraph = [];
  let fence = null;
  const flush = () => {
    if (!firstParagraph && paragraph.length > 0) firstParagraph = plainText(paragraph.join(" "));
    paragraph = [];
  };
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    const fenceMatch = /^(```|~~~)/.exec(trimmed);
    if (fence) {
      if (fenceMatch && trimmed.startsWith(fence)) fence = null;
      continue;
    }
    if (fenceMatch) {
      flush();
      fence = fenceMatch[1];
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(trimmed);
    if (heading) {
      flush();
      if (heading[1].length >= 2 && heading[1].length <= 3) headings.push(plainText(heading[2]));
      continue;
    }
    if (
      trimmed === "" ||
      JSX_TAG_LINE.test(trimmed) ||
      (isMdx && /^(import|export)\s/.test(line)) ||
      /^(\||>|[-*+]\s|\d+\.\s|---+$)/.test(trimmed)
    ) {
      flush();
      continue;
    }
    if (!firstParagraph) paragraph.push(trimmed);
  }
  flush();
  if (firstParagraph.length > FIRST_PARAGRAPH_MAX) {
    const cut = firstParagraph.slice(0, FIRST_PARAGRAPH_MAX);
    firstParagraph = `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 0)) || cut}…`;
  }
  return { headings, firstParagraph };
}

/** The bundled pages, in nav order: nav entries, de-duplicated, minus the denylist, resolved to a file. */
export function collectBundledPages(repoRoot) {
  const docsDir = path.join(repoRoot, "docs");
  const config = JSON.parse(readFileSync(path.join(docsDir, "docs.json"), "utf8"));
  const seen = new Set();
  const pages = [];
  for (const slug of navPageEntries(config)) {
    if (seen.has(slug) || isDeniedDocPath(slug)) continue;
    seen.add(slug);
    const file = [`${slug}.md`, `${slug}.mdx`].find((candidate) => existsSync(path.join(docsDir, candidate)));
    if (!file) continue; // docs.test.ts fails on unresolved entries; the index just skips them.
    pages.push({ slug, file, markdown: readFileSync(path.join(docsDir, file), "utf8") });
  }
  return pages;
}

export function buildDocsSearchIndex(repoRoot) {
  const pages = collectBundledPages(repoRoot).map(({ slug, file, markdown }) => {
    const { fields, body } = parseFrontMatter(markdown);
    const { headings, firstParagraph } = extractHeadingsAndFirstParagraph(body, file.endsWith(".mdx"));
    return {
      slug,
      title: fields.title || slug,
      summary: fields.summary || fields.description || "",
      headings,
      firstParagraph,
    };
  });
  return `${JSON.stringify({ source: "docs/docs.json", pages }, null, 2)}\n`;
}

/** The public slugs, in nav order: the only list of pages the UI trusts. */
export function buildDocsRoutes(repoRoot) {
  const slugs = collectBundledPages(repoRoot).map(({ slug }) => slug);
  return `${JSON.stringify({ source: "docs/docs.json", slugs }, null, 2)}\n`;
}

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const outputs = [
    [SEARCH_INDEX_REL, buildDocsSearchIndex(repoRoot)],
    [ROUTES_REL, buildDocsRoutes(repoRoot)],
  ];
  if (process.argv.includes("--check")) {
    let stale = false;
    for (const [rel, next] of outputs) {
      const target = path.join(repoRoot, rel);
      const current = existsSync(target) ? readFileSync(target, "utf8") : "";
      if (current !== next) {
        console.error(`${rel} is stale. Run: node scripts/docs/build-search-index.mjs`);
        stale = true;
      } else {
        console.log(`${rel} is current.`);
      }
    }
    if (stale) process.exit(1);
    return;
  }
  for (const [rel, next] of outputs) {
    const target = path.join(repoRoot, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, next);
    console.log(`Wrote ${rel}.`);
  }
}

// Entry guard: resolve symlinks on both sides, or a symlinked invocation
// silently skips main() (scripts/entry-guard.test.mjs; cf. #666).
function realOrResolved(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
if (process.argv[1] && realOrResolved(process.argv[1]) === realOrResolved(fileURLToPath(import.meta.url))) {
  main();
}
