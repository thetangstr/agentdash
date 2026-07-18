// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PricingPage } from "./PricingPage";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// PricingPage uses IntersectionObserver for scroll-reveal; jsdom doesn't ship
// one. Stub it so reveals mount without throwing (the reveal also has a
// reveal-on-mount fallback, so content renders regardless of motion).
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
    root.render(<PricingPage />);
  });
}

describe("PricingPage", () => {
  it("renders the three tier names", () => {
    render();
    const headings = Array.from(container.querySelectorAll("span")).map((s) => s.textContent);
    // Each tier name appears at least once (tier card header + compare table).
    expect(container.textContent).toContain("Free");
    expect(container.textContent).toContain("Pro");
    expect(container.textContent).toContain("Team");
    expect(headings).toContain("Free");
    expect(headings).toContain("Pro");
    expect(headings).toContain("Team");
  });

  it("renders the headline prices for each tier", () => {
    render();
    expect(container.textContent).toContain("$0");
    expect(container.textContent).toContain("$29");
    expect(container.textContent).toContain("Custom");
    // Pro is marked as the recommended plan.
    expect(container.textContent).toContain("Most popular");
  });

  it("renders the key Free + Pro entitlements without fabricating numbers", () => {
    render();
    expect(container.textContent).toContain("50 agent-runs / month");
    expect(container.textContent).toContain("1,000 agent-runs / mo");
    expect(container.textContent).toContain("$0.05 / run");
    expect(container.textContent).toContain("14-day trial");
  });

  it("routes Free and Pro CTAs to sign-up and Team CTA to a mailto (no live Stripe dependency)", () => {
    render();
    const signUpCtas = Array.from(container.querySelectorAll('a[href="/auth?mode=sign_up"]'));
    expect(signUpCtas.length).toBeGreaterThan(0);
    const mailtoCta = container.querySelector('a[href^="mailto:"]');
    expect(mailtoCta).not.toBeNull();
    // a sign-in affordance exists
    expect(container.querySelector('a[href="/auth"]')).not.toBeNull();
  });

  it("renders the FAQ covering billing, runs, trial, and cancellation", () => {
    render();
    expect(container.textContent).toContain("How does billing work?");
    expect(container.textContent).toContain("What counts as an agent-run?");
    expect(container.textContent).toContain("Do I need a credit card");
    expect(container.textContent).toContain("Can I cancel anytime?");
  });
});
