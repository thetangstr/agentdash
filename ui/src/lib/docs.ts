/**
 * The public docs, bundled from `docs/` and navigated by `docs/docs.json`.
 *
 * A generalisation of `guides.ts` (doc/plans/2026-10-01-public-docs-section.md,
 * PR 1): the same markdown files, the same renderer, the same `{{instanceUrl}}`
 * token — but the whole nav, not six pages, and loaded lazily so none of it is
 * in the initial bundle.
 *
 * What is bundled is decided here, not by what happens to sit under `docs/`.
 * Anything imported into the SPA can be fetched from the public site whether or
 * not a route links to it, so the bundled set is exactly: the pages
 * `docs/docs.json` lists, minus the denylist. The glob below is that set
 * spelled out, because Vite turns every file a glob matches into a chunk —
 * filtering the result at runtime does not stop a matched file from being
 * emitted. `docs.test.ts` fails when the glob and the nav disagree.
 *
 * The denylist itself is not in this file's runtime code: a shipped chunk is
 * readable by anyone, and the list names the private files it exists to hide.
 * It lives in `scripts/docs/build-search-index.mjs`, which writes the allowed
 * slugs to `ui/src/generated/docs-routes.json`; at runtime a page is public
 * only if its slug is on that list. The glob's `!` negations below are
 * compile-time only — Vite resolves them and emits none of the strings.
 */

import docsConfig from "../../../docs/docs.json";
import docsRoutes from "@/generated/docs-routes.json";
import searchIndex from "@/generated/docs-search-index.json";
import { INSTANCE_URL_TOKEN, parseFrontMatter } from "./guides";

export { INSTANCE_URL_TOKEN };

/** The slugs a page may be served under, in nav order (generated; see above). */
export const PUBLIC_DOC_SLUGS: ReadonlySet<string> = new Set(docsRoutes.slugs);

/**
 * The bundled pages, lazily. Keep in step with docs/docs.json: one pattern per
 * directory, listing that directory's nav pages. Patterns are literals (Vite
 * requires it), so they cannot be computed from the nav; the test computes the
 * nav-minus-denylist set and asserts these keys equal it. The negations are a
 * second lock: a denied path stays out even if a pattern here is widened. The
 * test checks they cover every denylist entry.
 */
const docModules = import.meta.glob(
  [
    "../../../docs/start/{what-is-paperclip,quickstart,core-concepts,architecture}.{md,mdx}",
    "../../../docs/guides/steward/{getting-started,connect-your-terminal,your-inbox,troubleshooting-connect}.{md,mdx}",
    "../../../docs/guides/board-operator/{dashboard,creating-a-company,managing-agents,agent-kinds-and-stewardship,onboard-a-steward,org-structure,managing-tasks,execution-workspaces-and-runtime-services,delegation,approvals,costs-and-budgets,activity-log,importing-and-exporting}.{md,mdx}",
    "../../../docs/guides/agent-developer/{how-agents-work,heartbeat-protocol,writing-a-skill,task-workflow,comments-and-communication,handling-approvals,cost-reporting}.{md,mdx}",
    "../../../docs/deploy/{overview,local-development,tailscale-private-access,docker,deployment-modes,database,secrets,storage,environment-variables}.{md,mdx}",
    "../../../docs/adapters/{overview,claude-local,codex-local,process,http,external-adapters,adapter-ui-parser,creating-an-adapter}.{md,mdx}",
    "../../../docs/api/{index,authentication,api-keys,conventions,reference,route-index,companies,agents,issues,approvals,goals-and-projects,routines,costs,secrets,activity,dashboard}.{md,mdx}",
    "../../../docs/mcp/{overview,connecting,toolsets,resources,playbooks}.{md,mdx}",
    "../../../docs/mcp/tools/{agent,setup,assistant,human,bridge}.{md,mdx}",
    "../../../docs/cli/{agentdash-connect,agentdash-mcp,overview,setup-commands,control-plane-commands}.{md,mdx}",
    "!../../../docs/api/agentdash-mk.{md,mdx}",
    "!../../../docs/deploy/ross-private-host.{md,mdx}",
    "!../../../docs/superpowers/**",
    "!../../../docs/agents/**",
    "!../../../docs/design/**",
    "!../../../docs/specs/**",
    "!../../../docs/plans/**",
  ],
  { query: "?raw", import: "default" },
) as Record<string, () => Promise<string>>;

