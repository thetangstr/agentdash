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
const { isUsageCounting, usageCountingEndsAt, USAGE_COUNTING_WINDOW_MS } = await import("../lib/shipped");
const { isIssueShippedQueryForRun } = await import("../context/LiveUpdatesProvider");

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
    document: null,
    creatingRunMeteringStatus: null,
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

  async function render(props: Partial<Parameters<typeof IssueResultBlock>[0]> = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <IssueResultBlock companyId="company-1" issueId="issue-1" {...props} />
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  const waitingItem = () =>
    shippedItem({
      type: "document",
      url: null,
      status: "ready_for_review",
      reviewState: "needs_board_review",
      issue: { id: "issue-1", identifier: "ACME-1", title: "Add a health badge", status: "in_review", projectId: null },
    });

  function setTextarea(el: HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("offers Accept and Request changes to a board user when a deliverable waits for review", async () => {
    mockIssuesApi.listShipped.mockResolvedValue({ items: [waitingItem()], total: 1, nextCursor: null, monthTotal: null });
    const onAccept = vi.fn().mockResolvedValue(undefined);
    const onRequestChanges = vi.fn().mockResolvedValue(undefined);
    await render({ issueStatus: "in_review", review: { onAccept, onRequestChanges } });

    const accept = container.querySelector<HTMLButtonElement>('[data-testid="issue-review-accept"]');
    expect(accept?.textContent).toBe("Accept");
    await act(async () => accept!.click());
    await flush();
    expect(onAccept).toHaveBeenCalledTimes(1);

    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="issue-review-request-changes"]')!.click());
    const send = container.querySelector<HTMLButtonElement>('[data-testid="issue-review-send-changes"]')!;
    expect(send.disabled).toBe(true);
    await act(async () => setTextarea(container.querySelector<HTMLTextAreaElement>('[data-testid="issue-review-note"]')!, "  Add Kyoto prices  "));
    expect(send.disabled).toBe(false);
    await act(async () => send.click());
    await flush();
    expect(onRequestChanges).toHaveBeenCalledWith("Add Kyoto prices");
  });

  // AgentDash (batch 2 review lane): while the issue shows "Live" a run may
  // still write the revision being accepted — the controls stay hidden.
  it("hides the review controls while the issue is live, and shows them again once it is not", async () => {
    mockIssuesApi.listShipped.mockResolvedValue({ items: [waitingItem()], total: 1, nextCursor: null, monthTotal: null });
    const review = { onAccept: vi.fn(), onRequestChanges: vi.fn() };
    await render({ issueStatus: "in_review", issueLive: true, review });
    expect(container.querySelector('[data-testid="issue-review-actions"]')).toBeNull();
    expect(review.onAccept).not.toHaveBeenCalled();

    await render({ issueStatus: "in_review", issueLive: false, review });
    expect(container.querySelector('[data-testid="issue-review-accept"]')).not.toBeNull();
  });

  it("shows no review actions without board access, or once the issue is done", async () => {
    mockIssuesApi.listShipped.mockResolvedValue({ items: [waitingItem()], total: 1, nextCursor: null, monthTotal: null });
    await render({ issueStatus: "in_review", review: null });
    expect(container.querySelector('[data-testid="issue-review-actions"]')).toBeNull();

    await render({ issueStatus: "done", review: { onAccept: vi.fn(), onRequestChanges: vi.fn() } });
    expect(container.querySelector('[data-testid="issue-review-actions"]')).toBeNull();
  });

  it("shows the error and keeps the actions when accepting fails", async () => {
    mockIssuesApi.listShipped.mockResolvedValue({ items: [waitingItem()], total: 1, nextCursor: null, monthTotal: null });
    const onAccept = vi.fn().mockRejectedValue(new Error("Issue update failed"));
    await render({ issueStatus: "in_review", review: { onAccept, onRequestChanges: vi.fn() } });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="issue-review-accept"]')!.click());
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Issue update failed");
    expect(container.querySelector('[data-testid="issue-review-accept"]')).not.toBeNull();
  });

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

  // Scan 4 lane O1: right after a run, "not measured" read as an error.
  it("says 'counting…' while a just-saved deliverable's usage is still being recorded", async () => {
    mockIssuesApi.listShipped.mockResolvedValueOnce({
      items: [
        shippedItem({
          status: "ready_for_review",
          createdByRunId: "run-1",
          issue: { id: "issue-1", identifier: "ACME-1", title: "Add a health badge", status: "in_review", projectId: null },
          usage: { metered: false, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costCents: 0 },
        }),
      ],
      total: 1,
      nextCursor: null,
      monthTotal: null,
    });
    await render();
    const usage = () => container.querySelector('[data-testid="issue-result-usage"]')?.textContent;
    expect(usage()).toBe("counting…");
    expect(container.textContent).not.toContain("not measured");
  });

  it("never says 'counting…' for a deliverable no run created, or one created long ago and edited since", () => {
    const unmetered = { metered: false, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costCents: 0 };
    const now = Date.now();
    // Recorded by hand: no run will ever meter it.
    expect(isUsageCounting(unmetered, [{ createdAt: new Date(now), createdByRunId: null }], now)).toBe(false);
    // Created an hour ago by a run; a later edit does not reopen the window.
    expect(
      isUsageCounting(unmetered, [{ createdAt: new Date(now - 60 * 60 * 1000), createdByRunId: "run-1" }], now),
    ).toBe(false);
    // Fresh and run-created: counting, until the window closes.
    const createdAt = new Date(now - 60_000);
    expect(isUsageCounting(unmetered, [{ createdAt, createdByRunId: "run-1" }], now)).toBe(true);
    expect(usageCountingEndsAt([{ createdAt, createdByRunId: "run-1" }], now)).toBe(createdAt.getTime() + USAGE_COUNTING_WINDOW_MS);
    expect(isUsageCounting({ ...unmetered, metered: true }, [{ createdAt, createdByRunId: "run-1" }], now)).toBe(false);
  });

  it("refetches only the shipped query of the issue whose deliverable the finished run created", () => {
    const data = { items: [{ createdByRunId: "run-1" }] };
    expect(isIssueShippedQueryForRun(["shipped", "company-1", "", "", "issue-1", "", ""], data, "company-1", "run-1")).toBe(true);
    expect(isIssueShippedQueryForRun(["shipped", "company-1", "", "", "issue-1", "", ""], data, "company-1", "run-2")).toBe(false);
    // The company-wide Shipped feed is not issue-scoped.
    expect(isIssueShippedQueryForRun(["shipped", "company-1", "", "", "", "", ""], data, "company-1", "run-1")).toBe(false);
    expect(isIssueShippedQueryForRun(["shipped", "company-2", "", "", "issue-1", "", ""], data, "company-1", "run-1")).toBe(false);
  });

  it("says 'not measured' rather than 0 when the issue has no metering", async () => {
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    mockIssuesApi.listShipped.mockResolvedValue({
      items: [
        shippedItem({
          createdAt: anHourAgo,
          updatedAt: anHourAgo,
          status: "ready_for_review",
          issue: { id: "issue-1", identifier: "ACME-1", title: "Add a health badge", status: "in_review", projectId: null },
          usage:{ metered: false, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costCents: 0 },
        }),
      ],
      nextCursor: null,
      monthTotal: null,
    });
    await render();
    expect(container.textContent).toContain("not measured");
    expect(container.textContent).not.toMatch(/\b0 tokens|\$0\.00/);
    expect(container.querySelector('[data-testid="work-product-state"]')?.textContent).toBe("open");
  });

  // AgentDash (batch 3): a document revision landing after the product row
  // was recorded must freshen the row's "when" — "6m ago" next to "rev 2",
  // not the stale "10m ago" of the work-product record.
  it("ages a document deliverable from its newest revision, not its record", async () => {
    mockIssuesApi.listShipped.mockResolvedValue({
      items: [
        shippedItem({
          type: "document",
          url: null,
          title: "Competitor scan",
          status: "ready_for_review",
          createdAt: new Date(Date.now() - 10 * 60 * 1000),
          document: { key: "scan", latestRevisionNumber: 2, updatedAt: new Date(Date.now() - 6 * 60 * 1000).toISOString() },
        }),
      ],
      total: 1,
      nextCursor: null,
      monthTotal: null,
    });
    await render();
    const block = container.querySelector('[data-testid="issue-result-block"]');
    expect(block?.textContent).toContain("6m ago");
    expect(block?.textContent).not.toContain("10m ago");
  });

  it("renders nothing when the issue has no work products", async () => {
    mockIssuesApi.listShipped.mockResolvedValue({ items: [], total: 1, nextCursor: null, monthTotal: null });
    await render();
    expect(container.innerHTML).toBe("");
  });
});
