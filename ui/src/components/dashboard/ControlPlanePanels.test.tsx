// @vitest-environment jsdom
// AgentDash: one-UX — the control-plane half of the Dashboard. Ports the
// Overview tests (AGE-448/449/451: loading, error, the agent-count race fix,
// open-issue headline) to the per-panel states of the merged page.

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockDashboardApi = vi.hoisted(() => ({ summary: vi.fn() }));
const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockActivityApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockAccessApi = vi.hoisted(() => ({ listUserDirectory: vi.fn() }));

vi.mock("../../api/dashboard", () => ({ dashboardApi: mockDashboardApi }));
vi.mock("../../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../../api/activity", () => ({ activityApi: mockActivityApi }));
vi.mock("../../api/access", () => ({ accessApi: mockAccessApi }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children?: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const { ControlPlanePanels, fleetSize, monthSpendTile, BYOK_SPEND_NOTE, NO_AGENTS_TEXT, NO_ACTIVITY_TEXT } = await import(
  "./ControlPlanePanels"
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeSummary(overrides: Record<string, unknown> = {}) {
  return {
    companyId: "company-1",
    agents: { active: 0, running: 0, paused: 0, error: 0 },
    tasks: { open: 2, inProgress: 1, blocked: 0, done: 4 },
    costs: { monthSpendCents: 1250, monthTokens: 40_000, monthBudgetCents: 10000, monthUtilizationPercent: 13 },
    pendingApprovals: 0,
    budgets: { activeIncidents: 0, pendingApprovals: 0, pausedAgents: 0, pausedProjects: 0 },
    ...overrides,
  };
}

function makeAgent(i: number, status = "idle") {
  return { id: `agent-${i}`, name: `Agent ${i}`, role: "general", status, lastHeartbeatAt: null };
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

describe("ControlPlanePanels", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockDashboardApi.summary.mockResolvedValue(makeSummary());
    mockAgentsApi.list.mockResolvedValue([]);
    mockActivityApi.list.mockResolvedValue([]);
    mockAccessApi.listUserDirectory.mockResolvedValue({ users: [] });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render({ settle = true } = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ControlPlanePanels companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    if (settle) await flush();
  }

  const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);

  it("shows each panel's loading state while its query is in flight", async () => {
    const never = new Promise(() => {});
    mockDashboardApi.summary.mockReturnValue(never);
    mockAgentsApi.list.mockReturnValue(never);
    mockActivityApi.list.mockReturnValue(never);
    await render({ settle: false });
    expect(q("dashboard-stats-loading")).not.toBeNull();
    expect(q("dashboard-fleet")?.textContent).toContain("Loading agents…");
    expect(q("dashboard-activity")?.textContent).toContain("Loading activity…");
  });

  it("shows an error in the stats panel only, and the other panels still render", async () => {
    mockDashboardApi.summary.mockRejectedValue(new Error("Internal Server Error"));
    mockAgentsApi.list.mockResolvedValue([makeAgent(1)]);
    await render();
    expect(q("dashboard-stats-error")?.textContent).toContain("Couldn't load the numbers. Internal Server Error");
    expect(container.querySelectorAll('[data-testid="dashboard-fleet-row"]')).toHaveLength(1);
    expect(q("dashboard-activity-empty")).not.toBeNull();
  });

  // AgentDash (c3 copy): a CoS literally named "Chief of Staff" used to fall
  // through the identity-line suppression into the generic "Agent" subtitle.
  it("names the role under a Chief of Staff whose name is its title", async () => {
    mockAgentsApi.list.mockResolvedValue([
      { id: "agent-cos", name: "Chief of Staff", role: "chief_of_staff", status: "idle", lastHeartbeatAt: null },
      { id: "agent-1", name: "Agent 1", role: "general", status: "idle", lastHeartbeatAt: null },
    ]);
    await render();
    const rows = container.querySelectorAll('[data-testid="dashboard-fleet-row"]');
    // Name + role subtitle — "Chief of Staff" appears twice, not "Agent".
    expect(rows[0]?.textContent?.match(/Chief of Staff/g) ?? []).toHaveLength(2);
    expect(rows[0]?.textContent).not.toContain("Agent");
    expect(rows[1]?.textContent).toContain("Agent");
  });

  it("shows an error in the fleet and activity panels when those queries fail", async () => {
    mockAgentsApi.list.mockRejectedValue(new Error("nope"));
    mockActivityApi.list.mockRejectedValue(new Error("nope"));
    await render();
    expect(q("dashboard-fleet")?.textContent).toContain("Couldn't load your agents.");
    expect(q("dashboard-activity")?.textContent).toContain("Couldn't load recent activity.");
    expect(q("dashboard-stats")).not.toBeNull();
  });

  it("uses the agent list length when the dashboard count lags behind (race fix)", async () => {
    mockDashboardApi.summary.mockResolvedValue(makeSummary({ agents: { active: 1, running: 0, paused: 0, error: 0 } }));
    mockAgentsApi.list.mockResolvedValue([makeAgent(1), makeAgent(2), makeAgent(3)]);
    await render();
    expect(q("dashboard-stat-agents-value")?.textContent).toBe("3");
    expect(q("dashboard-fleet")?.textContent).toContain("View all 3");
  });

  it("keeps the dashboard count when it exceeds the agent list length", async () => {
    mockDashboardApi.summary.mockResolvedValue(makeSummary({ agents: { active: 3, running: 2, paused: 0, error: 0 } }));
    mockAgentsApi.list.mockResolvedValue([makeAgent(1), makeAgent(2)]);
    await render();
    expect(q("dashboard-stat-agents-value")?.textContent).toBe("5");
  });

  it("shows tasks.open as the open-issue headline and the month spend against budget", async () => {
    mockDashboardApi.summary.mockResolvedValue(makeSummary({ tasks: { open: 3, inProgress: 5, blocked: 1, done: 7 } }));
    await render();
    expect(q("dashboard-stat-issues-value")?.textContent).toBe("3");
    expect(q("dashboard-stat-issues")?.textContent).toContain("5 in progress · 1 blocked");
    expect(q("dashboard-stat-spend-value")?.textContent).toBe("$12.50");
    expect(q("dashboard-stat-spend")?.textContent).toContain("13% of $100.00 budget");
  });

  // AgentDash: BYOK boxes meter tokens, not dollars.
  it("shows tokens this month and who bills them when no cost was metered", async () => {
    mockDashboardApi.summary.mockResolvedValue(
      makeSummary({ costs: { monthSpendCents: 0, monthTokens: 127_000, monthBudgetCents: 0, monthUtilizationPercent: 0 } }),
    );
    await render();
    const tile = q("dashboard-stat-spend");
    expect(tile?.textContent).toContain("Tokens this month");
    expect(tile?.textContent).not.toContain("Spend this month");
    expect(q("dashboard-stat-spend-value")?.textContent).toBe("127.0k");
    expect(tile?.textContent).toContain(BYOK_SPEND_NOTE);
    expect(tile?.textContent).not.toContain("$0.00");
  });

  it("keeps dollars whenever cost is known, and $0.00 when nothing ran", () => {
    expect(monthSpendTile({ monthSpendCents: 1250, monthTokens: 9000, monthBudgetCents: 0, monthUtilizationPercent: 0 })).toEqual({
      label: "Spend this month",
      value: "$12.50",
      unmetered: false,
    });
    expect(monthSpendTile({ monthSpendCents: 0, monthTokens: 0, monthBudgetCents: 0, monthUtilizationPercent: 0 })).toEqual({
      label: "Spend this month",
      value: "$0.00",
      unmetered: false,
    });
  });

  it("shows the empty states for a brand-new company", async () => {
    mockDashboardApi.summary.mockResolvedValue(
      makeSummary({ tasks: { open: 0, inProgress: 0, blocked: 0, done: 0 }, costs: { monthSpendCents: 0, monthBudgetCents: 0, monthUtilizationPercent: 0 } }),
    );
    await render();
    expect(q("dashboard-fleet-empty")?.textContent).toContain(NO_AGENTS_TEXT);
    expect(q("dashboard-fleet-empty")?.querySelector('a[href="/agents/new"]')).not.toBeNull();
    expect(q("dashboard-activity-empty")?.textContent).toContain(NO_ACTIVITY_TEXT);
    expect(q("dashboard-stat-spend")?.textContent).toContain("No monthly budget set");
  });

  it("leaves terminated agents out of the fleet", async () => {
    mockAgentsApi.list.mockResolvedValue([makeAgent(1, "running"), makeAgent(2, "terminated")]);
    await render();
    const rows = container.querySelectorAll('[data-testid="dashboard-fleet-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Agent 1");
    expect(rows[0]!.textContent).toContain("running");
  });

  it("names the issue in recent activity from the event details", async () => {
    mockAgentsApi.list.mockResolvedValue([makeAgent(1, "running")]);
    mockActivityApi.list.mockResolvedValue([
      {
        id: "ev-1",
        companyId: "company-1",
        actorType: "agent",
        actorId: "agent-1",
        action: "issue.created",
        entityType: "issue",
        entityId: "i-1",
        agentId: "agent-1",
        runId: null,
        details: { identifier: "ACM-1", title: "Add a /health badge" },
        createdAt: new Date().toISOString(),
      },
    ]);
    await render();
    const activity = q("dashboard-activity")!;
    expect(activity.textContent).toContain("Agent 1");
    expect(activity.textContent).toContain("ACM-1");
    expect(activity.querySelector('a[href="/issues/ACM-1"]')).not.toBeNull();
    expect(activity.querySelector('a[href="/activity"]')).not.toBeNull();
  });

  it("raises a budget incident above the stats", async () => {
    mockDashboardApi.summary.mockResolvedValue(
      makeSummary({ budgets: { activeIncidents: 1, pendingApprovals: 0, pausedAgents: 2, pausedProjects: 0 } }),
    );
    await render();
    expect(q("dashboard-budget-incident")?.textContent).toContain("1 active budget incident");
    expect(q("dashboard-budget-incident")?.textContent).toContain("2 agents paused");
  });
});

describe("fleetSize", () => {
  it("is null with no data, else the larger of summary total and live list", () => {
    expect(fleetSize(undefined, undefined)).toBeNull();
    const summary = makeSummary({ agents: { active: 1, running: 1, paused: 1, error: 1 } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(fleetSize(summary as any, [])).toBe(4);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(fleetSize(undefined, [makeAgent(1), makeAgent(2, "terminated")] as any)).toBe(1);
  });
});
