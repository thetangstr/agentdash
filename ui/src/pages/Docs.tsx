// AgentDash — the public docs at /docs (doc/plans/2026-10-01-public-docs-section.md).
//
// Public tier, like /mcp and /pricing: no auth, no company context, outside
// CloudAccessGate, mounted lazily from App.tsx so nothing here — the nav, the
// search index, the page bodies — is in the initial bundle. The app shell sets
// `body { overflow: hidden }`, so the page owns its scroll region
// (`h-screen overflow-y-auto`), exactly like PricingPage.
//
// It renders on the app's theme tokens rather than the cream marketing surface
// because the body goes through MarkdownBody, which follows the app theme;
// putting it on a fixed-light surface would print light prose on cream in dark
// mode.
//
// Served on the public marketing site and on instances. Public-site examples
// use an instance placeholder, regardless of what the health endpoint returns.

import { Suspense, lazy, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { Link, Navigate, useLocation, useNavigate } from "@/lib/router";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";
import { MarkdownBody } from "@/components/MarkdownBody";
import { AgentDashMark } from "@/components/brand/AgentDashMark";
import { useDocumentMeta } from "@/marketing/hooks/useDocumentMeta";
import { renderGuide } from "@/lib/guides";
import { cn } from "@/lib/utils";
import {
  docsTree,
  findDocPage,
  listDocPages,
  loadDocPage,
  neighbours,
  searchDocs,
  type DocPageRef,
  type DocTab,
} from "@/lib/docs";
import { docSlugFromPathname } from "@/lib/docs-nav";
import { INSTANCE_URL_PLACEHOLDER, referenceInstanceUrl } from "@/lib/api-reference-server";

/**
 * Two adjustments to MarkdownBody for reference pages, made here rather than
 * in the generators so the markdown stays plain:
 *  - table headers do not wrap, so a wide Type column cannot squeeze
 *    "Required" into one letter per line, and a first column (a property
 *    name) keeps 10rem, so `target` is not split mid-word (docs/mcp/tools/*.md);
 *  - ```markdown blocks wrap, because they quote prompt text whose paragraphs
 *    are single lines hundreds of characters long (docs/mcp/playbooks.md).
 *    Other code keeps `white-space: pre`: a shell command must not reflow.
 * The two whitespace rules are `!important`: index.css styles `.paperclip-markdown pre`
 * outside any layer, which beats a layered utility at any specificity.
 * Both table rules make a table wider than its content would need, so each
 * table also scrolls inside its own container (`scrollableTables`) and the
 * page itself never scrolls sideways on a phone.
 */
const DOC_BODY_CLASS =
  "[&_th]:whitespace-nowrap! [&_td:first-child]:min-w-40 [&_pre:has(code.language-markdown)]:whitespace-pre-wrap!";

// The API reference (Scalar) is its own lazy chunk: only a `kind: openapi`
// page loads it. See components/docs/ApiReference.tsx.
const ApiReference = lazy(() => import("@/components/docs/ApiReference"));

function documentIsDark(): boolean {
  // Read, not subscribed: the docs shell has no theme toggle, and the app's
  // ThemeProvider sets this class before anything renders.
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}

export function docsHref(slug: string): string {
  return `/docs/${slug}`;
}

export function Docs() {
  // Read from the pathname, not a route param: App.tsx reaches this from
  // `docs/*` and from the mirrored board paths (see docs-nav.ts), whose params
  // differ.
  const slug = docSlugFromPathname(useLocation().pathname);
  const tree = docsTree();
  const first = listDocPages(tree)[0] ?? null;

  if (!slug && first) {
    return <Navigate to={docsHref(first.slug)} replace />;
  }

  const ref = slug ? findDocPage(slug, tree) : null;
  return (
    <DocsLayout tree={tree} current={ref}>
      {ref ? <DocArticle docRef={ref} tree={tree} /> : <DocNotFound slug={slug} />}
    </DocsLayout>
  );
}

function useInstanceUrl(): string {
  // Same rule as Guide.tsx and the connect command: what the instance
  // publishes, else the browser's own origin.
  const { data: health } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    staleTime: 5 * 60_000,
  });
  const browserOrigin = typeof window !== "undefined" ? window.location.origin : "";
  const hostname = typeof window !== "undefined" ? window.location.hostname : "";
  return referenceInstanceUrl(hostname, health?.publicBaseUrl?.trim() || browserOrigin) ?? INSTANCE_URL_PLACEHOLDER;
}

