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
    expect(container.textContent).toContain("14-day trial");
  });

  it("does not advertise per-run overage, because nothing can charge it", () => {
    // `reportUsageToStripe` exists, is unit-tested, and has NO production
    // caller — no scheduler, no webhook, no invoice hook ever pushes a meter
    // event. So the $0.05/run overage was a price we could not collect.
    //
    // This assertion used to be the inverse, inside a test named "without
    // fabricating numbers" — it required the fabricated number to be present.
    // Restore the claim only when a caller exists and a real Stripe meter event
    // has been observed.
    render();
    expect(container.textContent).not.toContain("$0.05");
    expect(container.textContent).not.toMatch(/overage/i);
  });

  it("routes workspace CTAs directly to hosted signup and Team inquiries to the public contact", () => {
    render();
    const signUpCtas = Array.from(container.querySelectorAll('a[href="/start"]'));
    expect(signUpCtas.length).toBe(6);
    expect(container.querySelector('a[href="/auth?mode=sign_up"]')).toBeNull();
    expect(container.querySelector('a[href="/trial"]')).toBeNull();
    const mailtoCta = container.querySelector('a[href^="mailto:"]');
    expect(mailtoCta?.getAttribute("href")).toBe("mailto:edward@agentdash.cloud");
    // a sign-in affordance exists
    expect(container.querySelector('a[href="/auth"]')).not.toBeNull();
  });

  it("discloses hosted model requirements alongside plan pricing", () => {
    render();
    const text = container.textContent!;
    expect(text).toMatch(/hosted agents.*(?:your|owner).*provider.*API key/i);
    expect(text).toMatch(/before the Chief of Staff can reply/i);
    expect(text).toMatch(/provider usage is billed separately/i);
    expect(text).not.toMatch(/no setup/i);
    expect(text).not.toMatch(/build a company in a minute/i);
    expect(container.querySelector('a[href="/docs/start/quickstart"]')).not.toBeNull();
  });

  it("labels every hosted signup link accurately", () => {
    render();
    const signupLabels = [...container.querySelectorAll('a[href="/start"]')].map((entry) => entry.textContent?.trim());
    expect(signupLabels).toEqual([
      "Start free", "Start free", "Start 14-day trial", "Start free", "Create a workspace", "Create a workspace",
    ]);
  });

  it("does not advertise the unavailable Test Drive as a plan entitlement", () => {
    render();
    expect(container.textContent).not.toMatch(/test drive/i);
  });

  it("renders the FAQ covering billing, runs, trial, and cancellation", () => {
    render();
    expect(container.textContent).toContain("How does billing work?");
    expect(container.textContent).toContain("What counts as an agent-run?");
    expect(container.textContent).toContain("Do I need a credit card");
    expect(container.textContent).toContain("Can I cancel anytime?");
  });
});
