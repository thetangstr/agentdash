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

  it("hides it on a hosted MK company", async () => {
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
      expect(container.textContent).not.toContain("New agent (advanced)");
    });
    expect(container.querySelector('a[href="/agents/new"]')).toBeNull();
    act(() => root.unmount());
  });
});