function DocsLayout({
  tree,
  current,
  children,
}: {
  tree: DocTab[];
  current: DocPageRef | null;
  children: ReactNode;
}) {
  const [navOpen, setNavOpen] = useState(false);
  return (
    <div className="h-screen overflow-y-auto bg-background text-foreground" data-testid="docs-root">
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
          <a href="/" aria-label="AgentDash home" className="flex shrink-0 items-center gap-2">
            <AgentDashMark size={22} />
            <span className="text-sm font-semibold">AgentDash</span>
          </a>
          <Link to="/docs" className="shrink-0 text-sm text-muted-foreground hover:text-foreground">
            Docs
          </Link>
          <div className="ml-auto w-full max-w-xs">
            <DocsSearch />
          </div>
          <button
            type="button"
            className="shrink-0 rounded-md border border-border px-2 py-1 text-xs md:hidden"
            aria-expanded={navOpen}
            aria-controls="docs-nav"
            onClick={() => setNavOpen((open) => !open)}
          >
            Menu
          </button>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-6xl gap-8 px-4 sm:px-6">
        <aside
          id="docs-nav"
          className={cn(
            "w-full shrink-0 py-6 md:sticky md:top-14 md:block md:max-h-[calc(100vh-3.5rem)] md:w-60 md:overflow-y-auto",
            navOpen ? "block" : "hidden",
          )}
        >
          <DocsNav tree={tree} current={current} onNavigate={() => setNavOpen(false)} />
        </aside>
        <main className={cn("min-w-0 flex-1 py-6", navOpen && "hidden md:block")}>{children}</main>
      </div>
    </div>
  );
}

function groupKey(tab: string, group: string): string {
  return `${tab}/${group}`;
}

