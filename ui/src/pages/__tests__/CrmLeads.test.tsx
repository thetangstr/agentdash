// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CrmLead } from "../../api/crm";

const listLeadsMock = vi.fn<(companyId: string) => Promise<CrmLead[]>>();
const createLeadMock = vi.fn<(companyId: string, body: Partial<CrmLead>) => Promise<CrmLead>>();
const updateLeadMock = vi.fn<(companyId: string, id: string, body: Partial<CrmLead>) => Promise<CrmLead>>();
const convertLeadMock = vi.fn<(companyId: string, id: string) => Promise<CrmLead>>();
const setBreadcrumbsMock = vi.fn();
const pushToastMock = vi.fn();
const navigateMock = vi.fn();

vi.mock("../../api/crm", () => ({
  crmApi: {
    listLeads: (companyId: string) => listLeadsMock(companyId),
    createLead: (companyId: string, body: Partial<CrmLead>) => createLeadMock(companyId, body),
    updateLead: (companyId: string, id: string, body: Partial<CrmLead>) => updateLeadMock(companyId, id, body),
    convertLead: (companyId: string, id: string) => convertLeadMock(companyId, id),
  },
}));

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("../../context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigateMock };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeLead(overrides: Partial<CrmLead> = {}): CrmLead {
  return {
    id: "lead-1",
    companyId: "company-1",
    firstName: "Jane",
    lastName: "Doe",
    email: "jane@example.com",
    phone: null,
    company: "Acme Corp",
    title: null,
    source: "web",
    status: "new",
    score: null,
    ownerAgentId: null,
    ownerUserId: null,
    convertedAccountId: null,
    convertedContactId: null,
    convertedAt: null,
    externalId: null,
    externalSource: null,
    metadata: null,
    lastSyncedAt: null,
    createdAt: new Date("2026-04-15T00:00:00.000Z").toISOString(),
    updatedAt: new Date("2026-04-15T00:00:00.000Z").toISOString(),
    ...overrides,
  };
}

async function flush() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function renderPage(container: HTMLDivElement, Component: () => ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Component />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("CrmLeads page", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    listLeadsMock.mockReset();
    createLeadMock.mockReset();
    updateLeadMock.mockReset();
    convertLeadMock.mockReset();
    setBreadcrumbsMock.mockReset();
    pushToastMock.mockReset();
    navigateMock.mockReset();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders table rows when leads load", async () => {
    listLeadsMock.mockResolvedValue([
      makeLead({ id: "lead-a", firstName: "Alice", lastName: "Smith", email: "alice@a.com", company: "Alpha" }),
      makeLead({ id: "lead-b", firstName: "Bob", lastName: "Brown", email: "bob@b.com", company: "Beta" }),
    ]);

    const { CrmLeads } = await import("../CrmLeads");
    const root = renderPage(container, CrmLeads);
    await act(async () => {
      await flush();
    });

    expect(listLeadsMock).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("Leads");
    expect(container.textContent).toContain("Alice Smith");
    expect(container.textContent).toContain("alice@a.com");
    expect(container.textContent).toContain("Alpha");
    expect(container.textContent).toContain("Bob Brown");
    expect(container.textContent).toContain("Beta");

    act(() => {
      root.unmount();
    });
  });

  it("filters leads by search term", async () => {
    listLeadsMock.mockResolvedValue([
      makeLead({ id: "lead-a", firstName: "Alice", lastName: "Smith", email: "alice@a.com", company: "Alpha" }),
      makeLead({ id: "lead-b", firstName: "Bob", lastName: "Brown", email: "bob@b.com", company: "Beta" }),
    ]);

    const { CrmLeads } = await import("../CrmLeads");
    const root = renderPage(container, CrmLeads);
    await act(async () => {
      await flush();
    });

    const search = container.querySelector<HTMLInputElement>('input[data-testid="leads-search"]');
    expect(search).toBeDefined();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(search, "alice");
      search!.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });

    expect(container.textContent).toContain("Alice Smith");
    expect(container.textContent).not.toContain("Bob Brown");

    act(() => {
      root.unmount();
    });
  });

  it("clicking Convert calls convertLead and navigates to the returned deal", async () => {
    listLeadsMock.mockResolvedValue([
      makeLead({ id: "lead-xyz", firstName: "Xavier", lastName: "Yates" }),
    ]);
    convertLeadMock.mockResolvedValue(
      makeLead({ id: "lead-xyz", status: "converted", convertedAccountId: "acct-42" }),
    );

    const { CrmLeads } = await import("../CrmLeads");
    const root = renderPage(container, CrmLeads);
    await act(async () => {
      await flush();
    });

    const convertBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Convert"),
    );
    expect(convertBtn).toBeDefined();

    await act(async () => {
      convertBtn!.click();
      await flush();
    });

    expect(convertLeadMock).toHaveBeenCalledWith("company-1", "lead-xyz");
    expect(navigateMock).toHaveBeenCalled();
    const navArg = navigateMock.mock.calls[0]?.[0];
    expect(typeof navArg).toBe("string");
    expect(String(navArg)).toContain("/crm/");

    act(() => {
      root.unmount();
    });
  });
});
