// @vitest-environment jsdom
// AgentDash (scan 4, lane N): message.updated merges a card's new state into
// the message on screen; message.created still appends once.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../api/conversations";

const mockPaginate = vi.hoisted(() => vi.fn());
vi.mock("../api/conversations", () => ({ conversationsApi: { paginate: mockPaginate } }));

import { useMessages } from "./useMessages";
import { publishConversationMessage } from "./conversationEventBus";
import { setLiveSocketState } from "./liveSocketState";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const card = {
  id: "card1",
  conversationId: "conv1",
  role: "agent",
  content: "",
  cardKind: "issue_proposal_v1",
  cardPayload: { status: "pending", title: "T" },
  createdAt: "2026-10-02T08:00:00Z",
} as Message;

describe("useMessages", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let seen: Message[] = [];

  function Probe() {
    seen = useMessages("conv1");
    return null;
  }

  beforeEach(async () => {
    setLiveSocketState("idle");
    mockPaginate.mockResolvedValue([card]);
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root.render(<Probe />));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    setLiveSocketState("idle");
  });

  it("merges an update into the message on screen", async () => {
    await act(async () => {
      publishConversationMessage(
        { id: "card1", conversationId: "conv1", cardKind: "issue_proposal_v1", cardPayload: { status: "dismissed", title: "T" } } as unknown as Message,
        "updated",
      );
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: "card1", content: "", createdAt: card.createdAt, cardPayload: { status: "dismissed" } });
  });

  it("ignores an update for a message it never loaded", async () => {
    await act(async () => {
      publishConversationMessage({ id: "other", conversationId: "conv1", cardPayload: {} } as Message, "updated");
    });
    expect(seen.map((m) => m.id)).toEqual(["card1"]);
  });

  it("appends a created message once", async () => {
    const reply = { ...card, id: "m2", cardKind: null, cardPayload: null, content: "Hi" } as Message;
    await act(async () => {
      publishConversationMessage(reply);
      publishConversationMessage(reply);
    });
    expect(seen.map((m) => m.id)).toEqual(["card1", "m2"]);
  });

  // AgentDash (review #1000): switching threads must not leak the old
  // conversation's tail — mergePage keeps extras, so the list is reset on a
  // conversationId change.
  it("clears the list when the conversation changes", async () => {
    function Switchable({ id }: { id: string }) {
      seen = useMessages(id);
      return null;
    }
    const otherCard = { ...card, id: "other1", conversationId: "conv2" } as Message;
    mockPaginate.mockResolvedValueOnce([otherCard]);
    await act(async () => root.render(<Switchable id="conv2" />));
    expect(seen.map((m) => m.id)).toEqual(["other1"]);

    mockPaginate.mockResolvedValueOnce([card]);
    await act(async () => root.render(<Switchable id="conv1" />));
    expect(seen.map((m) => m.id)).toEqual(["card1"]);
  });
});

// AgentDash (canary, lane chat): the socket is a fast path only. Messages
// must still reach the screen when it is down — once on reconnect, and every
// 5s while the conversation is still owed a reply.
describe("useMessages without the live socket", () => {
  const userMsg = {
    id: "u1",
    conversationId: "conv1",
    role: "user",
    content: "how is it going?",
    createdAt: "2026-10-02T08:01:00Z",
  } as Message;
  const reply = {
    id: "a1",
    conversationId: "conv1",
    role: "agent",
    content: "Great — summary attached.",
    createdAt: "2026-10-02T08:01:05Z",
  } as Message;

  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let seen: Message[] = [];

  function Probe() {
    seen = useMessages("conv1");
    return null;
  }

  beforeEach(async () => {
    setLiveSocketState("idle");
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    setLiveSocketState("idle");
  });

  it("refetches once the socket comes back", async () => {
    // The page loaded while the socket was already down: only the user
    // message shows, the stored reply never arrives.
    mockPaginate.mockResolvedValue([userMsg]);
    await act(async () => root.render(<Probe />));
    expect(seen.map((m) => m.id)).toEqual(["u1"]);

    mockPaginate.mockResolvedValue([reply, userMsg]);
    await act(async () => setLiveSocketState("down"));
    await act(async () => setLiveSocketState("open"));

    expect(seen.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("polls every 5s while a reply is pending and the socket is down", async () => {
    vi.useFakeTimers();
    // "Now" is just after the user message — the reply is still fresh.
    vi.setSystemTime(new Date("2026-10-02T08:01:30Z"));
    mockPaginate.mockResolvedValue([userMsg]);
    await act(async () => root.render(<Probe />));
    await act(async () => setLiveSocketState("down"));
    mockPaginate.mockClear();

    mockPaginate.mockResolvedValue([reply, userMsg]);
    await act(async () => vi.advanceTimersByTime(5000));
    expect(mockPaginate).toHaveBeenCalledTimes(1);
    expect(seen.map((m) => m.id)).toEqual(["u1", "a1"]);

    // The reply arrived: the conversation is no longer pending, so the
    // interval keeps ticking but fetches nothing.
    await act(async () => vi.advanceTimersByTime(15000));
    expect(mockPaginate).toHaveBeenCalledTimes(1);
  });

  // AgentDash (review #1000): the poll is a fallback for a pending reply, not
  // a permanent subscription — once the pending message is older than the
  // reply timeout the UI already shows Retry, so polling stops.
  it("stops polling once the pending reply is past the reply timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T08:01:30Z"));
    mockPaginate.mockResolvedValue([userMsg]);
    await act(async () => root.render(<Probe />));
    await act(async () => setLiveSocketState("down"));
    mockPaginate.mockClear();

    await act(async () => vi.advanceTimersByTime(5000));
    expect(mockPaginate).toHaveBeenCalledTimes(1);

    // Jump past the 150s reply timeout — the user message is still last, but
    // it is no longer a reply worth waiting for.
    vi.setSystemTime(new Date("2026-10-02T08:05:00Z"));
    await act(async () => vi.advanceTimersByTime(20000));
    expect(mockPaginate).toHaveBeenCalledTimes(1);
  });

  it("does not poll when the newest message is the agent's", async () => {
    vi.useFakeTimers();
    mockPaginate.mockResolvedValue([reply, userMsg]);
    await act(async () => root.render(<Probe />));
    await act(async () => setLiveSocketState("down"));
    mockPaginate.mockClear();

    await act(async () => vi.advanceTimersByTime(20000));
    expect(mockPaginate).not.toHaveBeenCalled();
  });

  it("does not poll while the socket is live", async () => {
    vi.useFakeTimers();
    mockPaginate.mockResolvedValue([userMsg]);
    await act(async () => root.render(<Probe />));
    await act(async () => setLiveSocketState("open"));
    mockPaginate.mockClear();

    await act(async () => vi.advanceTimersByTime(20000));
    expect(mockPaginate).not.toHaveBeenCalled();
  });
});
