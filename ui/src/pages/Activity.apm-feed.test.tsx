// @vitest-environment jsdom
//
// AgentDash: Agent Performance Management gate 2 — the company Activity page
// leaves hiding to the server: by default it asks for the filtered feed
// (`includeSystem: false`, which also drops shadow-mode would-be refusals and
// per-step application rows), "Show system events" asks for everything
// (`includeSystem: true`), and it renders every row it gets — no client-side
// post-filter cutting a page short.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent } from "@paperclipai/shared";

const mockActivityApi = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../api/activity", () => ({ activityApi: mockActivityApi }));
vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("../api/access", () => ({ accessApi: { listUserDirectory: vi.fn().mockResolvedValue({ users: [] }) } }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../hooks/useIsPhone", () => ({ useIsPhone: () => false }));
vi.mock("../components/ActivityRow", () => ({
  ActivityRow: ({ event }: { event: ActivityEvent }) => <div data-testid="activity-row">{event.action}</div>,
}));

const { Activity } = await import("./Activity");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function event(id: string, action: string): ActivityEvent {
  return {
    id,
    companyId: "company-1",
    actorType: "agent",
    actorId: "agent-1",
    action,
    entityType: "agent",
    entityId: "agent-1",
    agentId: "agent-1",
    runId: null,
    details: null,
    createdAt: new Date("2026-10-29T12:00:00.000Z"),
  };
}

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

async function renderActivity() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <Activity />
      </QueryClientProvider>,
    );
  });
  await flush();
  await flush();
}

const rows = () => Array.from(container!.querySelectorAll("[data-testid='activity-row']")).map((row) => row.textContent);

describe("Activity page — APM gate 2 rows", () => {
  it("asks the server for the filtered feed, then for everything under Show system events", async () => {
    mockActivityApi.list.mockImplementation(async (_companyId: string, filters: { includeSystem?: boolean }) =>
      filters.includeSystem
        ? [event("1", "access.would_refuse"), event("2", "agent_profile.application_step"), event("3", "agent_profile.applied")]
        : [event("3", "agent_profile.applied")],
    );
    await renderActivity();
    expect(mockActivityApi.list).toHaveBeenLastCalledWith("company-1", { limit: 200, includeSystem: false });
    expect(rows()).toEqual(["agent_profile.applied"]);

    // Offered even when nothing on the page says rows were hidden: the server filtered them.
    const toggle = container!.querySelector<HTMLInputElement>("[data-testid='activity-show-system'] input")!;
    expect(toggle).not.toBeNull();
    await act(async () => {
      toggle.click();
    });
    await flush();
    await flush();
    expect(mockActivityApi.list).toHaveBeenLastCalledWith("company-1", { limit: 200, includeSystem: true });
    expect(rows()).toEqual(["access.would_refuse", "agent_profile.application_step", "agent_profile.applied"]);
  });

  it("renders every row the server returns, system-actor rows included, so a page is never cut short", async () => {
    const system = { ...event("4", "budget.hard_threshold_crossed"), actorType: "system" as const, actorId: "system" };
    mockActivityApi.list.mockResolvedValue([event("3", "agent_profile.applied"), system, event("5", "environment.lease_acquired")]);
    await renderActivity();
    expect(rows()).toEqual(["agent_profile.applied", "budget.hard_threshold_crossed", "environment.lease_acquired"]);
  });
});
