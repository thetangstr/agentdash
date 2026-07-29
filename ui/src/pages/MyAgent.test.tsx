// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockStewardshipsApi = vi.hoisted(() => ({
  getMyAgent: vi.fn(),
  getMyInbox: vi.fn(),
}));

const mockGovernanceApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

const mockCompany = vi.hoisted(() => ({
  value: { selectedCompanyId: "company-1", selectedCompany: { productProfile: "agentdash_mk" } },
}));

vi.mock("react-router-dom", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock("../api/stewardships", () => ({ stewardshipsApi: mockStewardshipsApi }));
vi.mock("../api/agent-governance", () => ({ agentGovernanceApi: mockGovernanceApi }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => mockCompany.value }));

const { default: MyAgent } = await import("./MyAgent");

const UNRESTRICTED = {
  permissions: ["*"],
  monthlyBudgetCents: 2_147_483_647,
  destructiveActions: "approval_required" as const,
  dataScopes: ["*"],
  providers: ["*"],
  minimumApproval: "steward" as const,
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MyAgent />
      </QueryClientProvider>,
    );
  });
  // Let the dependent query chain settle: myAgent resolves, which enables the
  // governance query keyed on the agent id.
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("MyAgent", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    mockCompany.value = {
      selectedCompanyId: "company-1",
      selectedCompany: { productProfile: "agentdash_mk" },
    };
    mockStewardshipsApi.getMyInbox.mockResolvedValue({ stewardedAgent: null, items: [] });
    mockGovernanceApi.get.mockResolvedValue({
      policy: {
        id: "policy-1",
        companyId: "company-1",
        agentId: "agent-1",
        ownerCeiling: { ...UNRESTRICTED, monthlyBudgetCents: 10_000 },
        stewardRequest: UNRESTRICTED,
        effectivePolicy: { ...UNRESTRICTED, monthlyBudgetCents: 10_000 },
        revision: 2,
        ownerCeilingUpdatedByUserId: null,
        stewardRequestUpdatedByUserId: null,
        createdAt: null,
        updatedAt: null,
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows the authenticated member's stewarded agent", async () => {
    mockStewardshipsApi.getMyAgent.mockResolvedValue({
      stewardship: { id: "s-1" },
      agent: { id: "agent-1", name: "Marketing Agent", role: "marketing", status: "idle" },
    });

    await render();

    expect(container.textContent).toContain("My Agent");
    expect(container.textContent).toContain("Marketing Agent");
    // The server derives identity from the session; the page must never pass one.
    expect(mockStewardshipsApi.getMyAgent).toHaveBeenCalledWith("company-1");
  });

  it("shows an explicit unassigned state without offering self-assignment", async () => {
    mockStewardshipsApi.getMyAgent.mockResolvedValue({ stewardship: null, agent: null });

    await render();

    expect(container.textContent).toContain("No agent assigned");
    expect(container.textContent).toContain("owner or administrator");
    expect(container.querySelector("button")).toBeNull();
  });

  it("explains the owner ceiling beside the effective authority", async () => {
    mockStewardshipsApi.getMyAgent.mockResolvedValue({
      stewardship: { id: "s-1" },
      agent: { id: "agent-1", name: "Marketing Agent", role: "marketing", status: "idle" },
    });

    await render();

    expect(container.textContent).toContain("Owner ceiling");
    expect(container.textContent).toContain("In force");
    // Budget is capped below what the steward asked for, and says so.
    expect(container.textContent).toContain("$100.00/mo");
    expect(container.textContent).toContain("capped");
    // The unlimited sentinel must never be rendered as a real number.
    expect(container.textContent).not.toContain("2147483647");
  });

  it("lists approvals awaiting the steward with the revision to decide against", async () => {
    mockStewardshipsApi.getMyAgent.mockResolvedValue({
      stewardship: { id: "s-1" },
      agent: { id: "agent-1", name: "Marketing Agent", role: "marketing", status: "idle" },
    });
    mockStewardshipsApi.getMyInbox.mockResolvedValue({
      stewardedAgent: { id: "agent-1", name: "Marketing Agent", role: "marketing", status: "idle" },
      items: [
        {
          approvalId: "approval-1",
          type: "request_board_approval",
          status: "pending",
          revision: 3,
          payload: {},
          createdAt: new Date().toISOString(),
          decidedAt: null,
          decisionChannel: null,
          decisionActorRole: null,
          requestingAgent: { id: "agent-1", name: "Marketing Agent", role: "marketing" },
          requiresOverride: false,
        },
      ],
    });

    await render();

    expect(container.textContent).toContain("Awaiting your decision");
    expect(container.textContent).toContain("revision 3");
    expect(container.querySelector('a[href="/approvals/approval-1"]')).not.toBeNull();
  });

  it("does not query profile-only routes for a default-profile company", async () => {
    mockCompany.value = {
      selectedCompanyId: "company-1",
      selectedCompany: { productProfile: "default" },
    };

    await render();

    expect(mockStewardshipsApi.getMyAgent).not.toHaveBeenCalled();
    expect(container.textContent).toContain("does not use the AgentDash-MK profile");
  });
});
