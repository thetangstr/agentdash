// @vitest-environment jsdom
//
// AgentDash admin powers (part 4): the agent page's read-only Directives
// panel. The server decides who reads (the steward; an owner or admin when the
// company allows it); the panel renders only on a 200 and nothing at all on a
// 403 or a 404.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDirective } from "@paperclipai/shared";
import { ApiError } from "../../api/client";

const mockDirectivesApi = vi.hoisted(() => ({ history: vi.fn() }));
vi.mock("../../api/agent-directives", () => ({ agentDirectivesApi: mockDirectivesApi }));

const { AgentDirectivesPanel } = await import("./AgentDirectivesPanel");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function version(n: number, directives: string, supersededAt: string | null = null): AgentDirective {
  return {
    id: `dir-${n}`,
    companyId: "company-1",
    agentId: "agent-1",
    version: n,
    directives,
    pushedByUserId: "steward-1",
    pushedAt: `2026-11-0${n}T12:00:00.000Z`,
    supersededAt,
  };
}

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

async function render() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <AgentDirectivesPanel companyId="company-1" agentId="agent-1" />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  mockDirectivesApi.history.mockReset();
});

describe("AgentDirectivesPanel", () => {
  it("on a 200 shows the current directives and the earlier versions, read-only", async () => {
    const current = version(2, "Keep replies under five lines.");
    const older = version(1, "Be formal.", "2026-11-02T12:00:00.000Z");
    mockDirectivesApi.history.mockResolvedValue({ active: current, history: [current, older] });
    const node = await render();
    expect(mockDirectivesApi.history).toHaveBeenCalledWith("company-1", "agent-1");
    expect(node.querySelector("[data-testid='agent-directives-panel']")).not.toBeNull();
    expect(node.querySelector("[data-testid='agent-directives-active']")?.textContent).toContain("Keep replies under five lines.");
    expect(node.querySelectorAll("[data-testid='agent-directives-version']")).toHaveLength(1);
    expect(node.querySelector("button, textarea, input")).toBeNull();
  });

  it("says so when there are none yet", async () => {
    mockDirectivesApi.history.mockResolvedValue({ active: null, history: [] });
    const node = await render();
    expect(node.querySelector("[data-testid='agent-directives-none']")?.textContent).toBe("No directives yet.");
  });

  it.each([
    [403, "Only the agent's active steward can push directives"],
    [404, "Company not found"],
  ])("renders nothing on a %s", async (status, message) => {
    mockDirectivesApi.history.mockRejectedValue(new ApiError(message, status, { error: message }));
    const node = await render();
    expect(node.textContent).toBe("");
  });
});
