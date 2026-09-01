// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * This page renders the same unmeasured number in four places, and I have now
 * missed one of them twice: first the 3xl headline beside the gated tile, then
 * the "usage" token box beside the gated headline. Each miss shipped a page
 * reading "Not measured" next to "$0.00", which is worse than either alone
 * because it looks like a bug rather than a boundary.
 *
 * So the load-bearing assertion here is not "the tile says Not measured". It is
 * that NO formatted currency and NO token figure appears anywhere on the page
 * when nothing has been metered. A fifth surface added later fails this without
 * anyone having to remember it exists.
 */

const mockCostsApi = vi.hoisted(() => ({
  summary: vi.fn(),
  byAgent: vi.fn(),
  byProject: vi.fn(),
  byAgentModel: vi.fn(),
  byProvider: vi.fn(),
  byBiller: vi.fn(),
  windowSpend: vi.fn(),
  runActivity: vi.fn(),
  financeSummary: vi.fn(),
  financeByBiller: vi.fn(),
  financeByKind: vi.fn(),
  financeEvents: vi.fn(),
}));
vi.mock("../api/costs", () => ({ costsApi: mockCostsApi }));

const mockBudgetsApi = vi.hoisted(() => ({
  overview: vi.fn(),
  upsertPolicy: vi.fn(),
  resolveIncident: vi.fn(),
}));
vi.mock("../api/budgets", () => ({ budgetsApi: mockBudgetsApi }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", setSelectedCompanyId: vi.fn() }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../components/PageSkeleton", () => ({ PageSkeleton: () => <div>loading</div> }));
vi.mock("../components/Identity", () => ({ Identity: () => <span /> }));
vi.mock("../components/StatusBadge", () => ({ StatusBadge: () => <span /> }));

const { Costs } = await import("./Costs");

/**
 * Budgets are configured but spend is not metered — the combination that makes
 * a green "0% of monthly budget consumed" bar, which is the most actionable
 * false claim the page can make.
 */
function budgetOverview() {
  return {
    activeIncidents: [],
    policies: [],
    pausedAgentCount: 0,
    pausedProjectCount: 0,
  };
}

function setup(measured: boolean, budgetCents: number) {
  mockCostsApi.summary.mockResolvedValue({
    companyId: "company-1",
    spendCents: measured ? 12_345 : 0,
    budgetCents,
    utilizationPercent: measured && budgetCents > 0 ? 25 : 0,
    measured,
  });
  mockCostsApi.byAgent.mockResolvedValue(
    measured
      ? [{ agentId: "a1", agentName: "CoS", costCents: 12_345, inputTokens: 900, cachedInputTokens: 0, outputTokens: 100 }]
      : [],
  );
  mockCostsApi.byProject.mockResolvedValue([]);
  mockCostsApi.byAgentModel.mockResolvedValue([]);
  mockCostsApi.byProvider.mockResolvedValue([]);
  mockCostsApi.byBiller.mockResolvedValue([]);
  mockCostsApi.windowSpend.mockResolvedValue([]);
  // Runs are recorded regardless of whether spend is. That is the whole point:
  // 69 runs happened on uat while zero cost events did.
  mockCostsApi.runActivity.mockResolvedValue({
    companyId: "company-1",
    totalRuns: 69,
    succeededRuns: 61,
    failedRuns: 8,
    totalSeconds: 2_829,
    medianSeconds: 41,
    p90Seconds: 96,
    lastRunAt: null,
  });
  // Finance is invoices and credits, not token-derived, so it is genuinely
  // measurable and stays as it is. Zeroes here are real zeroes.
  mockCostsApi.financeSummary.mockResolvedValue({
    netCents: 0, debitCents: 0, creditCents: 0, eventCount: 0, estimatedDebitCents: 0,
  });
  mockCostsApi.financeByBiller.mockResolvedValue([]);
  mockCostsApi.financeByKind.mockResolvedValue([]);
  mockCostsApi.financeEvents.mockResolvedValue([]);
  mockBudgetsApi.overview.mockResolvedValue(budgetOverview());
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
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
  for (let i = 0; i < 25; i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
  return container.textContent ?? "";
}

/**
 * The finance tiles legitimately render $0.00 — invoices and credits are not
 * token-derived, so a zero there is a real zero — which is why this is scoped
 * to the two inference regions rather than asserting over the whole page.
 */
function inferenceRegion(): string {
  const tile = container.querySelector('[data-testid="inference-spend-tile"]');
  const ledger = container.querySelector('[data-testid="inference-ledger-card"]');
  expect(tile, "the inference-spend tile should be on the page").not.toBeNull();
  expect(ledger, "the inference ledger card should be on the page").not.toBeNull();
  return `${tile?.textContent ?? ""} ${ledger?.textContent ?? ""}`;
}

describe("Costs when nothing is metered", () => {
  it("shows no inference currency figure at all", async () => {
    setup(false, 0);
    await render();
    const region = inferenceRegion();
    expect(region).toContain("Not measured");
    expect(region, "a formatted zero standing in for an unknown").not.toMatch(/\$0\.00/);
  });

  it("shows no token figure either", async () => {
    // The "usage" box beside the headline was the surface missed second time
    // round. It formats the same empty table.
    //
    // Asserted against the box itself. The first version of this test searched
    // the region for "0 tokens" — but the box renders a bare "0", so it passed
    // against an ungated implementation, which is the same failure it was
    // written to catch.
    setup(false, 0);
    await render();
    const usage = container.querySelector('[data-testid="inference-usage-tokens"]');
    expect(usage, "the usage box should still be on the page").not.toBeNull();
    expect(usage?.textContent?.trim()).toBe("—");
  });

  it("does not report budget headroom it cannot know", async () => {
    // A cap of $500 is real. How much of it is gone is not, and "$0.00 of
    // $500.00" reads as headroom the owner does not actually have.
    setup(false, 50_000);
    const text = await render();
    expect(text).not.toContain("0% of monthly budget consumed");
    expect(text).not.toMatch(/\$0\.00 of \$500\.00/);
    // The cap itself is still stated — it is a real configured value.
    expect(text).toContain("$500.00");
    expect(text).toContain("not measured");
  });
});

describe("Costs shows what it does know", () => {
  it("reports run counts and wall-clock beside the unmeasured spend", async () => {
    // Without this the page can only say what it does not know, which reads as
    // though nothing is happening — untrue, and its own kind of false claim.
    setup(false, 0);
    await render();
    const strip = container.querySelector('[data-testid="run-activity-strip"]');
    expect(strip, "run activity should render even when spend cannot").not.toBeNull();
    const text = strip?.textContent ?? "";
    expect(text).toContain("69");
    expect(text).toContain("61");
    expect(text).toContain("41s");
  });

  it("renders nothing rather than a row of dashes when there are no runs", async () => {
    // An empty strip would put the page back where it started.
    setup(false, 0);
    mockCostsApi.runActivity.mockResolvedValue({
      companyId: "company-1",
      totalRuns: 0,
      succeededRuns: 0,
      failedRuns: 0,
      totalSeconds: 0,
      medianSeconds: null,
      p90Seconds: null,
      lastRunAt: null,
    });
    await render();
    expect(container.querySelector('[data-testid="run-activity-strip"]')).toBeNull();
  });
});

describe("Costs when spend is metered", () => {
  it("shows the real figures", async () => {
    // The control case. Without it, a page that never renders a number would
    // satisfy every assertion above.
    setup(true, 50_000);
    const text = await render();
    const region = inferenceRegion();
    expect(region).not.toContain("Not measured");
    expect(region).toContain("$123.45");
    expect(container.querySelector('[data-testid="inference-usage-tokens"]')?.textContent?.trim())
      .not.toBe("—");
    expect(text).toContain("25%");
    expect(text).toContain("of monthly budget consumed");
  });
});
