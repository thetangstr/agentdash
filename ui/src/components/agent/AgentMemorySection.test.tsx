// @vitest-environment jsdom
//
// An agent's memory (the lessons it kept from its person's corrections) is
// readable only by the agent, its steward and admins. The server answers 404
// to everyone else; the agent page shows the section only when the read
// succeeds, so a colleague sees nothing at all — not even an empty heading.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMemory } from "@paperclipai/shared";
import { ApiError } from "../../api/client";

const mockMemoryApi = vi.hoisted(() => ({ history: vi.fn() }));

vi.mock("../../api/agent-memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/agent-memory")>();
  return { ...actual, agentMemoryApi: mockMemoryApi };
});

const { AgentMemorySection } = await import("./AgentMemorySection");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function version(n: number, content: string, overrides: Partial<AgentMemory> = {}): AgentMemory {
  return {
    id: `mem-${n}`,
    companyId: "company-1",
    agentId: "agent-1",
    version: n,
    content,
    authorKind: "agent",
    authorAgentId: "agent-1",
    authorUserId: null,
    writtenAt: `2026-10-0${n}T12:00:00.000Z`,
    supersededAt: null,
    ...overrides,
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
        <AgentMemorySection companyId="company-1" agentId="agent-1" />
      </QueryClientProvider>,
    );
  });
  // Let the query settle.
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
  mockMemoryApi.history.mockReset();
});

describe("AgentMemorySection", () => {
  it("shows the steward the current memory and every version, newest first", async () => {
    const current = version(2, "Label every figure as estimated.");
    const older = version(1, "First lesson.", { supersededAt: "2026-10-02T12:00:00.000Z" });
    mockMemoryApi.history.mockResolvedValue({ active: current, history: [current, older] });

    const node = await render();

    expect(mockMemoryApi.history).toHaveBeenCalledWith("company-1", "agent-1");
    expect(node.textContent).toContain("Memory");
    expect(node.textContent).toContain("Label every figure as estimated.");
    expect(node.textContent).toContain("only visible to the agent, its steward and admins");
    const items = Array.from(node.querySelectorAll("[data-testid='agent-memory-version']")).map((el) => el.textContent ?? "");
    expect(items).toHaveLength(2);
    expect(items[0]).toContain("v2");
    expect(items[1]).toContain("v1");
  });

  it("says so when the agent has not written any memory yet", async () => {
    mockMemoryApi.history.mockResolvedValue({ active: null, history: [] });
    const node = await render();
    expect(node.textContent).toContain("No memory yet");
  });

  it("renders nothing for a member the server refuses (404)", async () => {
    mockMemoryApi.history.mockRejectedValue(new ApiError("Agent memory not found", 404, { error: "Agent memory not found" }));
    const node = await render();
    expect(node.textContent).toBe("");
    expect(node.querySelector("[data-testid='agent-memory-section']")).toBeNull();
  });
});
