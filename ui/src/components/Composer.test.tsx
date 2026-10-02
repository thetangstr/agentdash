// @vitest-environment jsdom
// AgentDash (scan 4, lane N): a phone-width composer cut the placeholder off at
// "Tip:"; phones get the short one.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { COMPOSER_PLACEHOLDER, COMPOSER_PLACEHOLDER_PHONE, Composer } from "./Composer";
import { DESKTOP_WIDTH, PHONE_WIDTH, mockViewportWidth } from "../lib/test-viewport";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function placeholderAt(width: number): Promise<string | null> {
  const restore = mockViewportWidth(width);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<Composer onSend={() => {}} agentDirectory={[]} />);
    });
    return container.querySelector("input")?.getAttribute("placeholder") ?? null;
  } finally {
    act(() => root.unmount());
    container.remove();
    restore();
  }
}

describe("Composer placeholder", () => {
  it("is short on phones", async () => {
    expect(await placeholderAt(PHONE_WIDTH)).toBe(COMPOSER_PLACEHOLDER_PHONE);
    expect(COMPOSER_PLACEHOLDER_PHONE).not.toContain("Tip");
  });

  it("keeps the @-mention tip on wider screens", async () => {
    expect(await placeholderAt(DESKTOP_WIDTH)).toBe(COMPOSER_PLACEHOLDER);
  });
});
