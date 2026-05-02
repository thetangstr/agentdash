// @vitest-environment jsdom
// AgentDash: smoke test for CoSConversation onboarding page

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockBootstrap = vi.hoisted(() => vi.fn());
const mockRejectAgent = vi.hoisted(() => vi.fn());
const mockConfirmAgent = vi.hoisted(() => vi.fn());
const mockSendInvites = vi.hoisted(() => vi.fn());
const mockUseMessages = vi.hoisted(() => vi.fn());

vi.mock("../api/onboarding", () => ({
  onboardingApi: {
    bootstrap: mockBootstrap,
    interviewTurn: vi.fn(),
    confirmAgent: mockConfirmAgent,
    sendInvites: mockSendInvites,
    rejectAgent: mockRejectAgent,
  },
}));

vi.mock("../api/conversations", () => ({
  conversationsApi: {
    paginate: vi.fn().mockResolvedValue([]),
    post: vi.fn(),
    read: vi.fn(),
    participants: vi.fn(),
  },
}));

vi.mock("../realtime/useMessages", () => ({
  useMessages: mockUseMessages,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("CoSConversation", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockUseMessages.mockReturnValue([]);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("shows loading state while bootstrap is pending", async () => {
    // Never resolves so we stay in loading state
    mockBootstrap.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      const { CoSConversation } = await import("./CoSConversation");
      root.render(<CoSConversation />);
    });

    expect(container.textContent).toContain("Setting up your workspace");
  });

  it("renders ChatPanel after bootstrap resolves", async () => {
    mockBootstrap.mockResolvedValue({
      companyId: "c1",
      cosAgentId: "a1",
      conversationId: "conv1",
      firstMessage: "Welcome…",
    });

    await act(async () => {
      const { CoSConversation } = await import("./CoSConversation");
      root.render(<CoSConversation />);
    });

    // Flush the bootstrap promise
    await act(async () => {});

    expect(container.querySelector(".chat-panel")).toBeTruthy();
  });

  it("shows error state when bootstrap fails", async () => {
    mockBootstrap.mockRejectedValue(new Error("Network error"));

    await act(async () => {
      const { CoSConversation } = await import("./CoSConversation");
      root.render(<CoSConversation />);
    });

    await act(async () => {});

    expect(container.textContent).toContain("Couldn't set up your workspace");
    expect(container.textContent).toContain("Network error");
  });
});
