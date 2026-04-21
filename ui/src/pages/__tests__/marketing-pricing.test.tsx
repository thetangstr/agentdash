// @vitest-environment node
// AgentDash: Marketing pricing page — vitest smoke tests
// Imports the Next.js page component directly and renders it to static markup.
// The pricing page is a plain React component with no Next.js hooks, so it
// works fine in the existing vitest + react-dom/server environment in ui/.
//
// Tests assert:
//   - Three pricing tiers render (Free, Pro, Enterprise)
//   - Correct prices shown
//   - CTAs link to the correct destinations
//   - Navigation and footer are present

import React from "react";
import { describe, expect, it, beforeAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The marketing pricing page uses JSX without importing React (Next.js auto-injects
// the JSX transform). We must set React on global before importing the module so
// the compiled JSX calls (React.createElement) are available in the vitest environment.
(globalThis as unknown as { React: typeof React }).React = React;

// The marketing pricing page is a plain React component — importable directly.
// Path is relative from ui/src/pages/__tests__
const PRICING_PAGE_PATH =
  "../../../../marketing/src/app/pricing/page.tsx";

describe("Marketing pricing page", () => {
  let html: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let PricingPage: () => any;

  beforeAll(async () => {
    // Dynamic import so the test file parses even if the path is wrong
    const mod = await import(PRICING_PAGE_PATH);
    PricingPage = mod.default as () => React.JSX.Element;
    html = renderToStaticMarkup(<PricingPage />);
  });

  it("renders without throwing", () => {
    expect(html.length).toBeGreaterThan(100);
  });

  it("renders all three tier labels: Free, Pro, Enterprise", () => {
    // Match h2 content specifically to avoid nav/footer duplicates
    expect(html).toMatch(/<h2[^>]*>Free<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>Pro<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>Enterprise<\/h2>/);
  });

  it("shows correct prices for each tier", () => {
    expect(html).toContain("$0");
    expect(html).toContain("$99/mo");
    expect(html).toContain("$499/mo");
  });

  it("Free CTA links to app signup with tier=free", () => {
    expect(html).toMatch(/href="[^"]*signup\?tier=free"/);
  });

  it("Pro CTA links to app signup with tier=pro", () => {
    expect(html).toMatch(/href="[^"]*signup\?tier=pro"/);
  });

  it("Enterprise CTA is a mailto sales link", () => {
    expect(html).toContain("mailto:sales@agentdash.com");
    expect(html).toContain("Contact sales");
  });

  it("marks Pro as Most popular", () => {
    expect(html).toContain("Most popular");
  });

  it("Pro card lists HubSpot sync as a feature", () => {
    expect(html).toContain("HubSpot sync");
  });

  it("Enterprise card lists Priority support as a feature", () => {
    expect(html).toContain("Priority support");
  });

  it("navigation links contain Pricing and Docs", () => {
    expect(html).toContain('href="/pricing"');
    expect(html).toContain('href="/docs"');
  });

  it("Get started nav CTA links to signup", () => {
    expect(html).toMatch(/href="[^"]*\/signup"/);
    expect(html).toContain("Get started");
  });

  it("renders a footer with the AgentDash brand name", () => {
    // Footer should contain the brand name
    expect(html).toContain("AgentDash");
  });

  it("footer has a Contact link", () => {
    expect(html).toContain("Contact");
  });

  it("disclaimer note renders at the bottom of the page", () => {
    expect(html).toContain("Limits shown are display-only");
  });
});
