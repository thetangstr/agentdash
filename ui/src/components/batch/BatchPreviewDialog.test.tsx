// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BatchPreviewResult, BatchView } from "@paperclipai/shared";

/**
 * AgentDash admin powers: the shared batch dialog. It previews in plain
 * words, applies, polls, and shows every outcome a record can have.
 */

const mockBatchesApi = vi.hoisted(() => ({ preview: vi.fn(), confirm: vi.fn(), get: vi.fn(), cancel: vi.fn() }));
vi.mock("../../api/batches", () => ({ batchesApi: mockBatchesApi }));

const { BatchPreviewDialog } = await import("./BatchPreviewDialog");
const { ApiError } = await import("../../api/client");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const PREVIEW: BatchPreviewResult = {
  batchId: "batch-1",
  previewDigest: "d".repeat(64),
  confirmHandle: "handle-handle-handle",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  kind: "issue.update",
  items: [
    { itemId: "i1", entityType: "issue", entityId: "a", label: "ENG-1 Fix login", before: { status: "todo", priority: "low" }, after: { status: "done", priority: "low" } },
    { itemId: "i2", entityType: "issue", entityId: "b", label: "ENG-2 Old task", before: { status: "done" }, after: { status: "todo" }, notes: ["Moving it out of done reopens it."] },
  ],
  omitted: { notFound: 1, noop: 2, notDecidable: 1 },
  notDecidable: [{ entityType: "issue", entityId: "c", label: "ENG-3", reasonCode: "goes_to_review_first", reason: "ENG-3 goes to review first, so it was left out." }],
};

function item(itemId: string, label: string, outcome: string, extra: Record<string, unknown> = {}) {
  return {
    itemId, ordinal: 0, entityType: "issue", entityId: itemId, label, before: { status: "todo" }, after: { status: "done" },
    outcome, reasonCode: null, reason: null, httpStatus: 200, actual: null, appliedAt: null, reconciledVerdict: null, reconciledAt: null, ...extra,
  };
}

const FINISHED: BatchView = {
  id: "batch-1", companyId: "company-1", kind: "issue.update", change: { status: "done" }, origin: "ui", status: "completed",
  createdByUserId: "u", itemCount: 5, counts: { applied: 2, refused: 1, failed: 1, unknown: 1, appliedDifferently: 1 },
  expiresAt: new Date().toISOString(), confirmedAt: new Date().toISOString(), completedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
  items: [
    item("r1", "ENG-1 Fix login", "applied", { actual: { status: "done" } }),
    item("r2", "ENG-4 Review me", "applied", { reasonCode: "applied_differently", reason: "ENG-4 was changed, but not as previewed: status is in_review, not done.", actual: { status: "in_review" } }),
    item("r3", "ENG-5 Busy", "refused", { reasonCode: "changed_since_preview", reason: "This task changed after you previewed it, so nothing was done to it.", httpStatus: null }),
    item("r4", "ENG-6 Broken", "failed", { reason: "ENG-6 was not changed: the server reported an error.", httpStatus: 500 }),
    item("r5", "ENG-7 Slow", "unknown", { reason: "No answer came back for ENG-7.", httpStatus: null }),
  ] as never,
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  mockBatchesApi.cancel.mockResolvedValue({});
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

async function flush(times = 10) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const statusWords: Record<string, string> = { todo: "To do", done: "Done", in_review: "In review" };

async function render(props: Partial<Parameters<typeof BatchPreviewDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  const onFinished = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <BatchPreviewDialog
          open
          onOpenChange={onOpenChange}
          companyId="company-1"
          title="Change tasks"
          kind="issue.update"
          ids={["a", "b", "c"]}
          change={{ status: "done" }}
          noun={{ one: "task", many: "tasks" }}
          formatField={(field, value) => (field === "status" ? { label: "Status", value: statusWords[String(value)] ?? String(value) } : null)}
          onFinished={onFinished}
          pollIntervalMs={10}
          {...props}
        />
      </QueryClientProvider>,
    );
  });
  await flush();
  return { onOpenChange, onFinished };
}

