// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  stepForView,
  urlForView,
  TrialLandingPage,
} from "./TrialLanding";
import { TRIAL_TOKEN_KEY } from "../lib/trial-storage";

// ---------------------------------------------------------------------------
// pure history-mapping helpers
// ---------------------------------------------------------------------------

describe("trial history mapping", () => {
  it("collapses the build phase to a single 'building' step", () => {
    expect(stepForView("land")).toBe("land");
    expect(stepForView("intake")).toBe("intake");
    expect(stepForView("designing")).toBe("building");
    expect(stepForView("fleet")).toBe("building");
    expect(stepForView("exhausted")).toBe("building");
  });

  it("builds the right URL per step", () => {
    expect(urlForView("land")).toBe("/");
    expect(urlForView("intake")).toBe("/?step=intake");
    expect(urlForView("fleet")).toBe("/?step=building");
  });
});

// ---------------------------------------------------------------------------
// component: browser Back/Forward stays within the flow
// ---------------------------------------------------------------------------

const mockTrialApi = vi.hoisted(() => ({
  createSession: vi.fn(),
  design: vi.fn(),
  runAgent: vi.fn(),
  getCompany: vi.fn(),
}));

vi.mock("../api/trial", () => ({ trialApi: mockTrialApi }));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children?: ReactNode }) => (
    <a href={typeof to === "string" ? to : "#"} {...props}>
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").toLowerCase().includes(text.toLowerCase()),
  );
  if (!btn) throw new Error(`button containing "${text}" not found`);
  return btn as HTMLButtonElement;
}

function historyView(): string | undefined {
  return (window.history.state as { trialView?: string } | null)?.trialView;
}

describe("TrialLandingPage history navigation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/trial");
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: () => ({
        matches: true, // prefers-reduced-motion: reduce — kills animation timers
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render() {
    root = createRoot(container);
    await act(async () => {
      root.render(<TrialLandingPage />);
    });
    await flush();
  }

  it("Back from intake returns to land without leaving /trial", async () => {
    await render();
    expect(container.textContent).toContain("describe your company");
    expect(historyView()).toBe("land");

    // A template click moves land -> intake and pushes a history entry.
    await act(async () => {
      findButton(container, "B2B SaaS startup").click();
    });
    await flush();
    expect(historyView()).toBe("intake");
    expect(container.textContent?.toLowerCase()).toContain("build my company");

    // Simulate the browser Back button popping to the land entry.
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: { trialView: "land" } }));
    });
    await flush();
    expect(container.textContent).toContain("describe your company");
  });

  it("first Back during the build keeps the team; a second Back leaves it", async () => {
    mockTrialApi.createSession.mockResolvedValue({
      token: "tok_1",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      creditCents: 500,
    });
    mockTrialApi.design.mockResolvedValue({
      company: { name: "Acme Robotics", mission: "build the future" },
      agents: [
        {
          id: "a1",
          ref: "AGT-1",
          name: "Scout",
          role: "sales",
          category: "sales",
          charter: "find leads",
          firstTaskTitle: "Outreach plan",
          status: "active",
        },
      ],
      creditCents: 500,
      creditRemainingCents: 400,
      spentCents: 100,
    });
    mockTrialApi.runAgent.mockResolvedValue({
      artifact: { id: "art1", title: "Outreach plan", content: { markdown: "# Plan" } },
      creditCents: 500,
      creditRemainingCents: 300,
      spentCents: 100,
    });

    await render();

    // land -> intake (template) -> build
    await act(async () => {
      findButton(container, "B2B SaaS startup").click();
    });
    await flush();
    await act(async () => {
      findButton(container, "build my company").click();
    });
    await flush();
    await flush();

    expect(container.textContent).toContain("Acme Robotics");
    expect(historyView()).toBe("fleet");

    // First Back out of the built team is absorbed — the team stays visible.
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: { trialView: "intake" } }));
    });
    await flush();
    expect(container.textContent).toContain("Acme Robotics");

    // Second consecutive Back is allowed through to the intake form.
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: { trialView: "intake" } }));
    });
    await flush();
    expect(container.textContent?.toLowerCase()).toContain("build my company");

    // The token is still persisted, so the company is recoverable (not destroyed).
    expect(window.localStorage.getItem(TRIAL_TOKEN_KEY)).toBe("tok_1");
  });
});
