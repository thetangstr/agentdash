// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
const PROJECT_ID = "11111111-2222-4333-8444-555555555555";
vi.mock("../components/MarkdownEditor", () => ({ MarkdownEditor: () => null }));
vi.mock("../components/MarkdownBody", () => ({ MarkdownBody: ({ children }: { children?: ReactNode }) => <>{children}</> }));
vi.mock("../api/client", async original => {
  const actual = await original<typeof import("../api/client")>();
  return { ...actual, api: {
    get: vi.fn(async (path: string) => {
      if (path.includes("budgets/overview")) throw new actual.ApiError("Spend is restricted", 403, { error: "forbidden" });
      if (path.startsWith(`/projects/${PROJECT_ID}`)) return { id: PROJECT_ID, companyId: "company-1", name: "Synthetic project", status: "in_progress", workspaces: [], pauseReason: "budget", pausedAt: new Date().toISOString() };
      return [];
    }), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn(),
  } };
});
vi.mock("@/lib/router", async original => ({
  ...(await original<typeof import("@/lib/router")>()),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(), useParams: () => ({ companyPrefix: "acm", projectId: PROJECT_ID }),
  useLocation: () => ({ pathname: `/projects/${PROJECT_ID}/budget`, search: "" }), Navigate: () => null,
}));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ companies: [{ id: "company-1", issuePrefix: "ACM", name: "Acme" }], selectedCompanyId: "company-1", setSelectedCompanyId: vi.fn() }) }));
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("../context/PanelContext", () => ({ usePanel: () => ({ closePanel: vi.fn() }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
// Editing project direction and reading company spend are separate capabilities.
vi.mock("../hooks/useCapability", () => ({ useCapability: () => ({ allowed: true, isLoading: false }) }));
vi.mock("@/plugins/slots", () => ({ usePluginSlots: () => ({ slots: [], isLoading: false }), PluginSlotMount: () => null, PluginSlotOutlet: () => null }));
vi.mock("@/plugins/launchers", () => ({ PluginLauncherOutlet: () => null }));
const { ProjectDetail } = await import("./ProjectDetail");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let client: QueryClient;
afterEach(() => { if (root) act(() => root.unmount()); client?.clear(); container?.remove(); });
it("keeps the project budget-stop signal but no zero-filled editor when overview returns 403", async () => {
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { root.render(<QueryClientProvider client={client}><ProjectDetail /></QueryClientProvider>); });
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(container.textContent).toContain("Budget details are unavailable");
  expect(container.textContent).toContain("Ask a workspace administrator");
  expect(container.textContent).toContain("Paused by budget hard stop");
  expect(container.querySelector('input[type="number"]')).toBeNull();
  expect(container.textContent).not.toContain("$0.00");
});