const text = () => document.body.textContent ?? "";
const byTestId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function click(el: Element | null) {
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

describe("BatchPreviewDialog", () => {
  it("previews each record in plain words, with notes and what was left out and why", async () => {
    mockBatchesApi.preview.mockResolvedValue(PREVIEW);
    await render();
    expect(mockBatchesApi.preview).toHaveBeenCalledWith("company-1", { kind: "issue.update", ids: ["a", "b", "c"], change: { status: "done" } });
    expect(text()).toContain("Nothing has changed yet");
    expect(byTestId("batch-preview-summary")!.textContent).toBe("2 tasks will change.");
    const items = byTestId("batch-preview-items")!.textContent!;
    expect(items).toContain("ENG-1 Fix login");
    expect(items).toContain("Status: To do → Done");
    expect(items).not.toContain("priority");
    expect(items).toContain("Moving it out of done reopens it.");
    expect(text()).toContain("2 tasks already look like this, so they are left out.");
    expect(text()).toContain("1 task could not be found or you cannot see them");
    expect(byTestId("batch-not-decidable")!.textContent).toContain("ENG-3 goes to review first, so it was left out.");
    expect(byTestId("batch-apply")!.textContent).toBe("Apply to 2 tasks");
    // Plain words only: no internal ids or reason codes on the page.
    expect(text()).not.toMatch(/goes_to_review_first|batch-1|issue\.update/);
  });

  it("applies, polls until the batch ends, and shows every outcome, including applied differently and unknown", async () => {
    mockBatchesApi.preview.mockResolvedValue(PREVIEW);
    mockBatchesApi.confirm.mockResolvedValue({ batchId: "batch-1", status: "running" });
    mockBatchesApi.get
      .mockResolvedValueOnce({ ...FINISHED, status: "running", counts: { applied: 0, refused: 0, failed: 0, unknown: 0 }, items: [] })
      .mockResolvedValue(FINISHED);
    const { onFinished, onOpenChange } = await render();
    await click(byTestId("batch-apply"));
    await flush(30);
    expect(mockBatchesApi.confirm).toHaveBeenCalledWith("company-1", "batch-1", { handle: "handle-handle-handle", previewDigest: "d".repeat(64) });
    expect(mockBatchesApi.get.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(byTestId("batch-result-summary")!.textContent).toContain("2 changed (1 not as previewed), 1 not changed, 1 failed, 1 unknown");
    const rows = [...document.body.querySelectorAll<HTMLElement>('[data-testid="batch-result-row"]')];
    expect(rows.map((row) => row.dataset.outcome)).toEqual(["applied", "applied_differently", "refused", "failed", "unknown"]);
    expect(rows[0]!.textContent).toContain("Changed");
    expect(rows[1]!.textContent).toContain("Changed, but not as previewed");
    expect(rows[1]!.textContent).toContain("It is now:");
    expect(rows[1]!.textContent).toContain("Status: Done → In review");
    expect(rows[2]!.textContent).toContain("This task changed after you previewed it, so nothing was done to it.");
    expect(rows[3]!.textContent).toContain("Failed: nothing was changed");
    expect(rows[4]!.textContent).toContain("Unknown: it may or may not have changed");
    expect(rows[4]!.textContent).toContain("never retried automatically");
    await click([...document.body.querySelectorAll("button")].find((b) => b.textContent === "Close")!);
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockBatchesApi.cancel).not.toHaveBeenCalled();
  });

  it("an expired preview says so plainly and offers to preview again", async () => {
    mockBatchesApi.preview.mockResolvedValue(PREVIEW);
    mockBatchesApi.confirm.mockRejectedValue(new ApiError("This preview was already used or has expired. Preview the change again.", 409, null));
    await render();
    await click(byTestId("batch-apply"));
    expect(byTestId("batch-error")!.textContent).toContain("expired or was already used, so nothing was changed");
    await click([...document.body.querySelectorAll("button")].find((b) => b.textContent === "Preview again")!);
    expect(mockBatchesApi.preview).toHaveBeenCalledTimes(2);
  });

  it("says how many were selected and how many fit when the selection is over 200", async () => {
    mockBatchesApi.preview.mockResolvedValue({ ...PREVIEW, items: [] , batchId: null });
    const ids = Array.from({ length: 230 }, (_, i) => `id-${i}`);
    await render({ ids });
    expect(byTestId("batch-cap-notice")!.textContent).toBe("You selected 230 tasks. One batch holds 200, so the first 200 are included.");
    expect(mockBatchesApi.preview.mock.calls[0]![1].ids).toHaveLength(200);
  });

  it("closing an unapplied preview cancels it", async () => {
    mockBatchesApi.preview.mockResolvedValue(PREVIEW);
    const { onOpenChange } = await render();
    await click([...document.body.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!);
    expect(mockBatchesApi.cancel).toHaveBeenCalledWith("company-1", "batch-1");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows gains in green with '+' and losses in red with '−' for policy records, readable without colour", async () => {
    const policy = { permissions: ["*"], monthlyBudgetCents: 10_000, destructiveActions: "approval_required", dataScopes: ["*"], providers: ["slack", "teams"], minimumApproval: "steward", revision: 3 };
    mockBatchesApi.preview.mockResolvedValue({
      ...PREVIEW,
      kind: "agent.apply_ceiling",
      items: [{ itemId: "i1", entityType: "agent", entityId: "a", label: "Ada", before: policy, after: { ...policy, monthlyBudgetCents: 20_000, providers: ["slack"] },
        notes: ["Gains: Budget: up to $200 a month (was up to $100 a month)", "Loses: Providers: loses teams", "Anything it holds above the new ceiling is brought down at once."] }],
      notDecidable: [],
    });
    const { describePolicyChange } = await import("./policy-diff");
    await render({ kind: "agent.apply_ceiling", describeItem: describePolicyChange });
    const lines = [...document.body.querySelectorAll<HTMLElement>('[data-testid="batch-gains-losses"] li')];
    expect(lines.map((line) => [line.dataset.kind, line.textContent])).toEqual([
      ["gain", "+ Gains: Budget: up to $200 a month (was up to $100 a month)"],
      ["loss", "− Loses: Providers: loses teams"],
    ]);
    expect(lines[0]!.className).toContain("green");
    expect(lines[1]!.className).toContain("red");
    // The consequence note stays; the gains and losses are not printed twice.
    expect(text()).toContain("Anything it holds above the new ceiling is brought down at once.");
    expect(text().match(/Loses: Providers: loses teams/g)).toHaveLength(1);
  });
});
