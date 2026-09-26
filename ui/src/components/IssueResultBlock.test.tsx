// @vitest-environment jsdom
// AgentDash: UX-2 (#783) — the Result block on issue detail.

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShippedWorkProduct } from "@paperclipai/shared";

const mockIssuesApi = vi.hoisted(() => ({ listShipped: vi.fn() }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));

const mockCompany = vi.hoisted(() => ({ current: { id: "company-1" } as Record<string, unknown> }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: mockCompany.current }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

const { IssueResultBlock } = await import("./IssueResultBlock");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function shippedItem(overrides: Partial<ShippedWorkProduct> = {}): ShippedWorkProduct {
  return {
    id: "wp-1",
    companyId: "company-1",
    projectId: null,
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "pull_request",
    provider: "github",
    externalId: "12",
    title: "PR #12 health badge",
    url: "https://github.com/acme/web/pull/12",
    status: "merged",
    reviewState: "none",
    isPrimary: true,
    healthStatus: "unknown",
    summary: null,
    metadata: null,
    createdByRunId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    issue: { id: "issue-1", identifier: "ACME-1", title: "Add a health badge", status: "done", projectId: null },
    agent: { id: "agent-1", name: "Maya" },
    usage: { metered: true, inputTokens: 12_000, cachedInputTokens: 0, outputTokens: 400, costCents: 0 },
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("IssueResultBlock", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockCompany.current = { id: "company-1" };
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
          <IssueResultBlock companyId="company-1" issueId="issue-1" />
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  it("shows the PR link, its state, the agent and the issue's usage", async () => {
    mockIssuesApi.listShipped.mockResolvedValue({ items: [shippedItem()], total: 1, nextCursor: null, monthTotal: null });
    await render();
    expect(mockIssuesApi.listShipped).toHaveBeenCalledWith("company-1", { issueId: "issue-1" });
    const block = container.querySelector('[data-testid="issue-result-block"]');
    expect(block?.textContent).toContain("Result");
    const link = container.querySelector('a[href="https://github.com/acme/web/pull/12"]');
    expect(link?.textContent).toContain("PR #12 health badge");
    expect(container.querySelector('[data-testid="work-product-state"]')?.textContent).toBe("merged");
    expect(block?.textContent).toContain("Maya");
    expect(block?.textContent).toContain("12.4k tokens");
  });

  it("says 'not metered yet' rather than 0 when the issue has no metering", async () => {
    mockIssuesApi.listShipped.mockResolvedValue({
      items: [
        shippedItem({
          status: "ready_for_review",
          usage: { metered: false, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costCents: 0 },
        }),
      ],
      nextCursor: null,
      monthTotal: null,
    });
    await render();
    expect(container.textContent).toContain("not metered yet");
    expect(container.textContent).not.toMatch(/\b0 tokens|\$0\.00/);
    expect(container.querySelector('[data-testid="work-product-state"]')?.textContent).toBe("open");
  });

  it("renders nothing when the issue has no work products", async () => {
    mockIssuesApi.listShipped.mockResolvedValue({ items: [], total: 1, nextCursor: null, monthTotal: null });
    await render();
    expect(container.innerHTML).toBe("");
  });

  it("does not render or fetch on the agentdash_mk profile", async () => {
    mockCompany.current = { id: "company-1", productProfile: "agentdash_mk" };
    mockIssuesApi.listShipped.mockResolvedValue({ items: [shippedItem()], total: 1, nextCursor: null, monthTotal: null });
    await render();
    expect(mockIssuesApi.listShipped).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe("");
  });
});
