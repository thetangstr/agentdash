// @vitest-environment jsdom
//
// AgentDash admin powers (part 5): the review page of a batch the person's
// own Claude prepared. The code appears only after "Show code for Claude",
// only in the page (never the URL, browser storage or the console), and
// "Apply here" spends the same batch.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BatchView } from "@paperclipai/shared";

const mockBatchesApi = vi.hoisted(() => ({ get: vi.fn(), confirmCode: vi.fn(), applyHere: vi.fn() }));
vi.mock("@/api/batches", () => ({ batchesApi: mockBatchesApi }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));

const { BatchReview } = await import("./BatchReview");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CODE = "K7QM-3XRD";

function batch(overrides: Partial<BatchView> = {}): BatchView {
  return {
    id: "batch-1",
    companyId: "company-1",
    kind: "issue.update",
    change: { priority: "high" },
    origin: "assistant",
    status: "previewed",
    createdByUserId: "user-1",
    itemCount: 2,
    counts: { applied: 0, refused: 0, failed: 0, unknown: 0, appliedDifferently: 0 },
    expiresAt: new Date(Date.now() + 14 * 60_000).toISOString(),
    confirmedAt: null,
    completedAt: null,
    createdAt: new Date().toISOString(),
    assistantClientName: "Claude",
    items: [
      { itemId: "i1", ordinal: 0, entityType: "issue", entityId: "a", label: "ENG-1 Fix login", before: { priority: "medium" }, after: { priority: "high" }, outcome: "pending", reasonCode: null, reason: null, httpStatus: null, actual: null, appliedAt: null, reconciledVerdict: null, reconciledAt: null },
      { itemId: "i2", ordinal: 1, entityType: "issue", entityId: "b", label: "ENG-2 Fix signup", before: { priority: "low" }, after: { priority: "high" }, outcome: "pending", reasonCode: null, reason: null, httpStatus: null, actual: null, appliedAt: null, reconciledVerdict: null, reconciledAt: null },
    ],
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  for (const method of ["log", "info", "warn", "error", "debug"] as const) consoleSpies.push(vi.spyOn(console, method));
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  for (const spy of consoleSpies.splice(0)) spy.mockRestore();
  vi.clearAllMocks();
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/company/batches/batch-1"]}>
          <Routes>
            <Route path="/company/batches/:batchId" element={<BatchReview />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
  await flush();
  return client;
}

const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`);

async function click(id: string) {
  await act(async () => {
    (byTestId(id) as HTMLButtonElement).click();
  });
  await flush();
  await flush();
}

describe("BatchReview", () => {
  it("previewed: every record's before and after, the time left, and no code until asked", async () => {
    mockBatchesApi.get.mockResolvedValue(batch());
    await render();
    expect(mockBatchesApi.get).toHaveBeenCalledWith("company-1", "batch-1");
    expect(byTestId("batch-review-page")?.getAttribute("data-status")).toBe("previewed");
    expect(byTestId("batch-review-status")?.textContent).toMatch(/Nothing has changed yet. This preview expires in 14 minutes/);
    const items = container.querySelectorAll('[data-testid="batch-review-item"]');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("ENG-1 Fix login");
    expect(items[0]!.textContent).toMatch(/priority:.*medium → high/);
    expect(byTestId("batch-review-code")).toBeNull();
    expect(mockBatchesApi.confirmCode).not.toHaveBeenCalled();
    expect(container.textContent).toContain("prepared by Claude");
  });

  it("shows the code only after the click, keeps it out of the URL, storage and console, and a new code replaces it", async () => {
    mockBatchesApi.get.mockResolvedValue(batch());
    mockBatchesApi.confirmCode.mockResolvedValueOnce({ code: CODE, expiresAt: batch().expiresAt });
    const client = await render();
    await click("batch-review-show-code");
    expect(mockBatchesApi.confirmCode).toHaveBeenCalledWith("company-1", "batch-1");
    expect(byTestId("batch-review-code")?.textContent).toBe(CODE);
    expect(byTestId("batch-review-code-box")?.textContent).toMatch(/Read this to Claude. It works once and expires in 14 minutes/);
    expect(window.location.href).not.toContain(CODE);
    expect(JSON.stringify({ ...localStorage })).not.toContain(CODE);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(CODE);
    expect(JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data))).not.toContain(CODE);
    for (const spy of consoleSpies) expect(JSON.stringify(spy.mock.calls)).not.toContain(CODE);
    mockBatchesApi.confirmCode.mockResolvedValueOnce({ code: "AAAA-BBBB", expiresAt: batch().expiresAt });
    await click("batch-review-show-code");
    expect(byTestId("batch-review-code")?.textContent).toBe("AAAA-BBBB");
  });

  it("Apply here spends the batch with the person's session, and the code goes away", async () => {
    mockBatchesApi.get.mockResolvedValue(batch());
    mockBatchesApi.confirmCode.mockResolvedValueOnce({ code: CODE, expiresAt: batch().expiresAt });
    mockBatchesApi.applyHere.mockResolvedValue({ batchId: "batch-1", status: "running" });
    await render();
    await click("batch-review-show-code");
    mockBatchesApi.get.mockResolvedValue(batch({ status: "running" }));
    await click("batch-review-apply-here");
    expect(mockBatchesApi.applyHere).toHaveBeenCalledWith("company-1", "batch-1");
    expect(byTestId("batch-review-code")).toBeNull();
    expect(byTestId("batch-review-status")?.textContent).toMatch(/Applying now/);
    expect(byTestId("batch-review-actions")).toBeNull();
  });

  it("expired and done: no way to go ahead, and the outcomes are shown", async () => {
    mockBatchesApi.get.mockResolvedValue(batch({ expiresAt: new Date(Date.now() - 60_000).toISOString() }));
    await render();
    expect(byTestId("batch-review-status")?.textContent).toMatch(/expired/);
    expect(byTestId("batch-review-actions")).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    const done = batch({
      status: "completed",
      counts: { applied: 1, refused: 1, failed: 0, unknown: 0, appliedDifferently: 0 },
      items: batch().items!.map((item, index) => ({ ...item, outcome: index === 0 ? "applied" : "refused", reason: index === 0 ? null : "It changed after the preview." })),
    });
    mockBatchesApi.get.mockResolvedValue(done);
    await render();
    expect(byTestId("batch-review-status")?.textContent).toBe("Done: 1 changed, 1 not changed, 0 failed, 0 unknown.");
    const rows = [...container.querySelectorAll('[data-testid="batch-result-row"]')].map((row) => row.getAttribute("data-outcome"));
    expect(rows).toEqual(["applied", "refused"]);
    expect(byTestId("batch-review-actions")).toBeNull();
  });

  it("someone else's batch, or a missing one, says so plainly", async () => {
    const { ApiError } = await import("@/api/client");
    mockBatchesApi.get.mockRejectedValue(new ApiError("Batch not found", 404, { error: "Batch not found" }));
    await render();
    expect(byTestId("batch-review-missing")?.textContent).toBe("This batch does not exist, or it is not yours to review.");
  });
});
