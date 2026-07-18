// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvestorsPage } from "./InvestorsPage";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// InvestorsPage uses IntersectionObserver for scroll-reveal; jsdom doesn't ship
// one. Stub it so reveals mount without throwing (motion is irrelevant to the
// assertions; content renders regardless).
beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render() {
  act(() => {
    root.render(<InvestorsPage />);
  });
}

describe("InvestorsPage", () => {
  it("renders the hero thesis and primary CTA to the trial", () => {
    render();
    expect(container.textContent).toContain("autonomous company");
    expect(container.textContent).toContain("Chief of Staff");
    // primary CTA points at the public test drive
    const trialCtas = Array.from(container.querySelectorAll('a[href="/trial"]'));
    expect(trialCtas.length).toBeGreaterThan(0);
    // a sign-in affordance exists
    expect(container.querySelector('a[href="/auth"]')).not.toBeNull();
  });

  it("renders real founder-provided content, with no placeholder slots left", () => {
    render();
    // the founder card
    expect(container.textContent).toContain("Edward Yang Tang");
    expect(container.textContent).toContain("Founder");
    expect(container.textContent).toContain("Assembling a founding team");
    // real traction cards (no fabricated metrics)
    expect(container.textContent).toContain("Live in production");
    expect(container.textContent).toContain("Public Test Drive");
    expect(container.textContent).toContain("Stage: early");
    // the ask
    expect(container.textContent).toContain("Use of funds");
    // a real, clickable contact email
    const mailto = container.querySelector('a[href="mailto:edward@agentdash.cloud"]');
    expect(mailto).not.toBeNull();
    expect(mailto?.textContent).toContain("edward@agentdash.cloud");
    // nothing placeholder-shaped survives
    expect(container.querySelectorAll("[data-placeholder]").length).toBe(0);
    expect(container.textContent ?? "").not.toMatch(/placeholder/i);
  });

  it("includes the Google for Startups framing and a contact anchor", () => {
    render();
    expect(container.textContent).toContain("Google for Startups");
    expect(container.querySelector("#contact")).not.toBeNull();
  });
});
