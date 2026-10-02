// @vitest-environment jsdom
// AgentDash: mobile redesign lane A — phone (390px) behaviour of the issue header
// overflow menu and the Ask chat surface. jsdom does not evaluate Tailwind, so the
// phone layout is asserted through its class contract under a 390px viewport mock;
// tests/e2e/mobile-issue-ask.spec.ts checks the rendered geometry in Chromium.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockUseMessages = vi.hoisted(() => vi.fn());
const mockPost = vi.hoisted(() => vi.fn());

vi.mock("../realtime/useMessages", () => ({ useMessages: mockUseMessages }));
vi.mock("../api/conversations", () => ({
  conversationsApi: { read: vi.fn().mockResolvedValue(undefined), post: mockPost },
}));
vi.mock("./cards", () => ({ CardRenderer: () => <div data-testid="card" /> }));

import ChatPanel from "../pages/ChatPanel";
import { ChatHeader } from "./ChatHeader";
import { IssuePhoneActionsMenu } from "./IssuePhoneActionsMenu";
import { MessageList } from "./MessageList";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const PHONE_WIDTH = 390;
const originalInnerWidth = window.innerWidth;
const originalMatchMedia = window.matchMedia;

function mockPhoneViewport() {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: PHONE_WIDTH });
  window.matchMedia = vi.fn().mockImplementation((query: string) => {
    const max = /max-width:\s*(\d+)/.exec(query);
    const min = /min-width:\s*(\d+)/.exec(query);
    const matches = (max ? PHONE_WIDTH <= Number(max[1]) : true) && (min ? PHONE_WIDTH >= Number(min[1]) : true);
    return {
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
  }) as unknown as typeof window.matchMedia;
}

function classesOf(el: Element | null | undefined) {
  return (el?.getAttribute("class") ?? "").split(/\s+/);
}

describe("mobile issue + Ask (390px viewport)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    mockPhoneViewport();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Element.prototype.scrollIntoView = vi.fn();
    mockPost.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
    window.matchMedia = originalMatchMedia;
  });

  it("puts New sub-issue, Upload attachment and New document in one phone-only ⋯ menu", async () => {
    const onNewSubIssue = vi.fn();
    const onUploadAttachment = vi.fn();
    const onNewDocument = vi.fn();
    act(() =>
      root.render(
        <IssuePhoneActionsMenu
          onNewSubIssue={onNewSubIssue}
          onUploadAttachment={onUploadAttachment}
          onNewDocument={onNewDocument}
        />,
      ),
    );
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="issue-phone-actions-trigger"]');
    expect(trigger?.getAttribute("aria-label")).toBe("Issue actions");
    // Hidden from 640px up (desktop keeps its inline buttons); a 44px tap target on phones.
    expect(classesOf(trigger)).toEqual(expect.arrayContaining(["sm:hidden", "size-11"]));

    const open = async () => {
      await act(async () => {
        trigger!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      return Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    };

    let items = await open();
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      "New sub-issue",
      "Upload attachment",
      "New document",
    ]);
    for (const item of items) expect(classesOf(item)).toContain("min-h-11");

    await act(async () => items[0]!.click());
    expect(onNewSubIssue).toHaveBeenCalledTimes(1);
    items = await open();
    await act(async () => items[1]!.click());
    expect(onUploadAttachment).toHaveBeenCalledTimes(1);
    items = await open();
    await act(async () => items[2]!.click());
    expect(onNewDocument).toHaveBeenCalledTimes(1);
    // Three Radix menu open/close cycles; give a loaded CI box headroom past the 5s default.
  }, 15_000);

  it("shows the Ask starters as one sideways-scrolling row of 44px chips on phones", () => {
    mockUseMessages.mockReturnValue([{ id: "m1", authorKind: "agent", body: "Hi", createdAt: new Date().toISOString() }]);
    act(() =>
      root.render(
        <ChatPanel
          conversationId="c1"
          companyId="co1"
          suggestions={["Plan this quarter with me", "Who should I hire first?", "Turn a goal into tasks"]}
        />,
      ),
    );
    const row = container.querySelector('[data-testid="chat-suggestions"]');
    expect(classesOf(row)).toEqual(
      expect.arrayContaining(["max-sm:flex-nowrap", "max-sm:overflow-x-auto"]),
    );
    // Desktop keeps the wrapping row.
    expect(classesOf(row)).toContain("flex-wrap");
    const chips = Array.from(row!.querySelectorAll("button"));
    expect(chips).toHaveLength(3);
    for (const chip of chips) {
      expect(classesOf(chip)).toEqual(
        expect.arrayContaining(["max-sm:min-h-11", "max-sm:shrink-0", "max-sm:whitespace-nowrap"]),
      );
    }
    act(() => chips[1]!.click());
    expect(mockPost).toHaveBeenCalledWith("c1", "Who should I hire first?", "co1");
  });

  it("pads the Ask composer for the safe area only when the panel fills the viewport", () => {
    mockUseMessages.mockReturnValue([]);
    act(() => root.render(<ChatPanel conversationId="c1" companyId="co1" />));
    const embeddedDock = container.querySelector('[data-testid="chat-composer-dock"]');
    expect(embeddedDock?.getAttribute("class")).not.toContain("safe-area-inset-bottom");

    act(() => root.render(<ChatPanel conversationId="c1" companyId="co1" padComposerForSafeArea />));
    const fullscreenDock = container.querySelector('[data-testid="chat-composer-dock"]');
    expect(fullscreenDock?.getAttribute("class")).toContain("pb-[calc(0.5rem+env(safe-area-inset-bottom))]");
  });

  it("renders a compact header action (the workforce link) next to the CoS identity", () => {
    act(() =>
      root.render(
        <ChatHeader agentRole="Tell me what you want built." action={<a href="/workforce">Review</a>} />,
      ),
    );
    const header = container.querySelector('[data-testid="chat-header"]');
    expect(header?.querySelector('a[href="/workforce"]')?.textContent).toBe("Review");
    expect(classesOf(header)).toEqual(expect.arrayContaining(["max-sm:px-4", "max-sm:py-1.5"]));
    // The context line truncates to one line on phones.
    expect(classesOf(header?.querySelector("span.text-xs"))).toContain("max-sm:truncate");
  });

  it("lets Ask bubbles use the full width on phones (no avatar gutter, no 80% cap)", () => {
    act(() =>
      root.render(
        <MessageList
          cardContext={{
            onProposalConfirm: () => {},
            onProposalReject: () => {},
            onInviteSend: async () => {},
            onInviteSkip: () => {},
          }}
          messages={[
            { id: "a", authorKind: "agent", body: "From the CoS", createdAt: new Date().toISOString() },
            { id: "u", authorKind: "user", body: "From me", createdAt: new Date().toISOString() },
          ] as never}
        />,
      ),
    );
    const rows = Array.from(container.querySelectorAll(".message-list > div"));
    expect(rows).toHaveLength(2);
    const avatar = rows[0]!.querySelector(".rounded-full");
    expect(classesOf(avatar)).toContain("max-sm:hidden");
    for (const row of rows) {
      const column = row.querySelector(".flex-col");
      expect(classesOf(column)).toEqual(expect.arrayContaining(["max-w-[80%]", "max-sm:max-w-full", "min-w-0"]));
    }
    // Timestamps stay at 12px or larger on phones.
    for (const stamp of Array.from(container.querySelectorAll("span.text-text-tertiary"))) {
      expect(classesOf(stamp)).toContain("max-sm:text-xs");
    }
  });
});
