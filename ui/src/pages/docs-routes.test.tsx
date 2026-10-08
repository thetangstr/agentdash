// @vitest-environment jsdom
//
// The public docs are URLs before they are components. This mounts the real
// router with the same route lines App.tsx uses for /docs, and visits every
// bundled page at its exact URL, asserting the page's heading renders, the
// body arrives through the lazy loader non-empty, and no `{{instanceUrl}}`
// survives. The route lines are checked against App.tsx's source, so the tree
// here cannot quietly stop matching the app — the same contract as
// guides-routes.test.tsx.

import { act, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PUBLISHED = "http://10.0.0.5:3102";

vi.mock("@/api/health", () => ({
  healthApi: { get: vi.fn().mockResolvedValue({ status: "ok", publicBaseUrl: PUBLISHED }) },
}));

// Rendering markdown is MarkdownBody's own concern (and its own tests). Here it
// is a pass-through so the substituted text can be read back.
vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div data-testid="body">{children}</div>,
}));

// The API reference page renders Scalar, a large lazy chunk with its own
// renderer; what it draws is Scalar's concern. Here it is a marker, so the test
// can see that an `openapi` page mounts it and no other page does.
vi.mock("@/components/docs/ApiReference", () => ({
  default: ({ instanceUrl }: { instanceUrl: string | null }) => (
    <div data-testid="api-reference" data-instance-url={instanceUrl ?? ""}>API reference</div>
  ),
}));

// Link (from @/lib/router) reads the selected company to prefix board routes.
// /docs is a global root, so no company is selected and nothing is prefixed.
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ companies: [], selectedCompany: null, loading: false }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { healthApi } = await import("@/api/health");
const { Docs } = await import("./Docs");
const { listDocPages, loadDocSource, INSTANCE_URL_TOKEN } = await import("@/lib/docs");

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

/**
 * The same route lines as App.tsx, checked below. App also mirrors every board
 * path under docs/ so no board route outranks a docs URL; that needs App's own
 * boardRoutes(), so it is tested against the real App in
 * docs-app-routes.test.tsx. Mounted alone, `docs/*` reaches every page.
 */
function DocsRoutes() {
  return (
    <Routes>
      <Route path="docs" element={<Suspense fallback={null}><Docs /></Suspense>} />
      <Route path="docs/*" element={<Suspense fallback={null}><Docs /></Suspense>} />
    </Routes>
  );
}

