// @vitest-environment jsdom
// AgentDash (GH #786): the in-app assistant connection instructions.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockHealth = vi.hoisted(() => vi.fn());
vi.mock("@/api/health", () => ({ healthApi: { get: mockHealth } }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => undefined }) }));
vi.mock("@/lib/router", async () => {
  const dom = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { Link: dom.Link };
});

import { ConnectAssistant, assistantMcpUrl } from "./ConnectAssistant";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("ConnectAssistant", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("builds the assistant MCP URL from a base with or without a slash", () => {
    expect(assistantMcpUrl("https://acme.agentdash.cloud/")).toBe("https://acme.agentdash.cloud/api/mcp/assistant");
  });

  it("shows this box's assistant URL and the muse client id", async () => {
    mockHealth.mockResolvedValue({ status: "ok", publicBaseUrl: "https://acme.agentdash.cloud" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <ConnectAssistant />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[data-testid="assistant-mcp-url"]')?.textContent).toBe(
      "https://acme.agentdash.cloud/api/mcp/assistant",
    );
    expect(container.querySelector('[data-testid="assistant-client-id"]')?.textContent).toBe("muse");
    expect(container.textContent).not.toContain("/mcp page");
  });
});