export function DocsNav({
  tree,
  current,
  onNavigate,
}: {
  tree: DocTab[];
  current: DocPageRef | null;
  onNavigate?: () => void;
}) {
  const currentKey = current ? groupKey(current.tab, current.group) : null;
  const [open, setOpen] = useState<Set<string>>(() => new Set(currentKey ? [currentKey] : []));

  // Following a link into another group opens it; nothing the person opened is closed.
  useEffect(() => {
    if (!currentKey) return;
    setOpen((previous) => (previous.has(currentKey) ? previous : new Set(previous).add(currentKey)));
  }, [currentKey]);

  const toggle = (key: string) =>
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <nav aria-label="Documentation" className="flex flex-col gap-5 text-sm">
      {tree.map((tab) => (
        <section key={tab.title} aria-label={tab.title} className="flex flex-col gap-1">
          <h2 className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{tab.title}</h2>
          {tab.groups.map((group) => {
            const key = groupKey(tab.title, group.title);
            const expanded = open.has(key);
            const listId = `docs-group-${key.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
            return (
              <div key={key}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between rounded-md px-2 py-1 text-left font-medium hover:bg-accent"
                  aria-expanded={expanded}
                  aria-controls={listId}
                  onClick={() => toggle(key)}
                >
                  {group.title}
                  <ChevronDown
                    aria-hidden="true"
                    className={cn("h-3.5 w-3.5 transition-transform", !expanded && "-rotate-90")}
                  />
                </button>
                {expanded ? (
                  <ul id={listId} className="mt-0.5 flex flex-col border-l border-border pl-2 ml-2">
                    {group.pages.map((page) => {
                      const active = current?.slug === page.slug;
                      return (
                        <li key={page.slug}>
                          <Link
                            to={docsHref(page.slug)}
                            aria-current={active ? "page" : undefined}
                            onClick={onNavigate}
                            className={cn(
                              "block rounded-md px-2 py-1 text-muted-foreground hover:text-foreground",
                              active && "bg-accent font-medium text-foreground",
                            )}
                          >
                            {page.title}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </section>
      ))}
    </nav>
  );
}

function DocArticle({ docRef, tree }: { docRef: DocPageRef; tree: DocTab[] }) {
  const instanceUrl = useInstanceUrl();
  const { data: page, error, isLoading } = useQuery({
    queryKey: ["docs", "page", docRef.slug],
    queryFn: () => loadDocPage(docRef, tree),
    staleTime: Infinity,
  });
  const { prev, next } = neighbours(docRef.slug, tree);
  const title = page?.title ?? docRef.title;
  useDocumentMeta(`${title} — AgentDash Docs`, page?.summary || "AgentDash documentation.");

  const wide = page?.kind === "openapi";
  return (
    <article className={cn("mx-auto flex w-full flex-col gap-4", !wide && "max-w-3xl")}>
      <nav className="text-xs text-muted-foreground" aria-label="Breadcrumb">
        <span>{docRef.tab}</span>
        <span className="mx-1">/</span>
        <span>{docRef.group}</span>
      </nav>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-foreground">{title}</h1>
        {page?.summary ? <p className="text-sm text-muted-foreground">{page.summary}</p> : null}
      </header>
      {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {error ? (
        <p className="text-sm text-destructive">This page could not be loaded. Reload to try again.</p>
      ) : null}
      {page ? (
        <MarkdownBody linkIssueReferences={false} scrollableTables className={DOC_BODY_CLASS}>
          {renderGuide(page.body, { instanceUrl })}
        </MarkdownBody>
      ) : null}
      {page?.kind === "openapi" ? (
        <Suspense fallback={<p className="text-sm text-muted-foreground">Loading the API reference…</p>}>
          <ApiReference
            dark={documentIsDark()}
            instanceUrl={referenceInstanceUrl(typeof window !== "undefined" ? window.location.hostname : "", instanceUrl)}
          />
        </Suspense>
      ) : null}
      <nav aria-label="Pagination" className="mt-6 flex items-stretch justify-between gap-4 border-t border-border pt-4">
        {prev ? (
          <Link to={docsHref(prev.slug)} rel="prev" className="flex flex-col rounded-md p-2 hover:bg-accent">
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <ChevronLeft aria-hidden="true" className="h-3 w-3" /> Previous
            </span>
            <span className="text-sm font-medium">{prev.title}</span>
          </Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link to={docsHref(next.slug)} rel="next" className="flex flex-col items-end rounded-md p-2 text-right hover:bg-accent">
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              Next <ChevronRight aria-hidden="true" className="h-3 w-3" />
            </span>
            <span className="text-sm font-medium">{next.title}</span>
          </Link>
        ) : null}
      </nav>
    </article>
  );
}

function DocNotFound({ slug }: { slug: string }) {
  useDocumentMeta("Not found — AgentDash Docs", "AgentDash documentation.");
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <h1 className="text-2xl font-bold text-foreground">No such page</h1>
      <p className="text-sm text-muted-foreground">
        Nothing is filed at <code className="font-mono">{slug}</code>.{" "}
        <Link to="/docs" className="underline">
          Start from the beginning
        </Link>
      </p>
    </div>
  );
}

export function DocsSearch() {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => searchDocs(query), [query]);
  const listId = "docs-search-results";

  const go = (slug: string) => {
    setQuery("");
    setActive(0);
    inputRef.current?.blur();
    navigate(docsHref(slug));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setQuery("");
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, Math.max(hits.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter" && hits[active]) {
      event.preventDefault();
      go(hits[active]!.entry.slug);
    }
  };

  return (
    <div className="relative">
      <label className="sr-only" htmlFor="docs-search">
        Search the docs
      </label>
      <Search aria-hidden="true" className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        ref={inputRef}
        id="docs-search"
        type="search"
        role="combobox"
        aria-expanded={query.trim() !== "" && hits.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        placeholder="Search docs"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        className="h-8 w-full rounded-md border border-border bg-background pl-7 pr-2 text-sm outline-none focus:border-ring"
      />
      {query.trim() !== "" ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Search results"
          className="absolute right-0 top-9 z-50 max-h-96 w-[min(28rem,90vw)] overflow-y-auto rounded-md border border-border bg-popover p-1 text-sm shadow-md"
        >
          {hits.length === 0 ? (
            <li className="px-2 py-1.5 text-muted-foreground">No pages match.</li>
          ) : (
            hits.map((hit, index) => (
              <li key={hit.entry.slug} role="option" aria-selected={index === active}>
                <button
                  type="button"
                  className={cn(
                    "flex w-full flex-col items-start rounded px-2 py-1.5 text-left hover:bg-accent",
                    index === active && "bg-accent",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => go(hit.entry.slug)}
                >
                  <span className="font-medium">{hit.entry.title}</span>
                  <span className="line-clamp-1 text-xs text-muted-foreground">
                    {hit.heading ?? (hit.entry.summary || hit.entry.firstParagraph)}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
