// @vitest-environment jsdom
// AgentDash: UX-7 (GH #788) — one Decisions page, for every company (one UX,
// doc/plans/2026-09-30-one-ux.md), including the sources the MK Inbox showed.

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WaitingOnYou } from "@paperclipai/shared";

const mockDashboardApi = vi.hoisted(() => ({ waitingOnYou: vi.fn() }));

const mockStewardshipsApi = vi.hoisted(() => ({
  getMyInbox: vi.fn(),
  getOverrideInbox: vi.fn(),
  myFactRequests: vi.fn(),
}));
const mockConnectorSendApi = vi.hoisted(() => ({ listUnresolved: vi.fn() }));
const mockAccessApi = vi.hoisted(() => ({ listJoinRequests: vi.fn() }));

vi.mock("../api/dashboard", () => ({ dashboardApi: mockDashboardApi }));
vi.mock("../api/stewardships", () => ({ stewardshipsApi: mockStewardshipsApi }));
vi.mock("../api/connector-send-executions", () => ({
  connectorSendExecutionsApi: mockConnectorSendApi,
}));
vi.mock("../api/access", () => ({ accessApi: mockAccessApi }));

const { ApiError } = await import("../api/client");

/** What a capability-gated route answers for a company without it. */
function notFound() {
  return Promise.reject(new ApiError("Company not found", 404, null));
}
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const { Decisions, decisionsListLength } = await import("./Decisions");
const {
  loadSource,
  resetSourceFailureStreaks,
  sourceRefetchInterval,
  SOURCE_MAX_BACKOFF_MS,
  SOURCE_POLL_MS,
  decisionsSourceKeys,
} = await import("./DecisionsOtherSources");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const EMPTY_TEXT =
  "Nothing needs you. Agents ask here before hiring, spending over your limit, or doing anything outside your repo.";

