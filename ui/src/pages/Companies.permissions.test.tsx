// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Renaming and deleting a company are owner/admin acts; the server refuses
 * everyone else. The list asks `company:manage` per company and offers the
 * rename button and the actions menu only where the answer is yes.
 */

const mockCapabilitiesApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../api/capabilities", () => ({ capabilitiesApi: mockCapabilitiesApi }));

vi.mock("../api/health", () => ({ healthApi: { get: vi.fn().mockResolvedValue({ status: "ok" }) } }));

const mockCompaniesApi = vi.hoisted(() => ({ stats: vi.fn(), update: vi.fn(), remove: vi.fn() }));
vi.mock("../api/companies", () => ({ companiesApi: mockCompaniesApi }));

const COMPANIES = [
  { id: "company-admin", name: "Run By Me", description: null, status: "active", createdAt: new Date().toISOString() },
  { id: "company-member", name: "Just Helping", description: null, status: "active", createdAt: new Date().toISOString() },
];

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: COMPANIES,
    selectedCompanyId: "company-admin",
    setSelectedCompanyId: vi.fn(),
    loading: false,
    error: null,
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/lib/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/router")>();
  return { ...actual, useNavigate: () => vi.fn() };
});

const { Companies } = await import("./Companies");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  mockCompaniesApi.stats.mockResolvedValue({});
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Companies />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 15; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const has = (label: string) => container.querySelector(`[aria-label="${label}"]`) !== null;

describe("Companies list permissions", () => {
  it("offers rename and the actions menu only on the company the person administers", async () => {
    mockCapabilitiesApi.get.mockImplementation(async (companyId: string) => ({
      companyId,
      actorType: "board",
      membershipRole: companyId === "company-admin" ? "owner" : "member",
      isInstanceAdmin: false,
      capabilities: { "company:manage": companyId === "company-admin" },
    }));
    await render();

    expect(container.textContent).toContain("Run By Me");
    expect(container.textContent).toContain("Just Helping");
    expect(has("Rename Run By Me")).toBe(true);
    expect(has("Actions for Run By Me")).toBe(true);
    expect(has("Rename Just Helping")).toBe(false);
    expect(has("Actions for Just Helping")).toBe(false);
    expect(mockCapabilitiesApi.get).toHaveBeenCalledWith("company-admin");
    expect(mockCapabilitiesApi.get).toHaveBeenCalledWith("company-member");
  });

  it("offers neither while the answer is loading", async () => {
    mockCapabilitiesApi.get.mockReturnValue(new Promise(() => {}));
    await render();

    expect(has("Rename Run By Me")).toBe(false);
    expect(has("Actions for Run By Me")).toBe(false);
  });
});
