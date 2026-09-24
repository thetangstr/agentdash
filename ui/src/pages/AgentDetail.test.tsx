// @vitest-environment jsdom
//
// OBS-2 (#695): the ceiling status line is the pause's visibility surface. A
// steward has to be able to read, at a glance, that the agent stopped waking
// itself — and that assigned work still runs — or the ceiling reads as a bug.

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AgentTokenCeilingStatus } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

// AgentDetail's import graph reaches `@mdxeditor/editor` via AgentConfigForm →
// MarkdownEditor, and its Sandpack dependency throws inside jsdom's CSS
// parser. The status line never renders the editor, so it is mocked to a stub.
vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: () => null,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { TokenCeilingStatusLine } = await import("./AgentDetail");

function statusFixture(overrides: Partial<AgentTokenCeilingStatus> = {}): AgentTokenCeilingStatus {
  return {
    ceiling: 5_000_000,
    isDefault: true,
    tokensToday: 1_250_000,
    meteredRuns: 12,
    unmeteredRuns: 0,
    paused: false,
    liftsAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function render(status: AgentTokenCeilingStatus, onSave = vi.fn(), pending = false) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <TooltipProvider>
        <TokenCeilingStatusLine status={status} pending={pending} onSave={onSave} />
      </TooltipProvider>,
    );
  });
  return onSave;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("TokenCeilingStatusLine", () => {
  it("shows the daily ceiling and today's usage", () => {
    render(statusFixture());
    const text = container!.textContent ?? "";
    expect(text).toContain("Daily token ceiling");
    expect(text).toContain("(default)");
    expect(text).toContain("used today");
    expect(text).not.toContain("paused");
  });

  it("announces the pause with the UTC lift time and what still runs", () => {
    render(statusFixture({ paused: true, tokensToday: 5_200_000 }));
    const text = container!.textContent ?? "";
    expect(text).toContain("Timer and comment wakes are paused until");
    expect(text).toContain("UTC");
    expect(text).toContain("assigned work and manual wakes still run");
    // The paused affordance is the recovery path, not a bare Edit.
    expect(text).toContain("Raise or clear");
  });

  it("says off when the ceiling is disabled", () => {
    render(statusFixture({ ceiling: null, isDefault: false }));
    expect(container!.textContent).toContain("Daily token ceiling: off");
  });

  it("shows the unmetered-run count when metering is off", () => {
    render(statusFixture({ unmeteredRuns: 3 }));
    expect(container!.textContent).toContain("3 runs unmetered");
  });

  it("saves a typed ceiling and turns the ceiling off", () => {
    const onSave = render(statusFixture());
    const editButton = [...container!.querySelectorAll("button")].find(
      (b) => b.textContent === "Edit",
    )!;
    act(() => editButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const input = container!.querySelector("input")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "8000000");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const save = [...container!.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
    act(() => save.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).toHaveBeenCalledWith(8_000_000);

    // Reopen and turn off.
    const editAgain = [...container!.querySelectorAll("button")].find(
      (b) => b.textContent === "Edit",
    )!;
    act(() => editAgain.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const off = [...container!.querySelectorAll("button")].find(
      (b) => b.textContent === "Turn off",
    )!;
    act(() => off.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).toHaveBeenCalledWith(0);
  });

  it("keeps Save disabled on a non-numeric draft", () => {
    render(statusFixture());
    const editButton = [...container!.querySelectorAll("button")].find(
      (b) => b.textContent === "Edit",
    )!;
    act(() => editButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const save = [...container!.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
    expect(save.disabled).toBe(true);
  });
});
