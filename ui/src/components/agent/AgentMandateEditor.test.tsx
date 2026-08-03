// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentsApi = vi.hoisted(() => ({
  instructionsBundle: vi.fn(),
  instructionsFile: vi.fn(),
  saveInstructionsFile: vi.fn(),
}));

vi.mock("@/api/agents", () => ({ agentsApi: mockAgentsApi }));

const { AgentMandateEditor } = await import("./AgentMandateEditor");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <AgentMandateEditor agentId="agent-1" companyId="company-1" />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("AgentMandateEditor", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    mockAgentsApi.instructionsBundle.mockResolvedValue({ entryFile: "AGENTS.md", mode: "managed" });
    mockAgentsApi.instructionsFile.mockResolvedValue({ content: "Be helpful." });
    mockAgentsApi.saveInstructionsFile.mockResolvedValue({});
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("edits the bundle entry file rather than a parallel mandate store", async () => {
    await render();

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("Be helpful.");
    expect(container.textContent).toContain("AGENTS.md");

    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setter.call(textarea, "Ship the board deck weekly.");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const save = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Save mandate"),
    )!;
    await act(async () => save.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(mockAgentsApi.saveInstructionsFile).toHaveBeenCalledWith(
      "agent-1",
      { path: "AGENTS.md", content: "Ship the board deck weekly." },
      "company-1",
    );
  });

  it("explains rather than errors when the bundle is not managed", async () => {
    // The real API always populates entryFile, so `mode` is the only signal
    // that a steward cannot edit here. Keying off entryFile made this branch
    // unreachable and handed the steward an editor that 403s on every save.
    mockAgentsApi.instructionsBundle.mockResolvedValue({
      entryFile: "AGENTS.md",
      mode: "external",
    });

    await render();

    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("administrator configures where instructions live");
  });

  it("surfaces a refused save instead of appearing to succeed", async () => {
    mockAgentsApi.saveInstructionsFile.mockRejectedValue(
      new Error("Stewardship only permits editing instructions in the managed bundle"),
    );

    await render();
    const save = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Save mandate"),
    )!;
    await act(async () => save.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(container.textContent).toContain("managed bundle");
    expect(container.textContent).not.toContain("Saved.");
  });

  it("never saves one agent's draft into another agent's file", async () => {
    // The component is re-rendered, not remounted, when the stewarded agent
    // changes — an unkeyed draft would overwrite the new agent's mandate.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <AgentMandateEditor agentId="agent-1" companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    for (let i = 0; i < 8; i += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setter.call(textarea, "AGENT ONE ONLY");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // Same mount, different agent.
    mockAgentsApi.instructionsFile.mockResolvedValue({ content: "Agent two mandate." });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <AgentMandateEditor agentId="agent-2" companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    for (let i = 0; i < 8; i += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }

    const save = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Save mandate"),
    )!;
    await act(async () => save.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const written = mockAgentsApi.saveInstructionsFile.mock.calls[0];
    if (written) {
      expect(written[0]).toBe("agent-2");
      expect(written[1].content).not.toBe("AGENT ONE ONLY");
    }
  });
});
