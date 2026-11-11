// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * Export and import are owner/admin only on the server. A member who follows
 * a direct link to either page sees the plain rule, and the export page does
 * not request a preview on their behalf (it would only 403).
 */

const mockCapabilitiesApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../api/capabilities", () => ({ capabilitiesApi: mockCapabilitiesApi }));

const mockCompaniesApi = vi.hoisted(() => ({
  exportPreview: vi.fn(),
  exportBundle: vi.fn(),
  importPreview: vi.fn(),
  importBundle: vi.fn(),
}));
vi.mock("../api/companies", () => ({ companiesApi: mockCompaniesApi }));
vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("../api/projects", () => ({ projectsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("../api/auth", () => ({
  authApi: { getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" }, session: { userId: "user-1" } }) },
}));
vi.mock("../api/sidebarPreferences", () => ({ sidebarPreferencesApi: {} }));
// These pull in the markdown editor, whose sandpack styles jsdom's CSS parser
// rejects at import; the tests are about the permission gate, not rendering.
vi.mock("../components/MarkdownBody", () => ({ MarkdownBody: () => null }));
vi.mock("../components/AgentConfigForm", () => ({ AgentConfigForm: () => null }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", name: "Meridian", issuePrefix: "MER", status: "active" }],
    selectedCompany: { id: "company-1", name: "Meridian", issuePrefix: "MER", status: "active" },
    selectedCompanyId: "company-1",
    setSelectedCompanyId: vi.fn(),
  }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("@/lib/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/router")>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useLocation: () => ({ pathname: "/MER/company/export", search: "", hash: "", state: null, key: "k" }),
  };
});

const { CompanyExport } = await import("./CompanyExport");
const { CompanyImport } = await import("./CompanyImport");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  mockCompaniesApi.exportPreview.mockReturnValue(new Promise(() => {}));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function capabilities(manage: boolean) {
  mockCapabilitiesApi.get.mockResolvedValue({
    companyId: "company-1",
    actorType: "board",
    membershipRole: manage ? "owner" : "member",
    isInstanceAdmin: false,
    capabilities: { "company:manage": manage },
  });
}

async function render(element: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <TooltipProvider>{element}</TooltipProvider>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 15; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe("CompanyExport", () => {
  it("shows a member the plain rule and never asks for a preview", async () => {
    capabilities(false);
    await render(<CompanyExport />);
    expect(container.textContent).toContain("Only owners and admins can export this company.");
    expect(mockCompaniesApi.exportPreview).not.toHaveBeenCalled();
  });

  it("asks for the preview for an owner or admin", async () => {
    capabilities(true);
    await render(<CompanyExport />);
    expect(container.textContent).not.toContain("Only owners and admins can export this company.");
    expect(mockCompaniesApi.exportPreview).toHaveBeenCalledWith("company-1", expect.anything());
  });

  it("asks for nothing while the answer is loading", async () => {
    mockCapabilitiesApi.get.mockReturnValue(new Promise(() => {}));
    await render(<CompanyExport />);
    expect(container.textContent).not.toContain("Only owners and admins can export this company.");
    expect(mockCompaniesApi.exportPreview).not.toHaveBeenCalled();
  });
});

describe("CompanyImport", () => {
  it("shows a member the plain rule instead of the import form", async () => {
    capabilities(false);
    await render(<CompanyImport />);
    expect(container.textContent).toContain("Only owners and admins can import into this company.");
    expect(mockCompaniesApi.importPreview).not.toHaveBeenCalled();
  });

  it("shows an owner or admin the import form", async () => {
    capabilities(true);
    await render(<CompanyImport />);
    expect(container.textContent).not.toContain("Only owners and admins can import into this company.");
  });
});