describe("docs URLs", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.mocked(healthApi.get).mockResolvedValue({ status: "ok", publicBaseUrl: PUBLISHED } as Awaited<ReturnType<typeof healthApi.get>>);
  });

  async function settle(done: () => boolean) {
    // The page body and the health query both settle on macrotasks, so a
    // microtask flush is not enough — same as guides-routes.test.tsx.
    for (let i = 0; i < 20; i += 1) {
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      if (done()) break;
    }
  }

  function read() {
    return {
      pathname: container.querySelector('[data-testid="location"]')?.textContent ?? "",
      heading: container.querySelector("h1")?.textContent ?? "",
      body: container.querySelector('[data-testid="body"]')?.textContent ?? "",
      current: container.querySelector('nav[aria-label="Documentation"] [aria-current="page"]')?.textContent ?? "",
      prev: container.querySelector('a[rel="prev"]')?.getAttribute("href") ?? null,
      next: container.querySelector('a[rel="next"]')?.getAttribute("href") ?? null,
      text: container.textContent ?? "",
      apiReference: container.querySelector('[data-testid="api-reference"]') !== null,
      apiReferenceInstance: container.querySelector('[data-testid="api-reference"]')?.getAttribute("data-instance-url") ?? null,
    };
  }

  async function visit(url: string, until: (page: ReturnType<typeof read>) => boolean = () => true) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter key={url} initialEntries={[url]}>
            <DocsRoutes />
            <LocationProbe />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await settle(() => until(read()));
    return read();
  }

  const pages = listDocPages();

  it("has pages to test", () => {
    expect(pages.length).toBeGreaterThanOrEqual(50);
  });

  pages.forEach((page, index) => {
    const url = `/docs/${page.slug}`;

    it(`${url} renders "${page.title}"`, async () => {
      const source = await loadDocSource(page);
      const needsAddress = source.includes(INSTANCE_URL_TOKEN);
      const rendered = await visit(url, (current) =>
        current.body !== "" && (!needsAddress || current.body.includes(PUBLISHED)),
      );
      expect(rendered.pathname).toBe(url);
      expect(rendered.heading).toBe(page.title);
      expect(rendered.body.trim().length).toBeGreaterThan(0);
      expect(rendered.body).not.toContain(INSTANCE_URL_TOKEN);
      if (needsAddress) expect(rendered.body).toContain(PUBLISHED);
      expect(rendered.current).toBe(page.title);
      expect(rendered.prev).toBe(index > 0 ? `/docs/${pages[index - 1]!.slug}` : null);
      expect(rendered.next).toBe(index < pages.length - 1 ? `/docs/${pages[index + 1]!.slug}` : null);
    });
  });

  it("mounts the API reference on the openapi page, and only there", async () => {
    const reference = pages.find((page) => page.slug === "api/reference");
    expect(reference, "api/reference is in the nav").toBeDefined();
    const rendered = await visit("/docs/api/reference", (current) => current.body !== "" && current.apiReferenceInstance === PUBLISHED);
    expect(rendered.heading).toBe(reference!.title);
    expect(rendered.apiReference).toBe(true);
    // jsdom's host is not the public site, so "try it" is prefilled with the
    // instance's published address — the same one {{instanceUrl}} resolves to.
    expect(rendered.apiReferenceInstance).toBe(PUBLISHED);
    const other = await visit("/docs/api/authentication", (current) => current.body !== "");
    expect(other.apiReference).toBe(false);
  });

  it.each(["www.agentdash.cloud", "agentdash.cloud"])("uses a placeholder in prose and Try It on %s even when health names another host", async (hostname) => {
    const localWindow = window;
    vi.stubGlobal("window", new Proxy(localWindow, {
      get(target, key) {
        if (key === "location") return { hostname, origin: `https://${hostname}` };
        return Reflect.get(target, key);
      },
    }));
    const rendered = await visit("/docs/api/api-keys", (current) => current.body !== "");
    expect(rendered.body).toContain("https://your-instance.example");
    expect(rendered.body).not.toContain(PUBLISHED);
    const reference = await visit("/docs/api/reference", (current) => current.apiReference);
    expect(reference.apiReferenceInstance).toBe("");
  });

  it("uses the browser origin on an instance when health has no published URL", async () => {
    vi.mocked(healthApi.get).mockResolvedValue({ status: "ok" } as Awaited<ReturnType<typeof healthApi.get>>);
    const rendered = await visit("/docs/api/api-keys", (current) => current.body !== "");
    expect(rendered.body).toContain(window.location.origin);
    expect(rendered.body).not.toContain("https://your-instance.example");
  });

  it("/docs lands on the first page of the first tab", async () => {
    const rendered = await visit("/docs", (current) => current.body !== "");
    expect(rendered.pathname).toBe(`/docs/${pages[0]!.slug}`);
    expect(rendered.heading).toBe(pages[0]!.title);
  });

  it("lists every tab and the current page's group in the nav", async () => {
    const rendered = await visit(`/docs/${pages[0]!.slug}`);
    for (const tab of new Set(pages.map((page) => page.tab))) {
      expect(rendered.text).toContain(tab);
    }
    for (const page of pages.filter((candidate) => candidate.group === pages[0]!.group)) {
      expect(rendered.text).toContain(page.title);
    }
  });

  it("answers an unknown or denied path with a not-found page, not a private file", async () => {
    for (const url of ["/docs/no/such-page", "/docs/api/agentdash-mk", "/docs/superpowers/zk-spike-plan"]) {
      const rendered = await visit(url);
      expect(rendered.pathname, url).toBe(url);
      expect(rendered.heading, url).toBe("No such page");
      expect(rendered.body, url).toBe("");
    }
  });

  it("searches the index and opens the chosen page", async () => {
    await visit(`/docs/${pages[0]!.slug}`);
    const input = container.querySelector<HTMLInputElement>("#docs-search")!;
    expect(input).not.toBeNull();
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(input, "connect your terminal");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const results = container.querySelector('[role="listbox"]');
    expect(results?.textContent).toContain("Connect Your Terminal");
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle(() => read().body !== "");
    expect(read().pathname).toBe("/docs/guides/steward/connect-your-terminal");
  });

  it("uses route lines that match App.tsx", () => {
    const appSource = readAppSource();
    for (const line of [
      'const Docs = lazy(() => import("./pages/Docs").then((module) => ({ default: module.Docs })));',
      '<Route path="docs" element={<Suspense fallback={null}><Docs /></Suspense>} />',
      "const DOCS_SHADOW_ROUTE_PATHS = docsShadowRoutePaths(boardRoutes());",
      "{DOCS_SHADOW_ROUTE_PATHS.map((path) => <Route key={path} path={path} element={<Suspense fallback={null}><Docs /></Suspense>} />)}",
      '<Route path="docs/*" element={<Suspense fallback={null}><Docs /></Suspense>} />',
    ]) {
      expect(appSource, line).toContain(line);
    }
    // Public tier: the docs routes sit before CloudAccessGate, like /mcp.
    expect(appSource.indexOf('<Route path="docs/*"')).toBeLessThan(appSource.indexOf("<Route element={<CloudAccessGate />}>"));
  });
});

function readAppSource(): string {
  // import.meta.url is not a file: URL under jsdom, and vitest's cwd is ui/
  // locally but the repo root in CI's sharded run — so look in both places.
  const candidates = [
    path.join(process.cwd(), "src", "App.tsx"),
    path.join(process.cwd(), "ui", "src", "App.tsx"),
  ];
  const appPath = candidates.find((candidate) => existsSync(candidate));
  expect(appPath, `App.tsx not found at ${candidates.join(" or ")}`).toBeDefined();
  return readFileSync(appPath!, "utf8");
}