const MODULE_PREFIX = "../../../docs/";

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/** A docs.json page entry: a path string, or (Mintlify) a nested group. */
type RawNavEntry = string | { group?: string; pages?: RawNavEntry[] };

export interface DocsConfig {
  navigation?: {
    tabs?: Array<{ tab?: string; groups?: Array<{ group?: string; pages?: RawNavEntry[] }> }>;
  };
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

export interface DocPageRef {
  /** Docs-relative path without extension; also the URL tail: `/docs/<slug>`. */
  slug: string;
  /** Docs-relative file, e.g. `start/quickstart.md`. */
  file: string;
  title: string;
  tab: string;
  group: string;
}

export interface DocGroup {
  title: string;
  pages: DocPageRef[];
}

export interface DocTab {
  title: string;
  groups: DocGroup[];
}

/**
 * Docs-relative files the glob matched, e.g. `start/quickstart.md` — every one
 * of them is an emitted chunk, so this is deliberately unfiltered: it is what
 * actually ships, and the test holds it to the nav minus the denylist.
 */
export function globbedDocFiles(): string[] {
  return Object.keys(docModules)
    .map((key) => key.slice(MODULE_PREFIX.length))
    .sort();
}

const titles = new Map<string, string>(searchIndex.pages.map((page) => [page.slug, page.title]));

/** `guides/steward/your-inbox` → `Your inbox`, for a page the index has not caught up with. */
function fallbackTitle(slug: string): string {
  const leaf = slug.split("/").pop() ?? slug;
  const words = leaf.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The nav tree: tabs → groups → pages, keeping only pages that are public and
 * bundled. A page off the public list, or with no file, never reaches the
 * tree, and a group or tab left empty by that is dropped. A slug listed twice
 * keeps its first place.
 */
export function buildDocsTree(
  config: DocsConfig,
  files: readonly string[] = globbedDocFiles(),
  publicSlugs: ReadonlySet<string> = PUBLIC_DOC_SLUGS,
): DocTab[] {
  const available = new Set(files);
  const seen = new Set<string>();
  const tabs: DocTab[] = [];
  for (const rawTab of config.navigation?.tabs ?? []) {
    const tab: DocTab = { title: rawTab.tab ?? "", groups: [] };
    for (const rawGroup of rawTab.groups ?? []) {
      const group: DocGroup = { title: rawGroup.group ?? "", pages: [] };
      for (const slug of navPageEntries({ navigation: { tabs: [{ groups: [rawGroup] }] } })) {
        if (seen.has(slug) || !publicSlugs.has(slug)) continue;
        const file = [`${slug}.md`, `${slug}.mdx`].find((candidate) => available.has(candidate));
        if (!file) continue;
        seen.add(slug);
        group.pages.push({
          slug,
          file,
          title: titles.get(slug) ?? fallbackTitle(slug),
          tab: tab.title,
          group: group.title,
        });
      }
      if (group.pages.length > 0) tab.groups.push(group);
    }
    if (tab.groups.length > 0) tabs.push(tab);
  }
  return tabs;
}

let cachedTree: DocTab[] | null = null;

export function docsTree(): DocTab[] {
  cachedTree ??= buildDocsTree(docsConfig as DocsConfig);
  return cachedTree;
}

/** Every bundled page in nav order — the order prev/next follows. */
export function listDocPages(tree: DocTab[] = docsTree()): DocPageRef[] {
  return tree.flatMap((tab) => tab.groups.flatMap((group) => group.pages));
}

export function findDocPage(slug: string, tree: DocTab[] = docsTree()): DocPageRef | null {
  const normalized = slug.replace(/^\/+|\/+$/g, "");
  return listDocPages(tree).find((page) => page.slug === normalized) ?? null;
}

export function neighbours(
  slug: string,
  tree: DocTab[] = docsTree(),
): { prev: DocPageRef | null; next: DocPageRef | null } {
  const pages = listDocPages(tree);
  const index = pages.findIndex((page) => page.slug === slug);
  if (index === -1) return { prev: null, next: null };
  return { prev: pages[index - 1] ?? null, next: pages[index + 1] ?? null };
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/**
 * What renders a page. Almost every page is `markdown`. A page whose front
 * matter says `kind: openapi` is still a markdown file (it has a title, an
 * intro, a place in the nav and the search index) and additionally renders the
 * API reference below its body — see Docs.tsx.
 */
export type DocPageKind = "markdown" | "openapi";

export interface DocPage {
  ref: DocPageRef;
  title: string;
  summary: string;
  kind: DocPageKind;
  /** Markdown ready for MarkdownBody, tokens NOT yet substituted. */
  body: string;
}

/** The raw file text of a bundled page. Throws for anything outside the bundled set. */
export async function loadDocSource(ref: DocPageRef): Promise<string> {
  if (!PUBLIC_DOC_SLUGS.has(ref.slug)) throw new Error(`Not a public doc: ${ref.slug}`);
  const loader = docModules[`${MODULE_PREFIX}${ref.file}`];
  if (!loader) throw new Error(`Not a bundled doc: ${ref.file}`);
  return loader();
}

export async function loadDocPage(ref: DocPageRef, tree: DocTab[] = docsTree()): Promise<DocPage> {
  return parseDocPage(ref, await loadDocSource(ref), tree);
}

export function parseDocPage(ref: DocPageRef, markdown: string, tree: DocTab[] = docsTree()): DocPage {
  const { fields, body } = parseFrontMatter(markdown);
  const known = new Set(listDocPages(tree).map((page) => page.slug));
  return {
    ref,
    title: fields.title || ref.title,
    summary: fields.summary || fields.description || "",
    kind: fields.kind === "openapi" ? "openapi" : "markdown",
    body: rewriteDocLinks(
      normalizeDocMarkdown(body, { mdx: ref.file.endsWith(".mdx") }),
      ref.slug,
      known,
    ).trim(),
  };
}

const CALLOUTS: Record<string, string> = {
  Tip: "Tip",
  Note: "Note",
  Info: "Note",
  Warning: "Warning",
  Check: "Check",
};

const JSX_TAG_LINE = /^<\/?[A-Z][A-Za-z0-9]*(\s[^>]*)?\/?>$/;
const FENCE = /^(```|~~~)/;

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return match ? match[1]! : null;
}

/**
 * The Mintlify source as plain markdown MarkdownBody can render.
 *
 * Both `.md` and `.mdx` pages here use a few Mintlify components. Outside
 * code fences: callouts (`<Tip>`, `<Note>`, `<Info>`, `<Warning>`, `<Check>`)
 * become a labelled blockquote; `<Card title href>` becomes a bold link; any
 * other line that is only a component tag is dropped and its children kept.
 * For `.mdx`, top-level `import`/`export` lines are dropped too. Code fences
 * are left exactly as written — a `<Type>` in a code sample is code.
 */
export function normalizeDocMarkdown(body: string, options: { mdx: boolean }): string {
  const out: string[] = [];
  let fence: string | null = null;
  let callout = false;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    const fenceMatch = FENCE.exec(trimmed);
    if (fence) {
      out.push(callout ? `> ${line}` : line);
      if (fenceMatch && trimmed.startsWith(fence)) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      out.push(callout ? `> ${line}` : line);
      continue;
    }
    if (options.mdx && /^(import|export)\s/.test(line)) continue;

    // A one-line callout: <Tip>text</Tip>
    const inline = /^<(Tip|Note|Info|Warning|Check)>(.*)<\/\1>$/.exec(trimmed);
    if (inline) {
      out.push(`> **${CALLOUTS[inline[1]!]}:** ${inline[2]!.trim()}`);
      continue;
    }
    const open = /^<(Tip|Note|Info|Warning|Check)(\s[^>]*)?>$/.exec(trimmed);
    if (open) {
      callout = true;
      out.push(`> **${CALLOUTS[open[1]!]}:**`, ">");
      continue;
    }
    if (/^<\/(Tip|Note|Info|Warning|Check)>$/.test(trimmed)) {
      callout = false;
      out.push("");
      continue;
    }
    if (/^<Card[\s>]/.test(trimmed) && JSX_TAG_LINE.test(trimmed)) {
      const title = attribute(trimmed, "title") ?? "";
      const href = attribute(trimmed, "href");
      if (title) out.push(href ? `**[${title}](${href})**` : `**${title}**`, "");
      continue;
    }
    if (JSX_TAG_LINE.test(trimmed)) continue;
    out.push(callout ? `> ${trimmed}` : line);
  }
  return out.join("\n");
}

/**
 * Links between docs pages, rewritten to `/docs/<slug>`.
 *
 * Mintlify links are site-absolute (`/adapters/overview`) or relative
 * (`./your-inbox`, `../steward/getting-started`). On the app those would land
 * on app routes, so a link that resolves to a bundled page is pointed at its
 * docs URL. Anything else is left exactly as written.
 */
export function rewriteDocLinks(body: string, fromSlug: string, known: ReadonlySet<string>): string {
  const dir = fromSlug.split("/").slice(0, -1);
  const lines = body.split("\n");
  let fence: string | null = null;
  return lines
    .map((line) => {
      const trimmed = line.replace(/^>\s?/, "").trim();
      const fenceMatch = FENCE.exec(trimmed);
      if (fence) {
        if (fenceMatch && trimmed.startsWith(fence)) fence = null;
        return line;
      }
      if (fenceMatch) {
        fence = fenceMatch[1]!;
        return line;
      }
      return line.replace(/\]\(((?:\/|\.{1,2}\/)[^)\s#]*)(#[^)\s]*)?\)/g, (whole, target: string, hash?: string) => {
        const slug = resolveDocLink(target, dir);
        return slug && known.has(slug) ? `](/docs/${slug}${hash ?? ""})` : whole;
      });
    })
    .join("\n");
}

function resolveDocLink(target: string, dir: string[]): string | null {
  const clean = target.replace(/\.mdx?$/, "").replace(/\/+$/, "");
  const parts = clean.startsWith("/") ? [] : [...dir];
  for (const segment of clean.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.length > 0 ? parts.join("/") : null;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface DocSearchEntry {
  slug: string;
  title: string;
  summary: string;
  headings: string[];
  firstParagraph: string;
}

export interface DocSearchHit {
  entry: DocSearchEntry;
  score: number;
  /** The heading that matched, when one did — the result links to the page, labelled with it. */
  heading: string | null;
}

export function docsSearchEntries(): DocSearchEntry[] {
  return searchIndex.pages;
}

/**
 * Client-side matching over the build-time index. Every query word must appear
 * somewhere in the entry; title hits outrank heading hits outrank body hits.
 */
export function searchDocs(
  query: string,
  entries: readonly DocSearchEntry[] = docsSearchEntries(),
  limit = 8,
): DocSearchHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const hits: DocSearchHit[] = [];
  for (const entry of entries) {
    const title = entry.title.toLowerCase();
    const headings = entry.headings.map((heading) => heading.toLowerCase());
    const rest = `${entry.summary} ${entry.firstParagraph} ${entry.slug}`.toLowerCase();
    let score = 0;
    let heading: string | null = null;
    let all = true;
    for (const word of words) {
      if (title.includes(word)) {
        score += title.startsWith(word) ? 12 : 10;
        continue;
      }
      const headingIndex = headings.findIndex((candidate) => candidate.includes(word));
      if (headingIndex !== -1) {
        score += 5;
        heading ??= entry.headings[headingIndex]!;
        continue;
      }
      if (rest.includes(word)) {
        score += 1;
        continue;
      }
      all = false;
      break;
    }
    if (all) hits.push({ entry, score, heading });
  }
  return hits
    .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title))
    .slice(0, limit);
}
