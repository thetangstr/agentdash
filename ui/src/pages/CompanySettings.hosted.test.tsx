// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySettings } from "./CompanySettings";
import { TooltipProvider } from "@/components/ui/tooltip";

const mockHealthApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

const mockCompaniesApi = vi.hoisted(() => ({
  update: vi.fn(),
  archive: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  createOpenClawInvitePrompt: vi.fn(),
  getInviteOnboarding: vi.fn(),
}));

const mockAssetsApi = vi.hoisted(() => ({
  uploadCompanyLogo: vi.fn(),
}));

vi.mock("../api/health", () => ({
  healthApi: mockHealthApi,
}));

vi.mock("../api/companies", () => ({
  companiesApi: mockCompaniesApi,
}));

vi.mock("../api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("../api/assets", () => ({
  assetsApi: mockAssetsApi,
}));

const companyState = vi.hoisted(() => ({
  selectedCompany: {
    id: "company-1",
    name: "Meridian",
    description: null,
    brandColor: null,
    logoUrl: null,
    issuePrefix: "MER",
    status: "active",
  } as {
    id: string;
    name: string;
    description: null;
    brandColor: null;
    logoUrl: null;
    issuePrefix: string;
    status: string;
    productProfile?: string;
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", name: "Meridian", issuePrefix: "MER", status: "active" }],
    selectedCompany: companyState.selectedCompany,
    selectedCompanyId: "company-1",
    setSelectedCompanyId: vi.fn(),
  }),
}));

const reconciliation = vi.hoisted(() => ({ count: 0 }));

vi.mock("@/components/settings/NeedsReconciliationPanel", () => ({
  NeedsReconciliationPanel: () => <section data-testid="reconciliation-panel">Needs reconciliation</section>,
  useNeedsReconciliationCount: () => reconciliation.count,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/lib/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/router")>();
  return {
    ...actual,
    Link: ({ to, children, ...props }: { to: string; children?: ReactNode }) => (
      <a href={to} {...props}>{children}</a>
    ),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function render(container: HTMLDivElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <CompanySettings />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  return { root };
}

describe("CompanySettings Advanced section", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useRealTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    mockHealthApi.get.mockResolvedValue({ status: "ok", hostedBox: true });
    companyState.selectedCompany = {
      id: "company-1",
      name: "Meridian",
      description: null,
      brandColor: null,
      logoUrl: null,
      issuePrefix: "MER",
      status: "active",
    };
  });

  afterEach(() => {
    document.body.removeChild(container);
    vi.clearAllMocks();
  });

  it("links the advanced agent form from Settings on a hosted box", async () => {
    const { root } = render(container);
    await waitForAssertion(() => {
      expect(container.textContent).toContain("New agent (advanced)");
    });
    const link = container.querySelector('a[href="/agents/new"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain("New agent (advanced)");
    act(() => root.unmount());
  });

  it("hides it off hosted boxes", async () => {
    mockHealthApi.get.mockResolvedValue({ status: "ok", hostedBox: false });
    const { root } = render(container);
    await flush();
    await flush();
    expect(container.textContent).not.toContain("New agent (advanced)");
    expect(container.querySelector('a[href="/agents/new"]')).toBeNull();
    act(() => root.unmount());
  });

  it("shows it on a hosted MK company too (one UX)", async () => {
    companyState.selectedCompany = {
      id: "company-1",
      name: "MK Think",
      description: null,
      brandColor: null,
      logoUrl: null,
      issuePrefix: "MKT",
      status: "active",
      productProfile: "agentdash_mk",
    };
    const { root } = render(container);
    await waitForAssertion(() => {
      expect(container.textContent).toContain("New agent (advanced)");
    });
    act(() => root.unmount());
  });
});

// Review of #991: reconciliation stays under the collapsed Advanced section
// only while nothing waits for a verdict.
describe("CompanySettings reconciliation placement", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockHealthApi.get.mockResolvedValue({ status: "ok", hostedBox: false });
  });

  afterEach(() => {
    document.body.removeChild(container);
    reconciliation.count = 0;
    vi.clearAllMocks();
  });

  it("keeps an empty reconciliation panel inside the collapsed Advanced section", async () => {
    reconciliation.count = 0;
    const { root } = render(container);
    await flush();
    const panel = container.querySelector('[data-testid="reconciliation-panel"]');
    expect(panel).not.toBeNull();
    expect(panel!.closest('[data-testid="company-settings-advanced"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="company-settings-reconciliation-attention"]')).toBeNull();
    act(() => root.unmount());
  });

  it("lifts the panel into the main page when sends wait for a verdict", async () => {
    reconciliation.count = 2;
    const { root } = render(container);
    await flush();
    const panels = container.querySelectorAll('[data-testid="reconciliation-panel"]');
    expect(panels).toHaveLength(1);
    expect(panels[0]!.closest('[data-testid="company-settings-advanced"]')).toBeNull();
    expect(panels[0]!.closest('[data-testid="company-settings-reconciliation-attention"]')).not.toBeNull();
    act(() => root.unmount());
  });
});
