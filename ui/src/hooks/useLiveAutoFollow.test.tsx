// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLiveAutoFollow } from "./useLiveAutoFollow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no layout: each element reports the heights its data-* attributes
// say, and scrollTop is a plain stored number.
const scrollTops = new WeakMap<Element, number>();
const LINE_PX = 40;

function installLayout() {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const saved = {
    scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight"),
    clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight"),
    scrollTop: Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop"),
    scrollTo: proto.scrollTo,
  };
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.box ? this.querySelectorAll("[data-line]").length * LINE_PX : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.box ? 100 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return scrollTops.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      const max = Math.max(0, this.scrollHeight - this.clientHeight);
      scrollTops.set(this, Math.min(Math.max(0, value), max));
    },
  });
  proto.scrollTo = function scrollTo(this: HTMLElement, options: ScrollToOptions) {
    this.scrollTop = options.top ?? 0;
    this.dispatchEvent(new Event("scroll"));
  };
  return () => {
    for (const key of ["scrollHeight", "clientHeight", "scrollTop"] as const) {
      const descriptor = saved[key];
      if (descriptor) Object.defineProperty(Element.prototype, key, descriptor);
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
    }
    proto.scrollTo = saved.scrollTo;
  };
}

let followState: ReturnType<typeof useLiveAutoFollow> | null = null;

function RunPane({ ready, lines, contentKey }: { ready: boolean; lines: number; contentKey?: unknown }) {
  const follow = useLiveAutoFollow({ live: true, resetKey: "run-1", contentKey: contentKey ?? lines });
  followState = follow;
  // Like the run page: no pane (and no anchor) while the log is loading.
  if (!ready) return <p>Loading run logs...</p>;
  return (
    <div>
      <div data-box="1" style={{ overflowY: "auto", maxHeight: 100 }}>
        <div ref={follow.contentRef}>
          {Array.from({ length: lines }, (_, index) => (
            <div key={index} data-line>
              line {index}
            </div>
          ))}
        </div>
        <div ref={follow.anchorRef} />
      </div>
    </div>
  );
}

describe("useLiveAutoFollow", () => {
  let container: HTMLDivElement;
  let root: Root;
  let restoreLayout: () => void;
  let windowScroll: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    restoreLayout = installLayout();
    windowScroll = vi.fn();
    vi.stubGlobal("scrollTo", windowScroll);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreLayout();
    vi.unstubAllGlobals();
    followState = null;
  });

  const box = () => container.querySelector<HTMLElement>("[data-box]")!;

  it("follows the transcript pane even when the pane mounts after the loading state", () => {
    act(() => root.render(<RunPane ready={false} lines={0} />));
    act(() => root.render(<RunPane ready lines={2} />));
    act(() => root.render(<RunPane ready lines={10} />));
    // 10 lines × 40px in a 100px pane: the bottom is scrollTop 300.
    expect(box().scrollTop).toBe(300);
    expect(followState?.isFollowing).toBe(true);
    // The page itself was never scrolled instead of the pane.
    expect(windowScroll).not.toHaveBeenCalled();

    act(() => root.render(<RunPane ready lines={14} />));
    expect(box().scrollTop).toBe(460);
  });

  it("starts a live run at the latest line when it opens with history", () => {
    act(() => root.render(<RunPane ready lines={20} />));
    expect(box().scrollTop).toBe(700);
    expect(followState?.isFollowing).toBe(true);
  });

  it("lets go when the viewer scrolls up, and jump-to-latest follows again", () => {
    act(() => root.render(<RunPane ready lines={10} />));
    act(() => {
      box().scrollTop = 0;
      box().dispatchEvent(new Event("scroll"));
    });
    expect(followState?.isFollowing).toBe(false);
    act(() => root.render(<RunPane ready lines={12} />));
    expect(box().scrollTop).toBe(0);

    act(() => followState!.jumpToLatest());
    expect(box().scrollTop).toBe(380);
    expect(followState?.isFollowing).toBe(true);
  });

  it("follows content changes that do not add log lines (contentKey)", () => {
    act(() => root.render(<RunPane ready lines={5} contentKey="a" />));
    expect(box().scrollTop).toBe(100);
    // The view re-rendered taller from the same log lines (e.g. Business
    // timeline arrived): only the content key changes.
    act(() => root.render(<RunPane ready lines={9} contentKey="a" />));
    act(() => root.render(<RunPane ready lines={9} contentKey="b" />));
    expect(box().scrollTop).toBe(260);
  });
});
