// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockStewardshipsApi = vi.hoisted(() => ({
  getMyAgent: vi.fn(),
  getMyInbox: vi.fn(),
  listMyChannels: vi.fn(),
  startTelegramPairing: vi.fn(),
}));

const mockGovernanceApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockActivityApi = vi.hoisted(() => ({ list: vi.fn() }));

const mockCompany = vi.hoisted(() => ({
  value: { selectedCompanyId: "company-1", selectedCompany: { productProfile: "agentdash_mk" } },
}));

vi.mock("react-router-dom", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock("../api/stewardships", () => ({ stewardshipsApi: mockStewardshipsApi }));
vi.mock("../api/agent-governance", () => ({ agentGovernanceApi: mockGovernanceApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../api/activity", () => ({ activityApi: mockActivityApi }));
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
    mockStewardshipsApi.listMyChannels.mockResolvedValue({ bindings: [] });
    mockStewardshipsApi.startTelegramPairing.mockResolvedValue({
      deepLink: "https://t.me/agentdash_test_bot?start=tok",
      expiresAt: "2026-07-30T12:00:00.000Z",
    });
    mockIssuesApi.list.mockResolvedValue([]);
    mockActivityApi.list.mockResolvedValue([]);
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

  it("shows what the agent is currently working on and what it recently did", async () => {
    mockStewardshipsApi.getMyAgent.mockResolvedValue({
      stewardship: { id: "s-1" },
      agent: { id: "agent-1", name: "Marketing Agent", role: "marketing", status: "idle" },
    });
    mockIssuesApi.list.mockResolvedValue([
      { id: "issue-1", identifier: "MK-12", title: "Draft the deck", status: "in_progress" },
    ]);
    mockActivityApi.list.mockResolvedValue([{ id: "act-1", action: "agent.run_started" }]);

    await render();

    expect(container.textContent).toContain("Current work");
    expect(container.textContent).toContain("MK-12");
    expect(container.textContent).toContain("Draft the deck");
    expect(container.textContent).toContain("Recent activity");
    expect(container.textContent).toContain("agent run started");
    // Scoped to this agent, never the whole company.
    expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", { assigneeAgentId: "agent-1" });
    expect(mockActivityApi.list).toHaveBeenCalledWith("company-1", {
      agentId: "agent-1",
      limit: 10,
    });
  });

  it("offers a telegram pairing link and never mints one until asked", async () => {
    mockStewardshipsApi.getMyAgent.mockResolvedValue({
      stewardship: { id: "s-1" },
      agent: { id: "agent-1", name: "Marketing Agent", role: "marketing", status: "idle" },
    });

    await render();

    expect(container.textContent).toContain("Telegram");
    // Minting spends the user's one outstanding challenge and invalidates any
    // link they already opened. It must be an explicit act, never a page load.
    expect(mockStewardshipsApi.startTelegramPairing).not.toHaveBeenCalled();

    const connect = Array.from(container.querySelectorAll("button")).find((button) =>
      /connect telegram/i.test(button.textContent ?? ""),
    );
    expect(connect, "no Connect Telegram control was rendered").toBeTruthy();

    await act(async () => {
      connect!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    expect(mockStewardshipsApi.startTelegramPairing).toHaveBeenCalledWith("company-1");
    const link = Array.from(container.querySelectorAll("a")).find((anchor) =>
      anchor.getAttribute("href")?.startsWith("https://t.me/"),
    );
    expect(link, "the minted deep link was not shown to the user").toBeTruthy();
  });

  it("shows an already-connected channel instead of offering to pair again", async () => {
    mockStewardshipsApi.getMyAgent.mockResolvedValue({
      stewardship: { id: "s-1" },
      agent: { id: "agent-1", name: "Marketing Agent", role: "marketing", status: "idle" },
    });
    mockStewardshipsApi.listMyChannels.mockResolvedValue({
      bindings: [
        {
          id: "binding-1",
          provider: "telegram",
          externalUserId: "1",
          verifiedAt: "2026-07-29T00:00:00.000Z",
          revokedAt: null,
        },
      ],
    });

    await render();

    expect(container.textContent).toContain("Connected");
    const connect = Array.from(container.querySelectorAll("button")).find((button) =>
      /connect telegram/i.test(button.textContent ?? ""),
    );
    expect(connect, "offered to pair a channel that is already connected").toBeFalsy();
  });

  it("surfaces a pairing refusal instead of failing silently", async () => {
    mockStewardshipsApi.getMyAgent.mockResolvedValue({
      stewardship: { id: "s-1" },
      agent: { id: "agent-1", name: "Marketing Agent", role: "marketing", status: "idle" },
    });
    mockStewardshipsApi.startTelegramPairing.mockRejectedValue(
      new Error("Telegram pairing is not configured: TELEGRAM_BOT_USERNAME is unset"),
    );

    await render();
    const connect = Array.from(container.querySelectorAll("button")).find((button) =>
      /connect telegram/i.test(button.textContent ?? ""),
    )!;
    await act(async () => {
      connect.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    // The owner ceiling and the missing-config case both surface here. A button
    // that quietly does nothing reads as a broken page.
    expect(container.textContent).toContain("TELEGRAM_BOT_USERNAME");
  });
});
