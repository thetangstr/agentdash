// @vitest-environment jsdom
// AgentDash: UX-2 (#783) — the Shipped page: populated, empty, unmetered.

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShippedFeed, ShippedWorkProduct } from "@paperclipai/shared";

const mockIssuesApi = vi.hoisted(() => ({ listShipped: vi.fn() }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("../api/projects", () => ({ projectsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1" } }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../components/PageSkeleton", () => ({ PageSkeleton: () => <div>loading</div> }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

const { Shipped, SHIPPED_EMPTY_TEXT } = await import("./Shipped");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const UNMETERED = { metered: false, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costCents: 0 };

function item(id: string, overrides: Partial<ShippedWorkProduct> = {}): ShippedWorkProduct {
  return {
    id,
    companyId: "company-1",
    projectId: null,
    issueId: `issue-${id}`,
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "pull_request",
    provider: "github",
    externalId: null,
    title: `PR ${id}`,
    url: `https://github.com/acme/web/pull/${id}`,
    status: "merged",
    reviewState: "none",
    isPrimary: true,
    healthStatus: "unknown",
    summary: null,
    metadata: null,
    createdByRunId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    issue: { id: `issue-${id}`, identifier: `ACME-${id}`, title: `Issue ${id}`, status: "done", projectId: null },
    agent: { id: "agent-1", name: "Maya" },
    usage: { metered: true, inputTokens: 2_000, cachedInputTokens: 0, outputTokens: 500, costCents: 0 },
    ...overrides,
  };
}

function feed(items: ShippedWorkProduct[], monthUsage = UNMETERED): ShippedFeed {
  return {
    items,
    total: items.length,
    nextCursor: null,
    monthTotal: {
      since: "2026-09-01T00:00:00.000Z",
      count: items.length,
      pullRequests: items.filter((i) => i.type === "pull_request").length,
      usage: monthUsage,
    },
  };
}

async function flush() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

describe("Shipped page", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
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
          <Shipped />
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  it("lists work products in server order with issue, agent and usage, and the month total", async () => {
    mockIssuesApi.listShipped.mockResolvedValue(
      feed([item("2"), item("1", { type: "document", url: null, status: "active", summary: "Changelog draft" })], {
        metered: true,
        inputTokens: 4_000,
        cachedInputTokens: 0,
        outputTokens: 1_000,
        costCents: 0,
      }),
    );
    await render();
    expect(mockIssuesApi.listShipped).toHaveBeenCalledWith("company-1", expect.objectContaining({ limit: 50 }));
    const rows = [...container.querySelectorAll('[data-testid="shipped-row"]')];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("PR 2");
    expect(rows[0]!.querySelector('a[href="https://github.com/acme/web/pull/2"]')).not.toBeNull();
    expect(rows[0]!.querySelector('a[href="/issues/ACME-2"]')?.textContent).toContain("Issue 2");
    expect(rows[0]!.textContent).toContain("Maya");
    expect(rows[0]!.textContent).toContain("2.5k tokens");
    expect(rows[1]!.textContent).toContain("Changelog draft");
    const month = container.querySelector('[data-testid="shipped-month-total"]')?.textContent ?? "";
    expect(month).toContain("September: 2 shipped (1 pull request)");
    expect(month).toContain("5.0k tokens");
  });

  it("shows the plan's empty state with one action when nothing has shipped", async () => {
    mockIssuesApi.listShipped.mockResolvedValue(feed([]));
    await render();
    const empty = container.querySelector('[data-testid="shipped-empty"]');
    expect(empty?.textContent).toContain(SHIPPED_EMPTY_TEXT);
    expect(empty?.querySelector('a[href="/dashboard"]')?.textContent).toBe("See what's running");
  });

  it("says 'not metered yet' instead of $0 or 0 tokens for unmetered issues and months", async () => {
    mockIssuesApi.listShipped.mockResolvedValue(feed([item("3", { usage: UNMETERED })]));
    await render();
    expect(container.querySelector('[data-testid="shipped-usage"]')?.textContent).toBe("not metered yet");
    expect(container.querySelector('[data-testid="shipped-month-total"]')?.textContent).toContain("not metered yet");
    expect(container.textContent).not.toMatch(/\$0\.00|\b0 tokens/);
  });

  it("shows dollars only when the ledger actually recorded some", async () => {
    mockIssuesApi.listShipped.mockResolvedValue(
      feed([item("4", { usage: { metered: true, inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 0, costCents: 123 } })]),
    );
    await render();
    expect(container.querySelector('[data-testid="shipped-usage"]')?.textContent).toBe("1.0k tokens · $1.23");
  });
});
