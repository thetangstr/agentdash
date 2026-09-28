// @vitest-environment jsdom
// AgentDash: UX-7 (GH #788) — one Decisions page on the default profile.

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WaitingOnYou } from "@paperclipai/shared";

const mockDashboardApi = vi.hoisted(() => ({ waitingOnYou: vi.fn() }));

vi.mock("../api/dashboard", () => ({ dashboardApi: mockDashboardApi }));
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
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
});
