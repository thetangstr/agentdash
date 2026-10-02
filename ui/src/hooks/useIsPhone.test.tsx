// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useIsPhone } from "./useIsPhone";
import { DESKTOP_WIDTH, PHONE_WIDTH, mockViewportWidth } from "../lib/test-viewport";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  return <span data-testid="probe">{useIsPhone() ? "phone" : "wide"}</span>;
}

async function renderProbe(): Promise<{ text: string; unmount: () => void; container: HTMLElement }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Probe />);
  });
  return {
    text: container.textContent ?? "",
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("useIsPhone", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("is false where matchMedia does not exist", async () => {
    const view = await renderProbe();
    expect(view.text).toBe("wide");
    view.unmount();
  });

  it("is true at 390px", async () => {
    restore = mockViewportWidth(PHONE_WIDTH);
    const view = await renderProbe();
    expect(view.text).toBe("phone");
    view.unmount();
  });

  it("is false at desktop width and at the 640px sm breakpoint", async () => {
    restore = mockViewportWidth(DESKTOP_WIDTH);
    const desktop = await renderProbe();
    expect(desktop.text).toBe("wide");
    desktop.unmount();
    restore();
    restore = mockViewportWidth(640);
    const sm = await renderProbe();
    expect(sm.text).toBe("wide");
    sm.unmount();
  });
});
