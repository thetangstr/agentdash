import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import docsConfig from "../../../docs/docs.json";
import searchIndex from "@/generated/docs-search-index.json";
import docsRoutes from "@/generated/docs-routes.json";
// The denylist has one copy, in the generator script; UI runtime code never
// imports it, so it is never in a shipped chunk.
import { DOCS_PATH_DENYLIST, isDeniedDocPath } from "../../../scripts/docs/build-search-index.mjs";
import {
  INSTANCE_URL_TOKEN,
  PUBLIC_DOC_SLUGS,
  buildDocsTree,
  docsTree,
  findDocPage,
  globbedDocFiles,
  listDocPages,
  loadDocPage,
  loadDocSource,
  navPageEntries,
  neighbours,
  normalizeDocMarkdown,
  parseDocPage,
  rewriteDocLinks,
  searchDocs,
  type DocsConfig,
} from "./docs";
import { tokensIn } from "./guides";
import { docSlugFromPathname } from "./docs-nav";

// vitest's cwd is ui/ locally but the repo root in CI's sharded run.
const REPO_ROOT = [process.cwd(), path.join(process.cwd(), "..")].find((candidate) =>
  existsSync(path.join(candidate, "docs", "docs.json")),
)!;
const DOCS_DIR = path.join(REPO_ROOT, "docs");

const config = docsConfig as DocsConfig;

describe("docs: markdown normalisation", () => {
  it("turns callouts into labelled blockquotes and cards into links, outside code fences only", () => {
    const body = [
      "Intro.",
      "",
      "<Tip>",
      "Use the skill.",
      "</Tip>",
      "",
      '<Card title="Core Concepts" href="/start/core-concepts">',
      "  Learn the key concepts",
      "</Card>",
      "",
      "```ts",
      "<Tip>stays code</Tip>",
      "): Promise<AdapterResult> {",
      "```",
      "<Note>One line.</Note>",
      "<CardGroup cols={2}>",
      "</CardGroup>",
    ].join("\n");
    expect(normalizeDocMarkdown(body, { mdx: false }).split("\n")).toEqual([
      "Intro.",
      "",
      "> **Tip:**",
      ">",
      "> Use the skill.",
      "",
      "",
      "**[Core Concepts](/start/core-concepts)**",
      "",
      "  Learn the key concepts",
      "",
      "```ts",
      "<Tip>stays code</Tip>",
      "): Promise<AdapterResult> {",
      "```",
      "> **Note:** One line.",
    ]);
  });

  it("drops top-level import/export lines from .mdx, and only from .mdx", () => {
    const body = 'import { Foo } from "./foo";\nexport const meta = {};\n\n# Title\n\n```js\nimport x from "y";\n```';
    expect(normalizeDocMarkdown(body, { mdx: true })).toBe('\n# Title\n\n```js\nimport x from "y";\n```');
    expect(normalizeDocMarkdown(body, { mdx: false })).toContain('import { Foo } from "./foo";');
  });

  it("points links between bundled pages at /docs and leaves every other link alone", () => {
    const known = new Set(["adapters/overview", "guides/steward/your-inbox", "guides/steward/getting-started"]);
    const body = [
      "[a](/adapters/overview) [b](./your-inbox#top) [c](../steward/getting-started)",
      "[d](/adapters/not-bundled) [e](https://example.com) [f](/issues/abc)",
      "```",
      "[g](/adapters/overview)",
      "```",
    ].join("\n");
    expect(rewriteDocLinks(body, "guides/steward/connect-your-terminal", known).split("\n")).toEqual([
      "[a](/docs/adapters/overview) [b](/docs/guides/steward/your-inbox#top) [c](/docs/guides/steward/getting-started)",
      "[d](/adapters/not-bundled) [e](https://example.com) [f](/issues/abc)",
      "```",
      "[g](/adapters/overview)",
      "```",
    ]);
  });

  it("reads title and summary (or Mintlify's description) from front matter", () => {
    const tree = docsTree();
    const ref = listDocPages(tree)[0]!;
    const page = parseDocPage({ ...ref, file: "x/y.mdx" }, '---\ntitle: T\ndescription: "D"\n---\nimport A from "a";\n\nBody.', tree);
    expect(page).toMatchObject({ title: "T", summary: "D", kind: "markdown", body: "Body." });
  });

  it("reads `kind: openapi` from front matter, and only that value", () => {
    const tree = docsTree();
    const ref = listDocPages(tree)[0]!;
    expect(parseDocPage(ref, "---\ntitle: R\nkind: openapi\n---\nIntro.", tree).kind).toBe("openapi");
    expect(parseDocPage(ref, "---\ntitle: R\nkind: something-else\n---\nIntro.", tree).kind).toBe("markdown");
    expect(findDocPage("api/reference"), "the API reference is a bundled page").not.toBeNull();
  });
});

