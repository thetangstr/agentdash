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

  it("renders every placeholder slot the user must fill in (no fabricated data)", () => {
    render();
    const expectedSlots = [
      "traction-signups",
      "traction-usage",
      "traction-revenue",
      "traction-pipeline",
      "traction-proof",
      "team-member-1",
      "team-member-2",
      "team-member-3",
      "team-advisors",
      "ask-stage",
      "ask-amount",
      "ask-use",
      "contact-email",
      "contact-deck",
    ];
    for (const slot of expectedSlots) {
      expect(
        container.querySelector(`[data-placeholder="${slot}"]`),
        `missing placeholder slot: ${slot}`,
      ).not.toBeNull();
    }
    // every placeholder is loudly labelled so it can't ship as real content
    const placeholders = container.querySelectorAll("[data-placeholder]");
    expect(placeholders.length).toBe(expectedSlots.length);
  });

  it("includes the Google for Startups framing and a contact anchor", () => {
    render();
    expect(container.textContent).toContain("Google for Startups");
    expect(container.querySelector("#contact")).not.toBeNull();
  });
});
