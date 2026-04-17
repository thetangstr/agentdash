// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CrmDeal, CrmActivity, CrmAccount, CrmContact } from "../../api/crm";

const getDealMock = vi.fn<(companyId: string, id: string) => Promise<CrmDeal>>();
const updateDealMock = vi.fn<(companyId: string, id: string, body: Partial<CrmDeal>) => Promise<CrmDeal>>();
const listActivitiesMock = vi.fn<
  (companyId: string, opts?: { dealId?: string }) => Promise<CrmActivity[]>
>();
const getAccountMock = vi.fn<(companyId: string, id: string) => Promise<CrmAccount>>();
const getContactMock = vi.fn<(companyId: string, id: string) => Promise<CrmContact>>();

const setBreadcrumbsMock = vi.fn();
const pushToastMock = vi.fn();
const navigateMock = vi.fn();

vi.mock("../../api/crm", () => ({
  crmApi: {
    getDeal: (companyId: string, id: string) => getDealMock(companyId, id),
    updateDeal: (companyId: string, id: string, body: Partial<CrmDeal>) =>
      updateDealMock(companyId, id, body),
    listActivities: (companyId: string, opts?: { dealId?: string }) =>
      listActivitiesMock(companyId, opts),
    getAccount: (companyId: string, id: string) => getAccountMock(companyId, id),
    getContact: (companyId: string, id: string) => getContactMock(companyId, id),
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
  return {
    ...actual,
    useNavigate: () => navigateMock,
    useParams: () => ({ dealId: "deal-1" }),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeDeal(overrides: Partial<CrmDeal> = {}): CrmDeal {
  return {
    id: "deal-1",
    companyId: "company-1",
    accountId: "acct-1",
    contactId: "contact-1",
    name: "Acme renewal",
    stage: "qualified",
    amount: null,
    amountCents: "1250000",
    currency: "USD",
    closeDate: "2026-06-30",
    probability: null,
    ownerAgentId: null,
    ownerUserId: "user-1",
    linkedProjectId: null,
    linkedIssueId: null,
    externalId: null,
    externalSource: null,
    metadata: null,
    lastSyncedAt: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z").toISOString(),
    updatedAt: new Date("2026-04-15T00:00:00.000Z").toISOString(),
    ...overrides,
  };
}

function makeActivity(overrides: Partial<CrmActivity> = {}): CrmActivity {
  return {
    id: "act-1",
    companyId: "company-1",
    accountId: null,
    contactId: null,
    dealId: "deal-1",
    activityType: "email",
    subject: "Follow-up on proposal",
    body: "Sent a follow-up email",
    performedByAgentId: null,
    performedByUserId: "user-1",
    externalId: null,
    externalSource: null,
    occurredAt: new Date("2026-04-10T00:00:00.000Z").toISOString(),
    metadata: null,
    createdAt: new Date("2026-04-10T00:00:00.000Z").toISOString(),
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

describe("CrmDealDetail page", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    getDealMock.mockReset();
    updateDealMock.mockReset();
    listActivitiesMock.mockReset();
    getAccountMock.mockReset();
    getContactMock.mockReset();
    setBreadcrumbsMock.mockReset();
    pushToastMock.mockReset();
    navigateMock.mockReset();

    listActivitiesMock.mockResolvedValue([]);
    getAccountMock.mockRejectedValue(new Error("not called"));
    getContactMock.mockRejectedValue(new Error("not called"));
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders deal header with name, amount, and stage", async () => {
    getDealMock.mockResolvedValue(makeDeal());

    const { CrmDealDetail } = await import("../CrmDealDetail");
    const root = renderPage(container, CrmDealDetail);
    await act(async () => {
      await flush();
    });

    expect(getDealMock).toHaveBeenCalledWith("company-1", "deal-1");
    expect(container.textContent).toContain("Acme renewal");
    // $12,500 formatted from 1,250,000 cents
    expect(container.textContent).toMatch(/\$12,500/);
    expect(container.textContent?.toLowerCase()).toContain("qualified");

    act(() => {
      root.unmount();
    });
  });

  it("editing stage calls updateDeal with the new stage", async () => {
    getDealMock.mockResolvedValue(makeDeal({ stage: "qualified" }));
    updateDealMock.mockResolvedValue(makeDeal({ stage: "proposal" }));

    const { CrmDealDetail } = await import("../CrmDealDetail");
    const root = renderPage(container, CrmDealDetail);
    await act(async () => {
      await flush();
    });

    const stageSelect = container.querySelector<HTMLSelectElement>(
      'select[data-testid="deal-stage-select"]',
    );
    expect(stageSelect).toBeTruthy();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value",
      )!.set!;
      setter.call(stageSelect, "proposal");
      stageSelect!.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
    });

    expect(updateDealMock).toHaveBeenCalledWith(
      "company-1",
      "deal-1",
      expect.objectContaining({ stage: "proposal" }),
    );

    act(() => {
      root.unmount();
    });
  });

  it("renders activity timeline when activities load", async () => {
    getDealMock.mockResolvedValue(makeDeal());
    listActivitiesMock.mockResolvedValue([
      makeActivity({ id: "act-a", subject: "Discovery call", activityType: "call" }),
      makeActivity({ id: "act-b", subject: "Sent pricing email", activityType: "email" }),
    ]);

    const { CrmDealDetail } = await import("../CrmDealDetail");
    const root = renderPage(container, CrmDealDetail);
    await act(async () => {
      await flush();
    });

    expect(listActivitiesMock).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ dealId: "deal-1" }),
    );
    expect(container.textContent).toContain("Discovery call");
    expect(container.textContent).toContain("Sent pricing email");

    act(() => {
      root.unmount();
    });
  });
});
