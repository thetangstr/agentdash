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
    mockPaginate.mockResolvedValue([card]);
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root.render(<Probe />));
  });

  afterEach(() => {
    act(() => root.unmount());
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
});
