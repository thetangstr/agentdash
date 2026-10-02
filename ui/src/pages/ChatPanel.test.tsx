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
vi.mock("../api/conversations", () => ({
  conversationsApi: { read: vi.fn().mockResolvedValue(undefined), post: vi.fn() },
}));

import ChatPanel from "./ChatPanel";

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
