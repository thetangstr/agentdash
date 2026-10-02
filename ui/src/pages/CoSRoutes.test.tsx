// @vitest-environment jsdom
// AgentDash: Ask (the Chief of Staff conversation) lives inside the sidebar
// Layout at /:prefix/cos. Bare /cos redirects there once a company exists, and
// stays the full-screen bootstrap conversation for a founder with no company.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Company = { id: string; issuePrefix: string; name: string };

const companyState = vi.hoisted(() => ({
  companies: [] as Company[],
  selectedCompany: null as Company | null,
  loading: false,
}));
const mockBootstrap = vi.hoisted(() => vi.fn());
const mockCompanyInbox = vi.hoisted(() => vi.fn());
const mockAgentsList = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: companyState.companies,
    selectedCompany: companyState.selectedCompany,
    selectedCompanyId: companyState.selectedCompany?.id ?? null,
    loading: companyState.loading,
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../api/onboarding", () => ({
  onboardingApi: {
    bootstrap: mockBootstrap,
    adapterStatus: () => ({ status: { adapter: "minimax", ready: true, preset: "minimax", reason: null } }),
    setupHermesProvider: vi.fn(),
  },
}));

vi.mock("../api/conversations", () => ({
  conversationsApi: { companyInbox: mockCompanyInbox },
}));

vi.mock("../api/agents", () => ({
  agentsApi: { list: mockAgentsList },
}));

const mockQueryClient = vi.hoisted(() => ({ invalidateQueries: vi.fn(async () => undefined) }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => mockQueryClient,
  useQuery: ({ queryFn }: { queryFn: () => unknown }) => {
    const data = queryFn();
    // agentsApi.list returns a promise for the bootstrap effect; the directory
    // query only needs an array.
    return { data: data instanceof Promise ? [] : data, isLoading: false, error: null };
  },
}));

vi.mock("./ChatPanel", () => ({
  default: () => <div className="chat-panel" data-testid="chat-panel" />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ACME: Company = { id: "c-acme", issuePrefix: "ACME", name: "Acme" };

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</div>;
}

describe("Ask routes", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    companyState.companies = [];
    companyState.selectedCompany = null;
    companyState.loading = false;
    mockBootstrap.mockReset();
    mockCompanyInbox.mockReset();
    mockAgentsList.mockReset();
    mockSetBreadcrumbs.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderAt(url: string) {
    const { CoSAskPage, CoSEntryRoute } = await import("./CoSConversation");
    const { NavLink } = await import("@/lib/router");
    // Mirrors App.tsx: bare /cos at the top level, Ask under the
    // :companyPrefix Layout. The stand-in Layout renders a sidebar with the
    // real company-aware NavLink, so the highlight is the real mechanism.
    function SidebarLayout() {
      return (
        <div>
          <nav data-testid="sidebar">
            <NavLink to="/dashboard">Home</NavLink>
            <NavLink to="/cos" data-testid="sidebar-ask">Ask</NavLink>
          </nav>
          <main data-testid="main">
            <Outlet />
          </main>
        </div>
      );
    }
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="cos" element={<CoSEntryRoute />} />
            <Route path=":companyPrefix" element={<SidebarLayout />}>
              <Route path="cos" element={<CoSAskPage />} />
            </Route>
          </Routes>
          <LocationProbe />
        </MemoryRouter>,
      );
    });
    await act(async () => {});
    await act(async () => {});
  }

  const q = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);

  it("renders Ask inside the sidebar layout for an existing company, with Ask highlighted", async () => {
    companyState.companies = [ACME];
    companyState.selectedCompany = ACME;
    mockCompanyInbox.mockResolvedValue({ id: "conv-1" });
    mockAgentsList.mockResolvedValue([{ id: "cos-1", name: "CoS", role: "chief_of_staff" }]);

    await renderAt("/ACME/cos");

    expect(q("sidebar")).toBeTruthy();
    const conversation = q("cos-conversation");
    expect(conversation).toBeTruthy();
    expect(q("main")?.contains(conversation)).toBe(true);
    expect(conversation?.getAttribute("data-layout")).toBe("embedded");
    // Not the full-screen overlay that hid the sidebar.
    expect(conversation?.className).not.toContain("fixed");
    expect(conversation?.className).toContain("md:h-full");
    expect(q("chat-panel")).toBeTruthy();

    const ask = q("sidebar-ask");
    expect(ask?.getAttribute("href")).toBe("/ACME/cos");
    expect(ask?.getAttribute("aria-current")).toBe("page");
    expect(mockSetBreadcrumbs).toHaveBeenCalledWith([{ label: "Ask" }]);
    // The existing conversation is reused; no bootstrap for an existing company.
    expect(mockBootstrap).not.toHaveBeenCalled();
  });

  it("redirects bare /cos to the selected company's prefixed route, keeping query and hash", async () => {
    companyState.companies = [{ id: "c-other", issuePrefix: "OTH", name: "Other" }, ACME];
    companyState.selectedCompany = ACME;
    mockCompanyInbox.mockResolvedValue({ id: "conv-1" });
    mockAgentsList.mockResolvedValue([{ id: "cos-1", name: "CoS", role: "chief_of_staff" }]);

    await renderAt("/cos?from=email#latest");

    expect(q("location")?.textContent).toBe("/ACME/cos?from=email#latest");
    expect(q("sidebar")).toBeTruthy();
    expect(q("cos-conversation")?.getAttribute("data-layout")).toBe("embedded");
  });

  it("falls back to the first company when none is selected", async () => {
    companyState.companies = [ACME];
    mockCompanyInbox.mockResolvedValue({ id: "conv-1" });
    mockAgentsList.mockResolvedValue([{ id: "cos-1", name: "CoS", role: "chief_of_staff" }]);

    await renderAt("/cos");

    expect(q("location")?.textContent).toBe("/ACME/cos");
  });

  it("waits for the company list before deciding where /cos goes", async () => {
    companyState.loading = true;

    await renderAt("/cos");

    expect(q("location")?.textContent).toBe("/cos");
    expect(container.textContent).toContain("Setting up your workspace");
    expect(mockBootstrap).not.toHaveBeenCalled();
  });

  it("keeps the founder's first /cos session full-screen and bootstraps when no company exists", async () => {
    mockBootstrap.mockResolvedValue({ companyId: "c-new", cosAgentId: "cos-new", conversationId: "conv-new" });
    mockAgentsList.mockReturnValue([]);

    await renderAt("/cos");

    expect(q("location")?.textContent).toBe("/cos");
    expect(q("sidebar")).toBeNull();
    expect(mockBootstrap).toHaveBeenCalledTimes(1);
    const conversation = q("cos-conversation");
    expect(conversation?.getAttribute("data-layout")).toBe("fullscreen");
    expect(conversation?.className).toContain("fixed inset-0");
    expect(q("chat-panel")).toBeTruthy();
  });

  it("App.tsx mounts Ask under the :companyPrefix Layout and bare /cos as the redirecting entry", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const appSource = fs.readFileSync(path.resolve(import.meta.dirname, "../App.tsx"), "utf8");

    const board = appSource.match(/function boardRoutes\(\)[\s\S]*?\n\}/);
    expect(board?.[0]).toContain('<Route path="cos" element={<CoSAskPage />} />');
    expect(appSource).toContain('<Route path=":companyPrefix" element={<Layout />}>');
    expect(appSource).toContain('<Route path="cos" element={<CoSEntryRoute />} />');
    // The full-screen conversation is never mounted directly at the top level.
    expect(appSource).not.toMatch(/path="cos" element=\{<CoSConversation/);
  });
});
