// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/marketing/hooks/usePrefersReducedMotion", () => ({
  usePrefersReducedMotion: () => false,
}));

import { StewardDemo } from "./StewardDemo";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  Element.prototype.scrollTo = () => {};
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function buttonByText(text: RegExp): HTMLButtonElement {
  const btn = [...container.querySelectorAll("button")].find((b) => text.test(b.textContent ?? ""));
  if (!btn) throw new Error(`no button matching ${text}`);
  return btn as HTMLButtonElement;
}

// React flushes renders and effects when each act() scope closes, and the
// player schedules the next reveal from an effect, so time has to advance in
// separate act() steps for the scripted chain to progress.
async function runTimers(ms: number) {
  const step = 250;
  for (let t = 0; t < ms; t += step) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(step);
    });
  }
}

describe("StewardDemo", () => {
  it("walks a visitor from request to decision to result", async () => {
    await act(async () => {
      root.render(<StewardDemo />);
    });
    expect(container.textContent).toContain("Simulated walkthrough");

    await act(async () => { buttonByText(/^Send:/).click(); });
    expect(container.textContent).toContain("inbox_propose");
    expect(container.querySelectorAll(".mkt-issue")).toHaveLength(0);

    await act(async () => { buttonByText(/Reply “yes”/).click(); });
    expect(container.textContent).toContain("inbox_confirm");

    await runTimers(30_000);
    expect(container.querySelector(".mkt-approval")).not.toBeNull();
    expect(container.textContent).toContain("inbox_sync");
    expect(container.querySelector(".mkt-deliverable")).toBeNull();

    // Time alone must not resolve the gate.
    await runTimers(10_000);
    expect(container.querySelector(".mkt-deliverable")).toBeNull();

    await act(async () => { buttonByText(/Reply “approve”/).click(); });
    await runTimers(30_000);
    expect(container.textContent).toContain("inbox_decide");
    expect(container.querySelector(".mkt-deliverable")?.textContent).toContain("Board update");
    expect(container.querySelectorAll(".mkt-issue.is-done").length).toBeGreaterThan(2);

    await act(async () => { buttonByText(/Start over/).click(); });
    expect(container.querySelectorAll(".mkt-issue")).toHaveLength(0);
  });

  it("lets the visitor switch harness and scenario before sending", async () => {
    await act(async () => {
      root.render(<StewardDemo />);
    });
    await act(async () => { buttonByText(/^Codex$/).click(); });
    expect(container.textContent).toContain("codex · agentdash mcp");
    await act(async () => { buttonByText(/recruiting is stalling/).click(); });
    expect(buttonByText(/^Send:/).textContent).toContain("recruiting pipeline");
  });
});
