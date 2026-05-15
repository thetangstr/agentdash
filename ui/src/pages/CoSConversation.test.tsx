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
const mockChatPanelProps = vi.hoisted(() => vi.fn());

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

// CoSConversation now wraps a useQuery for agentsApi.list (added in PR #218 for
// mention typeahead). Mock @tanstack/react-query so the test doesn't need a
// QueryClientProvider, and mock agentsApi.list to return an empty directory —
// the smoke test only cares that the chat panel renders post-bootstrap, not
// that mention resolution works.
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryFn, enabled }: { queryFn: () => unknown; enabled?: boolean }) => {
    if (enabled === false) {
      return { data: undefined, isLoading: false, error: null };
    }
    try {
      const data = queryFn();
      return { data, isLoading: false, error: null };
    } catch (err) {
      return { data: undefined, isLoading: false, error: err };
    }
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    // The useQuery mock above invokes queryFn() synchronously and returns the
    // raw value as `data`. Returning a Promise would set `data` to the Promise
    // itself (truthy → bypasses ?? [] → .map fails). Return the array directly.
    list: vi.fn().mockReturnValue([]),
  },
}));

// Mock ChatPanel to a stub so we don't drag in its useQuery / WS / scroll deps.
// The tests only need to assert the page passes the expected card callbacks.
vi.mock("./ChatPanel", () => ({
  default: (props: unknown) => {
    mockChatPanelProps(props);
    return <div className="chat-panel" />;
  },
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
    mockBootstrap.mockReset();
    mockSendInvites.mockReset();
    mockChatPanelProps.mockClear();
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

  it("returns generated invite links from the send callback", async () => {
    mockBootstrap.mockResolvedValue({
      companyId: "company-1",
      cosAgentId: "agent-1",
      conversationId: "conversation-1",
    });
    mockSendInvites.mockResolvedValue({
      inviteIds: ["invite-1"],
      invites: [
        {
          id: "invite-1",
          email: "jane@example.com",
          invitePath: "/invite/pcp_invite_test",
          inviteUrl: "https://agentdash.local/invite/pcp_invite_test",
          expiresAt: "2026-05-16T00:00:00.000Z",
          emailStatus: "skipped",
        },
      ],
      errors: [],
    });

    await act(async () => {
      const { CoSConversation } = await import("./CoSConversation");
      root.render(<CoSConversation />);
    });
    await act(async () => {});

    const props = mockChatPanelProps.mock.calls.at(-1)?.[0] as {
      cardContext: {
        onInviteSend: (emails: string[]) => Promise<unknown>;
      };
    };
    let result: unknown;
    await act(async () => {
      result = await props.cardContext.onInviteSend(["jane@example.com"]);
    });

    expect(mockSendInvites).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      companyId: "company-1",
      emails: ["jane@example.com"],
    });
    expect(result).toMatchObject({
      invites: [
        {
          email: "jane@example.com",
          inviteUrl: "https://agentdash.local/invite/pcp_invite_test",
          emailStatus: "skipped",
        },
      ],
    });
  });
});