describe("docs: the nav tree", () => {
  it("drops non-public pages, missing files, duplicates and the groups and tabs they empty", () => {
    const tree = buildDocsTree(
      {
        navigation: {
          tabs: [
            { tab: "A", groups: [{ group: "G", pages: ["a/one", "a/two", "a/one", { group: "nested", pages: ["a/three"] }] }] },
            { tab: "B", groups: [{ group: "H", pages: ["b/private", "b/other"] }] },
          ],
        },
      },
      ["a/one.md", "a/three.mdx", "b/private.md", "b/other.md"],
      new Set(["a/one", "a/two", "a/three"]),
    );
    expect(tree.map((tab) => tab.title)).toEqual(["A"]);
    expect(tree[0]!.groups[0]!.pages.map((page) => [page.slug, page.file])).toEqual([
      ["a/one", "a/one.md"],
      ["a/three", "a/three.mdx"],
    ]);
  });

  it("serves exactly the generated public slugs, in nav order", () => {
    expect(listDocPages().map((page) => page.slug)).toEqual(docsRoutes.slugs);
    expect(docSlugFromPathname("/docs/start/quickstart/")).toBe("start/quickstart");
    expect(docSlugFromPathname("/docs")).toBe("");
    expect(docSlugFromPathname("/docs/")).toBe("");
  });

  it("orders prev/next by the nav", () => {
    const pages = listDocPages();
    expect(neighbours(pages[0]!.slug)).toEqual({ prev: null, next: pages[1] });
    expect(neighbours(pages[1]!.slug)).toEqual({ prev: pages[0], next: pages[2] });
    expect(neighbours(pages[pages.length - 1]!.slug).next).toBeNull();
    expect(findDocPage(`/${pages[2]!.slug}/`)).toEqual(pages[2]);
  });
});

/**
 * The bundled set is checked as a whole. Anything bundled is fetchable from
 * the public site, so these are the checks that keep private or broken pages
 * from shipping — not style.
 */