function waitingWith(overrides: Partial<WaitingOnYou> = {}): WaitingOnYou {
  return {
    decisions: [
      {
        approvalId: "appr-1",
        kind: "hire_agent",
        askedBy: "Priya",
        summary: "Priya asks to hire a new agent.",
        relatedItem: null,
        waitingSince: new Date().toISOString(),
        canDecide: true,
        risk: { level: "high", reason: "hires change the team" },
        effects: {
          approve: "The hire is approved and the new agent is created on the requested adapter.",
          reject: "The request is rejected and does not proceed.",
        },
      },
    ],
    total: 1,
    shown: 1,
    // The server applies the split: manual rows are the main list,
    // machine-filed rows arrive in otherTasksAssignedToYou.
    tasksAssignedToYou: [
      {
        issueId: "i-1",
        identifier: "ACM-1",
        title: "Which launch date works for you?",
        status: "todo",
        updatedAt: new Date().toISOString(),
        originKind: "manual",
      },
    ],
    tasksAssignedToYouTotal: 1,
    otherTasksAssignedToYou: [
      {
        issueId: "i-2",
        identifier: "ACM-2",
        title: "Weekly metrics snapshot",
        status: "todo",
        updatedAt: new Date().toISOString(),
        originKind: "routine_execution",
      },
    ],
    otherTasksAssignedToYouTotal: 1,
    ...overrides,
  };
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

describe("Decisions", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockDashboardApi.waitingOnYou.mockResolvedValue(waitingWith());
    // Default: every extra source is gated off (a default-profile company).
    mockStewardshipsApi.getMyInbox.mockImplementation(notFound);
    mockStewardshipsApi.getOverrideInbox.mockImplementation(notFound);
    mockStewardshipsApi.myFactRequests.mockImplementation(notFound);
    mockConnectorSendApi.listUnresolved.mockImplementation(notFound);
    mockAccessApi.listJoinRequests.mockImplementation(() =>
      Promise.reject(new ApiError("Forbidden", 403, null)),
    );
    resetSourceFailureStreaks();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  let client: QueryClient;
  async function render() {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Decisions />
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);

  it("shows the approval's question and what yes and no do, with a link to the detail", async () => {
    await render();
    const row = q("decisions-row")!;
    expect(row.textContent).toContain("Priya asks to hire a new agent.");
    expect(row.textContent).toContain("The hire is approved and the new agent is created");
    expect(row.textContent).toContain("The request is rejected and does not proceed.");
    expect(row.textContent).toContain("hires change the team");
    expect(row.querySelector('a[href="/approvals/appr-1"]')).toBeTruthy();
    // Badge math: the page count equals the list the sidebar badged.
    expect(q("decisions-count")?.textContent).toBe("2");
    expect(decisionsListLength(waitingWith())).toBe(2);
  });

  it("lists issues assigned to you in the main list when a human filed them", async () => {
    await render();
    const task = q("decisions-task-row")!;
    expect(task.textContent).toContain("Which launch date works for you?");
    expect(task.querySelector('a[href="/issues/ACM-1"]')).toBeTruthy();
  });

  it("puts machine-generated items under a collapsed Other activity, not the main list", async () => {
    await render();
    // Exactly one task row in the main list: the manual one.
    expect(container.querySelectorAll('[data-testid="decisions-task-row"]')).toHaveLength(1);
    const other = q("decisions-other")!;
    expect(other.textContent).not.toContain("Weekly metrics snapshot");

    // Expanding reveals it.
    const toggle = other.querySelector("button")!;
    await act(async () => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(other.textContent).toContain("Weekly metrics snapshot");
    expect(container.querySelectorAll('[data-testid="decisions-task-row"]')).toHaveLength(2);
  });

  it("says the exact empty line when nothing needs the person", async () => {
    mockDashboardApi.waitingOnYou.mockResolvedValue(
      waitingWith({
        decisions: [],
        total: 0,
        shown: 0,
        tasksAssignedToYou: [],
        tasksAssignedToYouTotal: 0,
        otherTasksAssignedToYou: [],
        otherTasksAssignedToYouTotal: 0,
      }),
    );
    await render();
    expect(q("decisions-empty")?.textContent).toBe(EMPTY_TEXT);
    expect(q("decisions-count")?.textContent).toBe("0");
  });

  it("keeps the empty line even when only machine-generated noise waits", async () => {
    mockDashboardApi.waitingOnYou.mockResolvedValue(
      waitingWith({
        decisions: [],
        total: 0,
        shown: 0,
        tasksAssignedToYou: [],
        tasksAssignedToYouTotal: 0,
        otherTasksAssignedToYou: [
          {
            issueId: "i-9",
            identifier: "ACM-9",
            title: "Evaluator follow-up",
            status: "todo",
            updatedAt: new Date().toISOString(),
            originKind: "stale_active_run_evaluation",
          },
        ],
        otherTasksAssignedToYouTotal: 1,
      }),
    );
    await render();
    expect(q("decisions-empty")?.textContent).toBe(EMPTY_TEXT);
    // The noise is reachable but muted, not counted.
    expect(q("decisions-count")?.textContent).toBe("0");
    expect(q("decisions-other")?.textContent).toContain("1");
  });
  const EMPTY_WAITING = {
    decisions: [],
    total: 0,
    shown: 0,
    tasksAssignedToYou: [],
    tasksAssignedToYouTotal: 0,
    otherTasksAssignedToYou: [],
    otherTasksAssignedToYouTotal: 0,
  };

  function inboxItem(approvalId: string, type: string, agentName = "Casper") {
    return {
      approvalId,
      type,
      status: "pending",
      revision: 1,
      payload: {},
      createdAt: new Date().toISOString(),
      decidedAt: null,
      expiresAt: null,
      requestingAgent: { id: "agent-1", name: agentName, role: "general" },
      sourceIssues: [{ id: "iss-1", identifier: "MK-7", title: "Send the Q3 update", status: "in_progress" }],
      risk: { level: "high", reason: "sends outside the company" },
      effectiveAuthority: { steward: null, minimumApproval: null },
      decisionHistory: {
        decidedAt: null,
        decidedByUserId: null,
        decisionChannel: null,
        decisionActorRole: null,
        overrideReason: null,
        supersededAt: null,
      },
      requiresOverride: false,
    };
  }

  it("shows nothing extra and no error when the gated sources 404", async () => {
    await render();
    for (const id of [
      "decisions-steward",
      "decisions-questions",
      "decisions-connector-sends",
      "decisions-join-requests",
      "decisions-override",
    ]) {
      expect(q(id), id).toBeNull();
    }
    expect(container.querySelector(".text-destructive")).toBeNull();
    expect(q("decisions-row")).not.toBeNull();
  });

  it("treats a transient failure as transient: nothing broken shown, and the source comes back", async () => {
    mockDashboardApi.waitingOnYou.mockResolvedValue(waitingWith(EMPTY_WAITING));
    mockConnectorSendApi.listUnresolved.mockImplementationOnce(() =>
      Promise.reject(new ApiError("Internal error", 500, null)),
    );
    await render();
    expect(q("decisions-connector-sends")).toBeNull();
    expect(container.querySelector(".text-destructive")).toBeNull();
    // Not cached as "absent": the query is in error and keeps its poll.
    const state = client.getQueryState(decisionsSourceKeys.connectorSends("company-1"));
    expect(state?.status).toBe("error");
    expect(state?.data).toBeUndefined();

    mockConnectorSendApi.listUnresolved.mockResolvedValue({
      items: [
        {
          id: "send-1",
          provider: "hubspot",
          operation: "update",
          objectType: "deal",
          reason: "timed out",
          executedAt: new Date().toISOString(),
        },
      ],
    });
    await act(async () => {
      await client.refetchQueries({ queryKey: decisionsSourceKeys.connectorSends("company-1") });
    });
    await flush();
    expect(q("decisions-connector-sends")).not.toBeNull();
  });

  it("surfaces steward, question, connector-send, join and override items when their APIs answer", async () => {
    mockDashboardApi.waitingOnYou.mockResolvedValue(waitingWith(EMPTY_WAITING));
    mockStewardshipsApi.getMyInbox.mockResolvedValue({
      stewardedAgent: { id: "agent-1", name: "Casper", role: "general", status: "active" },
      items: [inboxItem("appr-mk-1", "connector_send")],
    });
    mockStewardshipsApi.getOverrideInbox.mockResolvedValue({
      items: [inboxItem("appr-mk-1", "connector_send"), inboxItem("appr-mk-2", "hire_agent", "Priya")],
    });
    mockStewardshipsApi.myFactRequests.mockResolvedValue({
      factRequests: [
        {
          id: "fr-1",
          factKey: "fiscal_year_end",
          question: "When does the fiscal year end?",
          pipelineId: "p-1",
          runId: "r-1",
          status: "open",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    mockConnectorSendApi.listUnresolved.mockResolvedValue({
      items: [
        {
          id: "cse-1",
          provider: "hubspot",
          objectType: "contact",
          operation: "update",
          outcome: "outcome_unknown",
          reason: "timeout",
          requestedByAgentId: "agent-1",
          executedAt: new Date().toISOString(),
          revision: 0,
        },
      ],
    });
    mockAccessApi.listJoinRequests.mockResolvedValue([{ id: "jr-1" }, { id: "jr-2" }]);

    await render();

    // With extra items waiting, the page does not claim nothing needs you.
    expect(q("decisions-empty")).toBeNull();

    const steward = q("decisions-steward")!;
    expect(steward.textContent).toContain("Casper is waiting on you");
    expect(steward.textContent).toContain("Casper wants to send something outside the company");
    expect(steward.textContent).toContain("sends outside the company");
    expect(steward.querySelector('a[href="/approvals/appr-mk-1"]')).toBeTruthy();

    const questions = q("decisions-questions")!;
    expect(questions.textContent).toContain("When does the fiscal year end?");
    expect(questions.querySelector('a[href="/my-agent"]')).toBeTruthy();

    const sends = q("decisions-connector-sends")!;
    expect(sends.textContent).toContain("hubspot update contact: outcome unknown");

    const joins = q("decisions-join-requests")!;
    expect(joins.textContent).toContain("2 requests to join the company");
    expect(joins.querySelector('a[href="/inbox/requests"]')).toBeTruthy();

    // The override entry counts only what is not already listed above.
    const override = q("decisions-override")!;
    expect(override.textContent).toContain("1 company approval open to the override view");
    expect(override.querySelector('a[href="/inbox/override"]')).toBeTruthy();
  });

  it("does not list a steward approval twice when the main list already has it", async () => {
    mockStewardshipsApi.getMyInbox.mockResolvedValue({
      stewardedAgent: { id: "agent-1", name: "Casper", role: "general", status: "active" },
      items: [inboxItem("appr-1", "hire_agent")],
    });
    await render();
    expect(q("decisions-row")).not.toBeNull();
    expect(q("decisions-steward")).toBeNull();
  });
});

describe("Decisions source loading", () => {
  beforeEach(() => resetSourceFailureStreaks());

  it("resolves only the gates' 404 and 403 to absent", async () => {
    await expect(loadSource("k404", () => Promise.reject(new ApiError("nf", 404, null)))).resolves.toBeNull();
    await expect(loadSource("k403", () => Promise.reject(new ApiError("no", 403, null)))).resolves.toBeNull();
    await expect(loadSource("k500", () => Promise.reject(new ApiError("boom", 500, null)))).rejects.toThrow("boom");
    await expect(loadSource("knet", () => Promise.reject(new TypeError("Failed to fetch")))).rejects.toThrow(
      "Failed to fetch",
    );
    await expect(loadSource("kok", () => Promise.resolve({ items: [] }))).resolves.toEqual({ items: [] });
  });

  it("stops polling an absent source, backs off a failing one, polls a healthy one", () => {
    expect(sourceRefetchInterval({ data: null, status: "success" }, 0)).toBe(false);
    expect(sourceRefetchInterval({ data: { items: [] }, status: "success" }, 0)).toBe(SOURCE_POLL_MS);
    expect(sourceRefetchInterval({ data: undefined, status: "error" }, 1)).toBe(SOURCE_POLL_MS);
    expect(sourceRefetchInterval({ data: undefined, status: "error" }, 2)).toBe(SOURCE_POLL_MS * 2);
    expect(sourceRefetchInterval({ data: undefined, status: "error" }, 3)).toBe(SOURCE_POLL_MS * 4);
    expect(sourceRefetchInterval({ data: undefined, status: "error" }, 50)).toBe(SOURCE_MAX_BACKOFF_MS);
    // A source that had loaded and then failed keeps polling (with backoff) too.
    expect(sourceRefetchInterval({ data: { items: [] }, status: "error" }, 1)).toBe(SOURCE_POLL_MS);
  });
});
