// @vitest-environment jsdom
// AgentDash (first-session test, Lane A item 4): an empty conversation shows
// the page's opener instead of a blank panel.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockUseMessages = vi.hoisted(() => vi.fn());

vi.mock("../realtime/useMessages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../realtime/useMessages")>()),
  useMessages: mockUseMessages,
}));
vi.mock("../components/MessageList", () => ({
  MessageList: ({ messages }: { messages: Array<{ id: string }> }) => (
    <div data-testid="message-list">{messages.length} messages</div>
  ),
}));
vi.mock("../components/Composer", () => ({ Composer: () => <div data-testid="composer" /> }));
vi.mock("../components/ChatHeader", () => ({ ChatHeader: () => <div data-testid="chat-header" /> }));
const mockRetry = vi.hoisted(() => vi.fn());
const mockPost = vi.hoisted(() => vi.fn());
vi.mock("../api/conversations", () => ({
  conversationsApi: { read: vi.fn().mockResolvedValue(undefined), post: mockPost, retry: mockRetry },
}));
const mockPublish = vi.hoisted(() => vi.fn());
vi.mock("../realtime/conversationEventBus", () => ({
  publishConversationMessage: mockPublish,
  subscribeToConversationMessages: vi.fn(() => () => {}),
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

  // AgentDash (scan 3, lane G): server rows carry `role`, not `authorKind`.
  it("shows starter chips only until the person has sent a message", () => {
    const chips = ["Plan this quarter with me"];
    mockUseMessages.mockReturnValue([{ id: "m1", role: "agent", content: "Hi" }]);
    act(() => root.render(<ChatPanel conversationId="c1" companyId="co1" suggestions={chips} />));
    expect(container.querySelector('[data-testid="chat-suggestions"]')).not.toBeNull();

    mockUseMessages.mockReturnValue([
      { id: "m1", role: "agent", content: "Hi" },
      { id: "m2", role: "user", content: "Win more bids" },
    ]);
    act(() => root.render(<ChatPanel conversationId="c1" companyId="co1" suggestions={chips} />));
    expect(container.querySelector('[data-testid="chat-suggestions"]')).toBeNull();
  });

  it("hides the starter chips as soon as one is sent", async () => {
    mockPost.mockResolvedValue({ id: "m2" });
    mockUseMessages.mockReturnValue([{ id: "m1", role: "agent", content: "Hi" }]);
    act(() => root.render(<ChatPanel conversationId="c1" companyId="co1" suggestions={["Who should I hire first?"]} />));
    const chip = container.querySelector('[data-testid="chat-suggestions"] button') as HTMLButtonElement;
    act(() => chip.click());
    expect(container.querySelector('[data-testid="chat-suggestions"]')).toBeNull();
  });
});

// AgentDash (canary, lane chat): the POST response is the persisted row — it
// goes straight into the open chat instead of waiting for the live socket
// (which may be down) to deliver it back.
describe("ChatPanel sent message", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Element.prototype.scrollIntoView = vi.fn();
    mockPublish.mockClear();
    mockPost.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("publishes the message the POST returned as soon as it resolves", async () => {
    const posted = {
      id: "m9",
      conversationId: "c1",
      role: "user",
      authorUserId: "person-1",
      content: "Who should I hire first?",
      createdAt: "2026-10-03T09:00:00Z",
    };
    mockPost.mockResolvedValue(posted);
    mockUseMessages.mockReturnValue([{ id: "m1", role: "agent", content: "Hi" }]);
    act(() => root.render(<ChatPanel conversationId="c1" companyId="co1" suggestions={["Who should I hire first?"]} />));
    const chip = container.querySelector('[data-testid="chat-suggestions"] button') as HTMLButtonElement;

    await act(async () => chip.click());

    expect(mockPost).toHaveBeenCalledWith("c1", "Who should I hire first?", "co1");
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(posted);
  });

  it("publishes nothing when the POST fails, and says so", async () => {
    mockPost.mockRejectedValue(new Error("offline"));
    mockUseMessages.mockReturnValue([{ id: "m1", role: "agent", content: "Hi" }]);
    act(() => root.render(<ChatPanel conversationId="c1" companyId="co1" suggestions={["Who should I hire first?"]} />));
    const chip = container.querySelector('[data-testid="chat-suggestions"] button') as HTMLButtonElement;

    await act(async () => chip.click());

    expect(mockPublish).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="chat-send-error"]')?.textContent).toContain("was not sent");
  });
});

// AgentDash (canary, lane chat): the chat used to open ~52px short of the
// bottom — a smooth scroll interrupted mid-flight by the thinking block and
// cards still laying out. The first scroll is instant instead.
describe("ChatPanel initial scroll", () => {
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

  it("lands on the newest message instantly once the first page paints", () => {
    mockUseMessages.mockReturnValue([
      { id: "m1", role: "agent", content: "Hi" },
      { id: "m2", role: "agent", content: "Newest" },
    ]);
    // jsdom reports scrollHeight 0; fake a tall scroller so the effect has
    // something to land on.
    const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight");
    Object.defineProperty(Element.prototype, "scrollHeight", { value: 640, configurable: true });
    try {
      act(() => root.render(<ChatPanel conversationId="c1" companyId="co1" />));
      const scroller = container.querySelector('[data-testid="chat-scroller"]') as HTMLElement;
      // The container's own scrollTop is set (scrollIntoView on a marker
      // stopped the pb-4 padding short of the bottom), instantly — nothing
      // still laying out can interrupt it above the bottom.
      expect(scroller.scrollTop).toBe(640);
    } finally {
      if (original) Object.defineProperty(Element.prototype, "scrollHeight", original);
    }
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

// AgentDash (review-1015): a desktop→phone resize reflows the scroller —
// scrollHeight and clientHeight change, so a chat pinned to the bottom
// jumped to mid-thread. The pin is restored on resize only while the
// reader is still at the bottom; a person reading history is left alone.
describe("ChatPanel resize pin", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let resizeCallbacks: Array<() => void>;

  class FakeResizeObserver {
    constructor(callback: () => void) {
      resizeCallbacks.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  function renderAndMeasure() {
    mockUseMessages.mockReturnValue([{ id: "m1", role: "agent", content: "Hi" }]);
    act(() => root.render(<ChatPanel conversationId="c1" companyId="co1" />));
    const scroller = container.querySelector('[data-testid="chat-scroller"]') as HTMLElement;
    Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 400, configurable: true });
    return scroller;
  }

  const scrollTo = (el: HTMLElement, top: number) => {
    act(() => {
      el.scrollTop = top;
      el.dispatchEvent(new Event("scroll"));
    });
  };

  const resize = () => {
    act(() => resizeCallbacks.forEach((cb) => cb()));
  };

  beforeEach(() => {
    resizeCallbacks = [];
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("re-pins to the bottom on resize while the reader is at the bottom", () => {
    const scroller = renderAndMeasure();
    scrollTo(scroller, 600); // 1000 - 600 - 400 = 0 < 8 → at bottom
    scroller.scrollTop = 500; // a resize reflow nudged the pin off the bottom
    resize();
    expect(scroller.scrollTop).toBe(1000);
  });

  it("does not re-pin on resize after the reader scrolled up", () => {
    const scroller = renderAndMeasure();
    scrollTo(scroller, 100); // 1000 - 100 - 400 = 500 ≥ 8 → scrolled up
    scroller.scrollTop = 120;
    resize();
    expect(scroller.scrollTop).toBe(120);
  });
});
