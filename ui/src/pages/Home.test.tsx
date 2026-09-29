// @vitest-environment jsdom
// AgentDash: UX-3 (#784) — the honest Home.

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShippedFeed, WaitingOnYou, WorkingNow } from "@paperclipai/shared";

const mockDashboardApi = vi.hoisted(() => ({ summary: vi.fn(), waitingOnYou: vi.fn(), workingNow: vi.fn() }));
const mockIssuesApi = vi.hoisted(() => ({ listShipped: vi.fn() }));
const mockAuthApi = vi.hoisted(() => ({ getSession: vi.fn() }));
const mockCompany = vi.hoisted(() => ({
  current: { id: "company-1", name: "Acme Robotics", productProfile: "default" } as Record<string, unknown>,
}));

vi.mock("../api/dashboard", () => ({ dashboardApi: mockDashboardApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../api/auth", () => ({ authApi: mockAuthApi }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: mockCompany.current,
    // DashboardHome waits on the profile resolving before it picks a page.
    companies: mockCompany.current ? [mockCompany.current] : [],
    loading: false,
  }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("./Overview", () => ({ Overview: () => <div data-testid="mk-overview">MK dashboard</div> }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const { DashboardHome, Home, firstNameFor, formatElapsed, WAITING_EMPTY_TEXT, WORKING_EMPTY_TEXT, SHIPPED_WEEK_EMPTY_TEXT } =
  await import("./Home");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const summary = {
  companyId: "company-1",
  agents: { active: 4, running: 2, paused: 0, error: 0 },
  tasks: { open: 92, inProgress: 2, blocked: 1, done: 2 },
  costs: { monthSpendCents: 0, monthBudgetCents: 0, monthUtilizationPercent: 0 },
  pendingApprovals: 1,
};

const waiting: WaitingOnYou = {
  pendingQuestions: [],
  pendingQuestionsTotal: 0,
  decisions: [
    {
      approvalId: "appr-1",
      kind: "hire_agent",
      askedBy: null,
      summary: "The board asks to hire a new agent.",
      relatedItem: null,
      waitingSince: new Date().toISOString(),
      canDecide: true,
      risk: { level: "high" },
    },
  ],
  total: 1,
  shown: 1,
  tasksAssignedToYou: [
    { issueId: "i-6", identifier: "ACM-6", title: "Approve the pricing page copy", status: "todo", updatedAt: new Date().toISOString() },
    { issueId: "i-7", identifier: "ACM-7", title: "Pick a date for the demo", status: "todo", updatedAt: new Date().toISOString() },
  ],
  tasksAssignedToYouTotal: 2,
  otherTasksAssignedToYou: [],
  otherTasksAssignedToYouTotal: 0,
};

const working: WorkingNow = {
  total: 2,
  items: [
    {
      runId: "44444444-0000-4000-8000-000000000003",
      status: "running",
      agent: { id: "a-1", name: "Maya" },
      issue: { id: "i-4", identifier: "ACM-4", title: "Add rate limiting to the public API", status: "in_progress" },
      lastStep: "Running the API test suite",
      startedAt: new Date(Date.now() - 14 * 60_000).toISOString(),
    },
    {
      runId: "44444444-0000-4000-8000-000000000004",
      status: "queued",
      agent: { id: "a-2", name: "Priya" },
      issue: null,
      lastStep: null,
      startedAt: new Date().toISOString(),
    },
  ],
};

function shippedFeed(total: number): ShippedFeed {
  return {
    items: total
      ? [
          {
            id: "wp-1",
            companyId: "company-1",
            projectId: null,
            issueId: "i-1",
            executionWorkspaceId: null,
            runtimeServiceId: null,
            type: "pull_request",
            provider: "github",
            externalId: null,
            title: "README: add /health badge",
            url: "https://github.com/acme/web/pull/41",
            status: "merged",
            reviewState: "none",
            isPrimary: true,
            healthStatus: "unknown",
            summary: null,
            metadata: null,
            createdByRunId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            issue: { id: "i-1", identifier: "ACM-1", title: "Add a /health badge", status: "done", projectId: null },
            agent: { id: "a-1", name: "Maya" },
            usage: { metered: true, inputTokens: 184_000, cachedInputTokens: 0, outputTokens: 6_200, costCents: 0 },
          },
        ]
      : [],
    total,
    nextCursor: null,
    monthTotal: { since: "2026-09-01T00:00:00.000Z", count: total, pullRequests: total, usage: { metered: false, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costCents: 0 } },
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

describe("Home", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockCompany.current = { id: "company-1", name: "Acme Robotics", productProfile: "default" };
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "u-1", name: "Yao Tang", email: "y@example.com" } });
    mockDashboardApi.summary.mockResolvedValue(summary);
    mockDashboardApi.waitingOnYou.mockResolvedValue(waiting);
    mockDashboardApi.workingNow.mockResolvedValue(working);
    mockIssuesApi.listShipped.mockResolvedValue(shippedFeed(1));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render(node = <Home />) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
    });
    await flush();
  }

  const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);
  const rows = (id: string) => container.querySelectorAll(`[data-testid="${id}"]`);

  it("renders final counts directly, and each count matches its list", async () => {
    // A frame never comes, as in a background tab: numbers must not depend on one.
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0);
    await render();
    expect(q("home-subline")?.textContent).toBe("Acme Robotics · 6 agents · 92 open issues");
    expect(q("home-waiting-count")?.textContent).toBe("3");
    expect(rows("home-waiting-row")).toHaveLength(3);
    expect(q("home-working-count")?.textContent).toBe("2");
    expect(rows("home-working-row")).toHaveLength(2);
    expect(q("home-shipped-count")?.textContent).toBe("1");
    expect(q("home-shipped")?.querySelectorAll('[data-testid="shipped-row"]')).toHaveLength(1);
    raf.mockRestore();
  });

  it("puts issues assigned to the person in Waiting on you, not only approvals", async () => {
    await render();
    const block = q("home-waiting")!;
    expect(block.textContent).toContain("The board asks to hire a new agent.");
    expect(block.querySelector('a[href="/issues/ACM-6"]')?.textContent).toContain("Approve the pricing page copy");
    expect(block.textContent).toContain("Issue assigned to you");
  });

  it("says how many more when the list is capped, so the count still adds up", async () => {
    mockDashboardApi.waitingOnYou.mockResolvedValue({ ...waiting, tasksAssignedToYouTotal: 9 });
    await render();
    expect(q("home-waiting-count")?.textContent).toBe("10");
    expect(q("home-waiting")?.textContent).toContain("and 7 more issues assigned to you");
    // The link opens the issue list filtered to the person (issue-filters "__me").
    expect(q("home-waiting")?.querySelector('a[href="/issues?assignee=__me"]')).not.toBeNull();
  });

  it("shows issue titles in Working now, never run hashes", async () => {
    await render();
    const block = q("home-working")!;
    expect(block.textContent).toContain("ACM-4 Add rate limiting to the public API");
    expect(block.textContent).toContain("Maya");
    expect(block.textContent).toContain("14m");
    expect(block.textContent).toContain("Running the API test suite");
    expect(block.textContent).toContain("Working outside an issue");
    expect(block.textContent).not.toMatch(/44444444|c4f7ac0f/);
    expect(block.querySelector('a[href="/dashboard/live"]')).not.toBeNull();
  });

  it("greets the person by first name and offers planning with the Chief of Staff", async () => {
    await render();
    expect(q("home-greeting")?.textContent).toMatch(/^Good (morning|afternoon|evening), Yao$/);
    expect(q("home-greeting")?.textContent).not.toContain("board");
    expect(q("home-plan-with-cos")?.getAttribute("href")).toBe("/cos");
  });

  it("does not call the local operator 'board'", async () => {
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "local-board", name: "Board", email: "local@agentdash.local" } });
    await render();
    expect(q("home-greeting")?.textContent).toMatch(/^Good (morning|afternoon|evening)$/);
  });

  it("shows each block's empty state with no data", async () => {
    mockDashboardApi.waitingOnYou.mockResolvedValue({ decisions: [], total: 0, shown: 0, tasksAssignedToYou: [], tasksAssignedToYouTotal: 0, otherTasksAssignedToYou: [], otherTasksAssignedToYouTotal: 0 });
    mockDashboardApi.workingNow.mockResolvedValue({ items: [], total: 0 });
    mockIssuesApi.listShipped.mockResolvedValue(shippedFeed(0));
    await render();
    expect(q("home-waiting-count")?.textContent).toBe("0");
    expect(q("home-waiting")?.textContent).toContain(WAITING_EMPTY_TEXT);
    expect(q("home-working")?.textContent).toContain(WORKING_EMPTY_TEXT);
    expect(q("home-shipped")?.textContent).toContain(SHIPPED_WEEK_EMPTY_TEXT);
  });

  it("asks for a first issue when there is no work at all", async () => {
    mockDashboardApi.summary.mockResolvedValue({ ...summary, tasks: { open: 0, inProgress: 0, blocked: 0, done: 0 } });
    mockDashboardApi.workingNow.mockResolvedValue({ items: [], total: 0 });
    await render();
    expect(q("home-working")?.textContent).toContain("Tell your team what to build. One sentence is enough.");
  });

  it("asks the shipped feed for this week only", async () => {
    await render();
    const [, filters] = mockIssuesApi.listShipped.mock.calls[0]!;
    const since = new Date(filters.since).getTime();
    expect(Date.now() - since).toBeGreaterThanOrEqual(7 * 24 * 3_600_000);
    expect(Date.now() - since).toBeLessThan(7 * 24 * 3_600_000 + 3_600_000);
  });

  it("keeps the current dashboard for agentdash_mk companies", async () => {
    mockCompany.current = { id: "company-1", name: "MKThink", productProfile: "agentdash_mk" };
    await render(<DashboardHome />);
    expect(q("mk-overview")).not.toBeNull();
    expect(q("home")).toBeNull();
    expect(mockDashboardApi.waitingOnYou).not.toHaveBeenCalled();
  });

  it("gives the default profile the new Home", async () => {
    await render(<DashboardHome />);
    expect(q("home")).not.toBeNull();
    expect(q("mk-overview")).toBeNull();
  });
});

describe("Home helpers", () => {
  it("firstNameFor", () => {
    expect(firstNameFor({ id: "u", name: "Yao Tang" })).toBe("Yao");
    expect(firstNameFor({ id: "local-board", name: "Board" })).toBeNull();
    expect(firstNameFor({ id: "u", name: "" })).toBeNull();
    expect(firstNameFor(null)).toBeNull();
  });

  it("formatElapsed", () => {
    const now = Date.parse("2026-09-26T12:00:00Z");
    expect(formatElapsed("2026-09-26T11:59:40Z", now)).toBe("just started");
    expect(formatElapsed("2026-09-26T11:46:00Z", now)).toBe("14m");
    expect(formatElapsed("2026-09-26T10:48:00Z", now)).toBe("1h 12m");
    expect(formatElapsed("2026-09-24T12:00:00Z", now)).toBe("2d");
  });
});
