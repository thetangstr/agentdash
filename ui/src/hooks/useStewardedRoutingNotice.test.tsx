// @vitest-environment jsdom
// AgentDash: every assignee change in the UI says when the server gave the
// issue to the agent the named person stewards.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAgents = vi.hoisted(() => vi.fn());
const mockDirectory = vi.hoisted(() => vi.fn());
vi.mock("../api/agents", () => ({ agentsApi: { list: mockAgents } }));
vi.mock("../api/access", () => ({ accessApi: { listUserDirectory: mockDirectory } }));

import { ToastProvider, useToastState } from "../context/ToastContext";
import { useStewardedRoutingNotice } from "./useStewardedRoutingNotice";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let announce: ReturnType<typeof useStewardedRoutingNotice> | null = null;

function Probe() {
  announce = useStewardedRoutingNotice("company-1");
  const toasts = useToastState();
  return <ul>{toasts.map((toast) => <li key={toast.id}>{toast.title}</li>)}</ul>;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("useStewardedRoutingNotice", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    mockAgents.mockResolvedValue([{ id: "agent-a", name: "Agent A" }]);
    mockDirectory.mockResolvedValue({ users: [{ principalId: "steward-a", user: { name: "Steward A", email: null } }] });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    announce = null;
    vi.clearAllMocks();
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ToastProvider>
            <Probe />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await settle();
  }

  it("announces a routed assignment by agent and person", async () => {
    await render();
    await act(async () => {
      announce!({ routedToStewardedAgent: { fromUserId: "steward-a", toAgentId: "agent-a" } });
    });
    expect(container.textContent).toContain("Assigned to Agent A, Steward A's agent");
  });

  it("says nothing for an assignment that was not routed", async () => {
    await render();
    await act(async () => {
      announce!({});
      announce!(null);
    });
    expect(container.textContent).not.toContain("Assigned to");
  });
});
