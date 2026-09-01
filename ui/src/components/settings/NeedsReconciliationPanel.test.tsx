// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { NeedsReconciliationPanel } from "./NeedsReconciliationPanel";

const mockConnectorSendExecutionsApi = vi.hoisted(() => ({
  listUnresolved: vi.fn(),
  reconcile: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("@/api/connector-send-executions", () => ({
  connectorSendExecutionsApi: mockConnectorSendExecutionsApi,
}));

vi.mock("@/api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "exec-1",
    provider: "hubspot",
    objectType: "contact",
    operation: "create",
    outcome: "outcome_unknown",
    reason: "gateway timeout after write",
    requestedByAgentId: "agent-1",
    executedAt: "2026-08-04T12:00:00.000Z",
    revision: 0,
    ...overrides,
  };
}

function renderPanel(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return { root, queryClient };
}

describe("NeedsReconciliationPanel", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAgentsApi.list.mockResolvedValue([
      { id: "agent-1", name: "Atlas" },
      { id: "agent-2", name: "Mercury" },
    ]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders unresolved rows with the requesting agent and the action", async () => {
    mockConnectorSendExecutionsApi.listUnresolved.mockResolvedValue({
      items: [row(), row({ id: "exec-2", operation: "update", objectType: "deal", requestedByAgentId: "agent-2" })],
    });

    const { root, queryClient } = renderPanel(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <NeedsReconciliationPanel companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(mockConnectorSendExecutionsApi.listUnresolved).toHaveBeenCalledWith("company-1");
    // Requesting agent resolved to a name.
    expect(container.textContent).toContain("Atlas");
    expect(container.textContent).toContain("Mercury");
    // The action (operation + object type + provider).
    expect(container.textContent?.toLowerCase()).toContain("create");
    expect(container.textContent?.toLowerCase()).toContain("contact");
    expect(container.textContent?.toLowerCase()).toContain("hubspot");
    // Both reconcile affordances are offered per row.
    const buttons = [...container.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(buttons.some((t) => /delivered/i.test(t))).toBe(true);
    expect(buttons.some((t) => /failed/i.test(t))).toBe(true);

    await act(async () => root.unmount());
  });

  it("reconciles a row with its current revision and removes it from the list", async () => {
    // First fetch returns the row; after reconcile the query refetches empty
    // (the server excludes reconciled rows), so the row disappears.
    mockConnectorSendExecutionsApi.listUnresolved
      .mockResolvedValueOnce({ items: [row({ revision: 0 })] })
      .mockResolvedValue({ items: [] });
    mockConnectorSendExecutionsApi.reconcile.mockResolvedValue({
      id: "exec-1",
      verdict: "confirmed_delivered",
      idempotent: false,
    });

    const { root, queryClient } = renderPanel(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <NeedsReconciliationPanel companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Atlas");

    const confirmDelivered = [...container.querySelectorAll("button")].find((b) =>
      /delivered/i.test(b.textContent ?? ""),
    );
    expect(confirmDelivered).toBeTruthy();

    await act(async () => {
      confirmDelivered!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    // Revision-bound: the button echoes back the revision the row was rendered against.
    expect(mockConnectorSendExecutionsApi.reconcile).toHaveBeenCalledWith("company-1", "exec-1", {
      verdict: "confirmed_delivered",
      revision: 0,
    });

    // The reconciled row is gone.
    expect(container.textContent).not.toContain("Atlas");

    await act(async () => root.unmount());
  });

  it("shows a refusal and no rows when the viewer is not authorized (403)", async () => {
    mockConnectorSendExecutionsApi.listUnresolved.mockRejectedValue(
      new ApiError("Reconciliation requires owner, administrator, or the requesting steward", 403, null),
    );

    const { root, queryClient } = renderPanel(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <NeedsReconciliationPanel companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    // No rows, no reconcile buttons — a non-authorized member never sees the
    // work, rather than an empty "nothing to reconcile" that implies otherwise.
    expect(container.textContent).not.toContain("Atlas");
    const reconcileButtons = [...container.querySelectorAll("button")].filter((b) =>
      /delivered|failed/i.test(b.textContent ?? ""),
    );
    expect(reconcileButtons).toHaveLength(0);
    expect(container.textContent?.toLowerCase()).toContain("do not have access");

    await act(async () => root.unmount());
  });
});
