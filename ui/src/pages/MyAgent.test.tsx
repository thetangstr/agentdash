// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockStewardshipsApi = vi.hoisted(() => ({
  getMyAgent: vi.fn(),
  getMyInbox: vi.fn(),
  myFactRequests: vi.fn(),
  answerFactRequest: vi.fn(),
}));

const mockHumanChannelsApi = vi.hoisted(() => ({
  listMine: vi.fn(),
  startPairing: vi.fn(),
  revoke: vi.fn(),
  listAll: vi.fn(),
}));

const mockGovernanceApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

const mockHubspotApi = vi.hoisted(() => ({
  get: vi.fn(),
  connect: vi.fn(),
  recheck: vi.fn(),
  revoke: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockApprovalsApi = vi.hoisted(() => ({ approve: vi.fn(), reject: vi.fn() }));
const mockActivityApi = vi.hoisted(() => ({ list: vi.fn() }));

const mockCompany = vi.hoisted(() => ({
  value: { selectedCompanyId: "company-1", selectedCompany: { productProfile: "agentdash_mk" } },
}));

vi.mock("react-router-dom", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock("../api/stewardships", () => ({ stewardshipsApi: mockStewardshipsApi }));
vi.mock("../api/human-channels", () => ({ humanChannelsApi: mockHumanChannelsApi }));
vi.mock("../api/hubspot", () => ({ hubspotApi: mockHubspotApi }));
vi.mock("../api/agent-governance", () => ({ agentGovernanceApi: mockGovernanceApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../api/approvals", () => ({ approvalsApi: mockApprovalsApi }));
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
    mockHumanChannelsApi.listMine.mockResolvedValue({ bindings: [] });
    mockHubspotApi.get.mockResolvedValue({ connection: null });
    mockHumanChannelsApi.startPairing.mockResolvedValue({
      deepLink: "https://t.me/agentdash_test_bot?start=tok",
      expiresAt: "2026-07-30T12:00:00.000Z",
    });
    mockHumanChannelsApi.revoke.mockResolvedValue({ binding: { id: "binding-1", revokedAt: "2026-07-30T00:00:00.000Z" } });
    mockStewardshipsApi.myFactRequests.mockResolvedValue({ factRequests: [] });
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

    expect(container.textContent).toContain("Needs you");
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

    expect(container.textContent).toContain("What Marketing Agent is doing");
    expect(container.textContent).toContain("MK-12");
    expect(container.textContent).toContain("Draft the deck");
    expect(container.textContent).toContain("What just happened");
    expect(container.textContent).toContain("agent run started");
    // Scoped to this agent, never the whole company.
    expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", { assigneeAgentId: "agent-1" });
    expect(mockActivityApi.list).toHaveBeenCalledWith("company-1", {
      agentId: "agent-1",
      limit: 10,
    });
  });

  /**
   * Guards the page's heading, which an e2e test also relies on. The status
   * sentence is the loudest element, but making it the h1 left the page with no
   * heading naming it — breaking heading navigation and diverging from the four
   * guard states, which all render <h1>My Agent</h1>. Prominence belongs to the
   * stylesheet.
   */
  it("names the page in its heading, whatever the status sentence says", async () => {
    mockStewardshipsApi.getMyAgent.mockResolvedValue({
      stewardship: { id: "s-1", userId: "user-me" },
      agent: { id: "agent-1", name: "Casper", role: "marketing", status: "idle" },
    });

    await render();

    const headings = Array.from(container.querySelectorAll("h1")).map((h) => h.textContent?.trim());
    expect(headings).toContain("My Agent");
    expect(headings.some((text) => text?.includes("Nothing needs you"))).toBe(false);
  });

  /**
   * The lead. A steward should be able to answer "do I need to do anything?"
   * from one sentence, before reading any panel.
   */
  it("opens with a sentence saying whether anything needs the steward", async () => {
    mockStewardshipsApi.getMyAgent.mockResolvedValue({
      stewardship: { id: "s-1", userId: "user-me" },
      agent: { id: "agent-1", name: "Casper", role: "marketing", status: "idle" },
    });
    mockIssuesApi.list.mockResolvedValue([
      { id: "i-1", identifier: "MK-1", title: "Draft the deck", status: "in_progress" },
      { id: "i-2", identifier: "MK-2", title: "Check the dates", status: "todo" },
    ]);
    mockStewardshipsApi.getMyInbox.mockResolvedValue({ items: [] });

    await render();

    expect(container.textContent).toContain("Casper is working on 2 things. Nothing needs you.");
  });

  /**
   * A fact request blocks the agent just as an approval does — it is a question
   * only this person can answer. The sentence counted approvals alone, so a
   * steward with a waiting question was told nothing needed them.
   */
  /**
   * The defect this suite never caught, because `myFactRequests` was unmocked
   * and every read was `query.data?.x ?? []`: with both requests failing, the
   * page reported a calm all-clear. An untrustworthy all-clear is worse than
   * no sentence, because a steward who is misled once stops reading the page.
   */
  it("does not claim nothing needs you when it could not find out", async () => {
    mockStewardshipsApi.getMyAgent.mockResolvedValue({
      stewardship: { id: "s-1", userId: "user-me" },
      agent: { id: "agent-1", name: "Casper", role: "marketing", status: "idle" },
    });
    mockStewardshipsApi.getMyInbox.mockRejectedValue(new Error("inbox unavailable"));
    mockStewardshipsApi.myFactRequests.mockRejectedValue(new Error("questions unavailable"));

    await render();

    const text = container.textContent ?? "";
    expect(text).not.toContain("Nothing needs you");
    expect(text).toContain("Whether anything needs you could not be checked");
    // And says why, rather than leaving the reader to guess.
    expect(text).toMatch(/inbox unavailable|questions unavailable/);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  /** One failing half is enough to make the total unknowable. */
  it("treats a single failed source as unknown, not as zero", async () => {
    mockStewardshipsApi.getMyAgent.mockResolvedValue({
      stewardship: { id: "s-1", userId: "user-me" },
      agent: { id: "agent-1", name: "Casper", role: "marketing", status: "idle" },
    });
    mockStewardshipsApi.getMyInbox.mockResolvedValue({ items: [] });
    mockStewardshipsApi.myFactRequests.mockRejectedValue(new Error("questions unavailable"));

    await render();

    expect(container.textContent).not.toContain("Nothing needs you");
    expect(container.textContent).toContain("could not be checked");
  });

  /**
   * The other half of the same fix, in the panel itself: it used to render
   * "Nothing is waiting on you" for a failed query, and now hides entirely when
   * genuinely empty because the opening sentence already says so once.
   */
  it("never says nothing is waiting when the questions failed to load", async () => {
    mockStewardshipsApi.getMyAgent.mockResolvedValue({
      stewardship: { id: "s-1", userId: "user-me" },
      agent: { id: "agent-1", name: "Casper", role: "marketing", status: "idle" },
    });
    mockStewardshipsApi.myFactRequests.mockRejectedValue(new Error("questions unavailable"));

    await render();

    expect(container.textContent).not.toContain("Nothing is waiting on you");
    expect(container.textContent).toContain("not the same as nothing waiting");
  });

  it("hides the questions panel when there are genuinely none", async () => {
    mockStewardshipsApi.getMyAgent.mockResolvedValue({
      stewardship: { id: "s-1", userId: "user-me" },
      agent: { id: "agent-1", name: "Casper", role: "marketing", status: "idle" },
    });
    mockStewardshipsApi.myFactRequests.mockResolvedValue({ factRequests: [] });

    await render();

    expect(container.textContent).not.toContain("Questions for you");
    expect(container.textContent).toContain("Nothing needs you.");
  });

  it("counts waiting questions as well as decisions", async () => {
    mockStewardshipsApi.getMyAgent.mockResolvedValue({
      stewardship: { id: "s-1", userId: "user-me" },
      agent: { id: "agent-1", name: "Casper", role: "marketing", status: "idle" },
    });
    mockIssuesApi.list.mockResolvedValue([
      { id: "i-1", identifier: "MK-1", title: "Draft the deck", status: "in_progress" },
    ]);
    mockStewardshipsApi.getMyInbox.mockResolvedValue({
      items: [
        {
          approvalId: "approval-1",
          type: "connector_send",
          status: "pending",
          revision: 1,
          payload: {},
          createdAt: new Date().toISOString(),
          decidedAt: null,
          requestingAgent: { id: "agent-1", name: "Casper", role: "marketing" },
        },
      ],
    });
    mockStewardshipsApi.myFactRequests.mockResolvedValue({
      factRequests: [
        {
          id: "fact-1",
          factKey: "q3_headcount",
          question: "How many people are on the project?",
          pipelineId: "p-1",
          runId: "r-1",
          status: "open",
        },
      ],
    });

    await render();

    expect(container.textContent).toContain("needs you on 2");
  });

  /** A question on its own still needs the steward, with no approval pending. */
  it("counts a waiting question when no decision is pending", async () => {
    mockStewardshipsApi.getMyAgent.mockResolvedValue({
      stewardship: { id: "s-1", userId: "user-me" },
      agent: { id: "agent-1", name: "Casper", role: "marketing", status: "idle" },
    });
    mockStewardshipsApi.getMyInbox.mockResolvedValue({ items: [] });
    mockStewardshipsApi.myFactRequests.mockResolvedValue({
      factRequests: [
        {
          id: "fact-1",
          factKey: "q3_headcount",
          question: "How many people are on the project?",
          pipelineId: "p-1",
          runId: "r-1",
          status: "open",
        },
      ],
    });

    await render();

    expect(container.textContent).toContain("needs you on 1");
    expect(container.textContent).not.toContain("Nothing needs you");
  });

  it("says nothing needs you rather than rendering an empty decisions panel", async () => {
    mockStewardshipsApi.getMyAgent.mockResolvedValue({
      stewardship: { id: "s-1", userId: "user-me" },
      agent: { id: "agent-1", name: "Casper", role: "marketing", status: "idle" },
    });
    mockStewardshipsApi.getMyInbox.mockResolvedValue({ items: [] });

    await render();

    expect(container.textContent).toContain("Nothing needs you.");
    expect(container.querySelector('[aria-labelledby="needs-you-heading"]')).toBeNull();
  });

  /**
   * The fields the old page received and discarded. `risk.reason` is the
   * sentence explaining why a decision matters, and `expiresAt` was rendered
   * nowhere at all — so a decision could lapse with nobody having seen a clock.
   */
  it("shows why a decision matters and when it runs out", async () => {
    mockStewardshipsApi.getMyAgent.mockResolvedValue({
      stewardship: { id: "s-1", userId: "user-me" },
      agent: { id: "agent-1", name: "Casper", role: "marketing", status: "idle" },
    });
    mockStewardshipsApi.getMyInbox.mockResolvedValue({
      items: [
        {
          approvalId: "approval-1",
          type: "connector_send",
          status: "pending",
          revision: 3,
          payload: {},
          createdAt: new Date(Date.now() - 2 * 86400 * 1000).toISOString(),
          expiresAt: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
          decidedAt: null,
          requestingAgent: { id: "agent-1", name: "Casper", role: "marketing" },
          risk: { level: "high", reason: "This leaves the company and cannot be taken back." },
          sourceIssues: [{ id: "i-9", identifier: "MK-9", title: "Reconcile vendor invoices" }],
        },
      ],
    });

    await render();

    expect(container.textContent).toContain("Casper wants to send something outside the company");
    expect(container.textContent).toContain("This leaves the company and cannot be taken back.");
    expect(container.textContent).toContain("expires in 4h");
    // "waiting 2d", not "waiting 2d ago" — this assertion previously locked in
    // the doubled "ago", because it was written from the code rather than from
    // looking at what the page rendered.
    expect(container.textContent).toContain("waiting 2d");
    expect(container.textContent).not.toContain("waiting 2d ago");
    expect(container.textContent).toContain("high risk");
    // The issue is named, not just numbered.
    expect(container.textContent).toContain("Reconcile vendor invoices");
  });

  /**
   * The safety guarantee moving onto this page must survive the move: the
   * decision endpoint requires the revision the decider was shown, so a button
   * that re-read the current revision would silently defeat the stale-card
   * protection it exists to provide.
   */
  it("decides against the revision it displayed", async () => {
    mockStewardshipsApi.getMyAgent.mockResolvedValue({
      stewardship: { id: "s-1", userId: "user-me" },
      agent: { id: "agent-1", name: "Casper", role: "marketing", status: "idle" },
    });
    mockStewardshipsApi.getMyInbox.mockResolvedValue({
      items: [
        {
          approvalId: "approval-1",
          type: "connector_send",
          status: "pending",
          revision: 7,
          payload: {},
          createdAt: new Date().toISOString(),
          decidedAt: null,
          requestingAgent: { id: "agent-1", name: "Casper", role: "marketing" },
        },
      ],
    });
    mockApprovalsApi.approve.mockResolvedValue({});

    await render();

    const approve = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Approve",
    );
    expect(approve).toBeDefined();
    await act(async () => {
      approve!.click();
    });

    expect(mockApprovalsApi.approve).toHaveBeenCalledWith("approval-1", { revision: 7 });
  });

  /**
   * The redesign IS the ordering, so it needs a guard. Previously four setup
   * forms sat above every piece of live information and the decisions panel was
   * eighth. A future edit that reorders the JSX would otherwise regress this
   * silently, since every individual panel would still render.
   */
  it("puts what needs you above setup and governance", async () => {
    mockStewardshipsApi.getMyAgent.mockResolvedValue({
      stewardship: { id: "s-1", userId: "user-me" },
      agent: { id: "agent-1", name: "Casper", role: "marketing", status: "idle" },
    });
    mockStewardshipsApi.getMyInbox.mockResolvedValue({
      items: [
        {
          approvalId: "approval-1",
          type: "connector_send",
          status: "pending",
          revision: 1,
          payload: {},
          createdAt: new Date().toISOString(),
          decidedAt: null,
          requestingAgent: { id: "agent-1", name: "Casper", role: "marketing" },
        },
      ],
    });

    await render();

    const text = container.textContent ?? "";
    const needs = text.indexOf("Needs you");
    const doing = text.indexOf("What Casper is doing");
    const happened = text.indexOf("What just happened");
    const governance = text.indexOf("How Casper works");

    expect(needs).toBeGreaterThan(-1);
    expect(needs).toBeLessThan(doing);
    expect(doing).toBeLessThan(happened);
    expect(happened).toBeLessThan(governance);
  });

  it("keeps setup and governance behind a fold rather than in the flow", async () => {
    mockStewardshipsApi.getMyAgent.mockResolvedValue({
      stewardship: { id: "s-1", userId: "user-me" },
      agent: { id: "agent-1", name: "Casper", role: "marketing", status: "idle" },
    });

    await render();

    const summaries = Array.from(container.querySelectorAll("details > summary")).map(
      (node) => node.textContent ?? "",
    );
    expect(summaries.some((text) => text.includes("How Casper works"))).toBe(true);
    expect(summaries.some((text) => /Connect|connected/.test(text))).toBe(true);
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
    expect(mockHumanChannelsApi.startPairing).not.toHaveBeenCalled();

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

    expect(mockHumanChannelsApi.startPairing).toHaveBeenCalledWith("company-1", "telegram");
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
    mockHumanChannelsApi.listMine.mockResolvedValue({
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
    mockHumanChannelsApi.startPairing.mockRejectedValue(
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

  it("states that HubSpot writes attribute to the app, not the person", async () => {
    // The owner accepted this tradeoff; accepting it is not hiding it. Someone
    // pasting a key deserves to know what their name will not be attached to.
    mockStewardshipsApi.getMyAgent.mockResolvedValue({
      stewardship: { id: "s-1" },
      agent: { id: "agent-1", name: "Marketing Agent", role: "marketing", status: "idle" },
    });

    await render();

    expect(container.textContent).toContain("attributed to the app, not to you");
    // And that a write is never unilateral.
    expect(container.textContent).toContain("cannot write on its own");
  });

  it("never renders the stored HubSpot token", async () => {
    mockStewardshipsApi.getMyAgent.mockResolvedValue({
      stewardship: { id: "s-1" },
      agent: { id: "agent-1", name: "Marketing Agent", role: "marketing", status: "idle" },
    });
    mockHubspotApi.get.mockResolvedValue({
      connection: {
        id: "conn-1",
        hubId: "12345",
        scopes: ["crm.objects.contacts.read"],
        status: "active",
        createdAt: "2026-07-30T00:00:00.000Z",
        updatedAt: "2026-07-30T00:00:00.000Z",
      },
    });

    await render();

    expect(container.textContent).toContain("12345");
    expect(container.textContent).not.toContain("pat-");
  });
});
