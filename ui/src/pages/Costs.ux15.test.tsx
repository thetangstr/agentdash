// @vitest-environment jsdom
// AgentDash: UX-15 (GH #796) — the Costs page answers "what did the money
// buy" first, the same for every company (one UX).

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShippedFeed } from "@paperclipai/shared";

const mockCostsApi = vi.hoisted(() => ({
  summary: vi.fn(),
  runActivity: vi.fn(),
  byAgent: vi.fn(),
  byAgentModel: vi.fn(),
  byProject: vi.fn(),
  byIssue: vi.fn(),
  byProvider: vi.fn(),
  byBiller: vi.fn(),
  financeSummary: vi.fn(),
  financeByBiller: vi.fn(),
  financeByKind: vi.fn(),
  financeEvents: vi.fn(),
  windowSpend: vi.fn(),
  quotaWindows: vi.fn(),
}));
const mockBudgetsApi = vi.hoisted(() => ({
  overview: vi.fn(),
  upsertPolicy: vi.fn(),
  resolveIncident: vi.fn(),
}));
const mockIssuesApi = vi.hoisted(() => ({ listShipped: vi.fn() }));

vi.mock("../api/costs", () => ({ costsApi: mockCostsApi }));
vi.mock("../api/budgets", () => ({ budgetsApi: mockBudgetsApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1" },
  }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../components/PageSkeleton", () => ({ PageSkeleton: () => <div>loading</div> }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
}));

const { Costs } = await import("./Costs");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function shippedFeed(monthTotal: ShippedFeed["monthTotal"]): ShippedFeed {
  return { items: [], total: 0, nextCursor: null, monthTotal };
}

const METERED_MONTH: ShippedFeed["monthTotal"] = {
  since: "2026-09-01T00:00:00.000Z",
  count: 3,
  pullRequests: 2,
  usage: { metered: true, inputTokens: 4_000, cachedInputTokens: 0, outputTokens: 1_000, costCents: 1_000 },
};
const UNMETERED_MONTH: ShippedFeed["monthTotal"] = {
  ...METERED_MONTH,
  usage: { metered: false, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costCents: 0 },
};

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function mockHappyApis() {
  mockCostsApi.summary.mockResolvedValue({
    companyId: "company-1",
    spendCents: 12_345,
    budgetCents: 0,
    utilizationPercent: 0,
    measured: true,
    pricedSpend: true,
  });
  mockCostsApi.runActivity.mockResolvedValue({
    companyId: "company-1",
    totalRuns: 9,
    succeededRuns: 8,
    failedRuns: 1,
    totalSeconds: 3_600,
    medianSeconds: 400,
    p90Seconds: 900,
    lastRunAt: null,
  });
  mockCostsApi.byAgent.mockResolvedValue([]);
  mockCostsApi.byAgentModel.mockResolvedValue([]);
  mockCostsApi.byProject.mockResolvedValue([]);
  mockCostsApi.byIssue.mockResolvedValue([
    {
      issueId: "issue-1",
      issueIdentifier: "ACME-1",
      issueTitle: "Ship the thing",
      issueStatus: "done",
      costCents: 7_000,
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 50,
    },
  ]);
  mockCostsApi.byProvider.mockResolvedValue([]);
  mockCostsApi.byBiller.mockResolvedValue([]);
  mockCostsApi.financeSummary.mockResolvedValue({
    companyId: "company-1",
    debitCents: 0,
    creditCents: 0,
    netCents: 0,
    estimatedDebitCents: 0,
    eventCount: 0,
  });
  mockCostsApi.financeByBiller.mockResolvedValue([]);
  mockCostsApi.financeByKind.mockResolvedValue([]);
  mockCostsApi.financeEvents.mockResolvedValue([]);
  mockCostsApi.windowSpend.mockResolvedValue([]);
  mockCostsApi.quotaWindows.mockResolvedValue([]);
  mockBudgetsApi.overview.mockResolvedValue({
    policies: [],
    activeIncidents: [],
    pendingApprovalCount: 0,
    pausedAgentCount: 0,
    pausedProjectCount: 0,
  });
  mockIssuesApi.listShipped.mockResolvedValue(shippedFeed(METERED_MONTH));
}

