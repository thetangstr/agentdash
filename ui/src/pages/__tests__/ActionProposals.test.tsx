// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionProposal } from "../../api/action-proposals";

const listMock = vi.fn<(companyId: string, status?: string) => Promise<ActionProposal[]>>();
const approveMock = vi.fn<(companyId: string, id: string, note?: string) => Promise<ActionProposal>>();
const rejectMock = vi.fn<(companyId: string, id: string, note?: string) => Promise<ActionProposal>>();
const setBreadcrumbsMock = vi.fn();
const pushToastMock = vi.fn();

vi.mock("../../api/action-proposals", () => ({
  actionProposalsApi: {
    list: (companyId: string, status?: string) => listMock(companyId, status),
    approve: (companyId: string, id: string, note?: string) => approveMock(companyId, id, note),
    reject: (companyId: string, id: string, note?: string) => rejectMock(companyId, id, note),
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
  return { ...actual };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeProposal(overrides: Partial<ActionProposal> = {}): ActionProposal {
  return {
    id: "proposal-1",
    type: "send_email",
    status: "pending",
    payload: { title: "Outreach to Acme" },
    requestedByAgent: { id: "agent-1", name: "Sales Agent" },
    linkedIssues: [{ id: "issue-1", title: "Acme deal" }],
    decisionNote: null,
    createdAt: new Date("2026-04-15T00:00:00.000Z").toISOString(),
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

describe("ActionProposals page", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    listMock.mockReset();
    approveMock.mockReset();
    rejectMock.mockReset();
    setBreadcrumbsMock.mockReset();
    pushToastMock.mockReset();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders pending proposals with Approve/Reject buttons", async () => {
    listMock.mockResolvedValue([
      makeProposal({ id: "p-1", payload: { title: "Proposal A" } }),
      makeProposal({ id: "p-2", payload: { title: "Proposal B" } }),
    ]);

    const { ActionProposals } = await import("../ActionProposals");
    const root = renderPage(container, ActionProposals);
    await act(async () => {
      await flush();
    });

    expect(listMock).toHaveBeenCalledWith("company-1", "pending");
    expect(container.textContent).toContain("Action Proposals");
    expect(container.textContent).toContain("Proposal A");
    expect(container.textContent).toContain("Proposal B");
    expect(container.textContent).toContain("Acme deal");

    const approveButtons = Array.from(container.querySelectorAll("button")).filter(
      (b) => b.textContent?.includes("Approve"),
    );
    const rejectButtons = Array.from(container.querySelectorAll("button")).filter(
      (b) => b.textContent?.includes("Reject"),
    );
    expect(approveButtons).toHaveLength(2);
    expect(rejectButtons).toHaveLength(2);

    act(() => {
      root.unmount();
    });
  });

  it("approve click triggers mutation to the correct URL", async () => {
    listMock.mockResolvedValue([makeProposal({ id: "p-xyz" })]);
    approveMock.mockResolvedValue(makeProposal({ id: "p-xyz", status: "approved" }));

    const { ActionProposals } = await import("../ActionProposals");
    const root = renderPage(container, ActionProposals);
    await act(async () => {
      await flush();
    });

    const approveBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Approve"),
    );
    expect(approveBtn).toBeDefined();

    await act(async () => {
      approveBtn!.click();
      await flush();
    });

    expect(approveMock).toHaveBeenCalledWith("company-1", "p-xyz", undefined);

    act(() => {
      root.unmount();
    });
  });

  it('shows "No proposals awaiting your review" when list is empty', async () => {
    listMock.mockResolvedValue([]);

    const { ActionProposals } = await import("../ActionProposals");
    const root = renderPage(container, ActionProposals);
    await act(async () => {
      await flush();
    });

    expect(container.textContent).toContain("No proposals awaiting your review");

    act(() => {
      root.unmount();
    });
  });
});
