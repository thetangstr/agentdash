// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerUnreachableOverlay } from "./ServerUnreachableOverlay";

const mockUseServerHealth = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useServerHealth", () => ({
  useServerHealth: () => mockUseServerHealth(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("ServerUnreachableOverlay", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockUseServerHealth.mockReturnValue({
      reachability: "unreachable",
      lastCheck: new Date(),
      isOnline: true,
    });
  });

  afterEach(() => {
    if (root) {
      act(() => root.unmount());
    }
    document.body.removeChild(container);
  });

  function renderAt(pathname: string) {
    window.history.pushState({}, "", pathname);
    root = createRoot(container);
    act(() => {
      root.render(<ServerUnreachableOverlay />);
    });
  }

  it("does not cover the public auth page when the app backend is unavailable", () => {
    renderAt("/auth");

    expect(container.textContent).not.toContain("Connection Lost");
  });
});
