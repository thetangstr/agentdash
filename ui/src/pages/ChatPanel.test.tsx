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
// AgentDash (chat auto-follow): the same rule covers new messages. While the
// reader is at the bottom the chat follows; a scroll up lets go (new messages
// used to yank them back down) and shows "Jump to latest"; sending follows
// again.
describe("ChatPanel auto-follow", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let resizeCallbacks: Array<() => void>;
  // A fake layout for the scroller: each message is 200px tall.
  let layout: { scrollHeight: number; clientHeight: number; scrollTop: number };

  class FakeResizeObserver {
    constructor(callback: () => void) {
      resizeCallbacks.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  const messagesOf = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ id: `m${index + 1}`, role: "agent", content: `Message ${index + 1}` }));

  const scroller = () => container.querySelector('[data-testid="chat-scroller"]') as HTMLElement;
  const jumpButton = () => container.querySelector('[data-testid="chat-jump-to-latest"]') as HTMLButtonElement | null;
  const maxTop = () => Math.max(0, layout.scrollHeight - layout.clientHeight);

  function installLayout(el: HTMLElement) {
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => layout.scrollHeight });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => layout.clientHeight });
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => layout.scrollTop,
      set: (value: number) => {
        layout.scrollTop = Math.min(Math.max(0, value), maxTop());
      },
    });
    el.scrollTo = ((options: ScrollToOptions) => {
      el.scrollTop = options.top ?? 0;
      el.dispatchEvent(new Event("scroll"));
    }) as typeof el.scrollTo;
  }

  const relayout = () => {
    act(() => resizeCallbacks.forEach((cb) => cb()));
  };

  /** Render `count` messages and let the layout settle (the browser's ResizeObserver pass). */
  function renderMessages(count: number, extraProps: { suggestions?: string[] } = {}) {
    mockUseMessages.mockReturnValue(messagesOf(count));
    act(() => root.render(<ChatPanel conversationId="c1" companyId="co1" {...extraProps} />));
    if (scroller().dataset.layoutInstalled !== "1") {
      scroller().dataset.layoutInstalled = "1";
      installLayout(scroller());
    }
    layout.scrollHeight = count * 200;
    relayout();
  }

  const userScrollTo = (top: number) => {
    act(() => {
      scroller().scrollTop = top;
      scroller().dispatchEvent(new Event("scroll"));
    });
  };

  beforeEach(() => {
    resizeCallbacks = [];
    layout = { scrollHeight: 0, clientHeight: 400, scrollTop: 0 };
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Element.prototype.scrollIntoView = vi.fn();
    mockPost.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("opens on the newest message and follows new ones while the reader is at the bottom", () => {
    renderMessages(5);
    expect(scroller().scrollTop).toBe(600);
    expect(jumpButton()).toBeNull();

    renderMessages(7);
    expect(scroller().scrollTop).toBe(1000);
    expect(jumpButton()).toBeNull();
  });

  it("re-pins to the bottom on resize while the reader is at the bottom", () => {
    renderMessages(5);
    expect(scroller().scrollTop).toBe(600);
    // A desktop→phone reflow: the scroller gets shorter.
    layout.clientHeight = 300;
    relayout();
    expect(scroller().scrollTop).toBe(700);
  });

  it("does not re-pin on resize after the reader scrolled up", () => {
    renderMessages(5);
    userScrollTo(100);
    layout.clientHeight = 300;
    relayout();
    expect(scroller().scrollTop).toBe(100);
  });

  it("lets go when the reader scrolls up: new messages leave them where they are, and Jump to latest follows again", () => {
    renderMessages(5);
    userScrollTo(120);
    expect(jumpButton()?.textContent).toContain("Jump to latest");

    renderMessages(8);
    expect(scroller().scrollTop).toBe(120);

    act(() => jumpButton()!.click());
    expect(scroller().scrollTop).toBe(1200);
    expect(jumpButton()).toBeNull();

    renderMessages(9);
    expect(scroller().scrollTop).toBe(1400);
  });

  it("follows again when the person sends a message", async () => {
    mockPost.mockResolvedValue({ id: "m-sent" });
    renderMessages(5, { suggestions: ["Who should I hire first?"] });
    userScrollTo(0);
    expect(jumpButton()).not.toBeNull();

    const chip = container.querySelector('[data-testid="chat-suggestions"] button') as HTMLButtonElement;
    await act(async () => chip.click());
    expect(scroller().scrollTop).toBe(600);
    expect(jumpButton()).toBeNull();

    renderMessages(6);
    expect(scroller().scrollTop).toBe(800);
  });
});
