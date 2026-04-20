// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FeedEvent, FeedPage } from "../../api/feed";

const listMock = vi.fn<(companyId: string, opts?: { cursor?: string | null; limit?: number }) => Promise<FeedPage>>();
const setBreadcrumbsMock = vi.fn();

vi.mock("../../api/feed", () => ({
  feedApi: {
    list: (companyId: string, opts?: { cursor?: string | null; limit?: number }) =>
      listMock(companyId, opts),
  },
}));

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeEvent(overrides: Partial<FeedEvent> = {}): FeedEvent {
  return {
    id: "evt-1",
    type: "approval_decision",
    title: "Approval send_email — pending",
    actorAgentId: "agent-1",
    actorUserId: null,
    refType: "approval",
    refId: "approval-1",
    at: new Date("2026-04-15T00:00:00.000Z").toISOString(),
    ...overrides,
  };
}

async function flush() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function renderPage(container: HTMLDivElement, Component: () => ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Component />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("Feed page", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    listMock.mockReset();
    setBreadcrumbsMock.mockReset();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders events with titles and timestamps", async () => {
    listMock.mockResolvedValue({
      events: [
        makeEvent({ id: "e-1", title: "Approval send_email — approved" }),
        makeEvent({ id: "e-2", title: "Cost anthropic/opus — 42¢", type: "cost_event" }),
      ],
      nextCursor: null,
    });

    const { Feed } = await import("../Feed");
    const root = renderPage(container, Feed);
    await act(async () => {
      await flush();
    });

    expect(listMock).toHaveBeenCalledWith("company-1", { cursor: null });
    expect(container.textContent).toContain("Approval send_email — approved");
    expect(container.textContent).toContain("Cost anthropic/opus — 42¢");
    // relative timestamp rendered ("ago" suffix)
    expect(container.textContent).toMatch(/ago|just now/);

    act(() => {
      root.unmount();
    });
  });

  it('shows empty state "No activity yet" when events is empty', async () => {
    listMock.mockResolvedValue({ events: [], nextCursor: null });

    const { Feed } = await import("../Feed");
    const root = renderPage(container, Feed);
    await act(async () => {
      await flush();
    });

    expect(container.textContent).toContain("No activity yet");

    act(() => {
      root.unmount();
    });
  });

  it("shows Load more button when nextCursor is present", async () => {
    listMock.mockResolvedValue({
      events: [makeEvent({ id: "e-1" })],
      nextCursor: "cursor-abc",
    });

    const { Feed } = await import("../Feed");
    const root = renderPage(container, Feed);
    await act(async () => {
      await flush();
    });

    const loadMoreBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Load more"),
    );
    expect(loadMoreBtn).toBeDefined();

    act(() => {
      root.unmount();
    });
  });
});
