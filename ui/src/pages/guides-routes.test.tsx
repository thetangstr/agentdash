// @vitest-environment jsdom
//
// The links people are sent are URLs, not component names. This mounts the
// real router with the same route lines App.tsx uses, and for every bundled
// guide visits its exact URL two ways — with the company prefix, and without,
// the way a pasted link arrives — asserting the right page renders with this
// instance's published address in it. The route lines are also checked against
// App.tsx's source, so the tree here cannot quietly stop matching the app.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PUBLISHED = "http://10.0.0.5:3102";
const PREFIX = "MKT";

vi.mock("@/api/health", () => ({
  healthApi: { get: vi.fn().mockResolvedValue({ status: "ok", publicBaseUrl: PUBLISHED }) },
}));

// Rendering markdown is MarkdownBody's own concern (and its own tests). Here it
// is a pass-through so the substituted text can be read back.
vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div data-testid="body">{children}</div>,
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "c1", issuePrefix: PREFIX, name: "MKThink" }],
    selectedCompany: { id: "c1", issuePrefix: PREFIX, name: "MKThink" },
    loading: false,
  }),
}));

vi.mock("@/context/DialogContext", () => ({
  useDialogActions: () => ({ openOnboarding: vi.fn() }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { Guides } = await import("./Guides");
const { Guide } = await import("./Guide");
const { UnprefixedBoardRedirect } = await import("@/components/UnprefixedBoardRedirect");
const { listGuides, INSTANCE_URL_TOKEN } = await import("@/lib/guides");

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

/** The same route lines as App.tsx, in the same nesting. Checked below. */
function GuideRoutes() {
  return (
    <Routes>
      <Route path=":companyPrefix" element={<Outlet />}>
        <Route path="guides" element={<Guides />} />
        <Route path="guides/:group/:slug" element={<Guide />} />
      </Route>
      <Route path="guides" element={<UnprefixedBoardRedirect />} />
      <Route path="guides/*" element={<UnprefixedBoardRedirect />} />
    </Routes>
  );
}

describe("guide URLs", () => {
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
  });

  async function visit(url: string) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[url]}>
            <GuideRoutes />
            <LocationProbe />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    // Let the health query resolve so the published address, not the
    // fallback, is what gets substituted. react-query settles on a macrotask,
    // so a microtask flush is not enough — same as App.test.tsx's flushReact.
    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      if (container.textContent?.includes(PUBLISHED)) break;
    }
    return {
      pathname: container.querySelector('[data-testid="location"]')?.textContent ?? "",
      heading: container.querySelector("h1")?.textContent ?? "",
      body: container.querySelector('[data-testid="body"]')?.textContent ?? "",
      text: container.textContent ?? "",
    };
  }

  const guides = listGuides();

  it("has guides to test", () => {
    expect(guides.length).toBeGreaterThanOrEqual(5);
  });

  for (const guide of guides) {
    const path = `/guides/${guide.group}/${guide.slug}`;

    it(`${path} renders "${guide.title}" with the published address`, async () => {
      const page = await visit(`/${PREFIX}${path}`);
      expect(page.pathname).toBe(`/${PREFIX}${path}`);
      expect(page.heading).toBe(guide.title);
      expect(page.body).not.toContain("{{");
      if (guide.body.includes(INSTANCE_URL_TOKEN)) {
        expect(page.body).toContain(PUBLISHED);
      }
    });

    it(`${path} without the company prefix redirects to the same page`, async () => {
      const page = await visit(path);
      expect(page.pathname).toBe(`/${PREFIX}${path}`);
      expect(page.heading).toBe(guide.title);
    });
  }

  it("/guides lists every bundled guide, and redirects when unprefixed", async () => {
    const prefixed = await visit(`/${PREFIX}/guides`);
    expect(prefixed.heading).toBe("Guides");
    for (const guide of guides) {
      expect(prefixed.text).toContain(guide.title);
    }
    const unprefixed = await visit("/guides");
    expect(unprefixed.pathname).toBe(`/${PREFIX}/guides`);
    expect(unprefixed.heading).toBe("Guides");
  });

  it("uses a route tree that matches App.tsx line for line", () => {
    // vitest runs with cwd = ui/, and import.meta.url is not a file: URL under jsdom.
    const appSource = readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
    for (const line of [
      '<Route path="guides" element={<Guides />} />',
      '<Route path="guides/:group/:slug" element={<Guide />} />',
      '<Route path="guides" element={<UnprefixedBoardRedirect />} />',
      '<Route path="guides/*" element={<UnprefixedBoardRedirect />} />',
      '<Route path=":companyPrefix" element={<Layout />}>',
    ]) {
      expect(appSource, line).toContain(line);
    }
  });
});
