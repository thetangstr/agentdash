// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CrmDeal } from "../../api/crm";

const listDealsMock = vi.fn<(companyId: string) => Promise<CrmDeal[]>>();
const updateDealMock =
  vi.fn<(companyId: string, id: string, patch: Partial<CrmDeal>) => Promise<CrmDeal>>();
const setBreadcrumbsMock = vi.fn();
const pushToastMock = vi.fn();
const navigateMock = vi.fn();

vi.mock("../../api/crm", () => ({
  crmApi: {
    listDeals: (companyId: string) => listDealsMock(companyId),
    updateDeal: (companyId: string, id: string, patch: Partial<CrmDeal>) =>
      updateDealMock(companyId, id, patch),
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

function makeDeal(overrides: Partial<CrmDeal> = {}): CrmDeal {
  return {
    id: "deal-1",
    companyId: "company-1",
    accountId: null,
    contactId: null,
    name: "Acme renewal",
    stage: "prospect",
    amount: null,
    amountCents: "1000000",
    currency: "USD",
    closeDate: null,
    probability: null,
    ownerAgentId: null,
    ownerUserId: null,
    linkedProjectId: null,
    linkedIssueId: null,
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

describe("CrmKanban page", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    listDealsMock.mockReset();
    updateDealMock.mockReset();
    setBreadcrumbsMock.mockReset();
    pushToastMock.mockReset();
    navigateMock.mockReset();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders a column for each pipeline stage with the correct deals", async () => {
    listDealsMock.mockResolvedValue([
      makeDeal({ id: "deal-a", name: "Acme renewal", stage: "prospect", amountCents: "1200000" }),
      makeDeal({ id: "deal-b", name: "Beta expansion", stage: "qualified", amountCents: "500000" }),
      makeDeal({ id: "deal-c", name: "Charlie upgrade", stage: "closed_won", amountCents: "9800000" }),
    ]);

    const { CrmKanban } = await import("../CrmKanban");
    const root = renderPage(container, CrmKanban);
    await act(async () => {
      await flush();
    });

    expect(listDealsMock).toHaveBeenCalledWith("company-1");

    // Heading
    expect(container.textContent).toContain("Pipeline Kanban");

    // All 6 canonical stages are rendered as columns
    for (const label of ["Prospect", "Qualified", "Proposal", "Negotiation", "Closed Won", "Closed Lost"]) {
      expect(container.textContent).toContain(label);
    }

    // Deals are rendered inside the column they belong to
    const prospectCol = container.querySelector('[data-testid="kanban-column-prospect"]');
    expect(prospectCol).toBeTruthy();
    expect(prospectCol!.textContent).toContain("Acme renewal");
    expect(prospectCol!.textContent).not.toContain("Beta expansion");

    const qualifiedCol = container.querySelector('[data-testid="kanban-column-qualified"]');
    expect(qualifiedCol!.textContent).toContain("Beta expansion");

    const wonCol = container.querySelector('[data-testid="kanban-column-closed_won"]');
    expect(wonCol!.textContent).toContain("Charlie upgrade");

    // Amount is formatted as currency (cents -> dollars)
    expect(container.textContent).toContain("$12,000");
    expect(container.textContent).toContain("$5,000");

    act(() => {
      root.unmount();
    });
  });

  it("clicking a deal card navigates to the deal detail page", async () => {
    listDealsMock.mockResolvedValue([
      makeDeal({ id: "deal-xyz", name: "Click Target", stage: "proposal" }),
    ]);

    const { CrmKanban } = await import("../CrmKanban");
    const root = renderPage(container, CrmKanban);
    await act(async () => {
      await flush();
    });

    const card = container.querySelector<HTMLElement>('[data-testid="kanban-card-deal-xyz"]');
    expect(card).toBeTruthy();

    await act(async () => {
      card!.click();
      await flush();
    });

    expect(navigateMock).toHaveBeenCalled();
    const navArg = navigateMock.mock.calls[0]?.[0];
    expect(typeof navArg).toBe("string");
    expect(String(navArg)).toContain("/crm/deals/deal-xyz");

    act(() => {
      root.unmount();
    });
  });

  it("drop handler calls updateDeal with the new stage and fires a success toast", async () => {
    listDealsMock.mockResolvedValue([
      makeDeal({ id: "deal-move", name: "Move me", stage: "prospect" }),
    ]);
    updateDealMock.mockResolvedValue(
      makeDeal({ id: "deal-move", name: "Move me", stage: "qualified" }),
    );

    const { handleDealDrop } = await import("../CrmKanban");

    await handleDealDrop({
      companyId: "company-1",
      dealId: "deal-move",
      toStage: "qualified",
      deals: [makeDeal({ id: "deal-move", stage: "prospect" })],
      updateDeal: updateDealMock,
      pushToast: pushToastMock,
      onLocalUpdate: vi.fn(),
    });

    expect(updateDealMock).toHaveBeenCalledWith("company-1", "deal-move", { stage: "qualified" });
    expect(pushToastMock).toHaveBeenCalled();
    const toastArg = pushToastMock.mock.calls[0]?.[0];
    expect(toastArg.tone).toBe("success");
    expect(toastArg.title.toLowerCase()).toContain("moved");
  });

  it("drop handler reverts optimistic update and shows an error toast on failure", async () => {
    updateDealMock.mockRejectedValue(new Error("API down"));

    const { handleDealDrop } = await import("../CrmKanban");

    const originalDeals = [makeDeal({ id: "deal-fail", stage: "prospect" })];
    const revert = vi.fn();

    await handleDealDrop({
      companyId: "company-1",
      dealId: "deal-fail",
      toStage: "qualified",
      deals: originalDeals,
      updateDeal: updateDealMock,
      pushToast: pushToastMock,
      onLocalUpdate: revert,
    });

    // Optimistic apply then revert on error = 2 onLocalUpdate calls.
    expect(revert).toHaveBeenCalledTimes(2);
    expect(pushToastMock).toHaveBeenCalled();
    const toastArg = pushToastMock.mock.calls.at(-1)?.[0];
    expect(toastArg.tone).toBe("error");
  });

  it("shows an empty-state message when no deals exist", async () => {
    listDealsMock.mockResolvedValue([]);

    const { CrmKanban } = await import("../CrmKanban");
    const root = renderPage(container, CrmKanban);
    await act(async () => {
      await flush();
    });

    expect(container.textContent).toContain("No deals yet");

    act(() => {
      root.unmount();
    });
  });
});