describe("docs: the bundled set", () => {
  const pages = listDocPages();
  const entries = navPageEntries(config);
  const sources = new Map<string, string>();
  for (const page of pages) sources.set(page.slug, readFileSync(path.join(DOCS_DIR, page.file), "utf8"));

  it("has pages to test", () => {
    expect(pages.length).toBeGreaterThanOrEqual(50);
  });

  it("resolves every nav entry to a file under docs/", () => {
    for (const entry of entries) {
      const found = [`${entry}.md`, `${entry}.mdx`].some((file) => existsSync(path.join(DOCS_DIR, file)));
      expect(found, `docs.json lists ${entry}, which has no .md or .mdx file`).toBe(true);
    }
  });

  it("lists every slug once", () => {
    const duplicates = entries.filter((entry, index) => entries.indexOf(entry) !== index);
    expect(duplicates).toEqual([]);
    expect(new Set(pages.map((page) => page.slug)).size).toBe(pages.length);
  });

  // globbedDocFiles() is the raw glob, unfiltered: every key is a chunk Vite
  // emits, so this is what actually ships, not what the UI chooses to show.
  it("globs exactly the nav minus the denylist — every emitted chunk is a public page", () => {
    const expected = entries
      .filter((entry) => !isDeniedDocPath(entry))
      .map((entry) => [`${entry}.md`, `${entry}.mdx`].find((file) => existsSync(path.join(DOCS_DIR, file)))!)
      .sort();
    expect(globbedDocFiles()).toEqual(expected);
    expect(pages.map((page) => page.file).sort()).toEqual(expected);
  });

  it("globs no denied path, and lists none as public", () => {
    for (const file of globbedDocFiles()) {
      expect(isDeniedDocPath(file.replace(/\.mdx?$/, "")), file).toBe(false);
    }
    for (const slug of PUBLIC_DOC_SLUGS) {
      expect(isDeniedDocPath(slug), slug).toBe(false);
    }
  });

  it("denies the paths the plan names, and every one of them still exists", () => {
    for (const required of ["api/agentdash-mk", "deploy/ross-private-host", "superpowers/", "agents/", "design/", "specs/", "plans/"]) {
      expect(DOCS_PATH_DENYLIST).toContain(required);
    }
    for (const entry of DOCS_PATH_DENYLIST) {
      if (entry.endsWith("/")) {
        const dir = path.join(DOCS_DIR, entry);
        const files = existsSync(dir) && statSync(dir).isDirectory() ? listMarkdown(dir) : [];
        expect(files.length, `denylist entry ${entry} matches no file; drop it`).toBeGreaterThan(0);
      } else {
        const found = [`${entry}.md`, `${entry}.mdx`].some((file) => existsSync(path.join(DOCS_DIR, file)));
        expect(found, `denylist entry ${entry} matches no file; drop it`).toBe(true);
      }
    }
  });

  it("never names a denied file in UI runtime code — only in the glob's compile-time negations", () => {
    // Anything in ui/src outside a test can end up in a chunk anyone can read.
    // Directory entries (`plans/`) are too generic to scan for; file entries are not.
    const files = listSource(path.join(REPO_ROOT, "ui", "src"));
    for (const entry of DOCS_PATH_DENYLIST.filter((candidate) => !candidate.endsWith("/"))) {
      for (const file of files) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, index) => {
          if (!line.includes(entry)) return;
          const negation = line.trim() === `"!../../../docs/${entry}.{md,mdx}",`;
          expect(negation, `${path.relative(REPO_ROOT, file)}:${index + 1} names ${entry}`).toBe(true);
        });
      }
    }
  });

  it("covers every denylist entry with a negation in the glob", () => {
    const source = readFileSync(path.join(REPO_ROOT, "ui", "src", "lib", "docs.ts"), "utf8");
    for (const entry of DOCS_PATH_DENYLIST) {
      const negation = entry.endsWith("/")
        ? `"!../../../docs/${entry}**"`
        : `"!../../../docs/${entry}.{md,mdx}"`;
      expect(source, negation).toContain(negation);
    }
  });

  it("refuses to load anything outside the bundled set", async () => {
    const ref = listDocPages()[0]!;
    await expect(loadDocSource({ ...ref, slug: "api/agentdash-mk", file: "api/agentdash-mk.md" })).rejects.toThrow();
    await expect(loadDocSource({ ...ref, slug: "guides/execution-policy", file: "guides/execution-policy.md" })).rejects.toThrow();
  });

  it("loads every page lazily, with a title and a body", async () => {
    for (const page of pages) {
      const loaded = await loadDocPage(page);
      expect(loaded.title, page.slug).not.toBe("");
      expect(loaded.body.length, page.slug).toBeGreaterThan(0);
    }
  });

  it("uses no token other than the instance address outside code", () => {
    // Adapter pages document the prompt-template variables (`{{agentId}}`) in
    // inline code. Code renders literally, so it is not a substitution token.
    for (const [slug, source] of sources) {
      const unknown = tokensIn(stripCode(source)).filter((token) => token !== INSTANCE_URL_TOKEN);
      expect(unknown, slug).toEqual([]);
    }
  });

  it("never tells anyone to run a CLI that does not exist", () => {
    // Mirrors server/src/__tests__/bridge-command-name.test.ts (AGE-12).
    for (const [slug, source] of sources) {
      expect(source, slug).not.toMatch(/npx\s+agentdash(?![\w-])/);
    }
  });

  it("contains no forbidden token — pages, nav and search index", () => {
    const targets = new Map(sources);
    targets.set("docs/docs.json", readFileSync(path.join(DOCS_DIR, "docs.json"), "utf8"));
    targets.set("ui/src/generated/docs-search-index.json", JSON.stringify(searchIndex));
    targets.set("ui/src/generated/docs-routes.json", JSON.stringify(docsRoutes));
    // Shipped as a static asset by the API reference page (components/docs/ApiReference.tsx).
    targets.set("docs/api/openapi.yaml", readFileSync(path.join(DOCS_DIR, "api", "openapi.yaml"), "utf8"));
    for (const [name, text] of targets) {
      expect(forbiddenTokenOffsets(text), name).toEqual([]);
    }
  });
});

/**
 * Customer, instance and people identifiers that must never be on the public
 * site. Stored as SHA-256 of the lowercase token, with its length, only so the
 * tokens are not printed in clear in this file and its diffs. This is NOT a
 * secret: the tokens are short and guessable, and anyone with a guess list can
 * recover them from these hashes. The scan hashes every window of each length
 * across the page's lowercase text — deterministic, and a token is found
 * wherever it sits (inside a word, a hostname, an address). Hyphenated
 * spellings are listed separately; a bare short name is not, where it would
 * match inside ordinary words.
 */
