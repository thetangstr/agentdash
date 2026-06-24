// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardHarnessHealth, DashboardTaskOutcomeQuality } from "@paperclipai/shared";
import { CompanyHealth } from "./CompanyHealth";

const summaryMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/dashboard", () => ({
  dashboardApi: {
    summary: (companyId: string) => summaryMock(companyId),
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP" },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const harness: DashboardHarnessHealth = {
  windowHours: 24,
  overallStatus: "critical",
  totalRuns: 5,
  failedRuns: 3,
  failureRatePercent: 60,
  adapters: [
    {
      adapterType: "codex_local",
      status: "critical",
      totalRuns: 4,
      failedRuns: 3,
      failureRatePercent: 75,
      affectedAgents: 2,
      latestFailureAt: "2026-05-29T16:00:00.000Z",
      topFailureCategory: "rate_limited",
    },
  ],
};

const taskQuality: DashboardTaskOutcomeQuality = {
  windowDays: 30,
  issuesInScope: 4,
  issuesWithDefinitionOfDone: 3,
  dodCoveragePercent: 75,
  reviewedIssues: 2,
  passedIssues: 1,
  failedIssues: 1,
  revisionRequestedIssues: 0,
  escalatedIssues: 0,
  unreviewedDoneIssues: 1,
  acceptanceRatePercent: 50,
  greenRunsPendingReview: 1,
  greenRunsWithOpenTasks: 1,
  issueLinkedSpendCents: 2300,
  issueLinkedTokens: 2600,
  spendPerAcceptedIssueCents: 2300,
};

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("CompanyHealth", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    summaryMock.mockReset();
    summaryMock.mockResolvedValue({ harness, taskQuality });
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the harness health and task outcome quality panels", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      createRoot(container).render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <CompanyHealth />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(summaryMock).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("Harness health");
    expect(container.textContent).toContain("Task outcome quality");
  });
});
