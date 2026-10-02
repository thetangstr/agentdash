// @vitest-environment jsdom
// AgentDash (first-session test, Lane A item 4): an empty conversation shows
// the page's opener instead of a blank panel.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockUseMessages = vi.hoisted(() => vi.fn());

vi.mock("../realtime/useMessages", () => ({ useMessages: mockUseMessages }));
vi.mock("../components/MessageList", () => ({
  MessageList: ({ messages }: { messages: Array<{ id: string }> }) => (
    <div data-testid="message-list">{messages.length} messages</div>
  ),
}));
vi.mock("../components/Composer", () => ({ Composer: () => <div data-testid="composer" /> }));
vi.mock("../components/ChatHeader", () => ({ ChatHeader: () => <div data-testid="chat-header" /> }));
const mockRetry = vi.hoisted(() => vi.fn());
vi.mock("../api/conversations", () => ({
  conversationsApi: { read: vi.fn().mockResolvedValue(undefined), post: vi.fn(), retry: mockRetry },
}));

import ChatPanel, { REPLY_PENDING_TIMEOUT_MS } from "./ChatPanel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("ChatPanel empty state", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the opener while the conversation has no messages", () => {
    mockUseMessages.mockReturnValue([]);
    act(() => root.render(<ChatPanel conversationId="c1" companyId="co1" emptyState={<p>Hello from the CoS</p>} />));
    expect(container.querySelector('[data-testid="chat-empty-state"]')?.textContent).toBe("Hello from the CoS");
    expect(container.querySelector('[data-testid="message-list"]')).toBeNull();
  });

  it("shows the messages once there are any", () => {
    mockUseMessages.mockReturnValue([{ id: "m1", authorKind: "agent", body: "Hi" }]);
    act(() => root.render(<ChatPanel conversationId="c1" companyId="co1" emptyState={<p>Hello from the CoS</p>} />));
    expect(container.querySelector('[data-testid="chat-empty-state"]')).toBeNull();
    expect(container.querySelector('[data-testid="message-list"]')?.textContent).toBe("1 messages");
  });
});

// AgentDash (P0, v2026.1002.0): the chat never sits silently on the person's
// message. It shows "CoS is thinking…" until the reply (or the server's
// "CoS couldn't reply" card) arrives, and offers Retry once a reply is overdue.
describe("ChatPanel reply state", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Element.prototype.scrollIntoView = vi.fn();
    mockRetry.mockReset();
    mockRetry.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const userMsg = (createdAt: Date) => ({ id: "u1", role: "user", authorUserId: "person-1", content: "Are you there?", createdAt: createdAt.toISOString() });
  const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);

  it("shows CoS is thinking while the conversation ends on the person's message", () => {
    mockUseMessages.mockReturnValue([userMsg(new Date())]);
    act(() => root.render(<ChatPanel conversationId="c1" companyId="co1" />));
    expect(q("cos-thinking")?.textContent).toContain("CoS is thinking");
    expect(q("cos-reply-stalled")).toBeNull();
  });

  it("drops the thinking state once a reply or an error card arrives", () => {
    mockUseMessages.mockReturnValue([
      userMsg(new Date()),
      { id: "e1", role: "agent", content: "CoS couldn't reply: x. Retry", cardKind: "cos_dispatch_error_v1", createdAt: new Date().toISOString() },
    ]);
    act(() => root.render(<ChatPanel conversationId="c1" companyId="co1" />));
    expect(q("cos-thinking")).toBeNull();
    expect(q("cos-reply-stalled")).toBeNull();
  });

  it("turns an overdue reply into a Retry that re-dispatches the message", async () => {
    vi.useFakeTimers();
    const sent = new Date();
    vi.setSystemTime(sent);
    mockUseMessages.mockReturnValue([userMsg(sent)]);
    act(() => root.render(<ChatPanel conversationId="c1" companyId="co1" />));
    expect(q("cos-thinking")).not.toBeNull();

    act(() => {
      vi.setSystemTime(new Date(sent.getTime() + REPLY_PENDING_TIMEOUT_MS + 1000));
      vi.advanceTimersByTime(REPLY_PENDING_TIMEOUT_MS + 1000);
    });
    expect(q("cos-thinking")).toBeNull();
    const retry = q("cos-reply-stalled")?.querySelector("button") as HTMLButtonElement;
    expect(retry?.textContent).toBe("Retry");

    await act(async () => {
      retry.click();
    });
    expect(mockRetry).toHaveBeenCalledWith("c1", "u1");
    expect(q("cos-thinking")).not.toBeNull();
  });

  it("does not say the CoS is thinking when the message is for a mentioned agent, or the company has no CoS", () => {
    const directory = [{ id: "a1", name: "Maya", role: "engineer" }];
    mockUseMessages.mockReturnValue([{ ...userMsg(new Date()), content: "@Maya can you look at this?" }]);
    act(() => root.render(<ChatPanel conversationId="c1" companyId="co1" agentDirectory={directory} />));
    expect(q("cos-thinking")).toBeNull();

    mockUseMessages.mockReturnValue([userMsg(new Date())]);
    act(() => root.render(<ChatPanel conversationId="c1" companyId="co1" hasChiefOfStaff={false} />));
    expect(q("cos-thinking")).toBeNull();
  });

  it("offers the overdue-reply Retry only to the message's author", () => {
    vi.useFakeTimers();
    const sent = new Date();
    vi.setSystemTime(sent);
    mockUseMessages.mockReturnValue([userMsg(sent)]);
    act(() => root.render(<ChatPanel conversationId="c1" companyId="co1" viewerUserId="someone-else" />));
    act(() => {
      vi.setSystemTime(new Date(sent.getTime() + REPLY_PENDING_TIMEOUT_MS + 1000));
      vi.advanceTimersByTime(REPLY_PENDING_TIMEOUT_MS + 1000);
    });
    expect(q("cos-reply-stalled")).toBeNull();
  });
});