const FORBIDDEN_TOKENS: ReadonlyArray<{ length: number; sha256: string }> = [
  { length: 7, sha256: "4998fa28eb8d38a27eff147fb68e1ad03ea01658fb5eec10aabadbaf37ffe565" },
  { length: 7, sha256: "b9de7ec8cd4acc8522ecc7ac274f10fa904242ae15b9d05cd7a393a95bb7dd75" },
  { length: 12, sha256: "3e7cb594871023585497489bc000d29e482cda61bca9c8693020b3a85f40053c" },
  { length: 12, sha256: "0536debeda2dbcfc02c055b13ce259457871d9224cf501a302e1c751eb28c1f2" },
  { length: 6, sha256: "0c59fcbbac92f38fa899db945fa4e6d4b252a224b7003eb7839c80f7899544fc" },
  { length: 5, sha256: "b9cbfe962ddda6952b584988cbf7d074a35ec1e99ef71853447cb0eb91bb6547" },
  { length: 5, sha256: "2d07d002c88b7c7546f7c81175b0fd8ef3843654895574b81ba28573d4373a96" },
  { length: 12, sha256: "68b7730d0f4346654432e894c673760d287e3ee7a7509c4c6f802f216301c4b7" },
  { length: 12, sha256: "b9dd1da230753160f70e3864d24aa0bd1ca81cd8bceaf3709fd41e09d55214b1" },
  { length: 12, sha256: "53ac39752d14c82c6972e6acd2f56dbfbaeeccb41e7e6371e95799d1ad09dad8" },
];

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Offsets at which a window of `text` hashes to one of `tokens`. */
function forbiddenTokenOffsets(
  text: string,
  tokens: ReadonlyArray<{ length: number; sha256: string }> = FORBIDDEN_TOKENS,
): number[] {
  const lower = text.toLowerCase();
  const byLength = new Map<number, Set<string>>();
  for (const token of tokens) {
    if (!byLength.has(token.length)) byLength.set(token.length, new Set());
    byLength.get(token.length)!.add(token.sha256);
  }
  const offsets: number[] = [];
  for (const [length, hashes] of byLength) {
    for (let i = 0; i + length <= lower.length; i += 1) {
      if (hashes.has(sha256(lower.slice(i, i + length)))) offsets.push(i);
    }
  }
  return offsets.sort((a, b) => a - b);
}

describe("docs: the forbidden-token scan itself", () => {
  it("finds a hashed token anywhere in the text, case-insensitively, and nothing else", () => {
    const needle = [{ length: 6, sha256: sha256("needle") }];
    expect(forbiddenTokenOffsets("hay NEEDLE hay", needle)).toEqual([4]);
    expect(forbiddenTokenOffsets("x@needle.example", needle)).toEqual([2]);
    expect(forbiddenTokenOffsets("haystack only", needle)).toEqual([]);
  });

  it("holds well-formed hashes", () => {
    for (const token of FORBIDDEN_TOKENS) {
      expect(token.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(token.length).toBeGreaterThan(0);
    }
  });
});

describe("docs: search", () => {
  it("ranks a title match above a heading match above a body match", () => {
    const entries = [
      { slug: "a", title: "Other", summary: "", headings: [], firstParagraph: "about budgets" },
      { slug: "b", title: "Budgets", summary: "", headings: [], firstParagraph: "" },
      { slug: "c", title: "Costs", summary: "", headings: ["Setting budgets"], firstParagraph: "" },
    ];
    const hits = searchDocs("budgets", entries);
    expect(hits.map((hit) => hit.entry.slug)).toEqual(["b", "c", "a"]);
    expect(hits[1]!.heading).toBe("Setting budgets");
  });

  it("requires every word, and returns nothing for an empty query", () => {
    const entries = [{ slug: "a", title: "Docker", summary: "compose quickstart", headings: [], firstParagraph: "" }];
    expect(searchDocs("docker compose", entries)).toHaveLength(1);
    expect(searchDocs("docker kubernetes", entries)).toHaveLength(0);
    expect(searchDocs("   ", entries)).toHaveLength(0);
  });

  it("finds real pages in the shipped index", () => {
    expect(searchDocs("connect your terminal")[0]?.entry.slug).toBe("guides/steward/connect-your-terminal");
  });
});

/** Non-test .ts/.tsx/.js files under `dir`. */
function listSource(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listSource(full));
    else if (/\.(tsx?|jsx?|mjs)$/.test(entry) && !/\.test\.|\.spec\.|\.stories\./.test(entry)) out.push(full);
  }
  return out;
}

function listMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listMarkdown(full));
    else if (/\.mdx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** The text outside fenced code blocks and inline code spans. */
function stripCode(markdown: string): string {
  return markdown.replace(/^(```|~~~)[\s\S]*?^\1.*$/gm, "").replace(/`[^`\n]*`/g, "");
}
