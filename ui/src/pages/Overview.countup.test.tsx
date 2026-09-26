// @vitest-environment jsdom
// AgentDash: UX-3 (#784) — the stalled count-up. requestAnimationFrame does
// not fire in a background tab; the tiles showed 0 while the header showed 6.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { useCountUp } = await import("./Overview");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ target }: { target: number }) {
  const value = useCountUp(target, 0, false);
  return <span data-testid="v">{value}</span>;
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
}

describe("useCountUp", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // Background-tab behaviour: frames are requested but never delivered.
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
    setHidden(false);
  });

  const text = () => container.querySelector('[data-testid="v"]')?.textContent;

  it("shows the real number at once in a hidden tab", async () => {
    setHidden(true);
    await act(async () => root.render(<Probe target={6} />));
    expect(text()).toBe("6");
  });

  it("lands the real number even when no animation frame ever runs", async () => {
    setHidden(false);
    await act(async () => root.render(<Probe target={92} />));
    await act(async () => {
      vi.advanceTimersByTime(1200);
    });
    expect(text()).toBe("92");
  });

  it("never drops back to 0 when the target changes on refetch", async () => {
    setHidden(false);
    await act(async () => root.render(<Probe target={7} />));
    await act(async () => {
      vi.advanceTimersByTime(1200);
    });
    expect(text()).toBe("7");
    await act(async () => root.render(<Probe target={92} />));
    expect(text()).toBe("7");
    await act(async () => {
      vi.advanceTimersByTime(1200);
    });
    expect(text()).toBe("92");
  });

  it("jumps to the target when the tab is hidden mid-animation", async () => {
    setHidden(false);
    await act(async () => root.render(<Probe target={50} />));
    setHidden(true);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(text()).toBe("50");
  });
});
