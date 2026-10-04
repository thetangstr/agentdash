// @vitest-environment jsdom
// AgentDash (canary, lane chat): a green /api/health must not print
// "Connected" while the live socket is down — that lie is what hid the
// chat-goes-silent failure.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockUseServerHealth = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/useServerHealth", () => ({ useServerHealth: mockUseServerHealth }));

import { ConnectionStatus } from "./ConnectionStatus";
import { setLiveSocketState } from "../realtime/liveSocketState";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("ConnectionStatus", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    setLiveSocketState("idle");
    mockUseServerHealth.mockReturnValue({ reachability: "reachable", isOnline: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setLiveSocketState("idle");
  });

  const badge = () => container.querySelector('[data-testid="connection-status"]');

  it("says Connected only when health is green AND the socket is open", () => {
    act(() => root.render(<ConnectionStatus />));
    act(() => setLiveSocketState("open"));
    expect(badge()?.textContent).toBe("Connected");
  });

  it("shows reconnecting while the socket is down even with green health", () => {
    act(() => root.render(<ConnectionStatus />));
    act(() => setLiveSocketState("down"));
    expect(badge()?.textContent).toBe("Reconnecting…");
    expect(badge()?.querySelector("span")?.className).toContain("yellow");
  });

  it("shows connecting while the socket is still opening", () => {
    act(() => root.render(<ConnectionStatus />));
    act(() => setLiveSocketState("connecting"));
    expect(badge()?.textContent).toBe("Connecting…");
  });

  it("flips to Connected again when the socket recovers", () => {
    act(() => root.render(<ConnectionStatus />));
    act(() => setLiveSocketState("down"));
    expect(badge()?.textContent).toBe("Reconnecting…");
    act(() => setLiveSocketState("open"));
    expect(badge()?.textContent).toBe("Connected");
  });

  it("still says Offline when health fails, whatever the socket says", () => {
    mockUseServerHealth.mockReturnValue({ reachability: "unreachable", isOnline: true });
    act(() => root.render(<ConnectionStatus />));
    act(() => setLiveSocketState("open"));
    expect(badge()?.textContent).toBe("Offline");
  });

  it("still shows Checking while health is unsure and the socket is open", () => {
    mockUseServerHealth.mockReturnValue({ reachability: "checking", isOnline: true });
    act(() => root.render(<ConnectionStatus />));
    act(() => setLiveSocketState("open"));
    expect(badge()?.textContent).toBe("Checking…");
  });

  // AgentDash (review-1015): the steady "Connected" word costs ~90px of phone
  // header for nothing — it is screen-reader-only below md, while the states
  // that need saying stay visible.
  it("hides the Connected word below md but keeps it on warnings", () => {
    const label = () => badge()?.querySelector("span:last-child");

    act(() => root.render(<ConnectionStatus />));
    act(() => setLiveSocketState("open"));
    expect(label()?.textContent).toBe("Connected");
    expect(label()?.className).toContain("max-md:sr-only");

    act(() => setLiveSocketState("down"));
    expect(label()?.textContent).toBe("Reconnecting…");
    expect(label()?.className).not.toContain("sr-only");

    mockUseServerHealth.mockReturnValue({ reachability: "unreachable", isOnline: true });
    act(() => root.render(<ConnectionStatus />));
    expect(label()?.textContent).toBe("Offline");
    expect(label()?.className).not.toContain("sr-only");
  });
});
