import { MemoryRouter } from "react-router-dom";
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
const mockAdapterStatus = vi.hoisted(() => vi.fn());

vi.mock("../api/onboarding", () => ({
  onboardingApi: {
    bootstrap: mockBootstrap,
    interviewTurn: vi.fn(),
    confirmAgent: mockConfirmAgent,
    sendInvites: mockSendInvites,
    rejectAgent: mockRejectAgent,
    adapterStatus: mockAdapterStatus,
    setupHermesProvider: vi.fn(),
  },
}));

vi.mock("../api/conversations", () => ({
  conversationsApi: {
    paginate: vi.fn().mockResolvedValue([]),
    post: vi.fn(),
    read: vi.fn(),
    participants: vi.fn(),
    companyInbox: vi.fn().mockResolvedValue(null),
  },
}));

// Mock useCompany so CoSConversation can read the company context.
// Tests expect bootstrap path (no company selected), matching original behavior.
const mockCompanyState = vi.hoisted(() => ({
  companies: [] as Array<{ id: string }>,
  selectedCompanyId: null as string | null,
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: mockCompanyState.companies,
    selectedCompanyId: mockCompanyState.selectedCompanyId,
    selectedCompany: null,
    loading: false,
  }),
}));

vi.mock("../realtime/useMessages", () => ({
  useMessages: mockUseMessages,
}));

