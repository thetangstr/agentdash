// @vitest-environment jsdom
// AgentDash (c4-stops): the task card outlives the run — a stopped run must
// replace "They'll start on it now." with the resume pointer.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetIssue = vi.hoisted(() => vi.fn());
const mockRunsForIssue = vi.hoisted(() => vi.fn());
const mockLiveRunsForIssue = vi.hoisted(() => vi.fn());

vi.mock("../../api/issues", () => ({ issuesApi: { get: mockGetIssue } }));
vi.mock("../../api/activity", () => ({ activityApi: { runsForIssue: mockRunsForIssue } }));
vi.mock("../../api/heartbeats", () => ({ heartbeatsApi: { liveRunsForIssue: mockLiveRunsForIssue } }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

import { IssueCreatedCard, type IssueCreatedCardPayload } from "./IssueCreatedCard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const payload: IssueCreatedCardPayload = {
  issueId: "i1",
  identifier: "ACM-9",
  title: "Draft the checklist",
  assigneeName: "Riley",
  status: "in_progress",
};

const cancelledRun = {
  runId: "run-1",
  status: "cancelled",
  agentId: "a1",
  adapterType: "claude_local",
  startedAt: "2026-10-04T09:00:00Z",
  finishedAt: "2026-10-04T09:01:00Z",
  createdAt: "2026-10-04T09:00:00Z",
  invocationSource: "assignment",
  usageJson: null,
  resultJson: null,
};

describe("IssueCreatedCard stopped state", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let client: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockGetIssue.mockReset();
    mockRunsForIssue.mockReset();
    mockLiveRunsForIssue.mockReset();
    mockGetIssue.mockResolvedValue({ id: "i1", status: "in_progress", assigneeAgentId: "a1" });
    mockRunsForIssue.mockResolvedValue([cancelledRun]);
    mockLiveRunsForIssue.mockResolvedValue([]);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(cardPayload: IssueCreatedCardPayload = payload) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <IssueCreatedCard payload={cardPayload} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await act(async () => {});
    await act(async () => {});
  }

  it("says the work was stopped and points at the issue to resume", async () => {
    await render();
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Work on this was stopped — open the issue to resume it.");
    });
    expect(container.textContent).not.toContain("They'll start on it now.");
  });

  it("keeps the normal next step while a run is still live", async () => {
    mockLiveRunsForIssue.mockResolvedValue([{ id: "run-2", status: "running" }]);
    await render();
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Assigned to Riley. They'll start on it now.");
    });
  });
});
