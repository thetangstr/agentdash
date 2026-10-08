// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamSidebar, FollowingTranscript } from "./ReleaseIllustrations";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let reducedMotion = false;
beforeEach(() => {
  vi.useFakeTimers();
  reducedMotion = false;
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: reducedMotion && query.includes("reduced-motion"), addEventListener() {}, removeEventListener() {} }));
  Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: vi.fn(function (this: HTMLElement, options: ScrollToOptions) { this.scrollTop = options.top ?? 0; }) });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function button(text: string) {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

describe("release illustrations", () => {
  it("uses keyboard-native team disclosures and keeps the selected agent visible", async () => {
    await act(async () => root.render(<TeamSidebar />));
    const team = container.querySelector("details")!;
    expect(team.open).toBe(true);
    expect(team.querySelector("summary")?.textContent).toContain("Research team");
    await act(async () => { team.open = false; team.dispatchEvent(new Event("toggle")); });
    expect(container.querySelector('[aria-current="true"]')?.closest("details")).toBeNull();
    expect(container.querySelector('[aria-current="true"]')?.textContent).toContain("Writer");
  });
  it("holds the transcript while new output arrives, then follows on Jump to latest", async () => {
    await act(async () => root.render(<FollowingTranscript />));
    const pane = container.querySelector<HTMLElement>('[role="region"]')!;
    Object.defineProperties(pane, { scrollHeight: { get: () => 500 }, clientHeight: { get: () => 140 } });
    await act(async () => button("Play output").click());
    await act(async () => button("Read earlier").click());
    expect(container.textContent).toContain("Following paused");
    const heldTop = pane.scrollTop;
    await act(async () => vi.advanceTimersByTime(1100));
    expect(container.textContent).toContain("Draft prepared");
    expect(pane.scrollTop).toBe(heldTop);
    await act(async () => button("Jump to latest").click());
    expect(pane.scrollTop).toBe(500);
    expect(container.textContent).toContain("Following latest");
  });
  it("keeps reduced-motion illustrations manual without timed progression", async () => {
    reducedMotion = true;
    await act(async () => root.render(<FollowingTranscript />));
    await act(async () => vi.advanceTimersByTime(9000));
    expect(container.textContent).not.toContain("Draft prepared");
    await act(async () => button("Next output").click());
    expect(container.textContent).toContain("Draft prepared");
  });
});