// CoSConversation now wraps a useQuery for agentsApi.list (added in PR #218 for
// mention typeahead). Mock @tanstack/react-query so the test doesn't need a
// QueryClientProvider, and mock agentsApi.list to return an empty directory —
// the smoke test only cares that the chat panel renders post-bootstrap, not
// that mention resolution works.
// One stable client, like the real hook (the bootstrap effect depends on it).
const mockQueryClient = vi.hoisted(() => ({ invalidateQueries: vi.fn(async () => undefined) }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => mockQueryClient,
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

vi.mock("../api/auth", () => ({ authApi: { getSession: vi.fn().mockResolvedValue(null) } }));
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
    mockCompanyState.companies = [];
    mockCompanyState.selectedCompanyId = null;
    mockSendInvites.mockReset();
    mockChatPanelProps.mockClear();
    // On-prem default: no Hermes provider step.
    mockAdapterStatus.mockReset();
    mockAdapterStatus.mockReturnValue({ status: { adapter: "minimax", ready: true, preset: "minimax", reason: null } });
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
      root.render(<MemoryRouter><CoSConversation /></MemoryRouter>);
    });

    expect(container.textContent).toContain("Setting up your workspace");
  });

  it("does not bootstrap with no company while the loaded company list has no selection yet", async () => {
    // AgentDash: in the commit where the company list loads, CompanyProvider has
    // not auto-selected yet. Bootstrapping then (with no companyId) set up a
    // Chief of Staff in some other company the user belongs to.
    mockCompanyState.companies = [{ id: "c-route" }, { id: "c-other" }];
    mockCompanyState.selectedCompanyId = null;
    mockBootstrap.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      const { CoSConversation } = await import("./CoSConversation");
      root.render(<MemoryRouter><CoSConversation /></MemoryRouter>);
    });

    expect(mockBootstrap).not.toHaveBeenCalled();
  });

  it("renders ChatPanel after bootstrap resolves", async () => {
    mockBootstrap.mockResolvedValue({
      companyId: "c1",
      cosAgentId: "a1",
      conversationId: "conv1",
    });

    await act(async () => {
      const { CoSConversation } = await import("./CoSConversation");
      root.render(<MemoryRouter><CoSConversation /></MemoryRouter>);
    });

    // Flush the bootstrap promise
    await act(async () => {});

    expect(container.querySelector(".chat-panel")).toBeTruthy();
    // AgentDash: bootstrap may create the first company; the access queries are refetched.
    expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["access", "current-board-access"], refetchType: "all" });
  });

  // PR #956 review: a member (not owner/admin) who opens /cos before the CoS
  // exists gets 403 from bootstrap; the page explains instead of erroring.
  it("explains, without an error page, when a non-admin member cannot set up the CoS", async () => {
    const { ApiError } = await import("../api/client");
    mockBootstrap.mockRejectedValue(
      new ApiError("Only a workspace owner or admin can set up the Chief of Staff.", 403, {}),
    );

    await act(async () => {
      const { CoSConversation } = await import("./CoSConversation");
      root.render(<MemoryRouter><CoSConversation /></MemoryRouter>);
    });
    await act(async () => {});

    const notice = container.querySelector('[data-testid="cos-not-available"]');
    expect(notice?.textContent).toContain("isn't set up yet");
    expect(notice?.querySelector("a")).toBeTruthy();
    expect(container.textContent).not.toContain("Couldn't set up your workspace");
    expect(container.querySelector(".chat-panel")).toBeNull();
  });

  it("says so when the caller is not a member of the selected workspace (no other company's chat)", async () => {
    // The real error shape: the server's error handler answers
    // { error, details } and the real api client parses it into ApiError.body.
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: "You are not an active member of that workspace.", details: { code: "not_a_member" } }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { api, ApiError } = await vi.importActual<typeof import("../api/client")>("../api/client");
    mockBootstrap.mockImplementation((companyId?: string | null) =>
      api.post("/onboarding/bootstrap", companyId ? { companyId } : {}),
    );
    // The client really produces body.details.code, which the page reads.
    const probe = await api.post("/onboarding/bootstrap", {}).catch((err: unknown) => err);
    expect(probe).toBeInstanceOf(ApiError);
    expect((probe as InstanceType<typeof ApiError>).body).toEqual({
      error: "You are not an active member of that workspace.",
      details: { code: "not_a_member" },
    });

    try {
      await act(async () => {
        const { CoSConversation } = await import("./CoSConversation");
        root.render(<MemoryRouter><CoSConversation /></MemoryRouter>);
      });
      await act(async () => {});
      await act(async () => {});

      const notice = container.querySelector('[data-testid="cos-not-available"]');
      expect(notice?.textContent).toContain("aren't an active member of this workspace");
      expect(container.querySelector(".chat-panel")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // AgentDash (#725): a hosted box asks for the Hermes provider key before the CoS chat.
  it("asks for a Hermes provider key first on a hosted box that has none", async () => {
    mockBootstrap.mockResolvedValue({ companyId: "c1", cosAgentId: "a1", conversationId: "conv1" });
    mockAdapterStatus.mockReturnValue({
      status: { adapter: "hermes_local", ready: false, preset: "hermes", reason: "Hermes provider key not configured" },
      hermesProvider: {
        required: true,
        configured: false,
        provider: null,
        model: null,
        configuredAt: null,
        canConfigure: true,
        options: [
          { provider: "zai", label: "Z.AI (GLM)", defaultModel: "glm-5.3-flash", keyHint: "API key from z.ai" },
          { provider: "openrouter", label: "OpenRouter", defaultModel: "z-ai/glm-5.2", keyHint: "sk-or-…" },
          { provider: "anthropic", label: "Anthropic", defaultModel: "claude-sonnet-5", keyHint: "sk-ant-…" },
          { provider: "openai", label: "OpenAI", defaultModel: "gpt-5.4-mini", keyHint: "sk-…" },
        ],
      },
    });

    await act(async () => {
      const { CoSConversation } = await import("./CoSConversation");
      root.render(<MemoryRouter><CoSConversation /></MemoryRouter>);
    });
    await act(async () => {});

    expect(container.querySelector(".chat-panel")).toBeNull();
    expect(container.textContent).toContain("Connect a model provider");
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(4);
  });

  it("goes straight to the chat once the hosted box has a provider", async () => {
    mockBootstrap.mockResolvedValue({ companyId: "c1", cosAgentId: "a1", conversationId: "conv1" });
    mockAdapterStatus.mockReturnValue({
      status: { adapter: "hermes_local", ready: true, preset: "hermes", reason: null },
      hermesProvider: {
        required: true,
        configured: true,
        provider: "zai",
        model: "glm-5.3-flash",
        configuredAt: "2026-09-25T00:00:00.000Z",
        canConfigure: true,
        options: [],
      },
    });

    await act(async () => {
      const { CoSConversation } = await import("./CoSConversation");
      root.render(<MemoryRouter><CoSConversation /></MemoryRouter>);
    });
    await act(async () => {});

    expect(container.querySelector(".chat-panel")).toBeTruthy();
  });

  // AgentDash (first-session test, Lane A item 4): the Ask page opened empty
  // with engineering-only starter chips.
  it("passes an opener for an empty conversation and role-neutral starter chips", async () => {
    mockBootstrap.mockResolvedValue({ companyId: "c1", cosAgentId: "a1", conversationId: "conv1" });

    await act(async () => {
      const { CoSConversation } = await import("./CoSConversation");
      root.render(<MemoryRouter><CoSConversation /></MemoryRouter>);
    });
    await act(async () => {});

    const props = mockChatPanelProps.mock.calls.at(-1)?.[0] as { suggestions: string[]; emptyState: React.ReactNode };
    expect(props.suggestions).toEqual(["Plan this quarter with me", "Who should I hire first?", "Turn a goal into tasks"]);
    expect(props.suggestions.join(" ")).not.toMatch(/engineering|issue/i);
    const opener = document.createElement("div");
    const openerRoot = createRoot(opener);
    act(() => openerRoot.render(<>{props.emptyState}</>));
    expect(opener.textContent).toContain("Your Chief of Staff is ready.");
    expect(opener.textContent).toContain("this quarter");
    act(() => openerRoot.unmount());
  });

  it("shows error state when bootstrap fails", async () => {
    mockBootstrap.mockRejectedValue(new Error("Network error"));

    await act(async () => {
      const { CoSConversation } = await import("./CoSConversation");
      root.render(<MemoryRouter><CoSConversation /></MemoryRouter>);
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
      root.render(<MemoryRouter><CoSConversation /></MemoryRouter>);
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