describe("Costs page (UX-15)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    mockHappyApis();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
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
          <Costs />
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  function tabTriggers(): string[] {
    return [...container.querySelectorAll<HTMLElement>('[role="tab"]')].map((el) => el.textContent ?? "");
  }

  it("shows Overview + Advanced and what the money bought", async () => {
    await render();
    expect(tabTriggers()).toEqual(["Overview", "Advanced"]);
    expect(mockIssuesApi.listShipped).toHaveBeenCalledWith("company-1", expect.objectContaining({ limit: 1 }));

    const shipped = container.querySelector('[data-testid="shipped-count-tile"]')?.textContent ?? "";
    expect(shipped).toContain("Shipped this month");
    expect(shipped).toContain("3");
    const perPr = container.querySelector('[data-testid="cost-per-shipped-pr-tile"]')?.textContent ?? "";
    expect(perPr).toContain("$5.00");

    const byIssue = container.querySelector('[data-testid="by-issue-card"]')?.textContent ?? "";
    expect(byIssue).toContain("ACME-1");
    expect(byIssue).toContain("Ship the thing");
    expect(byIssue).toContain("$70.00");
    // Finance ledger is not on the first screen.
    expect(container.textContent).not.toContain("Finance ledger");
  });

  it("keeps the ledgers reachable under Advanced", async () => {
    await render();
    async function activateTab(label: string) {
      const tab = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
        (el) => el.textContent === label,
      );
      expect(tab, `tab ${label}`).toBeTruthy();
      // Radix triggers activate on mousedown (left button), not click.
      await act(async () => {
        tab!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      });
      await flush();
    }

    await activateTab("Advanced");
    expect(tabTriggers()).toEqual(
      expect.arrayContaining(["Budgets", "Providers", "Billers", "Finance"]),
    );
    await activateTab("Finance");
    expect(container.textContent).toContain("Finance ledger");
  });

  it("says 'Not measured' rather than $0 for unmetered shipped spend", async () => {
    mockIssuesApi.listShipped.mockResolvedValue(shippedFeed(UNMETERED_MONTH));
    mockCostsApi.byIssue.mockResolvedValue([]);
    mockCostsApi.summary.mockResolvedValue({
      companyId: "company-1",
      spendCents: 0,
      budgetCents: 0,
      utilizationPercent: 0,
      measured: false,
      pricedSpend: false,
    });
    await render();
    expect(container.querySelector('[data-testid="cost-per-shipped-pr-tile"]')?.textContent).toContain("Not measured");
    expect(container.querySelector('[data-testid="by-issue-card"]')?.textContent).toContain("Not measured.");
  });

  it("shows tokens, not $0.00, when shipped usage recorded no cents", async () => {
    mockIssuesApi.listShipped.mockResolvedValue(
      shippedFeed({
        since: "2026-09-01T00:00:00.000Z",
        count: 3,
        pullRequests: 3,
        usage: { metered: true, inputTokens: 1_200, cachedInputTokens: 0, outputTokens: 600, costCents: 0 },
      }),
    );
    mockCostsApi.byIssue.mockResolvedValue([
      {
        issueId: "issue-1",
        issueIdentifier: "ACME-1",
        issueTitle: "Ship the thing",
        issueStatus: "done",
        costCents: 0,
        inputTokens: 9_000,
        cachedInputTokens: 0,
        outputTokens: 3_000,
      },
    ]);
    await render();
    const perPr = container.querySelector('[data-testid="cost-per-shipped-pr-tile"]')?.textContent ?? "";
    expect(perPr).toContain("600 tokens");
    expect(perPr).not.toContain("$0.00");
    const byIssue = container.querySelector('[data-testid="by-issue-card"]')?.textContent ?? "";
    expect(byIssue).toContain("12.0k tokens");
    expect(byIssue).not.toContain("$0.00");
  });
});
